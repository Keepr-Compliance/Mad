/**
 * @jest-environment node
 *
 * BACKLOG-3854 — "Manage billing": openBrokerageBillingPortal (lib/actions/billingPortal.ts) and the
 * Keepr-owned portal configuration (lib/billing/portalConfig.ts). plan-3855 §6 C4/C5/C8 and SR
 * 6bada226 change 9.
 *
 * C4 (W6): the Stripe customer is the SESSION organization's row in this mode; FormData or an extra
 *     organization argument is ignored. No customer row -> zero Stripe calls (9e).
 * C5 (W5): sessions.create gets the ensured configuration; the configuration is asserted on every
 *     flag (swept) plus active and livemode; a mismatch -> no session. Create is idempotent per
 *     mode; duplicates -> the oldest.
 * C8: impersonation -> no session. IT admin / draft -> no Stripe call.
 * W9: success redirects to the https session url (redirect outside the try/catch).
 *
 * Configuration object shape transcribed from the TEST spike (2026-10-21, API 2025-02-24.acacia,
 * pm_comments 4de762c2 on BACKLOG-3854): features.{customer_update, invoice_history,
 * payment_method_update, subscription_cancel, subscription_pause, subscription_update}.enabled,
 * login_page.enabled, active, livemode, metadata. Ids [EDITED].
 */

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORG_A = '00000000-0000-0000-0000-000000000000';
const ORG_B = '00000000-0000-0000-0000-00000000000b'; // pii-allow-uuid: invented, not from any live row; must differ from ORG_A, and the nil UUID is the only other accepted value
const CUS_A = 'cus_FIXTUREorgA0000';

