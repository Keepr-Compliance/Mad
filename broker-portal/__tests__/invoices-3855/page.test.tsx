/**
 * /dashboard/billing with the brokerage's recent invoices — BACKLOG-3855 (plan C1, C2, C4, C7-C9;
 * SR C1, C3, C6).
 *
 * The REAL page, capabilities, set-up read, invoice reader, BillingPage and blocks run. Mocked:
 * getPortalAccess (who is signed in; shapes as lib/auth/portalAccess.ts returns them), the service
 * client (BillingDb: filters applied and recorded), Stripe (a recording stub serving p3853 TEST
 * captures), the session client's rpc (seats / plan end / suspension answers) and the two server
 * actions the buttons call.
 */

import type { PortalAccess } from '@keepr/shared';
import { BillingDb } from '../helpers/billingDb';

const mockGetPortalAccess = jest.fn();
let mockDb: BillingDb;
const mockSessionRpc = jest.fn();
const mockStripe = {
  invoicesList: jest.fn(),
  customersRetrieve: jest.fn(),
  clockRetrieve: jest.fn(),
};
jest.mock('@/lib/auth/portalAccess', () => ({ getPortalAccess: (...a: unknown[]) => mockGetPortalAccess(...a) }));
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: jest.fn(async () => null) }));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: jest.fn(() => ({ from: (t: string) => mockDb.from(t) })) }));
jest.mock('@/lib/stripe', () => ({
  getStripe: jest.fn(() => ({
    invoices: { list: (...a: unknown[]) => mockStripe.invoicesList(...a) },
    customers: { retrieve: (...a: unknown[]) => mockStripe.customersRetrieve(...a) },
    testHelpers: { testClocks: { retrieve: (...a: unknown[]) => mockStripe.clockRetrieve(...a) } },
  })),
}));
jest.mock('@/lib/billing/mode', () => ({ currentStripeMode: jest.fn(() => 'test') }));
jest.mock('@/lib/actions/billingPortal', () => ({ openBrokerageBillingPortal: jest.fn() }));
jest.mock('@/lib/actions/seats', () => ({ addSeats: jest.fn() }));
jest.mock('@/lib/actions/agentPlan', () => ({
  startAgentCheckout: jest.fn(),
  endAgentPlanAtPeriodEnd: jest.fn(),
  keepAgentPlan: jest.fn(),
  confirmAgentCheckout: jest.fn(),
  endAgentPlanNow: jest.fn(),
}));
jest.mock('@/lib/actions/billingCard', () => ({ startCardUpdate: jest.fn(), confirmCardUpdate: jest.fn(), updateBillingContact: jest.fn() }));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
jest.mock('@/lib/actions/autoRenew', () => ({ setAutoRenew: jest.fn() }));
jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: jest.fn() }),
}));

import { render, within } from '@testing-library/react';
import BillingRoute from '@/app/dashboard/billing/page';
import { CUSTOMER_A, P3853_CLOCK, P3853_CUSTOMER, STRIPE_ID, listOf, openInvoices, paidInvoice, pdfUrlFor, payUrlFor } from './fixtures';

const ORG_A = '00000000-0000-4000-8000-000000000000'; // pii-allow-uuid: nil-style invented fixture id
const ORG_B = '00000000-0000-4000-8000-000000385502'; // pii-allow-uuid: invented fixture id
const CUSTOMER_B = 'cus_EDITED_3855_orgB';
const CUSTOMER_A_LIVE = 'cus_EDITED_3855_live';
const T = 1805122801; // [EDITED] clock: every captured open invoice is past due

const full = (role: string): PortalAccess => ({ kind: 'full', role, organizationId: ORG_A }) as PortalAccess;
const BILLING_ONLY: PortalAccess = { kind: 'floor', via: 'unlicensed', role: 'agent', organizationId: ORG_A } as PortalAccess;

function signIn(access: PortalAccess, opts: { orgSuspended?: boolean; billingContact?: boolean } = {}): void {
  mockGetPortalAccess.mockResolvedValue({
    supabase: { rpc: (...a: unknown[]) => mockSessionRpc(...a) },
    user: { id: 'user-3855', email: null },
    access,
    suspended: false,
    orgSuspended: opts.orgSuspended ?? false,
    billingContact: opts.billingContact ?? false,
  });
  mockSessionRpc.mockImplementation(async (fn: string) =>
    fn === 'org_billing_suspended' ? { data: opts.orgSuspended ?? false, error: null } : { data: null, error: null }
  );
}

