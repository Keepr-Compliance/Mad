/**
 * BACKLOG-4036: the organization page reads admin_get_org_activity and hands the rows to the
 * Activity card, for every organization (not only behind the Billing card's gate).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@keepr/design-system', () => ({ Card: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/MembersTable', () => ({ MembersTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PendingInvitationsTable', () => ({ PendingInvitationsTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PlanAssignment', () => ({ PlanAssignment: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard', () => ({ BrokerageBillingCard: () => null }));
function OrgActivityCardStub() { return null; }
vi.mock('@/app/dashboard/organizations/[id]/components/OrgActivityCard', () => ({ OrgActivityCard: OrgActivityCardStub }));

const ROWS = [{
  action: 'member_invited',
  detail: { role: 'agent' },
  actor_name: 'Pat Doe',
  created_at: '2026-10-21T16:39:22+00:00',
  subject_name: 'Sam Roe',
  actor_is_staff: false,
  actor_is_subject: false,
}];
const state: { perms: Record<string, boolean>; activity: unknown; calls: Array<[string, unknown]> } = { perms: {}, activity: ROWS, calls: [] };

function table(name: string) {
  const rows: Record<string, unknown> = {
    internal_roles: { role_id: 'r1' },
    organizations: { id: 'o1', name: 'Org', slug: 'org', max_seats: 5, created_at: '2026-01-01', organization_plans: [] },
    organization_members: [],
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
        state.calls.push([fn, args]);
        if (fn === 'has_permission') return { data: state.perms[args.required_permission as string] ?? false };
        if (fn === 'admin_get_org_activity') return { data: state.activity, error: null };
        return { data: null };
      },
    },
  }),
}));

function findRows(node: ReactNode): unknown {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRows(n);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === OrgActivityCardStub) return el.props?.rows;
  return el.props ? findRows(el.props.children as ReactNode) : undefined;
}

async function rendered(): Promise<unknown> {
  const { default: Page } = await import('@/app/dashboard/organizations/[id]/page');
  return findRows((await Page({ params: Promise.resolve({ id: 'o1' }) })) as ReactNode);
}

describe('Activity on the organization page (BACKLOG-4036)', () => {
  beforeEach(() => {
    state.perms = { 'organizations.view': true };
    state.activity = ROWS;
    state.calls = [];
  });

  it('renders the card with the reader rows without billing.view', async () => {
    expect(await rendered()).toEqual(ROWS);
    expect(state.calls).toContainEqual(['admin_get_org_activity', { p_org: 'o1' }]);
  });

  it('renders an empty card when the reader fails', async () => {
    state.activity = null;
    expect(await rendered()).toEqual([]);
  });
});
