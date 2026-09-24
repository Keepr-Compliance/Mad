/**
 * The Checklists gate, end to end — BACKLOG-3474.
 *
 * Nothing below the gate is mocked: requireChecklistEditorAccess calls the real
 * pickBrokerageMembership and the real isFeatureEnabledFailClosed. Only the
 * Supabase client and the impersonation cookie reader are stand-ins.
 *
 * The membership table is served by the BACKLOG-3364 PostgREST emulator, which
 * applies `eq` / `in` as filters and answers `.single()` with PGRST116 when
 * more than one row matches — so a gate that narrows by role and calls
 * `.single()` (the SCIM pattern) is measured, not assumed. Its organization
 * records are transcribed from a real PostgREST.
 *
 * The feature payloads are DERIVED, not transcribed: transaction_checklists is
 * layered on the transcribed 21-key base with the shape jsonb_build_object
 * emits.
 *
 * @jest-environment node
 */

const mockCreateClient = jest.fn();
const mockGetImpersonationSession = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: () => mockGetImpersonationSession(),
}));

import {
  CHECKLIST_EDITOR_ROLES,
  CHECKLIST_FEATURE_KEY,
  isChecklistEditorEnabled,
  requireChecklistEditorAccess,
} from '@/lib/checklist-access';
import {
  NOT_AUTHENTICATED_PAYLOAD,
  ORG_WITHOUT_PLAN_FEATURES,
  withFeature,
} from '../fixtures/orgFeatures';
import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from '../helpers/postgrestEmulator';

const FEATURE_ON = withFeature(ORG_WITHOUT_PLAN_FEATURES, CHECKLIST_FEATURE_KEY, true, 'Transaction checklists');
const FEATURE_OFF = withFeature(ORG_WITHOUT_PLAN_FEATURES, CHECKLIST_FEATURE_KEY, false, 'Transaction checklists');

/** pii-allow-uuid: invented fixture id */
const SECOND_BROKERAGE_ORG_ID = '00000000-0000-4000-8000-0000003474b2';

/** A membership in a second brokerage, same user. */
function secondBrokerageMembership(role: string): Row {
  const row = brokerageMembership(role);
  return {
    ...row,
    id: `${SECOND_BROKERAGE_ORG_ID}-${role}`,
    organization_id: SECOND_BROKERAGE_ORG_ID,
    organizations: { ...(row.organizations as Row), id: SECOND_BROKERAGE_ORG_ID },
  };
}

interface Setup {
  user?: { id: string } | null;
  memberships?: Row[];
  rpc?: { data?: unknown; error?: unknown };
  impersonating?: boolean;
}

function setup(opts: Setup = {}) {
  const emu = createPostgrestEmulator({
    rows: { organization_members: opts.memberships ?? [brokerageMembership('broker')] },
  });
  const rpc = jest.fn(async () => opts.rpc ?? { data: FEATURE_ON, error: null });
  const from = jest.fn((t: string) => emu.from(t));
  const client = {
    auth: {
      getUser: jest.fn(async () => ({
        data: { user: opts.user === undefined ? { id: FIXTURE_USER_ID } : opts.user },
      })),
    },
    from,
    rpc,
  };
  mockCreateClient.mockResolvedValue(client);
  mockGetImpersonationSession.mockResolvedValue(
    opts.impersonating
      ? { session_id: 's', target_user_id: 't', admin_user_id: 'a', target_email: 'x@example.test', target_name: 'X', expires_at: '2999-01-01T00:00:00Z', started_at: '2026-01-01T00:00:00Z' }
      : null
  );
  return { emu, rpc, from, client };
}

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  mockCreateClient.mockReset();
  mockGetImpersonationSession.mockReset();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('constants', () => {
  it('uses the key the 3473 migration seeds', () => {
    expect(CHECKLIST_FEATURE_KEY).toBe('transaction_checklists');
  });

  it('mirrors can_edit_checklist_templates() roles exactly', () => {
    expect([...CHECKLIST_EDITOR_ROLES].sort()).toEqual(['admin', 'broker', 'it_admin']);
  });
});

