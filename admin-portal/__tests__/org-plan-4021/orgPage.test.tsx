/**
 * BACKLOG-4021: the organization page shows the plan name in the header and hands it to the
 * "Set up billing" card, whether the organization_plans embed arrives as an object (PostgREST,
 * UNIQUE (organization_id)) or as an array; "None" only when there is no plan.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@keepr/design-system', () => ({ Card: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/MembersTable', () => ({ MembersTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PendingInvitationsTable', () => ({ PendingInvitationsTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PlanAssignment', () => ({ PlanAssignment: () => null }));
function BillingCardStub() { return null; }
vi.mock('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard', () => ({ BrokerageBillingCard: BillingCardStub }));

const BILLING = {
  billing_live: false, is_test: true, list_price_cents: 2499, cap_pct: 20,
  can_manage: true, can_approve: false, can_suspend: true, assigned_seats: 0,
  deal: null, seat_line: null, stripe: null, account_managers: [], log: [],
};
const PLAN_ROW = { plan_id: 'p1', plans: { id: 'p1', name: 'Invented Team Plan', tier: 'team' } };
const state: { embed: unknown } = { embed: null };

function table(name: string) {
  const rows: Record<string, unknown> = {
    internal_roles: { role_id: 'r1' },
    organizations: { id: 'o1', name: 'Org', slug: 'org', max_seats: 5, created_at: '2026-01-01', organization_plans: state.embed },
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
      rpc: async (fn: string) => {
        if (fn === 'has_permission') return { data: true };
        if (fn === 'admin_get_org_billing') return { data: BILLING };
        return { data: null };
      },
    },
  }),
}));

function walk(node: ReactNode, texts: string[], cardProps: { planName?: string }[]): void {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
  if (Array.isArray(node)) { node.forEach((n) => walk(n, texts, cardProps)); return; }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === BillingCardStub) cardProps.push(el.props as { planName?: string });
  if (el.props) walk(el.props.children as ReactNode, texts, cardProps);
}

async function render() {
  const { default: Page } = await import('@/app/dashboard/organizations/[id]/page');
  const tree = await Page({ params: Promise.resolve({ id: 'o1' }) });
  const texts: string[] = [];
  const cards: { planName?: string }[] = [];
  walk(tree as ReactNode, texts, cards);
  return { texts, cards };
}

describe('organization page plan name (BACKLOG-4021)', () => {
  beforeEach(() => { state.embed = null; });

  it('object embed: header and billing card show the plan', async () => {
    state.embed = PLAN_ROW;
    const { texts, cards } = await render();
    expect(texts).toContain('Invented Team Plan');
    expect(cards[0].planName).toBe('Invented Team Plan');
  });
  it('array embed: same result', async () => {
    state.embed = [PLAN_ROW];
    const { texts, cards } = await render();
    expect(texts).toContain('Invented Team Plan');
    expect(cards[0].planName).toBe('Invented Team Plan');
  });
  it('null embed: None', async () => {
    state.embed = null;
    const { texts, cards } = await render();
    expect(texts).toContain('None');
    expect(cards[0].planName).toBe('None');
  });
});
