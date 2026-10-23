/**
 * BACKLOG-3991 C16: setMemberName, the real action.
 *
 * Who reaches set_member_name and on WHICH client (the function decides on
 * auth.uid(); a service client would be refused on every call), the input check
 * before the call, and the jsonb reply -> portal result by error CODE. Reply shapes
 * are transcribed from set_member_name's RETURN jsonb_build_object lines
 * (supabase/migrations/20261019050000_backlog_3991_idp_names_and_member_name_edit.sql).
 * Client builder copied from __tests__/license-actions-3851/setMemberLicense.test.ts.
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
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlock() }));
jest.mock('@/lib/supabase/server', () => ({ createClient: () => mockCreateClient() }));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: () => mockCreateServiceClient() }));

import { setMemberName } from '@/lib/actions/memberName';
import { MEMBER_NAME_ERRORS } from '@/lib/users/memberName';

const CALLER = 'user-caller';
const ORG = 'org-1';
const MEMBER = 'member-9';

interface World {
  userId: string | null;
  callerRole: string | null;
  rpcReply?: { data: unknown; error: unknown };
}

function given(world: World) {
  const rpc = jest.fn(async () => world.rpcReply ?? { data: null, error: null });
  const client = {
    auth: { getUser: async () => ({ data: { user: world.userId ? { id: world.userId } : null } }) },
    rpc,
    from(table: string) {
      const eqs: Record<string, unknown> = {};
      const answer = () => {
        if (table === 'licenses') return { data: { status: 'active' }, error: null };
        if (table === 'organization_members' && 'id' in eqs) return { data: { id: MEMBER, organization_id: ORG }, error: null };
        if (table === 'organization_members' && 'user_id' in eqs) {
          return world.callerRole && eqs.organization_id === ORG
            ? { data: { role: world.callerRole, license_status: 'active' }, error: null }
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
  mockCreateClient.mockResolvedValue(client);
  return { rpc };
}

beforeEach(() => {
  mockBlock.mockReset().mockResolvedValue(null);
  mockCreateClient.mockReset();
  mockCreateServiceClient.mockReset();
  mockCaptureException.mockReset();
  mockCaptureMessage.mockReset();
});

describe('who reaches set_member_name, and on which client', () => {
  it.each(['admin', 'it_admin'])('%s -> one call on the USER client, names trimmed, blank -> null', async (role) => {
    const { rpc } = given({
      userId: CALLER,
      callerRole: role,
      rpcReply: { data: { success: true, member_id: MEMBER, first_name: 'Ann', last_name: null, display_name: 'Ann' }, error: null },
    });
    const res = await setMemberName({ memberId: MEMBER, firstName: '  Ann ', lastName: '   ' });
    expect(res).toEqual({ success: true, displayName: 'Ann' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('set_member_name', { p_member_id: MEMBER, p_first: 'Ann', p_last: null });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });

  it.each(['broker', 'agent', null])('%s -> Not authorized, function not called', async (role) => {
    const { rpc } = given({ userId: CALLER, callerRole: role });
    expect(await setMemberName({ memberId: MEMBER, firstName: 'A', lastName: 'B' })).toEqual({
      success: false,
      error: MEMBER_NAME_ERRORS.notAuthorized,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('impersonation -> refused with its message, function not called', async () => {
    mockBlock.mockResolvedValue({ error: 'Read-only during impersonation' });
    const { rpc } = given({ userId: CALLER, callerRole: 'admin' });
    expect(await setMemberName({ memberId: MEMBER, firstName: 'A', lastName: 'B' })).toEqual({
      success: false,
      error: 'Read-only during impersonation',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['both empty', '', '  '],
    ['101 characters', 'x'.repeat(101), 'B'],
    ['a newline inside', 'A\nn', 'B'],
    ['a control character inside', `A${String.fromCharCode(1)}n`, 'B'],
    ['a line separator inside', `A${String.fromCharCode(0x2028)}n`, 'B'],
  ])('%s -> invalid name, function not called', async (_l, f, l) => {
    const { rpc } = given({ userId: CALLER, callerRole: 'admin' });
    expect(await setMemberName({ memberId: MEMBER, firstName: f, lastName: l })).toEqual({
      success: false,
      error: MEMBER_NAME_ERRORS.invalidName,
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('reply -> result, by error code', () => {
  it.each([
    ['directory_managed', MEMBER_NAME_ERRORS.directoryManaged],
    ['invalid_name', MEMBER_NAME_ERRORS.invalidName],
    ['not_authorized', MEMBER_NAME_ERRORS.refused],
    ['own_membership', MEMBER_NAME_ERRORS.refused],
    ['invalid_target', MEMBER_NAME_ERRORS.refused],
  ])('%s -> its message, no Sentry', async (code, message) => {
    given({ userId: CALLER, callerRole: 'admin', rpcReply: { data: { success: false, error: code }, error: null } });
    expect(await setMemberName({ memberId: MEMBER, firstName: 'A', lastName: 'B' })).toEqual({ success: false, error: message });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('an unknown reply -> generic message + Sentry message', async () => {
    given({ userId: CALLER, callerRole: 'admin', rpcReply: { data: { success: false, error: 'something_new' }, error: null } });
    expect(await setMemberName({ memberId: MEMBER, firstName: 'A', lastName: 'B' })).toEqual({
      success: false,
      error: MEMBER_NAME_ERRORS.failed,
    });
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it('an rpc error -> generic message + Sentry exception', async () => {
    given({ userId: CALLER, callerRole: 'admin', rpcReply: { data: null, error: { code: 'PGRST202', message: 'missing' } } });
    expect(await setMemberName({ memberId: MEMBER, firstName: 'A', lastName: 'B' })).toEqual({
      success: false,
      error: MEMBER_NAME_ERRORS.failed,
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
