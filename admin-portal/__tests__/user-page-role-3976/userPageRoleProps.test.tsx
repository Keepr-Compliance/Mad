/**
 * BACKLOG-3976: the user detail page hands UserProfileCard is_personal per membership (from the
 * organization's personal_owner_user_id) and the Change Role flag from the users.edit permission.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const U = '00000000-0000-0000-0000-000000000000';
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('lucide-react', () => ({ ArrowLeft: () => null }));
function UserProfileCardStub() { return null; }
vi.mock('@/app/dashboard/users/[id]/components/UserProfileCard', () => ({ UserProfileCard: UserProfileCardStub }));
vi.mock('@/app/dashboard/users/[id]/components/LicenseCard', () => ({ LicenseCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/DevicesTable', () => ({ DevicesTable: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/AuditLogTable', () => ({ AuditLogTable: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/BillingCreditsCard', () => ({ BillingCreditsCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/SentryErrorsCard', () => ({ SentryErrorsCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/PlanCard', () => ({ PlanCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/OrganizationCard', () => ({ OrganizationCard: () => null }));
vi.mock('@/lib/billing-queries', () => ({ getBillingData: async () => ({ errorMessages: [], creditBalance: 0 }) }));
vi.mock('@/lib/suspension-queries', () => ({ getSuspensionStatus: async () => null }));
vi.mock('@/lib/planLines', () => ({
  validPlanLineIds: (ids: string[]) => ids,
  readPlanLinesWithOrgs: async () => ({ lines: {}, brokerageOrgIds: {} }),
}));

// Row shapes follow the page's organization_members select:
// organization_id, role, joined_at, organizations(name, personal_owner_user_id, organization_plans(...)).
const MEMBERS = [
  { organization_id: 'org-personal', role: 'admin', joined_at: '2026-01-02', organizations: { name: 'Personal org', personal_owner_user_id: U, organization_plans: [] } },
  { organization_id: 'org-team', role: 'agent', joined_at: '2026-01-03', organizations: { name: 'Team org', personal_owner_user_id: null, organization_plans: [] } },
];
const state: { perms: Record<string, boolean> } = { perms: {} };

function table(name: string) {
  const rows: Record<string, unknown> = {
    internal_roles: { role_id: 'r1' },
    users: { id: U, email: 'a@example.test', display_name: 'A', avatar_url: null, oauth_provider: 'google', status: 'active', subscription_tier: 'free', created_at: '2026-01-01', last_login_at: null },
    organization_members: MEMBERS, licenses: [], audit_logs: [],
  };
  const result = { data: rows[name] ?? null, error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'single', 'limit']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
  return chain;
}
const session = {
  from: (n: string) => table(n),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'has_permission') return { data: state.perms[args.required_permission as string] ?? false };
    return { data: [] };
  },
};
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({ user: { id: 'u1' }, supabase: session }),
  createServiceClient: () => session,
}));

type Props = { memberships: { organization_id: string; is_personal: boolean }[]; canEditRole: boolean };
function findCard(node: ReactNode): Props | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const n of node) { const r = findCard(n); if (r) return r; } return undefined; }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === UserProfileCardStub) return el.props as unknown as Props;
  return el.props ? findCard(el.props.children as ReactNode) : undefined;
}
async function cardProps() {
  const { default: Page } = await import('@/app/dashboard/users/[id]/page');
  const props = findCard((await Page({ params: Promise.resolve({ id: U }) })) as ReactNode);
  expect(props).toBeDefined();
  return props as Props;
}

describe('User page UserProfileCard props (BACKLOG-3976)', () => {
  beforeEach(() => { state.perms = {}; });

  it('is_personal is true only for a membership whose org has personal_owner_user_id', async () => {
    const { memberships } = await cardProps();
    expect(memberships.map((m) => [m.organization_id, m.is_personal])).toEqual([
      ['org-personal', true],
      ['org-team', false],
    ]);
  });
  it('canEditRole is true with users.edit even when users.view is not held', async () => {
    state.perms = { 'users.edit': true, 'users.view': false };
    expect((await cardProps()).canEditRole).toBe(true);
  });
  it('canEditRole is false without users.edit even when users.view is held', async () => {
    state.perms = { 'users.edit': false, 'users.view': true };
    expect((await cardProps()).canEditRole).toBe(false);
  });
});
