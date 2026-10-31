/**
 * lib/billing/orgInvoices.ts — BACKLOG-3855 (plan C3-C6, C9, C10; SR C3-C5).
 *
 * The service client is BillingDb (filters applied and recorded), Stripe is a recording stub
 * serving p3853 TEST captures. "now" is the test clock's frozen_time [EDITED] per case.
 */

import fs from 'fs';
import path from 'path';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BillingDb } from '../helpers/billingDb';
import { recentOrgInvoices, ORG_INVOICES_LIMIT, type OrgInvoiceRow } from '@/lib/billing/orgInvoices';
import { CUSTOMER_A, P3853_CLOCK, P3853_CUSTOMER, STRIPE_ID, listOf, openInvoices, paidInvoice, pdfUrlFor, payUrlFor } from './fixtures';

const ORG_A = '00000000-0000-4000-8000-000000000000'; // pii-allow-uuid: nil-style invented fixture id
const ORG_B = '00000000-0000-4000-8000-000000385502'; // pii-allow-uuid: invented fixture id
const CUSTOMER_B = 'cus_EDITED_3855_orgB';
const CUSTOMER_A_LIVE = 'cus_EDITED_3855_live';

const invoicesList = jest.fn();
const customersRetrieve = jest.fn();
const clockRetrieve = jest.fn();
const stripe = {
  invoices: { list: (...a: unknown[]) => invoicesList(...a) },
  customers: { retrieve: (...a: unknown[]) => customersRetrieve(...a) },
  testHelpers: { testClocks: { retrieve: (...a: unknown[]) => clockRetrieve(...a) } },
} as unknown as Stripe;

let db: BillingDb;
const service = () => ({ from: db.from }) as unknown as SupabaseClient;

function seed(frozen: number, data: Stripe.Invoice[]): void {
  customersRetrieve.mockResolvedValue(P3853_CUSTOMER);
  clockRetrieve.mockResolvedValue({ ...P3853_CLOCK, frozen_time: frozen }); // [EDITED] frozen_time
  invoicesList.mockResolvedValue(listOf(data));
}

const read = (organizationId = ORG_A, mode: 'test' | 'live' = 'test') =>
  recentOrgInvoices({ service: service(), stripe, mode, organizationId });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  db = new BillingDb({
    org_billing_stripe: [
      { organization_id: ORG_A, stripe_mode: 'test', stripe_customer_id: CUSTOMER_A },
      { organization_id: ORG_B, stripe_mode: 'test', stripe_customer_id: CUSTOMER_B },
      { organization_id: ORG_A, stripe_mode: 'live', stripe_customer_id: CUSTOMER_A_LIVE },
    ],
  });
});
afterEach(() => jest.restoreAllMocks());

const [I5, I4, I3, I2, I1] = openInvoices(); // newest first
const T = 1805122801; // [EDITED] clock: one second after A9SLAZ3T-0005's due date

describe('C4: plain rows, no Stripe ids', () => {
  it('each row has exactly these keys; no Stripe id outside the two links', async () => {
    seed(T, openInvoices());
    const rows = (await read()) as OrgInvoiceRow[];
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['amountCents', 'created', 'currency', 'number', 'payUrl', 'pdfUrl', 'status']);
      const { pdfUrl: _p, payUrl: _u, ...rest } = row;
      expect(JSON.stringify(rest)).not.toMatch(STRIPE_ID);
    }
    // the links are compared by equality (the placeholder embeds the invoice id)
    expect(rows.map((r) => r.payUrl)).toEqual([I5, I4, I3, I2, I1].map((i) => payUrlFor(i.id as string)));
    expect(rows.map((r) => r.pdfUrl)).toEqual([I5, I4, I3, I2, I1].map((i) => pdfUrlFor(i.id as string)));
    expect(rows.map((r) => r.number)).toEqual(['A9SLAZ3T-0005', 'A9SLAZ3T-0004', 'A9SLAZ3T-0003', 'A9SLAZ3T-0002', 'A9SLAZ3T-0001']);
  });
});

describe('C3: the caller organization and the current mode only', () => {
  it('org A, test mode -> invoices.list gets exactly A\'s test-mode customer', async () => {
    seed(T, openInvoices());
    await read(ORG_A, 'test');
    expect(invoicesList).toHaveBeenCalledTimes(1);
    expect(invoicesList).toHaveBeenCalledWith({ customer: CUSTOMER_A, limit: 10 });
    expect(customersRetrieve).toHaveBeenCalledWith(CUSTOMER_A);
  });
  it('org B -> B\'s customer', async () => {
    seed(T, openInvoices());
    await read(ORG_B, 'test');
    expect(invoicesList.mock.calls).toEqual([[{ customer: CUSTOMER_B, limit: 10 }]]);
  });
  it('org A, live mode -> the live customer, never the test one', async () => {
    seed(T, openInvoices());
    await read(ORG_A, 'live');
    expect(invoicesList.mock.calls).toEqual([[{ customer: CUSTOMER_A_LIVE, limit: 10 }]]);
  });
  it('no customer row -> [] and no Stripe call', async () => {
    seed(T, openInvoices());
    expect(await read('00000000-0000-4000-8000-000000385509')).toEqual([]); // pii-allow-uuid: invented fixture id
    expect(invoicesList).not.toHaveBeenCalled();
    expect(customersRetrieve).not.toHaveBeenCalled();
  });
  it('the customer read fails -> null, no Stripe call', async () => {
    seed(T, openInvoices());
    db.failNext['org_billing_stripe.select'] = { code: 'PGRST000', message: 'fixture' };
    expect(await read()).toBeNull();
    expect(invoicesList).not.toHaveBeenCalled();
  });
});

