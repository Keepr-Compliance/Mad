/**
 * The billing-only login's Billing access, below middleware — BACKLOG-4007 PR-4 (C-A1).
 *
 *   - lib/auth/billingContact.ts: asks org_billing_contact_login ONLY for floor via 'unlicensed';
 *     a failed or thrown read is false (fail closed).
 *   - lib/auth/membership.ts mayOpenDashboardPath: the flag opens /dashboard/billing for that
 *     access only (an agent, a deactivated member, the personal owner gain nothing from it).
 *   - lib/billing/capabilities.ts: an organization page that pays and manages nothing.
 *   - app/dashboard/billing/page.tsx: the page is the gate; it admits the billing-only login,
 *     refuses every other unlicensed member, and shows the Pay button on a suspended brokerage.
 *
 * The RPC answer shape (a bare boolean) is the keepr-test read in
 * supabase/tests/backlog-4007-pr4/results-2026-10-20.txt (C_A1_*).
 */

import type { PortalAccess } from '@keepr/shared';

const mockGetPortalAccess = jest.fn();
const mockOrgDeal = { suspended_reason: 'non_payment' };
jest.mock('@/lib/auth/portalAccess', () => ({ getPortalAccess: (...a: unknown[]) => mockGetPortalAccess(...a) }));
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: jest.fn(async () => null) }));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: jest.fn(() => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) q[m] = jest.fn(() => q);
      q.maybeSingle = jest.fn(async () => ({ data: table === 'org_deals' ? mockOrgDeal : { name: 'Fixture Brokerage' }, error: null }));
      return q;
    },
  })),
}));
jest.mock('@/lib/stripe', () => ({ getStripe: jest.fn(() => ({})) }));
jest.mock('@/lib/billing/mode', () => ({ currentStripeMode: jest.fn(() => 'test') }));
jest.mock('@/lib/billing/orgPayLink', () => ({ oldestOverdueInvoiceUrl: jest.fn(async () => 'https://invoice.stripe.test/i/fixture') }));
jest.mock('@/components/billing/BillingPage', () => ({ BillingPage: function BillingPage() { return null; } }));
jest.mock('@/lib/billing/agentPlan', () => ({}));
jest.mock('@/lib/billing/personalBilling', () => ({}));
jest.mock('@/lib/supabase/server', () => ({ createClient: jest.fn() }));
class NotFound extends Error {}
class Redirect extends Error {
  constructor(public readonly to: string) {
    super('redirect');
  }
}
jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound();
  },
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));

import BillingRoute from '@/app/dashboard/billing/page';
import { BILLING_PATHS, mayOpenDashboardPath } from '@/lib/auth/membership';
import { readBillingContactLogin, mayBeBillingContact } from '@/lib/auth/billingContact';
import { billingCapabilities, billingNavVisible } from '@/lib/billing/capabilities';

const ORG = '00000000-0000-4000-8000-000000400701'; // pii-allow-uuid: invented fixture id
const UNLICENSED: PortalAccess = { kind: 'floor', via: 'unlicensed', role: 'agent', organizationId: ORG };
const AGENT: PortalAccess = { kind: 'floor', via: 'brokerage', role: 'agent', organizationId: ORG };
const DEACTIVATED: PortalAccess = { kind: 'floor', via: 'deactivated', role: 'agent', organizationId: ORG };
const OWNER: PortalAccess = { kind: 'floor', via: 'personal_owner', role: 'agent', organizationId: ORG };
const ADMIN: PortalAccess = { kind: 'full', role: 'admin', organizationId: ORG };

describe('readBillingContactLogin', () => {
  it.each<[string, PortalAccess]>([
    ['agent', AGENT],
    ['deactivated', DEACTIVATED],
    ['personal owner', OWNER],
    ['admin', ADMIN],
    ['unknown', { kind: 'unknown' }],
  ])('%s: never asked, false', async (_n, access) => {
    const rpc = jest.fn(async () => ({ data: true, error: null }));
    expect(await readBillingContactLogin({ rpc }, access)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(mayBeBillingContact(access)).toBe(false);
  });

  it('unlicensed: asks for its own brokerage and returns the answer', async () => {
    const rpc = jest.fn(async () => ({ data: true, error: null }));
    expect(await readBillingContactLogin({ rpc }, UNLICENSED)).toBe(true);
    expect(rpc).toHaveBeenCalledWith('org_billing_contact_login', { p_org: ORG });
    expect(await readBillingContactLogin({ rpc: jest.fn(async () => ({ data: false, error: null })) }, UNLICENSED)).toBe(false);
  });

  it('a failed or thrown read is false', async () => {
    expect(await readBillingContactLogin({ rpc: jest.fn(async () => ({ data: true, error: { code: '57014' } })) }, UNLICENSED)).toBe(false);
    const throws = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await readBillingContactLogin({ rpc: throws }, UNLICENSED)).toBe(false);
  });
});

