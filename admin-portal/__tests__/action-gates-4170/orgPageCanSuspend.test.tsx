/**
 * BACKLOG-4170 PR4: the organization page gives MembersTable canSuspend from users.suspend only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@keepr/design-system', () => ({ Card: () => null }));
function MembersTableStub() { return null; }
vi.mock('@/app/dashboard/organizations/[id]/components/MembersTable', () => ({ MembersTable: MembersTableStub }));
vi.mock('@/app/dashboard/organizations/[id]/components/PendingInvitationsTable', () => ({ PendingInvitationsTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PlanAssignment', () => ({ PlanAssignment: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard', () => ({ BrokerageBillingCard: () => null }));

const KEYS = ['organizations.view', 'plans.manage', 'users.edit', 'billing.view', 'users.suspend', 'billing.suspend', 'licenses.edit', 'credits.adjust'];
const state: { perms: Record<string, boolean>; asked: string[] } = { perms: {}, asked: [] };

function table(name: string) {
  const rows: Record<string, unknown> = {
    internal_roles: { role_id: 'r1' },
    organizations: { id: 'o1', name: 'Org', slug: 'org', max_seats: 5, created_at: '2026-01-01', organization_plans: null },
    organization_members: [{ user_id: 'm1', role: 'agent', license_status: 'active', joined_at: '2026-01-02',
      users: { id: 'm1', email: 'm1@example.test', display_name: 'M1', status: 'active', suspended_at: null } }],
  };
  const result = { data: rows[name] ?? null, error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'single', 'not', 'is']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'u1' },
    supabase: {
      from: (n: string) => table(n),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'has_permission') {
          const key = args.required_permission as string;
          state.asked.push(key);
          return { data: state.perms[key] === true };
        }
        return { data: null };
      },
    },
  }),
}));

function find(node: ReactNode): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const n of node) { const r = find(n); if (r) return r; } return undefined; }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === MembersTableStub) return el.props;
  return el.props ? find(el.props.children as ReactNode) : undefined;
}

async function tableProps() {
  const { default: Page } = await import('@/app/dashboard/organizations/[id]/page');
  const props = find((await Page({ params: Promise.resolve({ id: 'o1' }) })) as ReactNode);
  expect(props).toBeDefined();
  return props!;
}

describe('organization page MembersTable canSuspend (BACKLOG-4170)', () => {
  beforeEach(() => { state.perms = { 'organizations.view': true }; state.asked = []; });

  it('users.suspend held: canSuspend is true, and the exact key is requested', async () => {
    state.perms['users.suspend'] = true;
    expect((await tableProps()).canSuspend).toBe(true);
    expect(state.asked).toContain('users.suspend');
  });

  it('every other key held but not users.suspend: canSuspend is false', async () => {
    for (const k of KEYS) if (k !== 'users.suspend') state.perms[k] = true;
    const props = await tableProps();
    expect(props.canSuspend).toBe(false);
    expect(props.canEditRole).toBe(true);
  });
});
