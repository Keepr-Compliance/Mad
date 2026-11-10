/**
 * @jest-environment node
 *
 * BACKLOG-3932 — billing_outbox kind `notify_payment_failed` (lib/billing/paymentFailedNotify.ts).
 * Plan pm_comments 72a89749 + delta ce8c1637 (SR-approved 4b489443); copy: founder 0486b6aa.
 *
 * Stripe objects: __tests__/fixtures/stripe/p3932 — TEST captures of one brokerage send_invoice
 * invoice paid twice with Stripe's failing ACH test token, re-fetched at 2025-02-24.acacia (see
 * its README). Edits beyond the README's redactions are marked [EDITED] here.
 *
 * Row shape: the producer in lib/billing/brokerage.ts (notifyPaymentFailed):
 *   dedupe_key 'notify_payment_failed:<mode>:<org>:<invoice id>:<charge id>'
 *   payload {organization_id, invoice_id, charge_id}.
 */

import fs from 'fs';
import path from 'path';
import { createBrokerageFake, dealRow, type BrokerageFake } from '../../../helpers/brokerageFake';

const mockSend = jest.fn();
const mockRetrieve = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({ sendPaymentFailedEmail: (...a: unknown[]) => mockSend(...a) }));

import { handleNotifyPaymentFailedRow, formatAmount } from '@/lib/billing/paymentFailedNotify';
import { buildPaymentFailedEmail, paymentFailedLines } from '@/lib/email/templates/payment-failed';
import type { OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../../fixtures/stripe/p3932');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

const PF1_FAILED = fx('inv-pf1-failed.exp');
const PF1_PROCESSING = fx('inv-pf1-processing.exp');
const PF2_PROCESSING = fx('inv-pf2-processing.exp');
const PF2_FAILED = fx('inv-pf2-failed.exp');
const UNCOLLECTIBLE = fx('inv-pf-uncollectible.exp');
const VOID = fx('inv-pf-void.exp');
const INV_ID: string = PF1_FAILED.id;
const CH1: string = PF1_FAILED.payment_intent.latest_charge;
const CH2: string = PF2_FAILED.payment_intent.latest_charge;
const HOSTED: string = PF1_FAILED.hosted_invoice_url;

const ORG = 'ORG-3932-PF';
let fake: BrokerageFake;
let stripeInvoice: Obj;

function row(charge = CH1, over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: `outbox-pf-${charge}`,
    stripe_mode: 'test',
    kind: 'notify_payment_failed',
    user_id: null,
    organization_id: ORG,
    dedupe_key: `notify_payment_failed:test:${ORG}:${INV_ID}:${charge}`,
    run_after: '2026-11-09T19:00:00Z',
    payload: { organization_id: ORG, invoice_id: INV_ID, charge_id: charge },
    attempts: 1,
    last_error: null,
    claimed_until: null,
    created_at: '2026-11-09T18:00:00Z',
    processed_at: null,
    ...over,
  };
}
const ctx = () => ({
  stripe: { invoices: { retrieve: mockRetrieve } } as never,
  service: fake.service as never,
  mode: 'test' as const,
  deadline: new Date(Date.now() + 60_000),
});
const sends = () => mockSend.mock.calls.map((c) => c[0] as Obj);

/** [EDITED] paid: no paid state was captured; status, amount_remaining and the PI flipped. */
function paidInvoice(): Obj {
  const inv = clone(PF1_FAILED);
  inv.status = 'paid';
  inv.amount_paid = inv.amount_due;
  inv.amount_remaining = 0;
  inv.payment_intent.status = 'succeeded';
  return inv;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'info').mockImplementation(() => {});
  fake = createBrokerageFake({
    organizations: [{ id: ORG, name: 'Brokerage 3932 PF', is_test: true }],
    org_deals: [dealRow(ORG)],
    email_delivery_log: [],
  });
  stripeInvoice = clone(PF1_FAILED);
  mockRetrieve.mockImplementation(async () => clone(stripeInvoice));
  mockSend.mockImplementation(async (p: Obj) => {
    fake.db.rows('email_delivery_log').push({
      status: 'sent',
      metadata: { kind: 'org_payment_failed', outboxKey: p.outboxKey, organizationId: p.organizationId },
    });
    return { success: true, outcome: 'sent' };
  });
});

