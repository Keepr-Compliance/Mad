/**
 * bulkUpdateRole — the WRITE lands in the organization the caller was checked in
 * (BACKLOG-3917, SR R1).
 *
 * The organization is client-supplied, so `.eq('organization_id', input.organizationId)`
 * on the UPDATE is the line that ties "org the caller is admin in" to "org the
 * rows are changed in". The fake applies the chained filters to real rows, so
 * the assertion is on which rows changed, not on a call being made.
 *
 * Query shapes transcribed from the code under test:
 *   organization_members  select 'role, license_status' .eq(user_id) .eq(organization_id) .maybeSingle()
 *   licenses              select 'status' .eq(user_id) .maybeSingle()
 *   organization_members  .update({ role, updated_at }) .eq(organization_id) .in(id) .neq(user_id) .select('id')
 *
 * @jest-environment node
 */

type Row = Record<string, unknown>;

const CALLER = 'caller-3917';
const ORG_A = 'org-a-3917';
const ORG_B = 'org-b-3917';

const mockRows: { members: Row[]; licences: Row[] } = { members: [], licences: [] };
const mockFilters: [string, string, unknown][] = [];

function mockBuilder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  const matched = () => (table === 'organization_members' ? mockRows.members : mockRows.licences).filter((r) => filters.every((f) => f(r)));
  const b: Record<string, unknown> = {
    select: () => b,
    update: (values: Row) => {
      patch = values;
      return b;
    },
    eq: (c: string, v: unknown) => {
      mockFilters.push([table, c, v]);
      filters.push((r) => r[c] === v);
      return b;
    },
    neq: (c: string, v: unknown) => {
      filters.push((r) => r[c] !== v);
      return b;
    },
    in: (c: string, v: unknown[]) => {
      filters.push((r) => v.includes(r[c]));
      return b;
    },
    maybeSingle: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
    then: (ok: (r: unknown) => unknown, bad?: (e: unknown) => unknown) => {
      const rows = matched();
      if (patch) rows.forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ data: rows.map((r) => ({ id: r.id })), error: null }).then(ok, bad);
    },
  };
  return b;
}

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: CALLER } } }) },
    from: (table: string) => mockBuilder(table),
  })),
}));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: jest.fn(async () => null) }));

import { bulkUpdateRole } from '@/lib/actions/bulkUpdateRole';

const member = (id: string, organization_id: string, user_id: string, role = 'agent'): Row => ({
  id,
  user_id,
  organization_id,
  role,
  license_status: 'active',
  updated_at: 'seed',
});

beforeEach(() => {
  mockFilters.length = 0;
  mockRows.members = [
    member('caller-row-a', ORG_A, CALLER, 'admin'),
    member('agent-a', ORG_A, 'user-a'),
    member('agent-b', ORG_B, 'user-b'),
  ];
  mockRows.licences = [];
});

const roleOf = (id: string) => mockRows.members.find((r) => r.id === id)!.role;

it('changes the target-org member and leaves a same-id-list member of another org untouched', async () => {
  const result = await bulkUpdateRole({ organizationId: ORG_A, memberIds: ['agent-a', 'agent-b'], newRole: 'broker' });

  expect(result).toEqual({ success: true, updatedCount: 1 });
  expect(roleOf('agent-a')).toBe('broker');
  expect(roleOf('agent-b')).toBe('agent');
  expect(mockRows.members.find((r) => r.id === 'agent-b')!.updated_at).toBe('seed');
});

it('scopes the write to the same organization the caller was checked in', async () => {
  await bulkUpdateRole({ organizationId: ORG_A, memberIds: ['agent-a'], newRole: 'broker' });

  const checked = mockFilters.filter(([, c]) => c === 'organization_id');
  // helper read (caller row) + the write: both name ORG_A, nothing else
  expect(checked).toEqual([
    ['organization_members', 'organization_id', ORG_A],
    ['organization_members', 'organization_id', ORG_A],
  ]);
});

it('refuses, and writes nothing, when the caller is not an admin in the supplied organization', async () => {
  const result = await bulkUpdateRole({ organizationId: ORG_B, memberIds: ['agent-b'], newRole: 'broker' });

  expect(result).toEqual({ success: false, error: 'Not authorized to update roles' });
  expect(roleOf('agent-b')).toBe('agent');
});
