/**
 * BACKLOG-3848 — billing blocks 4–6 read model (lib/billing/personalBilling.ts).
 *
 * Fixtures are Stripe TEST producers (fixtures/stripe/p3848/README.md); every
 * edit is labelled where it is made.
 */

import fs from 'fs';
import path from 'path';
import type Stripe from 'stripe';
import { cardFrom, failedInvoiceFrom, getPersonalBillingView, rowsFrom, ROWS_LIMIT } from '@/lib/billing/personalBilling';
import { BillingDb } from '../../helpers/billingDb';

const FX = path.join(__dirname, '../../fixtures/stripe');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fx = (n: string): any => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));

const INV_AFTER_PAY = fx('p3848/invoices-list-after-pay').data as Stripe.Invoice[];
const INV_PASTDUE = fx('p3848/invoices-list-pastdue').data as Stripe.Invoice[];
const CH_AFTER_PAY = fx('p3848/charges-list-after-pay').data as Stripe.Charge[];
const CH_PASTDUE = fx('p3848/charges-list-pastdue').data as Stripe.Charge[];

describe('C-ROWS-INVOICE (R10): one row per invoice, never one per charge', () => {
  it('fixture check: 2 invoices, 5 charges of which 4 belong to an invoice (1 renewal retried 3 times)', () => {
    expect(INV_AFTER_PAY.map((i) => i.status)).toEqual(['paid', 'paid']);
    expect(CH_AFTER_PAY.map((c) => [c.status, !!c.invoice])).toEqual([
      ['succeeded', true],
      ['failed', true],
      ['failed', true],
      ['succeeded', true],
      ['succeeded', false],
    ]);
  });

  it('after pay -> exactly 3 rows: the 2 invoices and the 1 per-export payment', () => {
    const rows = rowsFrom(INV_AFTER_PAY, CH_AFTER_PAY);
    const payg = CH_AFTER_PAY.find((c) => !c.invoice)!;
    expect(rows.map((r) => r.id).sort()).toEqual([...INV_AFTER_PAY.map((i) => i.id), payg.id].sort());
    expect(rows.filter((r) => r.description === 'Export unlock').map((r) => [r.amountCents, r.status, r.linkLabel])).toEqual([
      [1499, 'paid', 'Receipt'],
    ]);
    expect(rows.filter((r) => r.description.startsWith('Agent plan · ')).map((r) => [r.amountCents, r.status, r.linkLabel])).toEqual([
      [1999, 'paid', 'View'],
      [1999, 'paid', 'View'],
    ]);
  });

  it('past due -> the open renewal is one "payment_failed" row; its failed charges make none', () => {
    const rows = rowsFrom(INV_PASTDUE, CH_PASTDUE);
    expect(rows.map((r) => r.status).sort()).toEqual(['paid', 'paid', 'payment_failed']);
    expect(rows.find((r) => r.status === 'payment_failed')!.id).toBe(INV_PASTDUE.find((i) => i.status === 'open')!.id);
  });

  it('description is the subscription line period, UTC', () => {
    const inv = INV_PASTDUE.find((i) => i.status === 'open')!;
    const p = inv.lines.data[0].period;
    const d = (s: number) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(s * 1000));
    expect(rowsFrom([inv], [])[0].description).toBe(`Agent plan · ${d(p.start)} – ${d(p.end)}`);
  });
});

