/**
 * BACKLOG-4007 PR-2 fix-up (SR 10f705da, founder 52d946a2): while brokerage billing is dark.
 *  - Organization page: the Invite button is told to show only where the Billing card shows
 *    (shouldShowBillingCard), for every cell of billing_live x is_test x billing.view.
 *  - Organizations list: Create Organization gets billingLive from
 *    admin_get_brokerage_billing_live; a failed read counts as off.
 * Drives the real server pages with a fake Supabase client (same harness as
 * billing-card-3853/cardVisibility.test.tsx) and reads the props handed to the children.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@keepr/design-system', () => ({ Card: () => null, PageHeader: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/MembersTable', () => ({ MembersTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PendingInvitationsTable', () => ({ PendingInvitationsTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PlanAssignment', () => ({ PlanAssignment: () => null }));
function BrokerageBillingCardStub() { return null; }
vi.mock('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard', () => ({ BrokerageBillingCard: BrokerageBillingCardStub }));
function OrgInviteButtonStub() { return null; }
vi.mock('@/app/dashboard/organizations/[id]/components/OrgInviteButton', () => ({ OrgInviteButton: OrgInviteButtonStub }));
function OrganizationsTableStub() { return null; }
vi.mock('@/app/dashboard/organizations/components/OrganizationsTable', () => ({ OrganizationsTable: OrganizationsTableStub }));

// admin_get_org_billing shape for an org with no deal (as in cardVisibility.test.tsx).
const BILLING = {
  billing_live: false, is_test: false, list_price_cents: 2499, cap_pct: 20,
  can_manage: true, can_approve: false, can_suspend: true, assigned_seats: 0,
  deal: null, seat_line: null, stripe: null, account_managers: [], log: [],
};

type RpcReply = { data: unknown; error: unknown };
const state: {
  perms: Record<string, boolean>;
  billing: Record<string, unknown>;
  liveReply: RpcReply;
  rpcCalls: string[];
} = { perms: {}, billing: BILLING, liveReply: { data: false, error: null }, rpcCalls: [] };

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
        if (fn === 'has_permission') return { data: state.perms[args.required_permission as string] ?? false, error: null };
        if (fn === 'admin_get_org_billing') return { data: state.billing, error: null };
        if (fn === 'admin_get_brokerage_billing_live') return state.liveReply;
        if (fn === 'admin_list_organizations') return { data: { success: true, organizations: [] }, error: null };
        return { data: null, error: null };
      },
    },
  }),
}));

function findProps(node: ReactNode, type: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const p = findProps(n, type); if (p) return p; }
    return null;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type) return el.props ?? {};
  return el.props ? findProps(el.props.children as ReactNode, type) : null;
}

async function orgPage() {
  const { default: Page } = await import('@/app/dashboard/organizations/[id]/page');
  const tree = (await Page({ params: Promise.resolve({ id: 'o1' }) })) as ReactNode;
  return { card: findProps(tree, BrokerageBillingCardStub) !== null, invite: findProps(tree, OrgInviteButtonStub) };
}

describe('org page: Invite follows the Billing card', () => {
  beforeEach(() => {
    state.perms = { 'organizations.view': true, 'billing.view': true, 'users.edit': true };
    state.billing = { ...BILLING };
    state.rpcCalls = [];
  });

  const cells: Array<{ name: string; live: boolean; test: boolean; view: boolean; card: boolean }> = [
    { name: 'billing dark, not a test org', live: false, test: false, view: true, card: false },
    { name: 'billing dark, test org', live: false, test: true, view: true, card: true },
    { name: 'billing live, not a test org', live: true, test: false, view: true, card: true },
    { name: 'billing live, test org', live: true, test: true, view: true, card: true },
    { name: 'no billing.view (billing not read), test org', live: false, test: true, view: false, card: false },
    { name: 'no billing.view (billing not read), billing live', live: true, test: false, view: false, card: false },
  ];
  for (const c of cells) {
    it(`${c.name}: card ${c.card ? 'shown' : 'hidden'}, showBillingCard=${c.card}`, async () => {
      state.billing = { ...BILLING, billing_live: c.live, is_test: c.test };
      if (!c.view) state.perms = { 'organizations.view': true, 'users.edit': true };
      const r = await orgPage();
      expect(r.card).toBe(c.card);
      expect(r.invite, 'the Invite element is in the header').not.toBeNull();
      expect(r.invite!.showBillingCard).toBe(c.card);
    });
  }
});

async function listPage() {
  const { default: Page } = await import('@/app/dashboard/organizations/page');
  const tree = (await Page()) as ReactNode;
  return findProps(tree, OrganizationsTableStub);
}

describe('organizations list: billingLive for Create Organization', () => {
  beforeEach(() => {
    state.perms = { 'organizations.view': true, 'organizations.edit': true };
    state.rpcCalls = [];
  });
  it('switch off -> billingLive false (Max Seats asked)', async () => {
    state.liveReply = { data: false, error: null };
    const p = await listPage();
    expect(p!.billingLive).toBe(false);
    expect(state.rpcCalls, 'the switch was read (non-vacuous)').toContain('admin_get_brokerage_billing_live');
  });
  it('switch on -> billingLive true (Max Seats hidden)', async () => {
    state.liveReply = { data: true, error: null };
    expect((await listPage())!.billingLive).toBe(true);
  });
  it('read fails (function not deployed on this environment) -> billingLive false', async () => {
    state.liveReply = { data: null, error: { message: 'Could not find the function public.admin_get_brokerage_billing_live' } };
    expect((await listPage())!.billingLive).toBe(false);
  });
  it('no organizations.edit -> switch not read, billingLive false', async () => {
    state.perms = { 'organizations.view': true };
    state.liveReply = { data: true, error: null };
    expect((await listPage())!.billingLive).toBe(false);
    expect(state.rpcCalls).not.toContain('admin_get_brokerage_billing_live');
  });
});
