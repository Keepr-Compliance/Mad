/**
 * The Checklists gate, end to end — BACKLOG-3474, BACKLOG-3535, BACKLOG-3618.
 *
 * Nothing below the gate is mocked: requireChecklistAccess calls the real
 * pickBrokerageMembership / isPersonalMembership. Only the Supabase client and
 * the impersonation cookie reader are stand-ins.
 *
 * The membership table is served by the BACKLOG-3364 PostgREST emulator, which
 * applies `eq` / `in` as filters and answers `.single()` with PGRST116 when
 * more than one row matches. Its organization records are transcribed from a
 * real PostgREST.
 *
 * BACKLOG-3535: the portal no longer carries a role list or a feature read. It
 * asks can_edit_checklist_templates(p_org_id) — the function RLS and
 * save_checklist_template use — for the org it picked. The RPC stub below
 * answers per org id from an explicit map, so each case states what the
 * database said; the database rule itself is measured by harness C41
 * (supabase/tests/backlog-3473).
 *
 * BACKLOG-3618: when can_edit says no for a BROKERAGE org, the gate asks
 * can_create_own_checklist_templates(p_org_id) and admits with
 * canEditOrg: false. The stub answers it from its own map (unlisted = false);
 * the database rule is measured by supabase/tests/backlog-3618 e05.
 *
 * The A12 fixtures (a brokerage row AND a personal row) describe a state no
 * sanctioned writer produces (_retire_personal_membership deletes the personal
 * row when a brokerage row is written). They are kept as defence in depth.
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
  CHECKLIST_FEATURE_KEY,
  isChecklistPageEnabled,
  pickChecklistMembership,
  requireChecklistAccess,
} from '@/lib/checklist-access';
import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from '../helpers/postgrestEmulator';

const B = FIXTURE_BROKERAGE_ORG_ID;
const P = FIXTURE_PERSONAL_ORG_ID;

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
  /** What can_edit_checklist_templates answers, per p_org_id. Unlisted = false. */
  canEdit?: Record<string, unknown>;
  /** What can_create_own_checklist_templates answers, per p_org_id. Unlisted = false. */
  canOwn?: Record<string, unknown>;
  /** A PostgREST error on the can_create_own call only. */
  ownRpcError?: unknown;
  /** A PostgREST error on the rpc call. */
  rpcError?: unknown;
  impersonating?: boolean;
}