/** Deal + customer rows. `extra` adds rows (another org, the other mode). */
function deal(status: string, opts: { reason?: string | null; extra?: Record<string, unknown>[] } = {}): void {
  mockDb = new BillingDb({
    org_deals: [{ organization_id: ORG_A, status, suspended_reason: opts.reason ?? null }],
    org_billing_stripe: [{ organization_id: ORG_A, stripe_mode: 'test', stripe_customer_id: CUSTOMER_A }, ...(opts.extra ?? [])],
    organizations: [{ id: ORG_A, name: 'Fixture Realty' }],
  });
}

function stripeServes(data = openInvoices()): void {
  mockStripe.customersRetrieve.mockResolvedValue(P3853_CUSTOMER);
  mockStripe.clockRetrieve.mockResolvedValue({ ...P3853_CLOCK, frozen_time: T }); // [EDITED] frozen_time
  mockStripe.invoicesList.mockResolvedValue(listOf(data));
}

/** invoices.list calls made by the new list read (no status filter). The 3853 Pay link always passes status:'open'. */
const listReads = () => mockStripe.invoicesList.mock.calls.filter(([p]) => !('status' in (p as object)));
const payLinkReads = () => mockStripe.invoicesList.mock.calls.filter(([p]) => (p as { status?: string }).status === 'open');

async function page() {
  const view = render(await BillingRoute({}));
  const c = view.container;
  return {
    c,
    text: c.textContent ?? '',
    rows: c.querySelectorAll('[data-org-invoice-row]'),
    viewAll: c.querySelectorAll('[data-billing-action="view_all_invoices"]'),
    downloads: c.querySelectorAll('[data-billing-action="download_invoice"]'),
    pays: c.querySelectorAll('[data-billing-action="pay_invoice"]'),
    manage: within(c).queryAllByRole('button', { name: 'Manage billing ↗' }),
    unmount: view.unmount,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  process.env.BILLING_ENABLED = 'true';
  stripeServes();
});
afterEach(() => jest.restoreAllMocks());

describe('Broker / Admin, billing set up', () => {
  it.each(['broker', 'admin'])('%s, active: five rows, Download + Pay, View all, Manage billing, help link', async (role) => {
    signIn(full(role));
    deal('active');
    const p = await page();
    expect(p.rows).toHaveLength(5);
    expect(p.downloads).toHaveLength(5);
    expect(p.pays).toHaveLength(5);
    expect(p.viewAll).toHaveLength(1);
    expect(p.manage).toHaveLength(1);
    expect(p.text).toContain('Overdue');
    expect(p.c.querySelector('a[href="/guides/invoices"]')?.textContent).toBe('Where do I find my invoices?');
    expect(listReads()).toEqual([[{ customer: CUSTOMER_A, limit: 10 }]]);
    p.unmount();
  });

  it('C4: no Stripe id in the text or in any attribute but href; hrefs are the expected placeholders', async () => {
    signIn(full('broker'));
    deal('active');
    const p = await page();
    expect(p.text).not.toMatch(STRIPE_ID);
    expect(p.c.innerHTML.replace(/href="[^"]*"/g, '')).not.toMatch(STRIPE_ID);
    const ids = openInvoices().map((i) => i.id as string);
    expect([...p.pays].map((a) => a.getAttribute('href'))).toEqual(ids.map(payUrlFor));
    expect([...p.downloads].map((a) => a.getAttribute('href'))).toEqual(ids.map(pdfUrlFor));
    p.unmount();
  });

  it('a paid row: Paid, $124.95, no Pay', async () => {
    signIn(full('admin'));
    deal('active');
    stripeServes([paidInvoice()]);
    const p = await page();
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].textContent).toContain('Paid');
    expect(p.rows[0].textContent).toContain('$124.95');
    expect(p.pays).toHaveLength(0);
    expect(p.downloads).toHaveLength(1);
    p.unmount();
  });

  it('no invoices yet -> the empty line, View all and Manage billing still there', async () => {
    signIn(full('broker'));
    deal('active');
    stripeServes([]);
    const p = await page();
    expect(p.text).toContain('No invoices yet.');
    expect(p.viewAll).toHaveLength(1);
    expect(p.manage).toHaveLength(1);
    p.unmount();
  });
});

