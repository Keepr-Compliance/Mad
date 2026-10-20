/**
 * BACKLOG-4021: the user detail page lists each organization membership with the organization's
 * plan, reading the nested organizations(organization_plans(...)) embed as an object (PostgREST,
 * UNIQUE (organization_id)) or as an array.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('lucide-react', () => ({ ArrowLeft: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/UserProfileCard', () => ({ UserProfileCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/LicenseCard', () => ({ LicenseCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/PlanCard', () => ({ PlanCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/DevicesTable', () => ({ DevicesTable: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/AuditLogTable', () => ({ AuditLogTable: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/BillingCreditsCard', () => ({ BillingCreditsCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/SentryErrorsCard', () => ({ SentryErrorsCard: () => null }));
function OrgCardStub() { return null; }
vi.mock('@/app/dashboard/users/[id]/components/OrganizationCard', () => ({ OrganizationCard: OrgCardStub }));
vi.mock('@/lib/billing-queries', () => ({ getBillingData: async () => ({ errorMessages: [], creditBalance: 0 }) }));
vi.mock('@/lib/suspension-queries', () => ({ getSuspensionStatus: async () => null }));
vi.mock('@/lib/planLines', () => ({ readPlanLines: async () => ({}), validPlanLineIds: () => null }));

const PLAN_ROW = { plan_id: 'p1', plans: { id: 'p1', name: 'Invented Team Plan', tier: 'team' } };
const state: { embed: unknown } = { embed: null };

function table(name: string) {
  const rows: Record<string, unknown> = {
    internal_roles: { role_id: 'r1' },
    users: { id: 'u2', email: 'a@example.test', display_name: 'A', avatar_url: null, oauth_provider: 'google', status: 'active', subscription_tier: 'free', created_at: '2026-01-01', last_login_at: null },
    organization_members: [{ organization_id: 'o1', role: 'agent', joined_at: '2026-01-01', organizations: { name: 'Org', organization_plans: state.embed } }],
    licenses: [], audit_logs: [],
  };
  const result = { data: rows[name] ?? null, error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'single', 'limit']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
  return chain;
}
const client = {
  from: (n: string) => table(n),
  rpc: async (fn: string) => ({ data: fn === 'admin_list_user_devices' ? [] : true }),
};
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({ user: { id: 'u1' }, supabase: client }),
  createServiceClient: () => client,
}));

type Membership = { plan_id: string | null; plan_name: string | null; plan_tier: string | null };
function find(node: ReactNode): Membership[] | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const n of node) { const r = find(n); if (r) return r; } return null; }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === OrgCardStub) return el.props!.memberships as Membership[];
  return el.props ? find(el.props.children as ReactNode) : null;
}
async function memberships() {
  const { default: Page } = await import('@/app/dashboard/users/[id]/page');
  return find((await Page({ params: Promise.resolve({ id: 'u2' }) })) as ReactNode)!;
}

describe('user page org plan (BACKLOG-4021)', () => {
  beforeEach(() => { state.embed = null; });
  it('object embed', async () => {
    state.embed = PLAN_ROW;
    const [m] = await memberships();
    expect([m.plan_id, m.plan_name, m.plan_tier]).toEqual(['p1', 'Invented Team Plan', 'team']);
  });
  it('array embed', async () => {
    state.embed = [PLAN_ROW];
    const [m] = await memberships();
    expect([m.plan_id, m.plan_name, m.plan_tier]).toEqual(['p1', 'Invented Team Plan', 'team']);
  });
  it('null embed', async () => {
    state.embed = null;
    const [m] = await memberships();
    expect([m.plan_id, m.plan_name]).toEqual([null, null]);
  });
});