describe('requireChecklistEditorAccess — allows', () => {
  it.each(['broker', 'admin', 'it_admin'])('a %s with the feature on', async (role) => {
    setup({ memberships: [brokerageMembership(role)] });
    await expect(requireChecklistEditorAccess()).resolves.toMatchObject({
      userId: FIXTURE_USER_ID,
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
      role,
    });
  });

  it('checks the feature for the brokerage org', async () => {
    const { rpc } = setup();
    await requireChecklistEditorAccess();
    expect(rpc).toHaveBeenCalledWith('broker_get_org_features', { p_org_id: FIXTURE_BROKERAGE_ORG_ID });
  });

  // A12: a personal-org agent row first, then the brokerage row.
  it('skips the personal organization row and routes on the brokerage [A12]', async () => {
    const { rpc } = setup({ memberships: [personalMembership(), brokerageMembership('broker')] });
    const access = await requireChecklistEditorAccess();
    expect(access.organizationId).toBe(FIXTURE_BROKERAGE_ORG_ID);
    expect(access.organizationId).not.toBe(FIXTURE_PERSONAL_ORG_ID);
    expect(rpc).toHaveBeenCalledWith('broker_get_org_features', { p_org_id: FIXTURE_BROKERAGE_ORG_ID });
  });

  // A12: two brokerage rows. `.single()` on a role-narrowed read returns
  // PGRST116 here and would refuse the user.
  it('picks the first brokerage when the user holds two [A12]', async () => {
    setup({
      memberships: [personalMembership(), brokerageMembership('broker'), secondBrokerageMembership('admin')],
    });
    await expect(requireChecklistEditorAccess()).resolves.toMatchObject({
      organizationId: FIXTURE_BROKERAGE_ORG_ID,
      role: 'broker',
    });
  });

  it('reads memberships with the portal select, ordered by created_at then id', async () => {
    const { emu } = setup();
    await requireChecklistEditorAccess();
    expect(emu.state.selects).toContainEqual({
      table: 'organization_members',
      columns: 'role, organization_id, organizations(*)',
    });
    expect(emu.state.orders.filter((o) => o.table === 'organization_members').map((o) => o.column)).toEqual([
      'created_at',
      'id',
    ]);
  });
});

describe('requireChecklistEditorAccess — refuses', () => {
  it('an agent of the brokerage', async () => {
    const { rpc } = setup({ memberships: [brokerageMembership('agent')] });
    await expect(requireChecklistEditorAccess()).rejects.toThrow('Not authorized');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a user with only a personal organization', async () => {
    setup({ memberships: [personalMembership()] });
    await expect(requireChecklistEditorAccess()).rejects.toThrow('Not authorized');
  });

  it('a user with no membership', async () => {
    setup({ memberships: [] });
    await expect(requireChecklistEditorAccess()).rejects.toThrow('Not authorized');
  });

  it('an unauthenticated caller, before touching the DB', async () => {
    const { from, rpc } = setup({ user: null });
    await expect(requireChecklistEditorAccess()).rejects.toThrow('Not authenticated');
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a broker when the feature is off', async () => {
    setup({ rpc: { data: FEATURE_OFF, error: null } });
    await expect(requireChecklistEditorAccess()).rejects.toThrow('Not authorized');
  });

  it('a broker when the feature key is missing', async () => {
    setup({ rpc: { data: ORG_WITHOUT_PLAN_FEATURES, error: null } });
    await expect(requireChecklistEditorAccess()).rejects.toThrow('Not authorized');
  });

  it('a broker when broker_get_org_features errors', async () => {
    setup({ rpc: { data: null, error: { message: 'RPC exploded' } } });
    await expect(requireChecklistEditorAccess()).rejects.toThrow('Not authorized');
  });

  it("a broker on the RPC's own error payload", async () => {
    setup({ rpc: { data: NOT_AUTHENTICATED_PAYLOAD, error: null } });
    await expect(requireChecklistEditorAccess()).rejects.toThrow('Not authorized');
  });

  // A10: an editor-role auth user exists AND a support session is active.
  it('an editor with a live session while impersonating [A10]', async () => {
    const { from } = setup({ impersonating: true, memberships: [brokerageMembership('admin')] });
    await expect(requireChecklistEditorAccess()).rejects.toThrow('Not authorized');
    expect(from).not.toHaveBeenCalled();
  });
});

describe('isChecklistEditorEnabled', () => {
  it('is true exactly when requireChecklistEditorAccess allows', async () => {
    setup();
    await expect(isChecklistEditorEnabled()).resolves.toBe(true);
  });

  it.each<[string, Setup]>([
    ['agent', { memberships: [brokerageMembership('agent')] }],
    ['unauthenticated', { user: null }],
    ['feature off', { rpc: { data: FEATURE_OFF, error: null } }],
    ['feature key missing', { rpc: { data: ORG_WITHOUT_PLAN_FEATURES, error: null } }],
    ['rpc error', { rpc: { data: null, error: { message: 'x' } } }],
    ['impersonating [A10]', { impersonating: true, memberships: [brokerageMembership('admin')] }],
  ])('is false when %s', async (_label, opts) => {
    setup(opts);
    await expect(isChecklistEditorEnabled()).resolves.toBe(false);
  });

  it('is false — never throws — when the client itself blows up', async () => {
    mockGetImpersonationSession.mockResolvedValue(null);
    mockCreateClient.mockRejectedValue(new Error('cookies() unavailable'));
    await expect(isChecklistEditorEnabled()).resolves.toBe(false);
  });
});
