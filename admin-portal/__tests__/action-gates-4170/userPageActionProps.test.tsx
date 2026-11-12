/**
 * BACKLOG-4170 PR4: the user detail page hands each action card the result of its own permission key.
 * One key held at a time: exactly one action flag turns on, and each key is requested by its exact name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const U = '00000000-0000-0000-0000-000000000000';
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('lucide-react', () => ({ ArrowLeft: () => null }));
function UserProfileCardStub() { return null; }
function LicenseCardStub() { return null; }
function BillingCreditsCardStub() { return null; }
vi.mock('@/app/dashboard/users/[id]/components/UserProfileCard', () => ({ UserProfileCard: UserProfileCardStub }));
vi.mock('@/app/dashboard/users/[id]/components/LicenseCard', () => ({ LicenseCard: LicenseCardStub }));
vi.mock('@/app/dashboard/users/[id]/components/BillingCreditsCard', () => ({ BillingCreditsCard: BillingCreditsCardStub }));
vi.mock('@/app/dashboard/users/[id]/components/DevicesTable', () => ({ DevicesTable: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/AuditLogTable', () => ({ AuditLogTable: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/SentryErrorsCard', () => ({ SentryErrorsCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/PlanCard', () => ({ PlanCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/OrganizationCard', () => ({ OrganizationCard: () => null }));
vi.mock('@/lib/billing-queries', () => ({ getBillingData: async () => ({ errorMessages: [], creditBalance: 0 }) }));
vi.mock('@/lib/suspension-queries', () => ({ getSuspensionStatus: async () => null }));
vi.mock('@/lib/planLines', () => ({
  validPlanLineIds: (ids: string[]) => ids,
  readPlanLinesWithOrgs: async () => ({ lines: {}, brokerageOrgIds: {} }),
}));
vi.mock('@/lib/user-detail-access', () => ({ canViewUserDetail: async () => true }));

const state: { perms: Record<string, boolean>; asked: string[] } = { perms: {}, asked: [] };

function table(name: string) {
  const rows: Record<string, unknown> = {
    internal_roles: { role_id: 'r1' },
    users: { id: U, email: 'a@example.test', display_name: 'A', avatar_url: null, oauth_provider: 'google', status: 'active', subscription_tier: 'free', created_at: '2026-01-01', last_login_at: null },
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
    if (fn === 'has_permission') {
      const key = args.required_permission as string;
      state.asked.push(key);
      return { data: state.perms[key] === true };
    }
    return { data: [] };
  },
};
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({ user: { id: 'u1' }, supabase: session }),
  createServiceClient: () => session,
}));

function find(node: ReactNode, type: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const n of node) { const r = find(n, type); if (r) return r; } return undefined; }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type) return el.props;
  return el.props ? find(el.props.children as ReactNode, type) : undefined;
}

async function flags() {
  const { default: Page } = await import('@/app/dashboard/users/[id]/page');
  const tree = (await Page({ params: Promise.resolve({ id: U }) })) as ReactNode;
  const profile = find(tree, UserProfileCardStub);
  const license = find(tree, LicenseCardStub);
  const billing = find(tree, BillingCreditsCardStub);
  expect(profile && license && billing).toBeTruthy();
  return {
    canSuspend: profile!.canSuspend,
    canEdit: license!.canEdit,
    canAdjustCredits: billing!.canAdjustCredits,
    canReinstate: billing!.canReinstate,
  };
}

const ALL_OFF = { canSuspend: false, canEdit: false, canAdjustCredits: false, canReinstate: false };
const CASES: [string, keyof typeof ALL_OFF][] = [
  ['users.suspend', 'canSuspend'],
  ['licenses.edit', 'canEdit'],
  ['credits.adjust', 'canAdjustCredits'],
  ['billing.suspend', 'canReinstate'],
];

describe('user page action flags (BACKLOG-4170)', () => {
  beforeEach(() => { state.perms = {}; state.asked = []; });

  it('no key held: every action flag is false', async () => {
    expect(await flags()).toEqual(ALL_OFF);
  });

  it.each(CASES)('only %s held: only %s is true', async (key, flag) => {
    state.perms = { [key]: true };
    expect(await flags()).toEqual({ ...ALL_OFF, [flag]: true });
  });

  it('each action key is requested by its exact name', async () => {
    await flags();
    for (const [key] of CASES) expect(state.asked).toContain(key);
  });
});
