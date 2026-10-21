/**
 * BACKLOG-4027 PR-1: the Users-page actions word the database's refusals (founder decision B:
 * a brokerage always keeps one active admin), and deactivateUser's own check counts the admin
 * role only, the same rule as the database guard.
 *
 * Error shapes: PostgREST returns a RAISE as { code, message, hint }. Transcribed from keepr-test
 * (supabase/tests/backlog-4027/controls.sql T3 / T3b / T5): 'P0001 last_admin' and
 * '42501 managed_by_idp'.
 */

const mockBlock = jest.fn();
const mockCreateClient = jest.fn();
const mockCreateServiceClient = jest.fn();

jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlock() }));
jest.mock('@/lib/supabase/server', () => ({ createClient: () => mockCreateClient() }));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: () => mockCreateServiceClient() }));

import { deactivateUser } from '@/lib/actions/deactivateUser';
import { updateUserRole } from '@/lib/actions/updateUserRole';
import { bulkUpdateRole } from '@/lib/actions/bulkUpdateRole';
import { removeUser } from '@/lib/actions/removeUser';

type Op = [string, ...unknown[]];

const LAST_ADMIN = { code: 'P0001', message: 'last_admin', hint: 'A brokerage must keep at least one active admin. Name another admin first.' };
const MANAGED = { code: '42501', message: 'managed_by_idp', hint: 'Managed by your identity provider.' };

function makeClient(results: unknown[], userId: string | null) {
  const queries: Op[][] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) },
    from(table: string) {
      const ops: Op[] = [['from', table]];
      queries.push(ops);
      const result = () => Promise.resolve(results.shift() ?? { data: null, error: null });
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'neq', 'not', 'is', 'update', 'delete']) {
        builder[m] = (...args: unknown[]) => { ops.push([m, ...args]); return builder; };
      }
      builder.single = () => { ops.push(['single']); return result(); };
      builder.maybeSingle = () => { ops.push(['maybeSingle']); return result(); };
      builder.then = (ok: (_v: unknown) => unknown, bad?: (_e: unknown) => unknown) => result().then(ok, bad);
      return builder;
    },
  };
  return { client, queries };
}

const CALLER = 'user-caller';
const ORG = 'org-1';
const MEMBER = 'member-9';
const LICENCE_ACTIVE = { data: { status: 'active' }, error: null };
const CALLER_IT = { data: { role: 'it_admin', license_status: 'active' } };
const CALLER_ADMIN = { data: { role: 'admin', license_status: 'active' } };

beforeEach(() => {
  mockBlock.mockReset().mockResolvedValue(null);
  mockCreateClient.mockReset();
  mockCreateServiceClient.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('deactivateUser (W11)', () => {
  it('the only admin, with an IT admin beside them: refused by the app check (admin role only), no service write', async () => {
    const user = makeClient(
      [
        { data: { id: MEMBER, user_id: 'user-x', role: 'admin', organization_id: ORG, license_status: 'active' } },
        CALLER_IT, LICENCE_ACTIVE,
        { count: 0, data: null, error: null }, // other active admins (the IT admin is not one)
      ],
      CALLER,
    );
    mockCreateClient.mockResolvedValue(user.client);
    const res = await deactivateUser({ memberId: MEMBER });
    expect(res).toEqual({ success: false, error: 'Cannot deactivate the last admin' });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
    const count = user.queries[3];
    expect(count).toEqual(expect.arrayContaining([['eq', 'role', 'admin'], ['not', 'user_id', 'is', null], ['neq', 'id', MEMBER]]));
    expect(count.some((o) => o[0] === 'in' && o[1] === 'role')).toBe(false);
  });

  it('the database refuses the service write (last_admin): the same sentence', async () => {
    const user = makeClient(
      [
        { data: { id: MEMBER, user_id: 'user-x', role: 'admin', organization_id: ORG, license_status: 'active' } },
        CALLER_IT, LICENCE_ACTIVE,
        { count: 1, data: null, error: null }, // a concurrent change: the app saw another admin
      ],
      CALLER,
    );
    const service = makeClient([{ data: null, error: LAST_ADMIN }], null);
    mockCreateClient.mockResolvedValue(user.client);
    mockCreateServiceClient.mockReturnValue(service.client);
    const res = await deactivateUser({ memberId: MEMBER });
    expect(res).toEqual({ success: false, error: 'Cannot deactivate the last admin' });
  });

  it('control: an agent is deactivated without the admin count', async () => {
    const user = makeClient(
      [{ data: { id: MEMBER, user_id: 'user-x', role: 'agent', organization_id: ORG, license_status: 'active' } }, CALLER_IT, LICENCE_ACTIVE],
      CALLER,
    );
    const service = makeClient([{ data: null, error: null }], null);
    mockCreateClient.mockResolvedValue(user.client);
    mockCreateServiceClient.mockReturnValue(service.client);
    expect(await deactivateUser({ memberId: MEMBER })).toEqual({ success: true });
    expect(user.queries).toHaveLength(3);
  });
});

describe('updateUserRole', () => {
  const target = { data: { id: MEMBER, user_id: 'user-x', role: 'agent', organization_id: ORG } };
  it.each([
    [LAST_ADMIN, 'Cannot demote the last admin. Assign another admin first.'],
    [MANAGED, 'Managed by your identity provider.'],
  ])('database refusal %o -> Users-page sentence', async (err, sentence) => {
    const user = makeClient([target, CALLER_ADMIN, LICENCE_ACTIVE, { data: null, error: err }], CALLER);
    mockCreateClient.mockResolvedValue(user.client);
    expect(await updateUserRole({ memberId: MEMBER, newRole: 'broker' })).toEqual({ success: false, error: sentence });
  });
});

describe('bulkUpdateRole', () => {
  it.each([
    [LAST_ADMIN, 'Cannot demote the last admin. Assign another admin first.'],
    [MANAGED, 'Managed by your identity provider.'],
  ])('database refusal %o -> Users-page sentence', async (err, sentence) => {
    const user = makeClient([CALLER_ADMIN, LICENCE_ACTIVE, { data: null, error: err }], CALLER);
    mockCreateClient.mockResolvedValue(user.client);
    expect(await bulkUpdateRole({ organizationId: ORG, memberIds: ['m-1', 'm-2'], newRole: 'agent' })).toEqual({ success: false, error: sentence });
  });
});

describe('removeUser', () => {
  it('database refusal last_admin -> "Cannot remove the last admin"', async () => {
    const user = makeClient(
      [{ data: { id: MEMBER, user_id: 'user-x', role: 'agent', organization_id: ORG } }, CALLER_IT, LICENCE_ACTIVE, { data: null, error: LAST_ADMIN }],
      CALLER,
    );
    mockCreateClient.mockResolvedValue(user.client);
    expect(await removeUser({ memberId: MEMBER })).toEqual({ success: false, error: 'Cannot remove the last admin' });
  });
});
