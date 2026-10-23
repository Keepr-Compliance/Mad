/**
 * BACKLOG-3853 PR-2A — the organization page renders the brokerage Billing card only for a
 * staff user with billing.view, and only while brokerage billing is switched on or the
 * organization is a test organization (SR R14 (c)). Drives the real page with a fake
 * Supabase client and looks for the card element in the returned tree.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@keepr/design-system', () => ({ Card: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/MembersTable', () => ({ MembersTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PendingInvitationsTable', () => ({ PendingInvitationsTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PlanAssignment', () => ({ PlanAssignment: () => null }));
function BrokerageBillingCardStub() { return null; }
vi.mock('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard', () => ({ BrokerageBillingCard: BrokerageBillingCardStub }));

// Shape returned by admin_get_org_billing (supabase/migrations/20261019030000_...), for an org with no deal.
const BILLING = {
  billing_live: false, is_test: false, list_price_cents: 2499, cap_pct: 20,
  can_manage: true, can_approve: false, can_suspend: true, assigned_seats: 0,
  deal: null, seat_line: null, stripe: null, account_managers: [], log: [],
};

const state: { perms: Record<string, boolean>; billing: Record<string, unknown>; rpcCalls: string[] } = {
  perms: {}, billing: BILLING, rpcCalls: [],
};

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
        state.rpcCalls.push(fn);
        if (fn === 'has_permission') return { data: state.perms[args.required_permission as string] ?? false };
        if (fn === 'admin_get_org_billing') return { data: state.billing };
        return { data: null };
      },
    },
  }),
}));

function findCard(node: ReactNode): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(findCard);
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === BrokerageBillingCardStub) return true;
  return el.props ? findCard(el.props.children as ReactNode) : false;
}

async function render(): Promise<boolean> {
  const { default: Page } = await import('@/app/dashboard/organizations/[id]/page');
  const tree = await Page({ params: Promise.resolve({ id: 'o1' }) });
  return findCard(tree as ReactNode);
}

describe('brokerage Billing card visibility (BACKLOG-3853 PR-2A)', () => {
  beforeEach(() => {
    state.perms = { 'organizations.view': true, 'billing.view': true };
    state.billing = { ...BILLING };
    state.rpcCalls = [];
  });

  it('is hidden while billing is off and the org is not a test org', async () => {
    expect(await render()).toBe(false);
    expect(state.rpcCalls, 'the billing read ran (non-vacuous)').toContain('admin_get_org_billing');
  });

  it('is shown for a test organization while billing is off', async () => {
    state.billing = { ...BILLING, is_test: true };
    expect(await render()).toBe(true);
  });

  it('is shown for any organization once billing is switched on', async () => {
    state.billing = { ...BILLING, billing_live: true };
    expect(await render()).toBe(true);
  });

  it('is hidden, and billing is not read, without billing.view', async () => {
    state.perms = { 'organizations.view': true };
    state.billing = { ...BILLING, is_test: true };
    expect(await render()).toBe(false);
    expect(state.rpcCalls).not.toContain('admin_get_org_billing');
  });
});
