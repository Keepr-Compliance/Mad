/**
 * BACKLOG-3962 PR2: the organization page passes canRevoke to the Domains card from the
 * organizations.edit permission. Renders the real page over a fake Supabase client (same harness
 * as members-invite-4022/membersInvite.test.tsx) and reads the props the page gave the card.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@keepr/design-system', () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock('@/app/dashboard/users/components/InviteUserDialog', () => ({ InviteUserDialog: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/MembersTable', () => ({ MembersTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PendingInvitationsTable', () => ({ PendingInvitationsTable: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/PlanAssignment', () => ({ PlanAssignment: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard', () => ({ BrokerageBillingCard: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/OrgPeopleCard', () => ({ OrgPeopleCard: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/OrgInviteButton', () => ({ OrgInviteButton: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/OrgActivityCard', () => ({ OrgActivityCard: () => null }));
vi.mock('@/app/dashboard/organizations/[id]/components/DomainClaimsCard', () => ({ DomainClaimsCard: () => null }));

const state: { perms: Record<string, boolean> } = { perms: {} };

function table(name: string) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'single', 'not', 'is']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => {
    let data: unknown = null;
    if (name === 'internal_roles') data = { role_id: 'r1' };
    if (name === 'organizations') data = { id: 'o1', name: 'Org', slug: 'org', max_seats: 5, created_at: '2026-01-01', organization_plans: [] };
    if (name === 'organization_members') data = [];
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
        if (fn === 'admin_list_domain_claims') return { data: { success: true, claims: [] } };
        return { data: null };
      },
    },
  }),
}));

async function domainCardProps() {
  const { default: Page } = await import('@/app/dashboard/organizations/[id]/page');
  const { DomainClaimsCard } = await import('@/app/dashboard/organizations/[id]/components/DomainClaimsCard');
  const tree = (await Page({ params: Promise.resolve({ id: 'o1' }) })) as ReactNode;
  const found: Record<string, unknown>[] = [];
  const walk = (n: ReactNode): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const el = n as { type?: unknown; props?: Record<string, unknown> };
    if (el.type === DomainClaimsCard) found.push(el.props ?? {});
    if (el.props) walk(el.props.children as ReactNode);
  };
  walk(tree);
  return found;
}

describe('org page passes canRevoke to the Domains card (BACKLOG-3962)', () => {
  beforeEach(() => { state.perms = { 'organizations.view': true }; });

  it('organizations.edit false -> canRevoke=false', async () => {
    state.perms['organizations.edit'] = false;
    const cards = await domainCardProps();
    expect(cards).toHaveLength(1);
    expect(cards[0].canRevoke).toBe(false);
  });

  it('organizations.edit true -> canRevoke=true', async () => {
    state.perms['organizations.edit'] = true;
    const cards = await domainCardProps();
    expect(cards).toHaveLength(1);
    expect(cards[0].canRevoke).toBe(true);
  });
});