describe('mayOpenDashboardPath with billingContact', () => {
  const paths = ['/dashboard/billing', '/dashboard/billing/x', '/dashboard/billingx', '/dashboard/users', '/dashboard/settings', '/dashboard/submissions', '/dashboard/checklists'];
  it('opens Billing (and its sub-paths) for the billing-only login only', () => {
    const open = paths.filter((p) => mayOpenDashboardPath(UNLICENSED, p, { billingContact: true }));
    expect(open).toEqual(['/dashboard/billing', '/dashboard/billing/x']);
    expect(BILLING_PATHS).toEqual(['/dashboard/billing']);
  });
  it.each<[string, PortalAccess]>([
    ['unlicensed without the flag', UNLICENSED],
    ['agent with the flag', AGENT],
    ['deactivated with the flag', DEACTIVATED],
  ])('%s: Billing stays closed', (_n, access) => {
    const flag = access === UNLICENSED ? {} : { billingContact: true };
    expect(mayOpenDashboardPath(access, '/dashboard/billing', flag)).toBe(false);
  });
});

describe('billingCapabilities for the billing-only login', () => {
  const base = { isImpersonating: false, enabled: true, agentPlan: 'none' as const, accountSuspended: false, orgBillingSetUp: false };
  it('organization page: sees the price, manages nothing, buys nothing', () => {
    const c = billingCapabilities({ ...base, access: UNLICENSED, billingContact: true });
    expect(c).toMatchObject({
      kind: 'organization',
      showPrice: true,
      canManageLicenses: false,
      canAddSeats: false,
      canPurchase: false,
      showManageUsersLink: false,
      primaryAction: null,
    });
    expect(billingCapabilities({ ...base, access: UNLICENSED, billingContact: true, orgBillingSetUp: true })?.blocks).toEqual([
      'plan',
      'seats',
      'manage_billing', // BACKLOG-3854: payment + invoices are Stripe's page
    ]);
  });
  it('null without the flag, for an agent, and while impersonating', () => {
    expect(billingCapabilities({ ...base, access: UNLICENSED })).toBeNull();
    expect(billingCapabilities({ ...base, access: AGENT, billingContact: true })).toBeNull();
    expect(billingCapabilities({ ...base, access: UNLICENSED, billingContact: true, isImpersonating: true })).toBeNull();
    expect(billingNavVisible({ access: UNLICENSED, isImpersonating: false, enabled: true, billingContact: true })).toBe(true);
    expect(billingNavVisible({ access: UNLICENSED, isImpersonating: false, enabled: true })).toBe(false);
  });
});

describe('/dashboard/billing page gate', () => {
  const OLD = process.env.BILLING_ENABLED;
  beforeEach(() => {
    process.env.BILLING_ENABLED = 'true';
    mockGetPortalAccess.mockReset();
  });
  afterAll(() => {
    if (OLD === undefined) delete process.env.BILLING_ENABLED;
    else process.env.BILLING_ENABLED = OLD;
  });

  function portal(access: PortalAccess, billingContact: boolean, orgSuspended: boolean) {
    const rpc = jest.fn(async (fn: string) => (fn === 'org_billing_suspended' ? { data: orgSuspended, error: null } : { data: null, error: { code: 'PGRST202' } }));
    mockGetPortalAccess.mockResolvedValue({
      supabase: { rpc },
      user: { id: 'u', email: 'payer@example.test' },
      access,
      suspended: false,
      orgSuspended: false,
      billingContact,
    });
    return rpc;
  }

  type El = { type: { name: string }; props: Record<string, unknown> };
  async function outcome(): Promise<'notFound' | El> {
    try {
      return (await BillingRoute({})) as unknown as El;
    } catch (e) {
      if (e instanceof NotFound) return 'notFound';
      throw e;
    }
  }

  it('another unlicensed member: 404', async () => {
    portal(UNLICENSED, false, false);
    expect(await outcome()).toBe('notFound');
  });

  it('the billing-only login: the organization page, read-only', async () => {
    portal(UNLICENSED, true, false);
    const el = await outcome();
    expect(el).not.toBe('notFound');
    const caps = (el as El).props.caps as { kind: string; canManageLicenses: boolean };
    expect(caps.kind).toBe('organization');
    expect(caps.canManageLicenses).toBe(false);
    expect((el as El).props.orgSuspension).toBeUndefined();
  });

  it('the billing-only login of a suspended brokerage: banner with the Pay link', async () => {
    const rpc = portal(UNLICENSED, true, true);
    const el = (await outcome()) as El;
    expect(rpc).toHaveBeenCalledWith('org_billing_suspended', { p_org: ORG });
    expect(el.props.orgSuspension).toMatchObject({
      reason: 'non_payment',
      role: 'billing_contact',
      payUrl: 'https://invoice.stripe.test/i/fixture',
    });
  });
});
