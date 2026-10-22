/**
 * BACKLOG-3851 PR-2a (C3, C4): the single-row readers, with TWO membership rows.
 *
 * After M2 (20261016100100) a deactivated member holds a suspended / expired
 * brokerage row AND their own personal row (the revert trigger attaches it).
 * Before PR-2a two readers asked for "the" row with `.maybeSingle()`:
 *   - lib/account/getAccountView.ts — PGRST116, data null: no organization shown;
 *   - lib/impersonation-guards.ts — PGRST116, data null: "has no organization",
 *     staff could not open the user.
 * The membership table is the BACKLOG-3364 PostgREST emulator, which answers
 * `.maybeSingle()` on two rows with PGRST116 + data null (supabase-js's shape;
 * helpers/postgrestEmulator.ts). Row embeds are transcribed there.
 *
 * @jest-environment node
 */

import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from '../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetImpersonationSession = jest.fn();
const mockFeature = jest.fn();

jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: () => mockGetImpersonationSession(),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: FIXTURE_USER_ID } } }) },
    from: (table: string) => mockEmulator.from(table),
  })),
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: jest.fn(() => ({ from: (table: string) => mockEmulator.from(table) })),
}));
jest.mock('@/lib/feature-gate', () => ({
  isFeatureEnabledFailClosed: (...a: unknown[]) => mockFeature(...a),
}));

import { getAccountView } from '@/lib/account/getAccountView';
import { getDataClient } from '@/lib/impersonation-guards';

const B = FIXTURE_BROKERAGE_ORG_ID;
const P = FIXTURE_PERSONAL_ORG_ID;
const ORGS: Row[] = [
  { id: B, name: 'Fixture Brokerage 3851', retention_years: 7, personal_owner_user_id: null },
  { id: P, name: 'Personal', retention_years: null, personal_owner_user_id: FIXTURE_USER_ID },
];
const USER: Row = { id: FIXTURE_USER_ID, email: 'two-rows-3851@fixture.example.test', oauth_provider: 'azure' };
const status = (row: Row, s: string): Row => ({ ...row, license_status: s });

function given(memberships: Row[]): void {
  mockEmulator.reset();
  mockEmulator.set({
    columnPresent: true,
    rows: { organization_members: memberships, organizations: ORGS, users: [USER], user_preferences: [] },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFeature.mockResolvedValue(true);
  mockGetImpersonationSession.mockResolvedValue(null);
});

const REVERTED = {
  'suspended admin, brokerage row first': () => [status(brokerageMembership('admin'), 'suspended'), personalMembership()],
  'suspended admin, personal row first': () => [personalMembership(), status(brokerageMembership('admin'), 'suspended')],
  'expired agent, brokerage row first': () => [status(brokerageMembership('agent'), 'expired'), personalMembership()],
} as const;
const revertedCases = Object.entries(REVERTED);

describe('C3 getAccountView', () => {
  it.each(revertedCases)('%s: shows the personal organization, no brokerage retention line', async (_label, rows) => {
    given(rows());
    const view = await getAccountView();
    expect(view?.identity.organizationName).toBe('Personal');
    expect(view?.identity.role).toBe('agent');
    expect(view?.orgRetentionYears).toBeNull();
    expect(mockFeature).toHaveBeenCalledWith(P, 'broker_submission');
    expect(mockFeature).not.toHaveBeenCalledWith(B, expect.anything());
  });

  it('twin: an active brokerage agent (one row) still shows the brokerage and its retention', async () => {
    given([brokerageMembership('agent')]);
    const view = await getAccountView();
    expect(view?.identity.organizationName).toBe('Fixture Brokerage 3851');
    expect(view?.orgRetentionYears).toBe(7);
  });

  it('twin: a deactivated member with no personal row still shows the brokerage name', async () => {
    given([status(brokerageMembership('admin'), 'suspended')]);
    const view = await getAccountView();
    expect(view?.identity.organizationName).toBe('Fixture Brokerage 3851');
    expect(view?.identity.role).toBe('admin');
  });

  it('reads every membership row, ordered by created_at then id', async () => {
    given([brokerageMembership('agent')]);
    await getAccountView();
    expect(mockEmulator.state.orders.filter((o) => o.table === 'organization_members').map((o) => o.column)).toEqual([
      'created_at',
      'id',
    ]);
  });
});

describe('C4 impersonation scope (getDataClient)', () => {
  beforeEach(() => mockGetImpersonationSession.mockResolvedValue({ target_user_id: FIXTURE_USER_ID }));

  it.each(revertedCases)('%s: the scoped client is scoped to the personal organization', async (_label, rows) => {
    given(rows());
    await expect(getDataClient()).resolves.toMatchObject({ organizationId: P, targetUserId: FIXTURE_USER_ID });
  });

  it.each(revertedCases)('%s: the account page opens under impersonation, naming the personal org', async (_label, rows) => {
    given(rows());
    const view = await getAccountView();
    expect(view?.isImpersonating).toBe(true);
    expect(view?.identity.organizationName).toBe('Personal');
  });

  it('twin: an active brokerage admin (one row) is scoped to the brokerage', async () => {
    given([brokerageMembership('admin')]);
    await expect(getDataClient()).resolves.toMatchObject({ organizationId: B });
  });

  it('twin: a user with no membership row still cannot be impersonated', async () => {
    given([]);
    await expect(getDataClient()).rejects.toThrow('has no organization');
  });
});