describe('row status sweep (one input per branch)', () => {
  const base = INV_PASTDUE.find((i) => i.status === 'open')!;
  const payg = CH_AFTER_PAY.find((c) => !c.invoice)!;
  it.each([
    ['open, attempt_count 1 (fixture)', base, 'payment_failed'],
    ['open, attempt_count 0 [EDITED]', { ...base, attempt_count: 0 }, 'open'],
    ['paid (fixture)', INV_AFTER_PAY[0], 'paid'],
    ['void (fixture inv-voided)', fx('p3848/inv-voided'), 'void'],
    ['uncollectible [EDITED status]', { ...base, status: 'uncollectible' }, 'uncollectible'],
  ] as [string, Stripe.Invoice, string][])('invoice %s -> %s', (_n, inv, status) => {
    expect(rowsFrom([inv], []).map((r) => r.status)).toEqual([status]);
  });

  // p0a ch-4 is a real fully refunded Agent charge; Stripe keeps its invoice 'paid'.
  const ch4 = fx('p0a/ch-4-after-refunds');
  const paidInv = { ...INV_AFTER_PAY[0], id: ch4.invoice } as Stripe.Invoice; // [COMPOSED] paid invoice given ch-4's invoice id
  it.each([
    ['fully refunded charge (p0a ch-4)', ch4, 'refunded'],
    ['partly refunded charge [EDITED refunded false, amount_refunded 500]', { ...ch4, refunded: false, amount_refunded: 500 }, 'partly_refunded'],
    ['charge not refunded [EDITED refunded false, amount_refunded 0]', { ...ch4, refunded: false, amount_refunded: 0 }, 'paid'],
  ] as [string, Stripe.Charge, string][])('C-ROWS-REFUND: paid invoice whose %s -> %s, still one row', (_n, ch, status) => {
    expect(ch4.invoice).toBeTruthy();
    expect(rowsFrom([paidInv], [ch]).map((r) => [r.id, r.status])).toEqual([[ch4.invoice, status]]);
  });

  it('a draft invoice [EDITED status] makes no row', () => {
    expect(rowsFrom([{ ...base, status: 'draft' } as Stripe.Invoice], [])).toEqual([]);
  });

  const refunded = { ...fx('p0a/ch-4-after-refunds'), invoice: null }; // [EDITED invoice: null] p0a full refund as a per-export charge
  it.each([
    ['succeeded (fixture)', payg, 'paid'],
    ['fully refunded (p0a ch-4, invoice [EDITED] null)', refunded, 'refunded'],
    ['partly refunded [EDITED refunded false, amount_refunded 500]', { ...refunded, refunded: false, amount_refunded: 500 }, 'partly_refunded'],
  ] as [string, Stripe.Charge, string][])('per-export charge %s -> %s', (_n, ch, status) => {
    expect(rowsFrom([], [ch]).map((r) => [r.status, r.description])).toEqual([[status, 'Export unlock']]);
  });

  it('a failed per-export charge [EDITED status, invoice null] makes no row (no money was taken)', () => {
    const failed = { ...CH_AFTER_PAY.find((c) => c.status === 'failed')!, invoice: null };
    expect(rowsFrom([], [failed as Stripe.Charge])).toEqual([]);
  });

  it(`newest first, at most ${ROWS_LIMIT} rows [COMPOSED: the paid invoice repeated with ids/created EDITED]`, () => {
    const many = Array.from({ length: ROWS_LIMIT + 5 }, (_, i) => ({ ...INV_AFTER_PAY[0], id: `in_EDITED_${i}`, created: 1_000_000 + i }));
    const rows = rowsFrom(many as Stripe.Invoice[], []);
    expect(rows).toHaveLength(ROWS_LIMIT);
    expect(rows[0].id).toBe(`in_EDITED_${ROWS_LIMIT + 4}`);
  });
});

describe('card and failed invoice', () => {
  it('cardFrom: expanded PM -> brand/last4/expiry; an unexpanded id or null -> null', () => {
    const pm = fx('p3848/pm-good');
    expect(cardFrom(pm)).toEqual({ brand: 'visa', last4: '4242', expMonth: pm.card.exp_month, expYear: pm.card.exp_year });
    expect(cardFrom(pm.id)).toBeNull();
    expect(cardFrom(null)).toBeNull();
  });

  it('failedInvoiceFrom: the open renewal with an attempt; none once paid', () => {
    const open = INV_PASTDUE.find((i) => i.status === 'open')!;
    expect(failedInvoiceFrom(INV_PASTDUE)).toEqual({ amountCents: 1999, currency: 'usd', created: open.created });
    expect(failedInvoiceFrom(INV_AFTER_PAY)).toBeNull();
  });
});

