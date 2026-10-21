/**
 * BACKLOG-4022: the organization page's Invite button also sits in the Members section.
 *  - Members heading row (members > 0) and the empty state (0 members) carry the same
 *    OrgInviteButton as the header, with identical props.
 *  - Every instance follows the same rules: hidden where the Billing card is hidden, disabled
 *    with the reason until a deal exists, users.edit gate.
 *  - "No members yet." appears only at 0 members; where the button is hidden it stands alone.
 * Renders the real page and the real OrgInviteButton to static markup over a fake Supabase client
 * (same harness as org-plan-4021/orgPage.test.tsx).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@keepr/design-system', () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => <button disabled={disabled}>{children}</button>,
}));
vi.mock('@/app/dashboard/users/components/InviteUserDialog', () => ({ InviteUserDialog: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/MembersTable', () => ({ MembersTable: () => <div>MEMBERS-TABLE</div> }));
vi.mock('@/app/dashboard/organizations/[id]/components/PendingInvitationsTable', () => ({ PendingInvitationsTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PlanAssignment', () => ({ PlanAssignment: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard', () => ({ BrokerageBillingCard: () => null }));
// BACKLOG-4036: the Activity card has its own tests (activity-4036)
vi.mock('@/app/dashboard/organizations/[id]/components/OrgActivityCard', () => ({ OrgActivityCard: () => null }));

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

async function renderPage() {
  const { default: Page } = await import('@/app/dashboard/organizations/[id]/page');
  const { OrgInviteButton } = await import('@/app/dashboard/organizations/[id]/components/OrgInviteButton');
  const tree = (await Page({ params: Promise.resolve({ id: 'o1' }) })) as ReactNode;
  const invites: Record<string, unknown>[] = [];
  const walk = (n: ReactNode): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const el = n as { type?: unknown; props?: Record<string, unknown> };
    if (el.type === OrgInviteButton) invites.push(el.props ?? {});
    if (el.props) walk(el.props.children as ReactNode);
  };
  walk(tree);
  const html = renderToStaticMarkup(tree as React.ReactElement);
  const count = (s: string) => html.split(s).length - 1;
  return {
    invites,
    html,
    buttons: count('>Invite</button>'),
    disabled: count('<button disabled="">Invite</button>'),
    reasons: count('Set up billing first.'),
    emptyState: count('No members yet.'),
  };
}

describe('org page Members section Invite (BACKLOG-4022)', () => {
  beforeEach(() => {
    state.perms = { 'organizations.view': true, 'billing.view': true, 'users.edit': true };
    state.isTest = true;
    state.deal = DEAL;
    state.members = 2;
    state.pending = 0;
  });

  it('members > 0: header + Members heading row, same props, enabled, no empty state', async () => {
    const r = await renderPage();
    expect(r.invites).toHaveLength(2);
    expect(r.invites[1]).toEqual(r.invites[0]);
    expect(r.buttons).toBe(2);
    expect(r.disabled).toBe(0);
    expect(r.emptyState).toBe(0);
    expect(r.html).toContain('MEMBERS-TABLE');
    expect(r.html).toMatch(/Members \(2\)<\/h2><div[^>]*><button[^>]*>Invite<\/button>/);
  });

  it('0 members: header + empty state carry the button; first invite defaults to Admin on both', async () => {
    state.members = 0;
    const r = await renderPage();
    expect(r.invites).toHaveLength(2);
    expect(r.invites.every((p) => p.isFirstInvite === true)).toBe(true);
    expect(r.invites[1]).toEqual(r.invites[0]);
    expect(r.buttons).toBe(2);
    expect(r.emptyState).toBe(1);
    expect(r.html).not.toContain('No members found');
    expect(r.html).not.toContain('MEMBERS-TABLE');
    expect(r.html).toMatch(/No members yet\.<\/p><div[^>]*><div[^>]*><button[^>]*>Invite<\/button>/);
  });

  it('0 members but an open invitation: not a first invite', async () => {
    state.members = 0;
    state.pending = 1;
    const r = await renderPage();
    expect(r.invites.every((p) => p.isFirstInvite === false)).toBe(true);
  });

  it('no deal: every instance is disabled and says why', async () => {
    state.deal = null;
    for (const members of [2, 0]) {
      state.members = members;
      const r = await renderPage();
      expect(r.buttons).toBe(2);
      expect(r.disabled).toBe(2);
      expect(r.reasons).toBe(2);
    }
  });

  it('billing card hidden: no Invite anywhere; empty state stands alone', async () => {
    state.isTest = false;
    state.members = 0;
    let r = await renderPage();
    expect(r.buttons).toBe(0);
    expect(r.emptyState).toBe(1);
    state.members = 2;
    r = await renderPage();
    expect(r.buttons).toBe(0);
    expect(r.html).toContain('MEMBERS-TABLE');
  });

  it('no users.edit: no Invite anywhere; empty state stands alone', async () => {
    state.perms = { 'organizations.view': true, 'billing.view': true };
    state.members = 0;
    const r = await renderPage();
    expect(r.buttons).toBe(0);
    expect(r.emptyState).toBe(1);
  });

  it('the empty state appears only at 0 members', async () => {
    for (const members of [1, 2, 5]) {
      state.members = members;
      expect((await renderPage()).emptyState).toBe(0);
    }
  });
});
