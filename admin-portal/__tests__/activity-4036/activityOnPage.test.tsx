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
const state: { perms: Record<string, boolean>; activity: unknown; activityError: unknown; calls: Array<[string, unknown]> } = { perms: {}, activity: ROWS, activityError: null, calls: [] };

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
        if (fn === 'admin_get_org_activity') return { data: state.activity, error: state.activityError };
        return { data: null };
      },
    },
  }),
}));

function findProps(node: ReactNode): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findProps(n);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === OrgActivityCardStub) return el.props;
  return el.props ? findProps(el.props.children as ReactNode) : undefined;
}

async function renderedProps(): Promise<Record<string, unknown> | undefined> {
  const { default: Page } = await import('@/app/dashboard/organizations/[id]/page');
  return findProps((await Page({ params: Promise.resolve({ id: 'o1' }) })) as ReactNode);
}

async function rendered(): Promise<unknown> {
  return (await renderedProps())?.rows;
}

describe('Activity on the organization page (BACKLOG-4036)', () => {
  beforeEach(() => {
    state.perms = { 'organizations.view': true };
    state.activity = ROWS;
    state.activityError = null;
    state.calls = [];
  });

  it('renders the card with the reader rows without billing.view', async () => {
    expect(await rendered()).toEqual(ROWS);
    expect(state.calls).toContainEqual(['admin_get_org_activity', { p_org: 'o1' }]);
  });

  it('does not flag a failure when the reader succeeds', async () => {
    expect((await renderedProps())?.failed).toBe(false);
  });

  it('tells the card the reader failed (error, not an empty history)', async () => {
    state.activity = null;
    state.activityError = { message: 'boom' };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const props = await renderedProps();
    expect(props?.rows).toEqual([]);
    expect(props?.failed).toBe(true);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