describe('getPersonalBillingView', () => {
  const USER = 'USER-3848-PR1';
  function stripeStub() {
    const calls: string[] = [];
    const rec = (name: string, value: unknown) =>
      jest.fn(async (...a: unknown[]) => {
        calls.push(`${name}:${JSON.stringify(a[0])}`);
        return value;
      });
    const stripe = {
      customers: { retrieve: rec('customers.retrieve', fx('p3848/cus-expand-pm')), create: rec('customers.create', { id: 'cus_EDITED' }) },
      subscriptions: { retrieve: rec('subscriptions.retrieve', fx('p3848/sub-pastdue-expand-pm')) },
      invoices: { list: rec('invoices.list', fx('p3848/invoices-list-pastdue')) },
      charges: { list: rec('charges.list', fx('p3848/charges-list-pastdue')) },
      paymentMethods: { retrieve: rec('paymentMethods.retrieve', fx('p3848/pm-good')) },
    };
    return { stripe: stripe as unknown as Stripe, calls };
  }
  const session = (data: unknown = 3) => ({ rpc: jest.fn(async () => ({ data, error: null })) });

  it('C-READ-NOCREATE (R11): no customer row in this mode -> zero Stripe calls, card none, rows empty, contact = sign-in email', async () => {
    const db = new BillingDb({});
    const { stripe, calls } = stripeStub();
    const out = await getPersonalBillingView({
      session: session() as never,
      service: db as never,
      stripe,
      userId: USER,
      signInEmail: 'signin@fixture.example.test',
      mode: 'test',
      view: { row: null },
    });
    expect(calls).toEqual([]);
    expect(out).toEqual({
      credits: 3,
      customer: 'none',
      card: null,
      contact: { name: null, email: 'signin@fixture.example.test' },
      rows: [],
      failedInvoice: null,
    });
  });

  it('C-MODE (reads): a test row and a live row -> every Stripe read uses the live customer only, under a live key', async () => {
    const cus = fx('p3848/cus-expand-pm');
    const db = new BillingDb({
      stripe_customers: [
        { user_id: USER, stripe_customer_id: 'cus_EDITED_test', stripe_mode: 'test', default_payment_method_id: null },
        { user_id: USER, stripe_customer_id: cus.id, stripe_mode: 'live', default_payment_method_id: null },
      ],
    });
    const { stripe, calls } = stripeStub();
    const out = await getPersonalBillingView({
      session: session() as never,
      service: db as never,
      stripe,
      userId: USER,
      signInEmail: null,
      mode: 'live',
      view: { row: null },
    });
    expect(out.customer).toBe('present');
    expect(calls.sort()).toEqual(
      [
        `charges.list:${JSON.stringify({ customer: cus.id, limit: ROWS_LIMIT })}`,
        `customers.retrieve:${JSON.stringify(cus.id)}`,
        `invoices.list:${JSON.stringify({ customer: cus.id, limit: ROWS_LIMIT })}`,
      ].sort()
    );
  });

  it('card order: the subscription default (failing 0341) wins over the customer default (4242)', async () => {
    const cus = fx('p3848/cus-expand-pm');
    const sub = fx('p3848/sub-pastdue-expand-pm');
    const db = new BillingDb({
      stripe_customers: [{ user_id: USER, stripe_customer_id: cus.id, stripe_mode: 'test', default_payment_method_id: null }],
    });
    const { stripe } = stripeStub();
    const out = await getPersonalBillingView({
      session: session() as never,
      service: db as never,
      stripe,
      userId: USER,
      signInEmail: null,
      mode: 'test',
      view: { row: { stripe_subscription_id: sub.id } as never },
    });
    expect(out.card?.last4).toBe('0341');
    expect(out.contact).toEqual({ name: cus.name, email: cus.email });
    expect(out.failedInvoice?.amountCents).toBe(1999);
  });

  it('no default on the customer [EDITED] and no subscription -> the stored per-export card is read', async () => {
    const cus = { ...fx('p3848/cus-expand-pm'), invoice_settings: { default_payment_method: null } };
    const db = new BillingDb({
      stripe_customers: [{ user_id: USER, stripe_customer_id: cus.id, stripe_mode: 'test', default_payment_method_id: 'pm_SEEDED' }],
    });
    const { stripe, calls } = stripeStub();
    (stripe.customers.retrieve as jest.Mock).mockResolvedValue(cus);
    const out = await getPersonalBillingView({
      session: session() as never,
      service: db as never,
      stripe,
      userId: USER,
      signInEmail: null,
      mode: 'test',
      view: { row: null },
    });
    expect(out.card?.last4).toBe('4242');
    expect(calls).toContain('paymentMethods.retrieve:"pm_SEEDED"');
  });
});
