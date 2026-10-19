/**
 * BACKLOG-3851 PR-2b: setMemberLicense, the real action.
 *
 * C1 — who reaches set_member_license, and on WHICH client: the database
 *      function decides on auth.uid(), so a service client would be refused on
 *      every call. The service-client factory must never be called.
 * C2 — the function's jsonb reply -> the portal result. Reply shapes are
 *      transcribed from set_member_license (supabase/migrations/
 *      20261015152446_backlog_3851_license_model.sql, the RETURN
 *      jsonb_build_object lines); invalid_transition was also produced by a real
 *      call on the test project inside a rolled-back block.
 *
 * last_manager and own_membership cannot be produced through this action (the
 * caller is itself an active manager and never the target); their mappings are
 * defensive and are NOT counted as coverage.
 */

const mockBlock = jest.fn();
const mockCreateClient = jest.fn();
const mockCreateServiceClient = jest.fn();
const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
}));
jest.mock('@/lib/impersonation-guards', () => ({
  blockWriteDuringImpersonation: () => mockBlock(),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => mockCreateServiceClient(),
}));

import { setMemberLicense } from '@/lib/actions/memberLicense';
import { MEMBER_LICENSE_ERRORS } from '@/lib/users/memberLicenseActions';

const CALLER = 'user-caller';
const ORG = 'org-1';
const MEMBER = 'member-9';

interface World {
  userId: string | null;
  callerRole: string | null;
  callerStatus?: string;
  target?: Record<string, unknown> | null;
  rpcReply?: { data: unknown; error: unknown };
}

/** Answers by table and filter, not by call order. */
function makeClient(world: World) {
  const rpc = jest.fn(async () => world.rpcReply ?? { data: null, error: null });
  const client = {
    auth: { getUser: async () => ({ data: { user: world.userId ? { id: world.userId } : null } }) },
    rpc,
    from(table: string) {
      const eqs: Record<string, unknown> = {};
      const answer = () => {
        if (table === 'licenses') return { data: { status: 'active' }, error: null };
        if (table === 'organization_members' && 'id' in eqs) {
          return { data: world.target === undefined ? defaultTarget() : world.target, error: null };
        }
        if (table === 'organization_members' && 'user_id' in eqs) {
          return world.callerRole && eqs.organization_id === ORG
            ? { data: { role: world.callerRole, license_status: world.callerStatus ?? 'active' }, error: null }
            : { data: null, error: null };
        }
        return { data: null, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          eqs[col] = val;
          return builder;
        },
        single: async () => answer(),
        maybeSingle: async () => answer(),
      };
      return builder;
    },
  };
  return { client, rpc };
}

function defaultTarget() {
  return { id: MEMBER, user_id: 'user-x', role: 'agent', organization_id: ORG, license_status: 'unassigned' };
}

beforeEach(() => {
  mockBlock.mockReset().mockResolvedValue(null);
  mockCreateClient.mockReset();
  mockCreateServiceClient.mockReset();
  mockCaptureException.mockReset();
  mockCaptureMessage.mockReset();
});

function given(world: World) {
  const c = makeClient(world);
  mockCreateClient.mockResolvedValue(c.client);
  return c;
}

