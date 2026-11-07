/**
 * BACKLOG-4145 PR 2: reads that move off the caller's session client.
 *
 * - settings + plans/[id]: the service client is created only AFTER the page permission check
 *   passes; a denied caller never reaches it.
 * - users/[id]: users.view OR support_can_view_requester (migration 20261108150000) opens the
 *   page; neither -> notFound, and no service client is created.
 *
 * redirect/notFound are mocked to THROW so a denied page stops where Next would stop it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const log: string[] = [];
const perms: Record<string, boolean> = {};
const rpcAnswers: Record<string, unknown> = {};
const rpcErrors: Record<string, boolean> = {};

class Stop extends Error {}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => { log.push(`redirect:${to}`); throw new Stop(`redirect ${to}`); },
  notFound: () => { log.push('notFound'); throw new Stop('notFound'); },
}));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@keepr/design-system', () => ({ Card: () => null, PageHeader: () => null }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

function chain(tag: string, table: string) {
  const rows: Record<string, unknown> = {
    internal_roles: { role_id: 'r1' },
    plans: { id: 'p1', name: 'Plan', tier: 'team', is_active: true, created_at: '2026-01-01', updated_at: '2026-01-01' },
    users: { id: 'target', email: 'invented@example.test' },
  };
  // internal_roles: .single() is the caller's own-role check; without it, the settings list.
  let single = false;
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'in', 'limit', 'not', 'is']) c[m] = () => c;
  c.single = () => { single = true; return c; };
  c.then = (res: (v: unknown) => unknown) => {
    log.push(`${tag}.from:${table}`);
    const data = table === 'internal_roles' && !single ? [] : rows[table] ?? [];
    return Promise.resolve({ data, error: null }).then(res);
  };
  return c;
}

function client(tag: string) {
  return {
    from: (t: string) => chain(tag, t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      log.push(`${tag}.rpc:${fn}`);
      if (fn === 'has_permission') return { data: perms[args.required_permission as string] === true, error: null };
      if (fn === 'has_any_permission') {
        const keys = args.permission_keys as string[];
        return { data: keys.some((k) => perms[k] === true), error: null };
      }
      if (rpcErrors[fn]) return { data: null, error: { message: 'invented error' } };
      return { data: rpcAnswers[fn] ?? null, error: null };
    },
    auth: { getUser: async () => ({ data: { user: { id: 'caller' } } }) },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({ user: { id: 'caller' }, supabase: client('session') }),
  createClient: async () => client('session'),
  createServiceClient: () => { log.push('service.create'); return client('service'); },
}));

// settings page children
vi.mock('@/app/dashboard/settings/components/SettingsManager', () => ({ SettingsManager: () => null }));
// plans page children
vi.mock('@/app/dashboard/plans/components/FeatureToggleList', () => ({ FeatureToggleList: () => null }));
vi.mock('@/app/dashboard/plans/components/DeletePlanButton', () => ({ DeletePlanButton: () => null }));
vi.mock('@/app/dashboard/plans/components/PlanStatusToggle', () => ({ PlanStatusToggle: () => null }));
vi.mock('@/app/dashboard/plans/components/PlanTierEditor', () => ({ PlanTierEditor: () => null }));
// users/[id] page children and service helpers
vi.mock('@/app/dashboard/users/[id]/components/UserProfileCard', () => ({ UserProfileCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/OrganizationCard', () => ({ OrganizationCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/LicenseCard', () => ({ LicenseCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/PlanCard', () => ({ PlanCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/DevicesTable', () => ({ DevicesTable: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/AuditLogTable', () => ({ AuditLogTable: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/BillingCreditsCard', () => ({ BillingCreditsCard: () => null }));
vi.mock('@/app/dashboard/users/[id]/components/SentryErrorsCard', () => ({ SentryErrorsCard: () => null }));
vi.mock('@/lib/billing-queries', () => ({
  getBillingData: async () => { log.push('service.billing'); return { errorMessages: [], creditBalance: 0 }; },
}));
vi.mock('@/lib/suspension-queries', () => ({ getSuspensionStatus: async () => null }));
vi.mock('@/lib/planLines', () => ({
  validPlanLineIds: () => null,
  readPlanLinesWithOrgs: async () => ({ lines: {}, brokerageOrgIds: {} }),
}));

async function run(fn: () => Promise<unknown>): Promise<'rendered' | 'stopped'> {
  try { await fn(); return 'rendered'; } catch (e) { if (e instanceof Stop) return 'stopped'; throw e; }
}

const idx = (entry: string) => log.indexOf(entry);

beforeEach(() => {
  log.length = 0;
  for (const k of Object.keys(perms)) delete perms[k];
  for (const k of Object.keys(rpcAnswers)) delete rpcAnswers[k];
  for (const k of Object.keys(rpcErrors)) delete rpcErrors[k];
});

describe('settings page (BACKLOG-4145)', () => {
  const render = async () => {
    const { default: Page } = await import('@/app/dashboard/settings/page');
    return run(() => Page());
  };

  it('allowed: internal users are read through the service client, created after the permission check', async () => {
    perms['internal_users.view'] = true;
    expect(await render()).toBe('rendered');
    expect(idx('service.from:internal_roles')).toBeGreaterThan(-1);
    expect(idx('service.create')).toBeGreaterThan(idx('session.rpc:has_any_permission'));
    expect(idx('session.rpc:has_any_permission')).toBeGreaterThan(-1);
  });

  it('denied: redirected and the service client is never created', async () => {
    expect(await render()).toBe('stopped');
    expect(log).toContain('redirect:/dashboard?error=insufficient_permissions');
    expect(log).not.toContain('service.create');
  });

  it('audit.view only: internal users stay on the own-session read, no service client', async () => {
    perms['audit.view'] = true;
    expect(await render()).toBe('rendered');
    expect(log).not.toContain('service.create');
    expect(log).not.toContain('service.from:internal_roles');
    expect(log.filter((e) => e === 'session.from:internal_roles').length).toBe(2);
  });

  it('roles.view only: same, no service client', async () => {
    perms['roles.view'] = true;
    expect(await render()).toBe('rendered');
    expect(log).not.toContain('service.create');
  });
});

describe('plans/[id] page (BACKLOG-4145)', () => {
  const render = async () => {
    const { default: Page } = await import('@/app/dashboard/plans/[id]/page');
    return run(() => Page({ params: Promise.resolve({ id: 'p1' }) }));
  };

  it('allowed: the organizations embed is read through the service client, created after plans.view', async () => {
    perms['plans.view'] = true;
    expect(await render()).toBe('rendered');
    expect(idx('service.from:organization_plans')).toBeGreaterThan(-1);
    expect(log).not.toContain('session.from:organization_plans');
    const planCheck = log.findIndex((e) => e === 'session.rpc:has_permission');
    expect(planCheck).toBeGreaterThan(-1);
    expect(idx('service.create')).toBeGreaterThan(planCheck);
  });

  it('denied: redirected and the service client is never created', async () => {
    expect(await render()).toBe('stopped');
    expect(log).toContain('redirect:/dashboard?error=insufficient_permissions');
    expect(log).not.toContain('service.create');
  });
});

describe('users/[id] page (BACKLOG-4145)', () => {
  const render = async () => {
    const { default: Page } = await import('@/app/dashboard/users/[id]/page');
    return run(() => Page({ params: Promise.resolve({ id: 'target' }) }));
  };

  it('users.view opens it without asking the requester rule', async () => {
    perms['users.view'] = true;
    expect(await render()).toBe('rendered');
    expect(log).not.toContain('session.rpc:support_can_view_requester');
  });

  it('no users.view, but the caller can see this user as a ticket requester: opens it', async () => {
    rpcAnswers.support_can_view_requester = true;
    expect(await render()).toBe('rendered');
    expect(log).toContain('session.rpc:support_can_view_requester');
    expect(log).not.toContain('notFound');
    expect(idx('service.create')).toBeGreaterThan(idx('session.rpc:support_can_view_requester'));
  });

  it('requester check answers null: notFound, no service client', async () => {
    expect(await render()).toBe('stopped');
    expect(log).toContain('session.rpc:support_can_view_requester');
    expect(log).toContain('notFound');
    expect(log).not.toContain('service.create');
  });

  it('requester check errors (even with a truthy payload absent): notFound, no service client', async () => {
    rpcErrors.support_can_view_requester = true;
    expect(await render()).toBe('stopped');
    expect(log).toContain('notFound');
    expect(log).not.toContain('service.create');
  });

  it('neither rule: notFound, and no service client or billing read', async () => {
    rpcAnswers.support_can_view_requester = false;
    expect(await render()).toBe('stopped');
    expect(log).toContain('notFound');
    expect(log).not.toContain('service.create');
    expect(log).not.toContain('service.billing');
  });
});
