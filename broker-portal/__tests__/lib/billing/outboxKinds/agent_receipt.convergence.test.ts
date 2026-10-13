/**
 * @jest-environment node
 *
 * BACKLOG-3848 — billing_outbox kind `agent_receipt` (SR R9).
 *
 * Convergence (handler contract (a)): running the handler again for the same
 * row sends nothing more once a receipt for the invoice is on record.
 * Invoice: fixtures/stripe/p3848/pr2-inv-paid-expand-charge (TEST, acacia):
 * a paid renewal with its charge expanded; `receipt_number` is null in TEST
 * (Stripe sends no receipt emails there), so the "Stripe already sent one"
 * case sets it [EDITED]. Customer: pr2-cus-update-contact (after Edit contact).
 * The email sender is mocked; email_delivery_log rows live in BillingDb with
 * the shape send-email.ts writes (email_type, recipient_email, status,
 * metadata.paymentReference). No network.
 */

import fs from 'fs';
import path from 'path';
import { BillingDb } from '../../../helpers/billingDb';
import { clone, createStripeStub, type StripeStub } from '../../../helpers/stripeStub';

const mockCaptureMessage = jest.fn();
const mockSendReceipt = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCaptureMessage(...a), captureException: jest.fn() }));
jest.mock('@/lib/email', () => ({ sendReceiptEmail: (...a: unknown[]) => mockSendReceipt(...a) }));

import { handleAgentReceiptRow } from '@/lib/billing/agentReceipt';
import { NonRetryableOutboxError, type OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../../fixtures/stripe/p3848');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));

const INV = fx('pr2-inv-paid-expand-charge');
const CUS = fx('pr2-cus-update-contact');
const USER = 'USER-3848-RCPT';
const SIGN_IN = 'signin-3848@example.invalid';

let db: BillingDb;
let stripe: StripeStub;
let getUserById: jest.Mock;

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'outbox-1',
    stripe_mode: 'test',
    kind: 'agent_receipt',
    user_id: USER,
    organization_id: null,
    dedupe_key: `agent_receipt:test:${INV.id}`,
    run_after: '2026-10-13T00:10:00Z',
    payload: { invoice_id: INV.id },
    attempts: 1,
    last_error: null,
    claimed_until: null,
    created_at: '2026-10-13T00:00:00Z',
    processed_at: null,
    ...over,
  };
}

function ctx() {
  return {
    stripe: stripe.client,
    service: { from: db.from, auth: { admin: { getUserById } } } as never,
    mode: 'test' as const,
    deadline: new Date(Date.now() + 60_000),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db = new BillingDb({ email_delivery_log: [] });
  getUserById = jest.fn(async () => ({ data: { user: { email: SIGN_IN } }, error: null }));
  stripe = createStripeStub({ 'invoices.retrieve': () => INV, 'customers.retrieve': () => CUS });
  mockSendReceipt.mockImplementation(async (p: Obj) => {
    // send-email.ts logs every send with the receipt's logMetadata.
    db.rows('email_delivery_log').push({
      email_type: 'receipt',
      recipient_email: p.recipientEmail,
      status: 'sent',
      metadata: { amountCents: p.amountCents, paymentReference: p.paymentReference },
    });
    return { success: true, outcome: 'sent' };
  });
});

describe('agent_receipt handler', () => {
  it('sends one receipt to the billing contact (the customer email), for the amount paid, referencing the invoice', async () => {
    expect(INV.charge.receipt_number).toBeNull();
    await handleAgentReceiptRow(row(), ctx());
    expect(mockSendReceipt).toHaveBeenCalledTimes(1);
    expect(mockSendReceipt.mock.calls[0][0]).toMatchObject({
      recipientEmail: CUS.email,
      amountCents: INV.amount_paid,
      paymentReference: INV.id,
    });
    expect(stripe.callsTo('invoices.retrieve')).toEqual([[INV.id, { expand: ['charge'] }]]);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('convergence: the same row run twice sends once (the second run finds the receipt on record)', async () => {
    await handleAgentReceiptRow(row(), ctx());
    await handleAgentReceiptRow(row({ attempts: 2 }), ctx());
    expect(mockSendReceipt).toHaveBeenCalledTimes(1);
  });

  it('a queued (not yet delivered) receipt also counts as on record', async () => {
    db.rows('email_delivery_log').push({ email_type: 'receipt', status: 'queued', metadata: { paymentReference: INV.id } });
    await handleAgentReceiptRow(row(), ctx());
    expect(mockSendReceipt).not.toHaveBeenCalled();
  });

  it('a failed earlier send does not count: it sends', async () => {
    db.rows('email_delivery_log').push({ email_type: 'receipt', status: 'failed', metadata: { paymentReference: INV.id } });
    await handleAgentReceiptRow(row(), ctx());
    expect(mockSendReceipt).toHaveBeenCalledTimes(1);
  });

  it('C-RCPT-STRIPE-SENT: charge.receipt_number set [EDITED] -> no Keepr receipt, alert', async () => {
    const sent = clone(INV);
    sent.charge.receipt_number = '1234-5678';
    stripe.impl['invoices.retrieve'] = () => sent;
    await handleAgentReceiptRow(row(), ctx());
    expect(mockSendReceipt).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith('billing alert: agent_receipt_stripe_sent', expect.anything());
  });

  it('customer without an email [EDITED email null] -> the sign-in email', async () => {
    stripe.impl['customers.retrieve'] = () => ({ ...clone(CUS), email: null });
    await handleAgentReceiptRow(row(), ctx());
    expect(mockSendReceipt.mock.calls[0][0].recipientEmail).toBe(SIGN_IN);
  });

  it('invoice not paid [EDITED status open] -> nothing sent, no error', async () => {
    stripe.impl['invoices.retrieve'] = () => ({ ...clone(INV), status: 'open' });
    await handleAgentReceiptRow(row(), ctx());
    expect(mockSendReceipt).not.toHaveBeenCalled();
  });

  it('email not configured -> parked (non-retryable); a failed send -> retried (ordinary throw)', async () => {
    mockSendReceipt.mockResolvedValueOnce({ success: false, outcome: 'skipped' });
    await expect(handleAgentReceiptRow(row(), ctx())).rejects.toBeInstanceOf(NonRetryableOutboxError);
    mockSendReceipt.mockResolvedValueOnce({ success: false, outcome: 'failed' });
    const err = await handleAgentReceiptRow(row(), ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableOutboxError);
  });
});