function setup(opts: Setup = {}) {
  const emu = createPostgrestEmulator({
    rows: { organization_members: opts.memberships ?? [brokerageMembership('broker')] },
  });
  const canEdit = opts.canEdit ?? { [B]: true };
  const canOwn = opts.canOwn ?? {};
  const rpc = jest.fn(async (fn: string, args: { p_org_id: string }) => {
    if (opts.rpcError) return { data: null, error: opts.rpcError };
    // `in`, not `??`: a null answer must reach the gate as null.
    if (fn === 'can_edit_checklist_templates') {
      return { data: args.p_org_id in canEdit ? canEdit[args.p_org_id] : false, error: null };
    }
    if (fn === 'can_create_own_checklist_templates') {
      if (opts.ownRpcError) return { data: null, error: opts.ownRpcError };
      return { data: args.p_org_id in canOwn ? canOwn[args.p_org_id] : false, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  });
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
});

describe('requireChecklistAccess — allows', () => {
  it.each(['broker', 'admin', 'it_admin'])('a %s the database admits', async (role) => {
    setup({ memberships: [brokerageMembership(role)] });
    await expect(requireChecklistAccess()).resolves.toMatchObject({
      userId: FIXTURE_USER_ID,
      organizationId: B,
      role,
    });
  });

  it('asks can_edit_checklist_templates for the brokerage org, once', async () => {
    const { rpc } = setup();
    await requireChecklistAccess();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('can_edit_checklist_templates', { p_org_id: B });
  });

  // A12: a personal-org agent row first, then the brokerage row.
  it('skips the personal organization row and routes on the brokerage [A12]', async () => {
    const { rpc } = setup({ memberships: [personalMembership(), brokerageMembership('broker')], canEdit: { [B]: true, [P]: true } });
    const access = await requireChecklistAccess();
    expect(access.organizationId).toBe(B);
    expect(rpc).toHaveBeenCalledWith('can_edit_checklist_templates', { p_org_id: B });
    expect(rpc).not.toHaveBeenCalledWith('can_edit_checklist_templates', { p_org_id: P });
  });

  // A12: two brokerage rows. `.single()` on a role-narrowed read returns
  // PGRST116 here and would refuse the user.
  it('picks the first brokerage when the user holds two [A12]', async () => {
    setup({
      memberships: [personalMembership(), brokerageMembership('broker'), secondBrokerageMembership('admin')],
    });
    await expect(requireChecklistAccess()).resolves.toMatchObject({
      organizationId: B,
      role: 'broker',
    });
  });

  it('reads memberships with the portal select, ordered by created_at then id', async () => {
    const { emu } = setup();
    await requireChecklistAccess();
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

describe('BACKLOG-3535 — solo owner (personal organization only)', () => {
  it('P1 edits the personal org when the database says yes', async () => {
    const { rpc } = setup({ memberships: [personalMembership()], canEdit: { [P]: true } });
    await expect(requireChecklistAccess()).resolves.toMatchObject({ organizationId: P, role: 'agent' });
    expect(rpc).toHaveBeenCalledWith('can_edit_checklist_templates', { p_org_id: P });
  });

  it('P2 is refused when the database says no (feature off for the personal org)', async () => {
    setup({ memberships: [personalMembership()], canEdit: { [P]: false } });
    await expect(requireChecklistAccess()).rejects.toThrow('Not authorized');
  });

  it('pickChecklistMembership: brokerage row wins, else the personal row, else null', () => {
    expect(pickChecklistMembership([personalMembership(), brokerageMembership('agent')] as never)?.organization_id).toBe(B);
    expect(pickChecklistMembership([personalMembership()] as never)?.organization_id).toBe(P);
    expect(pickChecklistMembership([] as never)).toBeNull();
    expect(pickChecklistMembership(null)).toBeNull();
  });
});

describe('BACKLOG-3535 — brokerage wins, no fall-through', () => {
  it.each([
    ['personal row first', () => [personalMembership(), brokerageMembership('agent')]],
    ['brokerage row first', () => [brokerageMembership('agent'), personalMembership()]],
  ])('P3 a brokerage agent who owns a personal org is refused (%s)', async (_label, rows) => {
    const { rpc } = setup({ memberships: rows(), canEdit: { [B]: false, [P]: true } });
    await expect(requireChecklistAccess()).rejects.toThrow('Not authorized');
    // BACKLOG-3618: the second question is about the same brokerage, never P.
    expect(rpc.mock.calls.map((c) => c[1])).toEqual([{ p_org_id: B }, { p_org_id: B }]);
  });

  it('P3b an agent in the first brokerage and a broker in a second is refused, asking only the first', async () => {
    const { rpc } = setup({
      memberships: [brokerageMembership('agent'), secondBrokerageMembership('broker')],
      canEdit: { [B]: false, [SECOND_BROKERAGE_ORG_ID]: true },
    });
    await expect(requireChecklistAccess()).rejects.toThrow('Not authorized');
    expect(rpc.mock.calls.map((c) => c[1])).toEqual([{ p_org_id: B }, { p_org_id: B }]);
  });

  it('P4 a brokerage broker who owns a personal org edits the brokerage', async () => {
    setup({ memberships: [personalMembership(), brokerageMembership('broker')], canEdit: { [B]: true, [P]: true } });
    await expect(requireChecklistAccess()).resolves.toMatchObject({ organizationId: B });
  });
});

describe('BACKLOG-3535 — the database is the only rule', () => {
  it('P5a no role list in the portal: an agent the database admits is admitted', async () => {
    setup({ memberships: [brokerageMembership('agent')], canEdit: { [B]: true } });
    await expect(requireChecklistAccess()).resolves.toMatchObject({ organizationId: B, role: 'agent' });
  });

  it('P5b a broker the database refuses is refused', async () => {
    setup({ memberships: [brokerageMembership('broker')], canEdit: { [B]: false } });
    await expect(requireChecklistAccess()).rejects.toThrow('Not authorized');
  });

  it.each<[string, Setup]>([
    ['an rpc error', { rpcError: { message: 'RPC exploded' } }],
    ['a null answer', { canEdit: { [B]: null } }],
    ['the string "true"', { canEdit: { [B]: 'true' } }],
    ['an object answer', { canEdit: { [B]: { allowed: true } } }],
  ])('P6 fails closed on %s', async (_label, opts) => {
    setup({ memberships: [brokerageMembership('broker')], ...opts });
    await expect(requireChecklistAccess()).rejects.toThrow('Not authorized');
  });

  it('P7 no membership: refused without asking the database', async () => {
    const { rpc } = setup({ memberships: [] });
    await expect(requireChecklistAccess()).rejects.toThrow('Not authorized');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('requireChecklistAccess — refuses', () => {
  it('an agent of the brokerage when the database refuses', async () => {
    setup({ memberships: [brokerageMembership('agent')], canEdit: { [B]: false } });
    await expect(requireChecklistAccess()).rejects.toThrow('Not authorized');
  });

  it('an unauthenticated caller, before touching the DB', async () => {
    const { from, rpc } = setup({ user: null });
    await expect(requireChecklistAccess()).rejects.toThrow('Not authenticated');
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  // A10: an editor-role auth user exists AND a support session is active.
  it('an editor with a live session while impersonating [A10]', async () => {
    const { from } = setup({ impersonating: true, memberships: [brokerageMembership('admin')] });
    await expect(requireChecklistAccess()).rejects.toThrow('Not authorized');
    expect(from).not.toHaveBeenCalled();
  });
});

describe('isChecklistPageEnabled', () => {
  it('is true exactly when requireChecklistAccess allows', async () => {
    setup();
    await expect(isChecklistPageEnabled()).resolves.toBe(true);
  });

  it.each<[string, Setup]>([
    ['the database refuses an agent', { memberships: [brokerageMembership('agent')], canEdit: { [B]: false } }],
    ['unauthenticated', { user: null }],
    ['the database refuses (feature off)', { canEdit: { [B]: false } }],
    ['rpc error', { rpcError: { message: 'x' } }],
    ['impersonating [A10]', { impersonating: true, memberships: [brokerageMembership('admin')] }],
  ])('is false when %s', async (_label, opts) => {
    setup(opts);
    await expect(isChecklistPageEnabled()).resolves.toBe(false);
  });

  it('is false — never throws — when the client itself blows up', async () => {
    mockGetImpersonationSession.mockResolvedValue(null);
    mockCreateClient.mockRejectedValue(new Error('cookies() unavailable'));
    await expect(isChecklistPageEnabled()).resolves.toBe(false);
  });
});

describe('BACKLOG-3618 — a brokerage member keeps their own checklists', () => {
  it('O1 an agent the database lets create their own is admitted, not as an editor', async () => {
    const { rpc } = setup({ memberships: [brokerageMembership('agent')], canEdit: { [B]: false }, canOwn: { [B]: true } });
    await expect(requireChecklistAccess()).resolves.toMatchObject({
      organizationId: B,
      role: 'agent',
      canEditOrg: false,
      personalOrg: false,
    });
    expect(rpc.mock.calls).toEqual([
      ['can_edit_checklist_templates', { p_org_id: B }],
      ['can_create_own_checklist_templates', { p_org_id: B }],
    ]);
  });

  it('O2 an editor is admitted as an editor and the second question is never asked', async () => {
    const { rpc } = setup({ memberships: [brokerageMembership('broker')], canEdit: { [B]: true }, canOwn: { [B]: true } });
    await expect(requireChecklistAccess()).resolves.toMatchObject({ canEditOrg: true, personalOrg: false });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['can_edit_checklist_templates']);
  });

  it('O3 an editor is still admitted when can_create_own errors (it is never consulted)', async () => {
    setup({ memberships: [brokerageMembership('admin')], canEdit: { [B]: true }, ownRpcError: { code: 'PGRST202', message: 'missing' } });
    await expect(requireChecklistAccess()).resolves.toMatchObject({ canEditOrg: true });
  });

  it('O4 a solo owner is an editor of the personal org, personalOrg: true (one list)', async () => {
    setup({ memberships: [personalMembership()], canEdit: { [P]: true } });
    await expect(requireChecklistAccess()).resolves.toMatchObject({ organizationId: P, canEditOrg: true, personalOrg: true });
  });

  it('O5 a solo owner the database refuses is refused without the second question', async () => {
    const { rpc } = setup({ memberships: [personalMembership()], canEdit: { [P]: false }, canOwn: { [P]: true } });
    await expect(requireChecklistAccess()).rejects.toThrow('Not authorized');
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['can_edit_checklist_templates']);
  });

  it.each<[string, Setup]>([
    ['the database says no (feature off)', { canOwn: { [B]: false } }],
    ['an rpc error', { canOwn: { [B]: true }, ownRpcError: { message: 'boom' } }],
    ['a null answer', { canOwn: { [B]: null } }],
    ['the string "true"', { canOwn: { [B]: 'true' } }],
  ])('O6 an agent is refused when can_create_own gives %s', async (_label, opts) => {
    setup({ memberships: [brokerageMembership('agent')], canEdit: { [B]: false }, ...opts });
    await expect(requireChecklistAccess()).rejects.toThrow('Not authorized');
  });

  it('O7 an error on can_edit refuses, even when can_create_own would say yes', async () => {
    setup({ memberships: [brokerageMembership('agent')], rpcError: { message: 'boom' }, canOwn: { [B]: true } });
    await expect(requireChecklistAccess()).rejects.toThrow('Not authorized');
  });

  it('O8 isChecklistPageEnabled is true for an admitted agent', async () => {
    setup({ memberships: [brokerageMembership('agent')], canEdit: { [B]: false }, canOwn: { [B]: true } });
    await expect(isChecklistPageEnabled()).resolves.toBe(true);
  });
});