afterEach(() => jest.restoreAllMocks());

describe('notify_payment_failed', () => {
  it('C-PFN1: a failed attempt -> one email to the billing contact, amount remaining, hosted pay link, one expanded re-fetch', async () => {
    await handleNotifyPaymentFailedRow(row(), ctx());
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    expect(mockRetrieve).toHaveBeenCalledWith(INV_ID, { expand: ['payment_intent'] });
    expect(sends()).toEqual([
      {
        recipientEmail: 'billing-3853@example.test',
        brokerageName: 'Brokerage 3932 PF',
        amountLabel: '$74.97',
        payUrl: HOSTED,
        outboxKey: row().dedupe_key,
        organizationId: ORG,
      },
    ]);
  });

  it.each([
    ['paid [EDITED]', () => paidInvoice()],
    ['void', () => clone(VOID)],
    ['uncollectible', () => clone(UNCOLLECTIBLE)],
  ])('C3: invoice %s by the drain -> no send, row processed (no throw)', async (_label, make) => {
    stripeInvoice = make();
    await expect(handleNotifyPaymentFailedRow(row(CH2), ctx())).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('C4: the PaymentIntent is processing at the drain (a retry is in flight) -> no send', async () => {
    // PF1_PROCESSING: the first debit itself still processing; the row's charge is that debit.
    stripeInvoice = clone(PF1_PROCESSING);
    await expect(handleNotifyPaymentFailedRow(row(CH1), ctx())).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('C7: no billing contact -> no send, no throw', async () => {
    fake.db.rows('org_deals')[0].billing_contact_email = null;
    await expect(handleNotifyPaymentFailedRow(row(), ctx())).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(['canceled', 'suspended', 'draft'])('C-PFN2: deal %s -> no send, no Stripe call', async (status) => {
    fake.db.rows('org_deals')[0].status = status;
    await handleNotifyPaymentFailedRow(row(), ctx());
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('C8: converges: the same row run twice sends once', async () => {
    await handleNotifyPaymentFailedRow(row(), ctx());
    await handleNotifyPaymentFailedRow(row(CH1, { attempts: 2 }), ctx());
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(fake.db.rows('email_delivery_log')).toHaveLength(1);
  });

  it('C10: fail (ch 1) -> retry processing at drain (no send) -> retry fails (ch 2) -> exactly one email, for ch 2', async () => {
    expect(CH1).not.toEqual(CH2);
    // Row A drains while the customer's retry is processing.
    stripeInvoice = clone(PF2_PROCESSING);
    await handleNotifyPaymentFailedRow(row(CH1), ctx());
    expect(mockSend).not.toHaveBeenCalled();
    // The retry fails: the webhook queued row B (charge 2); it drains on the failed invoice.
    stripeInvoice = clone(PF2_FAILED);
    await handleNotifyPaymentFailedRow(row(CH2), ctx());
    // A late re-run of row A on the same state is superseded by the newer attempt.
    await handleNotifyPaymentFailedRow(row(CH1, { attempts: 2 }), ctx());
    expect(sends().map((s) => s.outboxKey)).toEqual([row(CH2).dedupe_key]);
  });

  it('C-PFN3: the row is for an older attempt and a newer one failed too -> only the newer row sends', async () => {
    stripeInvoice = clone(PF2_FAILED);
    await handleNotifyPaymentFailedRow(row(CH1), ctx());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('C13: amount is amount_remaining, not amount_due', async () => {
    stripeInvoice = clone(PF1_FAILED);
    stripeInvoice.amount_remaining = 2497; // [EDITED] part already paid from customer balance
    expect(stripeInvoice.amount_due).toBe(7497);
    await handleNotifyPaymentFailedRow(row(), ctx());
    expect(sends()[0].amountLabel).toBe('$24.97');
    expect(paymentFailedLines({ brokerageName: 'B', amountLabel: '$24.97' })[0]).toBe(
      "Your $24.97 payment for B's Keepr subscription didn't go through."
    );
  });

  it('C-PFN4: no https hosted link -> the button opens the Keepr Billing page', async () => {
    stripeInvoice = clone(PF1_FAILED);
    stripeInvoice.hosted_invoice_url = null; // [EDITED]
    await handleNotifyPaymentFailedRow(row(), ctx());
    expect(sends()[0].payUrl).toMatch(/^https:\/\/.+\/dashboard\/billing$/);
  });

  it('C-PFN5: a payload without the invoice or charge is NonRetryable', async () => {
    await expect(handleNotifyPaymentFailedRow(row(CH1, { payload: { organization_id: ORG, invoice_id: INV_ID } }), ctx())).rejects.toThrow(
      'bad_payload'
    );
  });

  it('C9: no card/bank detail in the email; Pay = hosted link; the link is absent from payload, log metadata, last_error and console', async () => {
    const consoleSpies = (['info', 'log', 'warn', 'error'] as const).map((m) =>
      (console[m] as unknown as jest.Mock).mock ? (console[m] as unknown as jest.Mock) : jest.spyOn(console, m).mockImplementation(() => {})
    );
    const r = row();
    await handleNotifyPaymentFailedRow(r, ctx());
    const params = sends()[0];
    const { subject, html, text } = buildPaymentFailedEmail(params as never);
    expect(subject).toBe('Payment failed for Brokerage 3932 PF');
    expect(html).toContain(`href="${HOSTED}"`);
    expect(html).toContain('Pay invoice');
    expect(text).toContain(`Pay invoice: ${HOSTED}`);
    const bank = PF1_FAILED.payment_intent.last_payment_error.payment_method.us_bank_account;
    expect(bank.last4).toMatch(/^\d{4}$/);
    for (const s of [html, text]) {
      expect(s).not.toMatch(/last4|visa|mastercard|routing|ending in/i);
      expect(s).not.toContain(bank.last4);
      expect(s).not.toContain(bank.bank_name);
      expect(s).not.toContain(bank.routing_number);
    }
    expect(JSON.stringify(r.payload)).not.toContain('stripe.test');
    expect(JSON.stringify(fake.db.rows('email_delivery_log'))).not.toContain('stripe.test');
    expect(JSON.stringify(Object.keys(params).filter((k) => k !== 'payUrl').map((k) => params[k]))).not.toContain('stripe.test');
    for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain('stripe.test');
  });

  it('C-PFN6: founder copy (option B), verbatim', () => {
    expect(paymentFailedLines({ brokerageName: 'Acme Realty', amountLabel: '$74.97' })).toEqual([
      "Your $74.97 payment for Acme Realty's Keepr subscription didn't go through.",
      'Please pay the invoice with the button below, or change your payment method under Manage billing on the Keepr Billing page.',
      'Your members keep their access. Questions? Reply to this email or contact your Keepr account manager.',
    ]);
    expect(paymentFailedLines({ brokerageName: 'Acme Realty', amountLabel: null })[0]).toBe(
      "Your payment for Acme Realty's Keepr subscription didn't go through."
    );
  });

  it('C-PFN7: amount formatting: usd cents, zero-decimal whole units, anything else none', () => {
    expect(formatAmount(7497, 'usd')).toBe('$74.97');
    expect(formatAmount(500, 'jpy')).toBe('¥500');
    expect(formatAmount(1000, 'kwd')).toBeNull();
  });
});