describe('C1: who reaches set_member_license, and on which client', () => {
  it.each(['admin', 'it_admin'])('%s -> called once on the USER client with p_member_id and p_action', async (role) => {
    const { rpc } = given({
      userId: CALLER,
      callerRole: role,
      rpcReply: { data: { success: true, member_id: MEMBER, license_status: 'active' }, error: null },
    });
    const res = await setMemberLicense({ memberId: MEMBER, action: 'assign' });
    expect(res).toEqual({ success: true, licenseStatus: 'active' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('set_member_license', { p_member_id: MEMBER, p_action: 'assign' });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });

  it.each(['broker', 'agent'])('%s -> Not authorized, function not called', async (role) => {
    const { rpc } = given({ userId: CALLER, callerRole: role });
    const res = await setMemberLicense({ memberId: MEMBER, action: 'assign' });
    expect(res).toEqual({ success: false, error: MEMBER_LICENSE_ERRORS.notAuthorized });
    expect(rpc).not.toHaveBeenCalled();
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });

  it('a caller with no row in the TARGET organization -> Not authorized, function not called', async () => {
    const { rpc } = given({
      userId: CALLER,
      callerRole: 'admin',
      target: { ...defaultTarget(), organization_id: 'org-other' },
    });
    const res = await setMemberLicense({ memberId: MEMBER, action: 'assign' });
    expect(res).toEqual({ success: false, error: MEMBER_LICENSE_ERRORS.notAuthorized });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a suspended admin row -> Not authorized, function not called', async () => {
    const { rpc } = given({ userId: CALLER, callerRole: 'admin', callerStatus: 'suspended' });
    const res = await setMemberLicense({ memberId: MEMBER, action: 'reactivate' });
    expect(res).toEqual({ success: false, error: MEMBER_LICENSE_ERRORS.notAuthorized });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('impersonation -> refused before any client is made', async () => {
    mockBlock.mockResolvedValue({ error: 'Read-only during impersonation' });
    const res = await setMemberLicense({ memberId: MEMBER, action: 'assign' });
    expect(res).toEqual({ success: false, error: 'Read-only during impersonation' });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('not signed in -> Not authenticated, function not called', async () => {
    const { rpc } = given({ userId: null, callerRole: 'admin' });
    const res = await setMemberLicense({ memberId: MEMBER, action: 'assign' });
    expect(res).toEqual({ success: false, error: MEMBER_LICENSE_ERRORS.notAuthenticated });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('unknown member -> Member not found, function not called', async () => {
    const { rpc } = given({ userId: CALLER, callerRole: 'admin', target: null });
    const res = await setMemberLicense({ memberId: MEMBER, action: 'assign' });
    expect(res).toEqual({ success: false, error: MEMBER_LICENSE_ERRORS.notFound });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('C2: function reply -> portal result', () => {
  const cases: [string, unknown, Record<string, unknown>, boolean][] = [
    ['success', { success: true, member_id: MEMBER, license_status: 'unassigned' }, { success: true, licenseStatus: 'unassigned' }, false],
    ['seat_limit_reached', { success: false, error: 'seat_limit_reached', action: 'assign' }, { success: false, outOfSeats: true }, false],
    ['not_authorized', { success: false, error: 'not_authorized' }, { success: false, error: MEMBER_LICENSE_ERRORS.notAuthorized }, false],
    ['invalid_transition', { success: false, error: 'invalid_transition' }, { success: false, error: MEMBER_LICENSE_ERRORS.invalidTransition }, false],
    ['unexpected (null) reply', null, { success: false, error: MEMBER_LICENSE_ERRORS.failed }, true],
  ];

  it.each(cases)('%s', async (_name, data, expected, reported) => {
    given({ userId: CALLER, callerRole: 'admin', rpcReply: { data, error: null } });
    const res = await setMemberLicense({ memberId: MEMBER, action: 'assign' });
    expect(res).toEqual(expected);
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledTimes(reported ? 1 : 0);
  });

  it('transport error -> generic error, reported to Sentry', async () => {
    given({ userId: CALLER, callerRole: 'admin', rpcReply: { data: null, error: { message: 'fetch failed' } } });
    const res = await setMemberLicense({ memberId: MEMBER, action: 'reactivate' });
    expect(res).toEqual({ success: false, error: MEMBER_LICENSE_ERRORS.failed });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  // Defensive only — not reachable through this action (see header).
  it.each([
    ['last_manager (unemittable from the portal)', { success: false, error: 'last_manager' }, MEMBER_LICENSE_ERRORS.lastManager],
    ['own_membership (unemittable from the portal)', { success: false, error: 'not_authorized', reason: 'own_membership' }, MEMBER_LICENSE_ERRORS.notAuthorized],
  ])('%s', async (_name, data, error) => {
    given({ userId: CALLER, callerRole: 'admin', rpcReply: { data, error: null } });
    expect(await setMemberLicense({ memberId: MEMBER, action: 'unassign' })).toEqual({ success: false, error });
  });
});

// BACKLOG-3853 PR-2B (C-A1): a suspended brokerage. The member trigger
// _billing_guard_member_while_suspended raises out of set_member_license:
//   RAISE EXCEPTION 'account_suspended' USING ERRCODE = 'P0001', HINT = '<the G5 text>'
// (keepr-test catalog, 2026-10-19). PostgREST forwards SQLSTATE as `code`, the
// message unchanged and the hint as `hint`. Provoked on keepr-test as the Beta
// admin inside a rolled-back block (plan 2cafe0ef §5): ERR P0001 account_suspended.
describe('C-A1: brokerage suspended (BACKLOG-3853)', () => {
  const SUSPENDED = {
    code: 'P0001',
    message: 'account_suspended',
    details: null,
    hint: 'This brokerage account is suspended. Contact Keepr to restore it.',
  };
  it.each(['assign', 'unassign', 'reactivate'] as const)('%s -> the suspended message, not reported', async (action) => {
    given({ userId: CALLER, callerRole: 'admin', rpcReply: { data: null, error: SUSPENDED } });
    expect(await setMemberLicense({ memberId: MEMBER, action })).toEqual({
      success: false,
      error: 'This brokerage account is suspended. Contact Keepr to restore it.',
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['same message, other code', { ...SUSPENDED, code: '42501' }],
    ['same code, other message', { ...SUSPENDED, message: 'something_else' }],
  ])('%s -> generic failure, reported', async (_n, err) => {
    given({ userId: CALLER, callerRole: 'admin', rpcReply: { data: null, error: err } });
    expect(await setMemberLicense({ memberId: MEMBER, action: 'assign' })).toEqual({
      success: false,
      error: MEMBER_LICENSE_ERRORS.failed,
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