const mockBlocked = jest.fn(async () => null as { error: string } | null);
let mockAccess: Obj | null;
let mockDeal: Obj | null;
let mockMirror: Obj | null;
const mockReads: Array<[string, Obj]> = [];
const mockRedirect = jest.fn((url: string) => {
  throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;${url}` });
});

function config(over: Obj = {}, features: Obj = {}): Obj {
  return {
    id: 'bpc_FIXTURE0001',
    object: 'billing_portal.configuration',
    active: true,
    created: 1793458800,
    is_default: false,
    livemode: false,
    login_page: { enabled: false, url: null },
    metadata: { keepr: 'brokerage-portal-v1' },
    features: {
      customer_update: { enabled: false, allowed_updates: [] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: false, mode: 'at_period_end', proration_behavior: 'none' },
      subscription_pause: { enabled: false },
      subscription_update: { enabled: false, default_allowed_updates: [], proration_behavior: 'none' },
      ...features,
    },
    ...over,
  };
}

const mockStripe = {
  billingPortal: {
    configurations: { list: jest.fn(), create: jest.fn() },
    sessions: { create: jest.fn() },
  },
};
const stripeCalls = () =>
  mockStripe.billingPortal.configurations.list.mock.calls.length +
  mockStripe.billingPortal.configurations.create.mock.calls.length +
  mockStripe.billingPortal.sessions.create.mock.calls.length;

jest.mock('next/navigation', () => ({ redirect: (u: string) => mockRedirect(u) }));
jest.mock('next/headers', () => ({ headers: async () => new Map([['host', 'portal.example.test']]) }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlocked() }));
jest.mock('@/lib/billing/flag', () => ({ billingEnabled: () => true }));
jest.mock('@/lib/billing/mode', () => ({ currentStripeMode: () => 'test' }));
jest.mock('@/lib/stripe', () => ({ getStripe: () => mockStripe }));
jest.mock('@/lib/auth/orgSuspension', () => ({ readOrgBillingSuspendedFor: async () => false }));
jest.mock('@/lib/auth/portalAccess', () => ({
  getPortalAccess: async () => mockAccess && { supabase: {}, user: { id: 'U' }, suspended: false, orgSuspended: false, billingContact: false, ...mockAccess },
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const filters: Obj = {};
      const q: Obj = {
        select: () => q,
        eq: (k: string, v: unknown) => ((filters[k] = v), q),
        maybeSingle: async () => {
          mockReads.push([table, { ...filters }]);
          if (filters.organization_id === ORG_A) return { data: table === 'org_deals' ? mockDeal : mockMirror, error: null };
          if (filters.organization_id === ORG_B) return { data: table === 'org_deals' ? { status: 'active' } : { stripe_customer_id: 'cus_FIXTUREorgB0000' }, error: null };
          return { data: null, error: null };
        },
      };
      return q;
    },
  }),
}));

import { openBrokerageBillingPortal } from '@/lib/actions/billingPortal';
import { assertPortalConfiguration, ensurePortalConfiguration, portalConfigCreateParams } from '@/lib/billing/portalConfig';

const full = (role: string) => ({ access: { kind: 'full', role, organizationId: ORG_A } });
async function run(...args: unknown[]): Promise<string> {
  try {
    await (openBrokerageBillingPortal as unknown as (...a: unknown[]) => Promise<void>)(...args);
  } catch (e) {
    const d = (e as { digest?: string }).digest ?? '';
    if (d.startsWith('NEXT_REDIRECT;')) return d.slice('NEXT_REDIRECT;'.length);
    throw e;
  }
  throw new Error('test: no redirect');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReads.length = 0;
  process.env.NEXT_PUBLIC_APP_URL = 'https://portal.example.test';
  mockAccess = full('admin');
  mockDeal = { status: 'active' };
  mockMirror = { stripe_customer_id: CUS_A };
  mockStripe.billingPortal.configurations.list.mockResolvedValue({ object: 'list', data: [config()], has_more: false });
  mockStripe.billingPortal.configurations.create.mockResolvedValue(config({ id: 'bpc_FIXTURENEW' }));
  mockStripe.billingPortal.sessions.create.mockResolvedValue({ id: 'bps_FIXTURE', url: 'https://billing.stripe.test/p/session/FIXTURE' });
});

describe('openBrokerageBillingPortal', () => {
  it('W9: success -> redirect to the https session url; customer = the session org, configuration = Keepr\'s, return to Billing', async () => {
    expect(await run()).toBe('https://billing.stripe.test/p/session/FIXTURE');
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: CUS_A,
      configuration: 'bpc_FIXTURE0001',
      return_url: 'https://portal.example.test/dashboard/billing',
    });
  });

  it('Broker and the billing-only login are allowed too', async () => {
    mockAccess = full('broker');
    expect(await run()).toMatch(/^https:\/\/billing\.stripe\.test/);
    mockAccess = { access: { kind: 'floor', via: 'unlicensed', role: 'agent', organizationId: ORG_A }, billingContact: true };
    expect(await run()).toMatch(/^https:\/\/billing\.stripe\.test/);
  });

  it('C4 / W6: FormData and an extra organization argument naming another brokerage are ignored', async () => {
    const fd = new FormData();
    fd.set('organizationId', ORG_B);
    expect(await run(fd, ORG_B)).toMatch(/^https:\/\//);
    expect(mockStripe.billingPortal.sessions.create.mock.calls[0][0].customer).toBe(CUS_A);
    expect(mockReads.every(([, f]) => f.organization_id === ORG_A)).toBe(true);
  });

  it('9e: no customer row -> back to Billing unavailable, zero Stripe calls', async () => {
    mockMirror = null;
    expect(await run()).toBe('/dashboard/billing?portal=unavailable');
    expect(stripeCalls()).toBe(0);
  });

  it('IT admin, an agent, a draft deal, impersonation -> unavailable, zero Stripe calls', async () => {
    mockAccess = full('it_admin');
    expect(await run()).toBe('/dashboard/billing?portal=unavailable');
    mockAccess = { access: { kind: 'floor', via: 'brokerage', role: 'agent', organizationId: ORG_A } };
    expect(await run()).toBe('/dashboard/billing?portal=unavailable');
    mockAccess = full('admin');
    mockDeal = { status: 'draft' };
    expect(await run()).toBe('/dashboard/billing?portal=unavailable');
    mockDeal = { status: 'active' };
    mockBlocked.mockResolvedValueOnce({ error: 'blocked' });
    expect(await run()).toBe('/dashboard/billing?portal=unavailable');
    expect(stripeCalls()).toBe(0);
  });

  it('a non-https session url -> unavailable', async () => {
    mockStripe.billingPortal.sessions.create.mockResolvedValue({ id: 'bps_X', url: 'http://billing.stripe.test/x' });
    expect(await run()).toBe('/dashboard/billing?portal=unavailable');
  });

  it('a Stripe error -> unavailable (no throw to the page)', async () => {
    mockStripe.billingPortal.sessions.create.mockRejectedValue(new Error('down'));
    expect(await run()).toBe('/dashboard/billing?portal=unavailable');
  });

  it.each([
    ['subscription_update on', {}, { subscription_update: { enabled: true } }],
    ['subscription_cancel on', {}, { subscription_cancel: { enabled: true } }],
    ['subscription_pause on', {}, { subscription_pause: { enabled: true } }],
    ['customer_update on', {}, { customer_update: { enabled: true } }],
    ['invoice_history off', {}, { invoice_history: { enabled: false } }],
    ['payment_method_update off', {}, { payment_method_update: { enabled: false } }],
    ['login_page on', { login_page: { enabled: true, url: 'https://billing.stripe.test/p/login/x' } }, {}],
    ['inactive', { active: false }, {}],
    ['live config in test mode', { livemode: true }, {}],
  ])('C5 / W5: a Keepr configuration with %s -> no session', async (_n, over, features) => {
    mockStripe.billingPortal.configurations.list.mockResolvedValue({ object: 'list', data: [config(over, features)], has_more: false });
    expect(await run()).toBe('/dashboard/billing?portal=unavailable');
    expect(mockStripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('the account default (no Keepr tag) is never used: a Keepr one is created with the idempotency key', async () => {
    mockStripe.billingPortal.configurations.list.mockResolvedValue({
      object: 'list',
      data: [config({ id: 'bpc_DEFAULT', is_default: true, metadata: {} })],
      has_more: false,
    });
    expect(await run()).toMatch(/^https:\/\//);
    expect(mockStripe.billingPortal.configurations.create).toHaveBeenCalledWith(portalConfigCreateParams(), {
      idempotencyKey: 'brokerage:portal-config:test:v1',
    });
    expect(mockStripe.billingPortal.sessions.create.mock.calls[0][0].configuration).toBe('bpc_FIXTURENEW');
  });
});

describe('portal configuration', () => {
  it('the create parameters allow invoices and the payment method only, no login page', () => {
    const p = portalConfigCreateParams();
    expect(p.features).toEqual({
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_update: { enabled: false },
      subscription_cancel: { enabled: false },
      customer_update: { enabled: false },
    });
    expect(p.login_page).toEqual({ enabled: false });
    expect(p.metadata).toEqual({ keepr: 'brokerage-portal-v1' });
  });

  it('the spike shape passes; absent subscription_pause counts as off', () => {
    expect(() => assertPortalConfiguration(config() as never, 'test')).not.toThrow();
    const c = config();
    delete c.features.subscription_pause;
    expect(() => assertPortalConfiguration(c as never, 'test')).not.toThrow();
  });

  it('pages the list and, with two Keepr configurations, uses the oldest', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockStripe.billingPortal.configurations.list
      .mockResolvedValueOnce({ object: 'list', data: [config({ id: 'bpc_NEWER', created: 1793500000 })], has_more: true })
      .mockResolvedValueOnce({ object: 'list', data: [config({ id: 'bpc_OLDER', created: 1793400000 })], has_more: false });
    await expect(ensurePortalConfiguration(mockStripe as never, 'test')).resolves.toBe('bpc_OLDER');
    expect(mockStripe.billingPortal.configurations.list.mock.calls[1][0]).toMatchObject({ active: true, starting_after: 'bpc_NEWER' });
    expect(mockStripe.billingPortal.configurations.create).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