describe('C5: status, amount, date, Pay — boundary sweep on the clock', () => {
  const byNumber = (rows: OrgInvoiceRow[] | null, n: string) => (rows ?? []).find((r) => r.number === n) as OrgInvoiceRow;

  it('open: due_date = now-1 Overdue, = now Due, = now+1 Due; each with Pay', async () => {
    const now = I3.due_date as number; // [EDITED] clock exactly at A9SLAZ3T-0003's due date
    seed(now, [
      { ...I4, due_date: now + 1 }, // [EDITED] due_date
      I3, // due_date == now
      { ...I2, due_date: now - 1 }, // [EDITED] due_date
    ]);
    const rows = await read();
    expect(byNumber(rows, 'A9SLAZ3T-0004')).toMatchObject({ status: 'due', payUrl: payUrlFor(I4.id as string) });
    expect(byNumber(rows, 'A9SLAZ3T-0003')).toMatchObject({ status: 'due', payUrl: payUrlFor(I3.id as string) });
    expect(byNumber(rows, 'A9SLAZ3T-0002')).toMatchObject({ status: 'overdue', payUrl: payUrlFor(I2.id as string) });
  });

  it('paid and void past their due date read Paid / Void, never Overdue, and offer no Pay', async () => {
    const paid = paidInvoice(); // the same invoice as A9SLAZ3T-0001, after payment
    const voided = { ...I2, status: 'void' as const }; // [EDITED] status flip; amount_remaining left as captured
    seed(T, [voided, paid]);
    expect((paid.due_date as number) < T).toBe(true);
    const rows = await read();
    expect(byNumber(rows, 'A9SLAZ3T-0002')).toMatchObject({ status: 'void', payUrl: null });
    expect(byNumber(rows, 'A9SLAZ3T-0001')).toMatchObject({ status: 'paid', payUrl: null });
  });

  it('paid row: amount is what the invoice asked for (amount_due), date is created', async () => {
    const paid = paidInvoice();
    expect(paid.amount_due).toBe(12495);
    expect(paid.amount_remaining).toBe(0);
    expect(paid.created).not.toBe(paid.due_date);
    seed(T, [paid]);
    expect(await read()).toEqual([
      { number: 'A9SLAZ3T-0001', created: paid.created, amountCents: 12495, currency: 'usd', status: 'paid', pdfUrl: pdfUrlFor(paid.id as string), payUrl: null },
    ]);
  });

  it('uncollectible with something left -> Unpaid with Pay; open with nothing left -> Due without Pay', async () => {
    seed(T, [
      { ...I5, status: 'uncollectible' as const }, // [EDITED] status flip
      { ...I4, due_date: T + 100, amount_remaining: 0 }, // [EDITED] due_date, amount_remaining
    ]);
    const rows = await read();
    expect(byNumber(rows, 'A9SLAZ3T-0005')).toMatchObject({ status: 'unpaid', payUrl: payUrlFor(I5.id as string) });
    expect(byNumber(rows, 'A9SLAZ3T-0004')).toMatchObject({ status: 'due', payUrl: null });
  });

  it('drafts are skipped; six non-drafts -> the newest five', async () => {
    const draft = { ...I5, status: 'draft' as const, number: null }; // [EDITED] status flip
    const paid = paidInvoice(); // same invoice as A9SLAZ3T-0001 (paid); listed here as a sixth, older row
    seed(T, [draft, ...openInvoices(), paid]);
    const rows = (await read()) as OrgInvoiceRow[];
    expect(rows).toHaveLength(ORG_INVOICES_LIMIT);
    expect(rows.map((r) => r.number)).toEqual(['A9SLAZ3T-0005', 'A9SLAZ3T-0004', 'A9SLAZ3T-0003', 'A9SLAZ3T-0002', 'A9SLAZ3T-0001']);
    expect(rows.every((r) => r.status === 'overdue')).toBe(true);
  });
});

describe('C6: https links only', () => {
  it.each([
    ['http://', (id: string) => `http://invoice.stripe.test/REDACTED/${id}`], // [SYNTHETIC]
    ['the capture redaction', () => '[REDACTED hosted URL]'],
  ])('%s hosted / PDF url -> no link', async (_n, url) => {
    seed(T, [{ ...I5, hosted_invoice_url: url(I5.id as string), invoice_pdf: url(`${I5.id as string}.pdf`) }]);
    expect(await read()).toEqual([expect.objectContaining({ status: 'overdue', payUrl: null, pdfUrl: null })]);
  });
});

describe('C9: one time limit; failures read "unavailable"', () => {
  it('Stripe hangs -> null at the limit', async () => {
    seed(T, []);
    invoicesList.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    expect(await read()).toBeNull();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(4500);
  }, 15000);
  it('Stripe throws -> null', async () => {
    seed(T, []);
    invoicesList.mockRejectedValue(new Error('stripe down'));
    expect(await read()).toBeNull();
  });
});

describe('C10: no caching', () => {
  it('org A then org B in one process -> B\'s rows', async () => {
    seed(T, [I5]);
    expect((await read(ORG_A))?.map((r) => r.number)).toEqual(['A9SLAZ3T-0005']);
    invoicesList.mockResolvedValue(listOf([I1]));
    expect((await read(ORG_B))?.map((r) => r.number)).toEqual(['A9SLAZ3T-0001']);
  });
  it('source: no Next cache wrapper (unstable_cache / "use cache") — cannot run under jest', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lib/billing/orgInvoices.ts'), 'utf8');
    expect(src).not.toMatch(/unstable_cache|['"]use cache['"]|from 'react'/);
  });
});
