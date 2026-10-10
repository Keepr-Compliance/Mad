/**
 * BACKLOG-3843: deactivateUser runs every check on the user's session and only
 * then writes license_status with the service client, scoped to the member AND
 * the organization the caller administers. These tests call the real action.
 */

const mockBlock = jest.fn();
const mockCreateClient = jest.fn();
const mockCreateServiceClient = jest.fn();

jest.mock('@/lib/impersonation-guards', () => ({
  blockWriteDuringImpersonation: () => mockBlock(),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => mockCreateServiceClient(),
}));

import { deactivateUser } from '@/lib/actions/deactivateUser';

type Op = [string, ...unknown[]];

/** Query-builder stand-in: records every call; each query resolves to the next queued result. */
function makeClient(results: unknown[], userId: string | null) {
  const queries: Op[][] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) },
    from(table: string) {
      const ops: Op[] = [['from', table]];
      queries.push(ops);
      const result = () => Promise.resolve(results.shift() ?? { data: null, error: null });
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'neq', 'update']) {
        builder[m] = (...args: unknown[]) => {
          ops.push([m, ...args]);
          return builder;
        };
      }
      builder.single = () => {
        ops.push(['single']);
        return result();
      };
      builder.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => result().then(ok, bad);
      return builder;
    },
  };
  return { client, queries };
}

const ADMIN = 'user-admin';
const ORG = 'org-1';
const MEMBER = 'member-9';

beforeEach(() => {
  mockBlock.mockReset().mockResolvedValue(null);
  mockCreateClient.mockReset();
  mockCreateServiceClient.mockReset();
});

describe('deactivateUser service-role write (BACKLOG-3843)', () => {
  it('J1a: admin of the member\'s org -> service write scoped by member id AND organization id', async () => {
    const user = makeClient(
      [
        { data: { id: MEMBER, user_id: 'user-x', role: 'agent', organization_id: ORG, license_status: 'active' } },
        { data: { role: 'admin' } },
      ],
      ADMIN
    );
    const service = makeClient([{ data: null, error: null }], null);
    mockCreateClient.mockResolvedValue(user.client);
    mockCreateServiceClient.mockReturnValue(service.client);

    const res = await deactivateUser({ memberId: MEMBER });

    expect(res).toEqual({ success: true });
    expect(service.queries).toHaveLength(1);
    const ops = service.queries[0];
    expect(ops[0]).toEqual(['from', 'organization_members']);
    const update = ops.find((o) => o[0] === 'update');
    expect(update?.[1]).toEqual(expect.objectContaining({ license_status: 'suspended' }));
    const eqs = ops.filter((o) => o[0] === 'eq');
    expect(eqs).toEqual(
      expect.arrayContaining([
        ['eq', 'id', MEMBER],
        ['eq', 'organization_id', ORG],
      ])
    );
    expect(eqs).toHaveLength(2);
    // the user session never attempts the license_status write itself
    expect(user.queries.some((q) => q.some((o) => o[0] === 'update'))).toBe(false);
  });

  it('J1b: caller is not a member of the target\'s org -> refused, no service write', async () => {
    const user = makeClient(
      [
        { data: { id: MEMBER, user_id: 'user-x', role: 'agent', organization_id: 'org-other', license_status: 'active' } },
        { data: null },
      ],
      ADMIN
    );
    mockCreateClient.mockResolvedValue(user.client);

    const res = await deactivateUser({ memberId: MEMBER });

    expect(res).toEqual({ success: false, error: 'Not authorized' });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
    // the membership check was made against the target's own organization
    expect(user.queries[1]).toEqual(
      expect.arrayContaining([['eq', 'user_id', ADMIN], ['eq', 'organization_id', 'org-other']])
    );
  });

  it('J2: non-admin caller -> refused, no service write', async () => {
    const user = makeClient(
      [
        { data: { id: MEMBER, user_id: 'user-x', role: 'agent', organization_id: ORG, license_status: 'active' } },
        { data: { role: 'agent' } },
      ],
      'user-agent'
    );
    mockCreateClient.mockResolvedValue(user.client);

    const res = await deactivateUser({ memberId: MEMBER });

    expect(res).toEqual({ success: false, error: 'Not authorized to deactivate users' });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });

  it('J3: impersonation session -> refused before any client is created', async () => {
    mockBlock.mockResolvedValue({ error: 'Read-only during impersonation' });

    const res = await deactivateUser({ memberId: MEMBER });

    expect(res).toEqual({ success: false, error: 'Read-only during impersonation' });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });
});
