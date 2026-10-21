/**
 * BACKLOG-3852 C4: the Plan card's price line reaches only staff with billing.view, is read through
 * the session client (never the service client), and only for a brokerage member.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ACTIVE } from '../onboarding-4007/fixtures';

const ORG = '00000000-0000-0000-0000-000000000000';
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('lucide-react', () => ({ ArrowLeft: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/UserProfileCard', () => ({ UserProfileCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/LicenseCard', () => ({ LicenseCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/DevicesTable', () => ({ DevicesTable: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/AuditLogTable', () => ({ AuditLogTable: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/BillingCreditsCard', () => ({ BillingCreditsCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/SentryErrorsCard', () => ({ SentryErrorsCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/OrganizationCard', () => ({ OrganizationCard: () => null }));
function PlanCardStub() { return null; }
vi.mock('@/app/dashboard/users/[id]/components/PlanCard', () => ({ PlanCard: PlanCardStub }));
vi.mock('@/lib/billing-queries', () => ({ getBillingData: async () => ({ errorMessages: [], creditBalance: 0 }) }));
vi.mock('@/lib/suspension-queries', () => ({ getSuspensionStatus: async () => null }));

const state: { kind: string; orgIds: Record<string, string>; billingView: boolean; sessionRpc: string[]; serviceRpc: string[] } = {
  kind: 'brokerage', orgIds: {}, billingView: true, sessionRpc: [], serviceRpc: [],
};
vi.mock('@/lib/planLines', () => ({
  validPlanLineIds: (ids: string[]) => ids,
  readPlanLinesWithOrgs: async (_s: unknown, ids: string[]) => ({
    lines: { [ids[0]]: { kind: state.kind, text: 'Team plan', test: false, warning: null } },
    brokerageOrgIds: state.orgIds,
  }),
}));

function table(name: string) {
  const rows: Record<string, unknown> = {
    internal_roles: { role_id: 'r1' },
    users: { id: 'u2', email: 'a@example.test', display_name: 'A', avatar_url: null, oauth_provider: 'google', status: 'active', subscription_tier: 'free', created_at: '2026-01-01', last_login_at: null },
    organization_members: [], licenses: [], audit_logs: [],
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
    state.sessionRpc.push(fn);
    if (fn === 'has_permission') return { data: args.required_permission === 'billing.view' ? state.billingView : true };
    if (fn === 'admin_get_org_billing') return { data: ACTIVE, error: null };
    return { data: [] };
  },
};
const service = { from: (n: string) => table(n), rpc: async (fn: string) => { state.serviceRpc.push(fn); return { data: ACTIVE, error: null }; } };
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({ user: { id: 'u1' }, supabase: session }),
  createServiceClient: () => service,
}));

function findAmount(node: ReactNode): string | null | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const n of node) { const r = findAmount(n); if (r !== undefined) return r; } return undefined; }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === PlanCardStub) return (el.props!.amount as string | null | undefined) ?? null;
  return el.props ? findAmount(el.props.children as ReactNode) : undefined;
}
async function amount() {
  const { default: Page } = await import('@/app/dashboard/users/[id]/page');
  return findAmount((await Page({ params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000001' }) })) as ReactNode);
}

describe('Plan card price line (BACKLOG-3852)', () => {
  beforeEach(() => { Object.assign(state, { kind: 'brokerage', orgIds: { '00000000-0000-0000-0000-000000000001': ORG }, billingView: true, sessionRpc: [], serviceRpc: [] }); });

  it('billing.view + brokerage member: shows the price line, read through the session client only', async () => {
    expect(await amount()).toBe('$24.99 per seat / month · next invoice Nov 19, 2026');
    expect(state.sessionRpc).toContain('admin_get_org_billing');
    expect(state.serviceRpc).not.toContain('admin_get_org_billing');
  });
  it('no billing.view: nothing new, and the billing read never runs', async () => {
    state.billingView = false;
    expect(await amount()).toBeNull();
    expect(state.sessionRpc).not.toContain('admin_get_org_billing');
    expect(state.serviceRpc).not.toContain('admin_get_org_billing');
  });
  it('not a brokerage member (no org id): nothing, no billing read', async () => {
    state.orgIds = {};
    expect(await amount()).toBeNull();
    expect(state.sessionRpc).not.toContain('admin_get_org_billing');
  });
  it('agent plan line: nothing, even with an org id', async () => {
    state.kind = 'agent_unlimited';
    expect(await amount()).toBeNull();
    expect(state.sessionRpc).not.toContain('admin_get_org_billing');
  });
});