describe('C1: IT admin — no invoice read, no rows', () => {
  it('active, set up: no Stripe call at all, no rows, no View all, no Download', async () => {
    signIn(full('it_admin'));
    deal('active');
    const p = await page();
    expect(mockStripe.invoicesList).not.toHaveBeenCalled();
    expect(mockStripe.customersRetrieve).not.toHaveBeenCalled();
    expect(p.rows).toHaveLength(0);
    expect(p.viewAll).toHaveLength(0);
    expect(p.downloads).toHaveLength(0);
    p.unmount();
  });

  it('suspended for non-payment, set up: only the banner Pay link reads invoices (status open), once', async () => {
    signIn(full('it_admin'), { orgSuspended: true });
    deal('suspended', { reason: 'non_payment' });
    const p = await page();
    expect(p.c.querySelector('[data-billing-action="pay_overdue_invoice"]')).not.toBeNull();
    expect(payLinkReads()).toHaveLength(1);
    expect(listReads()).toEqual([]);
    expect(mockStripe.invoicesList).toHaveBeenCalledTimes(1);
    expect(p.rows).toHaveLength(0);
    expect(p.viewAll).toHaveLength(0);
    expect(p.downloads).toHaveLength(0);
    p.unmount();
  });
});

describe('suspended brokerage: rows under the banner for the payers', () => {
  it('broker, non-payment: banner Pay + five rows with Pay; one list read beside the Pay-link read', async () => {
    signIn(full('broker'), { orgSuspended: true });
    deal('suspended', { reason: 'non_payment' });
    const p = await page();
    expect(p.c.querySelector('[data-billing-action="pay_overdue_invoice"]')).not.toBeNull();
    expect(p.rows).toHaveLength(5);
    expect(p.pays).toHaveLength(5);
    expect(payLinkReads()).toHaveLength(1);
    expect(listReads()).toHaveLength(1);
    p.unmount();
  });
});

describe('C2 / SR C1: the billing-only login', () => {
  it('before set-up (draft deal, customer exists): no money block, no Stripe call', async () => {
    signIn(BILLING_ONLY, { billingContact: true });
    deal('draft');
    const p = await page();
    expect(p.text).toContain('Managed by Keepr');
    expect(p.manage).toHaveLength(0);
    expect(p.viewAll).toHaveLength(0);
    expect(p.rows).toHaveLength(0);
    expect(mockStripe.invoicesList).not.toHaveBeenCalled();
    expect(mockStripe.customersRetrieve).not.toHaveBeenCalled();
    p.unmount();
  });
  it('set up: rows, View all, Manage billing', async () => {
    signIn(BILLING_ONLY, { billingContact: true });
    deal('active');
    const p = await page();
    expect(p.rows).toHaveLength(5);
    expect(p.viewAll).toHaveLength(1);
    expect(p.manage).toHaveLength(1);
    p.unmount();
  });
});

describe('C7: draft deal / not set up -> no invoice read', () => {
  it.each(['broker', 'admin'])('%s, draft deal with a customer: Managed by Keepr, no list read', async (role) => {
    signIn(full(role));
    deal('draft');
    const p = await page();
    expect(p.text).toContain('Managed by Keepr');
    expect(mockStripe.invoicesList).not.toHaveBeenCalled();
    expect(p.viewAll).toHaveLength(0);
    p.unmount();
  });
});

describe('C3: the caller organization, the current mode', () => {
  it('another org\'s customer and a live-mode customer of the same org exist: the list reads A\'s test customer, once', async () => {
    signIn(full('broker'));
    deal('active', {
      extra: [
        { organization_id: ORG_B, stripe_mode: 'test', stripe_customer_id: CUSTOMER_B },
        { organization_id: ORG_A, stripe_mode: 'live', stripe_customer_id: CUSTOMER_A_LIVE },
      ],
    });
    const p = await page();
    expect(listReads()).toEqual([[{ customer: CUSTOMER_A, limit: 10 }]]);
    expect(p.rows).toHaveLength(5);
    p.unmount();
  });
});

describe('C9 / SR C6: Stripe trouble never hides the controls', () => {
  it('Stripe hangs (active): renders inside the time limit with the unavailable line, View all and Manage billing', async () => {
    signIn(full('broker'));
    deal('active');
    mockStripe.invoicesList.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    const p = await page();
    const elapsed = Date.now() - started;
    expect(p.text).toContain('Your invoices are unavailable right now.');
    expect(p.viewAll).toHaveLength(1);
    expect(p.manage).toHaveLength(1);
    p.unmount();
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(4500);
  }, 15000);

  it('Stripe throws: unavailable line, View all and Manage billing', async () => {
    signIn(full('admin'));
    deal('active');
    mockStripe.invoicesList.mockRejectedValue(new Error('stripe down'));
    const p = await page();
    expect(p.text).toContain('Your invoices are unavailable right now.');
    expect(p.viewAll).toHaveLength(1);
    expect(p.manage).toHaveLength(1);
    p.unmount();
  });
});
