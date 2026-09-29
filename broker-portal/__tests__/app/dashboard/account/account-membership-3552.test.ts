/**
 * My Account names the organization the portal routes on — BACKLOG-3552.
 *
 * getAccountView() used to read organization_members with `.maybeSingle()` and
 * no order. On a user with two membership rows that returns PGRST116 and
 * `data: null`, so the page showed no role, no organization and no retention
 * card: indistinguishable from a user with no organization at all.
 *
 * It now sends the same query getPortalAccess() sends (lib/auth/portalAccess.ts)
 * and resolves the rows with classifyPortalAccess, so it cannot disagree with
 * middleware or the layout about which organization a person belongs to.
 *
 * The rows come from the PostgREST emulator's builders, whose embeds are
 * transcribed from a real PostgREST (supabase/tests/backlog-3364/fixtures).
 * The emulator RECORDS `.order()` and does not apply it: fixtures are written in
 * the order the query returns them. So P6 cannot tell "first row" from "first
 * row by created_at, id" — the ORDER test is the only control that does.
 */

import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  personalMembershipOwnedBy,
  type Emulator,
  type Row,
} from '../../../helpers/postgrestEmulator';

const mockGetDataClient = jest.fn();
const mockCreateClient = jest.fn();

jest.mock('@/lib/impersonation-guards', () => ({
  getDataClient: () => mockGetDataClient(),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
}));
// The entitlement is not what this file measures; every org here may submit.
jest.mock('@/lib/feature-gate', () => ({
  isFeatureEnabledFailClosed: async () => true,
}));

import { getAccountView } from '@/lib/account/getAccountView';

/** pii-allow-uuid: invented fixture id, a second brokerage for P6. */
const SECOND_BROKERAGE_ORG_ID = '00000000-0000-4000-8000-0000035520b0';

/** A second brokerage membership, same transcribed embed, different org. */
function secondBrokerageMembership(role: string): Row {
  const base = brokerageMembership(role);
  return {
    ...base,
    id: `${SECOND_BROKERAGE_ORG_ID}-${role}`,
    organization_id: SECOND_BROKERAGE_ORG_ID,
    organizations: {
      ...(base.organizations as Record<string, unknown>),
      id: SECOND_BROKERAGE_ORG_ID,
    },
  };
}

const ORGANIZATIONS: Row[] = [
  { id: FIXTURE_BROKERAGE_ORG_ID, name: 'Northwind Realty', retention_years: 7 },
  { id: SECOND_BROKERAGE_ORG_ID, name: 'Second Brokerage', retention_years: 3 },
  { id: FIXTURE_PERSONAL_ORG_ID, name: 'Personal Org', retention_years: null },
];

const USERS: Row[] = [
  {
    id: FIXTURE_USER_ID,
    email: 'member.3552@example.test',
    display_name: 'Member 3552',
    first_name: null,
    last_name: null,
    oauth_provider: 'azure',
    created_at: '2026-01-15T10:00:00.000Z',
  },
];

function setup(members: Row[], columnPresent = true): Emulator {
  const emulator = createPostgrestEmulator({
    columnPresent,
    rows: {
      organization_members: members,
      organizations: ORGANIZATIONS,
      users: USERS,
    },
  });
  const client = { from: emulator.from };
  mockGetDataClient.mockResolvedValue({
    client,
    impersonation: null,
    targetUserId: null,
    organizationId: null,
  });
  mockCreateClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: FIXTURE_USER_ID } } }) },
  });
  return emulator;
}

async function viewFor(members: Row[], columnPresent = true) {
  setup(members, columnPresent);
  const view = await getAccountView();
  return {
    role: view?.identity.role ?? null,
    organizationName: view?.identity.organizationName ?? null,
    orgRetentionYears: view?.orgRetentionYears ?? null,
  };
}

beforeEach(() => {
  mockGetDataClient.mockReset();
  mockCreateClient.mockReset();
});

describe('getAccountView membership — BACKLOG-3552 personas', () => {
  it('P1 brokerage agent + own personal org (personal row first) -> the brokerage', async () => {
    await expect(viewFor([personalMembership(), brokerageMembership('agent')])).resolves.toEqual({
      role: 'agent',
      organizationName: 'Northwind Realty',
      orgRetentionYears: 7,
    });
  });

  it('P2 brokerage admin + own personal org (personal row first) -> the brokerage', async () => {
    await expect(viewFor([personalMembership(), brokerageMembership('admin')])).resolves.toEqual({
      role: 'admin',
      organizationName: 'Northwind Realty',
      orgRetentionYears: 7,
    });
  });

  it('P3 solo owner of a personal org -> the personal org', async () => {
    await expect(viewFor([personalMembership()])).resolves.toEqual({
      role: 'agent',
      organizationName: 'Personal Org',
      orgRetentionYears: null,
    });
  });

  it('P4 no membership rows -> no role, no organization', async () => {
    await expect(viewFor([])).resolves.toEqual({
      role: null,
      organizationName: null,
      orgRetentionYears: null,
    });
  });

  it('P5 one brokerage agent row -> the brokerage', async () => {
    await expect(viewFor([brokerageMembership('agent')])).resolves.toEqual({
      role: 'agent',
      organizationName: 'Northwind Realty',
      orgRetentionYears: 7,
    });
  });

  it('P6 two brokerages -> the first row by created_at, id', async () => {
    await expect(
      viewFor([brokerageMembership('agent'), secondBrokerageMembership('admin')])
    ).resolves.toEqual({
      role: 'agent',
      organizationName: 'Northwind Realty',
      orgRetentionYears: 7,
    });
  });

  it('P7 pre-migration database (no personal column) -> the brokerage, no 42703', async () => {
    await expect(viewFor([brokerageMembership('agent', 'pre')], false)).resolves.toEqual({
      role: 'agent',
      organizationName: 'Northwind Realty',
      orgRetentionYears: 7,
    });
  });

  it("P8 member of SOMEONE ELSE's personal org only -> no role, no organization", async () => {
    await expect(viewFor([personalMembershipOwnedBy()])).resolves.toEqual({
      role: null,
      organizationName: null,
      orgRetentionYears: null,
    });
  });
});

describe('getAccountView membership — ORDER', () => {
  it('orders organization_members on its own created_at, then id, both ascending', async () => {
    const emulator = setup([personalMembership(), brokerageMembership('agent')]);
    await getAccountView();
    const orders = emulator.state.orders
      .filter((o) => o.table === 'organization_members')
      .map(({ column, options }) => ({ column, options }));
    expect(orders).toEqual([
      { column: 'created_at', options: { ascending: true } },
      { column: 'id', options: { ascending: true } },
    ]);
  });
});
