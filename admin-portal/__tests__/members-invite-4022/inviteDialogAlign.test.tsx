// @vitest-environment jsdom
/**
 * BACKLOG-4022 follow-up: the Invite dialog opened from the Members empty state must not sit
 * under a `text-center` ancestor (the dialog renders inline, so it inherits text-align).
 * Renders the real page, real OrgInviteButton and real InviteUserDialog in jsdom.
 * jsdom applies no Tailwind CSS, so the check walks ancestor class lists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@/lib/actions/inviteUser', () => ({ inviteUser: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'is', 'in', 'limit']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
    return { from: () => chain, rpc: async () => ({ data: null, error: null }) };
  },
}));
vi.mock('@/app/dashboard/organizations/[id]/components/MembersTable', () => ({ MembersTable: () => <div>MEMBERS-TABLE</div> }));
vi.mock('@/app/dashboard/organizations/[id]/components/PendingInvitationsTable', () => ({ PendingInvitationsTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PlanAssignment', () => ({ PlanAssignment: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard', () => ({ BrokerageBillingCard: () => null }));

const DEAL = { id: 'd1' };
const state: {
  perms: Record<string, boolean>;
  isTest: boolean;
  deal: unknown;
  members: number;
  pending: number;
} = { perms: {}, isTest: true, deal: DEAL, members: 0, pending: 0 };

function billing() {
  return {
    billing_live: false, is_test: state.isTest, list_price_cents: 2499, cap_pct: 20,
    can_manage: true, can_approve: false, can_suspend: true, assigned_seats: 0,
    deal: state.deal, seat_line: null, stripe: null, account_managers: [], log: [],
  };
}

function table(name: string) {
  let pendingQuery = false;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'single', 'not']) chain[m] = () => chain;
  chain.is = () => { pendingQuery = true; return chain; };
  chain.then = (res: (v: unknown) => unknown) => {
    let data: unknown = null;
    if (name === 'internal_roles') data = { role_id: 'r1' };
    if (name === 'organizations') data = { id: 'o1', name: 'Org', slug: 'org', max_seats: 5, created_at: '2026-01-01', organization_plans: [] };
    if (name === 'organization_members') {
      data = pendingQuery
        ? Array.from({ length: state.pending }, (_, i) => ({ id: `p${i}`, invited_email: `p${i}@example.test`, role: 'agent', license_status: null, invited_at: '2026-01-01', invitation_expires_at: '2026-02-01' }))
        : Array.from({ length: state.members }, (_, i) => ({ user_id: `u${i}`, role: 'agent', license_status: null, joined_at: '2026-01-01', users: { id: `u${i}`, email: `m${i}@example.test`, display_name: `M${i}`, status: 'active', suspended_at: null } }));
    }
    return Promise.resolve({ data, error: null }).then(res);
  };
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'u1' },
    supabase: {
      from: (n: string) => table(n),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'has_permission') return { data: state.perms[args.required_permission as string] ?? false };
        if (fn === 'admin_get_org_billing') return { data: billing() };
        return { data: null };
      },
    },
  }),
}));

afterEach(cleanup);

function centeredAncestor(el: Element): string | null {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.classList.contains('text-center')) return n.className;
  }
  return null;
}

async function mountPage(members: number) {
  state.perms = { 'organizations.view': true, 'billing.view': true, 'users.edit': true };
  state.members = members;
  const { default: Page } = await import('@/app/dashboard/organizations/[id]/page');
  render((await Page({ params: Promise.resolve({ id: 'o1' }) })) as ReactNode);
}

describe('Invite dialog alignment (BACKLOG-4022)', () => {
  it('empty state: dialog labels have no text-center ancestor; the empty-state text stays centered', async () => {
    await mountPage(0);
    const buttons = screen.getAllByRole('button', { name: 'Invite' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]); // the empty-state button
    const label = await screen.findByText('Email Address');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(centeredAncestor(label)).toBeNull();
    expect(centeredAncestor(screen.getByRole('dialog'))).toBeNull();
    expect(centeredAncestor(screen.getByText('No members yet.'))).not.toBeNull();
  });

  it.each([['header', 0], ['Members heading', 1]])('%s Invite button (members > 0 case uses heading): dialog has no text-center ancestor', async (_n, idx) => {
    await mountPage(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Invite' })[idx]);
    await screen.findByRole('dialog');
    expect(centeredAncestor(screen.getByRole('dialog'))).toBeNull();
  });
});
