/**
 * @jest-environment node
 *
 * BACKLOG-3848 — End plan now (founder Q1 = A; SR R4).
 *
 * Stripe objects: fixtures/stripe/p3848 (TEST, acacia; README):
 *   - pr2-sub-past_due / pr2-invoices-list-sub-open: the past_due plan and
 *     invoices.list({subscription, status: open}) of it (one open renewal);
 *   - SR-VOID-inv-voided / SR-VOID-sub-after-void / SR-VOID-sub-canceled: the
 *     SR trace void -> sub flips active -> cancel -> canceled;
 *   - pr2-void-paid-refused / pr2-inv-paid: Stripe refusing to void a paid
 *     invoice, and the invoice as it then reads.
 * The SR trace ran on another TEST subscription than pr2-sub-past_due; the
 * outcome objects are served for it [COMPOSED]. No network.
 */

import fs from 'fs';
import path from 'path';
import { BillingDb } from '../../helpers/billingDb';
import { clone, createStripeStub, stripeError, type StripeStub } from '../../helpers/stripeStub';

const mockCaptureMessage = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCaptureMessage(...a), captureException: jest.fn() }));

import { endPlanNow, END_NOW_KIND } from '@/lib/billing/endPlanNow';
import { mirrorState } from '@/lib/billing/sync';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../fixtures/stripe/p3848');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));

const SUB = fx('pr2-sub-past_due');
const OPEN_LIST = fx('pr2-invoices-list-sub-open');
const INV = OPEN_LIST.data[0];
const VOIDED = { ...fx('SR-VOID-inv-voided'), id: INV.id }; // [COMPOSED] SR trace object under this invoice id
const CANCELED = { ...fx('SR-VOID-sub-canceled'), id: SUB.id, customer: SUB.customer }; // [COMPOSED]
const USER = 'USER-3848-END';
const OTHER = 'USER-3848-OTHER';

let db: BillingDb;
let stripe: StripeStub;

function seed(): void {
  db = new BillingDb({
    organizations: [{ id: 'ORG-END', personal_owner_user_id: USER, is_test: true }],
    stripe_customers: [{ user_id: USER, stripe_customer_id: SUB.customer, default_payment_method_id: null, stripe_mode: 'test' }],
    billing_subscriptions: [
      { id: 'row-mine', stripe_mode: 'test', user_id: USER, stripe_subscription_id: SUB.id, ...mirrorState(SUB as never) },
      // Another user's row: never touched. (stripe_subscription_id is UNIQUE across modes, so no second row of this id can exist.)
      { id: 'row-other', stripe_mode: 'test', user_id: OTHER, stripe_subscription_id: 'sub_OTHER', status: 'past_due' },
    ],
  });
}

async function run() {
  return endPlanNow({ stripe: stripe.client, service: { from: db.from } as never, mode: 'test', userId: USER, subscriptionId: SUB.id });
}
const mine = () => db.rows('billing_subscriptions').find((r) => r.id === 'row-mine')!;

beforeEach(() => {
  jest.clearAllMocks();
  seed();
  stripe = createStripeStub({
    'subscriptions.retrieve': () => SUB,
    'invoices.list': () => OPEN_LIST,
    'invoices.voidInvoice': () => VOIDED,
    'subscriptions.cancel': () => CANCELED,
  });
});

describe('endPlanNow (R4)', () => {
  it('C-END-ORDER: status read, open invoices listed, every one voided, THEN cancel; mirror row canceled, paused false', async () => {
    expect(await run()).toBe('ended');
    expect(stripe.ops()).toEqual(['subscriptions.retrieve', 'invoices.list', 'invoices.voidInvoice', 'subscriptions.cancel']);
    expect(stripe.callsTo('invoices.voidInvoice')).toEqual([[INV.id, {}, { idempotencyKey: `end-now-void:${INV.id}` }]]);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([
      [SUB.id, { prorate: false, invoice_now: false }, { idempotencyKey: `end-now-cancel:${SUB.id}` }],
    ]);
    expect(mine()).toMatchObject({ status: 'canceled', paused: false, cancel_at_period_end: false });
    // Only this user's row in this mode.
    const upd = db.callsTo('billing_subscriptions', 'update')[0];
    expect(upd.filters).toEqual([
      { op: 'eq', column: 'stripe_subscription_id', value: SUB.id },
      { op: 'eq', column: 'stripe_mode', value: 'test' },
      { op: 'eq', column: 'user_id', value: USER },
    ]);
    expect(db.rows('billing_subscriptions').find((r) => r.id === 'row-other')).toMatchObject({ status: 'past_due' });
    expect(db.rows('billing_outbox')).toEqual([]);
  });

  it('C-END-LIST-SCOPE: invoices are listed by subscription (never by customer), open only, every page', async () => {
    const p1 = { ...clone(OPEN_LIST), has_more: true };
    const second = { ...clone(INV), id: 'in_EDITED_page2' }; // [EDITED] a second open invoice on page 2
    const p2 = { ...clone(OPEN_LIST), data: [second], has_more: false };
    stripe.impl['invoices.list'] = (params: Obj) => (params.starting_after ? p2 : p1);
    expect(await run()).toBe('ended');
    const lists = stripe.callsTo('invoices.list').map((a) => a[0]);
    expect(lists).toEqual([
      { subscription: SUB.id, status: 'open', limit: 100 },
      { subscription: SUB.id, status: 'open', limit: 100, starting_after: INV.id },
    ]);
    expect(lists.every((p) => !('customer' in p))).toBe(true);
    expect(stripe.callsTo('invoices.voidInvoice').map((a) => a[0])).toEqual([INV.id, 'in_EDITED_page2']);
  });

  it('C-END-PAID-MEANWHILE: void refused (captured) and the invoice now reads paid -> stop: zero cancel, mirror untouched', async () => {
    stripe.impl['invoices.voidInvoice'] = () => {
      throw stripeError(fx('pr2-void-paid-refused'));
    };
    stripe.impl['invoices.retrieve'] = () => ({ ...fx('pr2-inv-paid'), id: INV.id });
    expect(await run()).toBe('paid_meanwhile');
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
    expect(mine()).toMatchObject({ status: 'past_due' });
    expect(db.rows('billing_outbox')).toEqual([]);
  });

  it('C-END-VOID-OPEN: void refused and the invoice is still open -> try again: zero cancel', async () => {
    stripe.impl['invoices.voidInvoice'] = () => {
      throw Object.assign(new Error('Cannot void an invoice with an active checkout session'), { type: 'StripeInvalidRequestError' });
    };
    stripe.impl['invoices.retrieve'] = () => INV;
    expect(await run()).toBe('try_again');
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
    expect(mine()).toMatchObject({ status: 'past_due' });
  });

  it('C-END-CANCEL-FAIL: cancel throws after the voids -> one outbox row (deduped), alert, "finalizing"; mirror not yet canceled', async () => {
    stripe.impl['subscriptions.cancel'] = () => {
      throw Object.assign(new Error('api down'), { type: 'StripeAPIError' });
    };
    expect(await run()).toBe('finalizing');
    expect(await run()).toBe('finalizing'); // a second click queues nothing more
    expect(db.rows('billing_outbox')).toEqual([
      expect.objectContaining({
        stripe_mode: 'test',
        kind: END_NOW_KIND,
        user_id: USER,
        dedupe_key: `end-now:test:${SUB.id}`,
        payload: { subscription_id: SUB.id },
      }),
    ]);
    expect(mockCaptureMessage).toHaveBeenCalledWith('billing alert: end_now_cancel_failed', expect.anything());
  });

  it.each([
    ['active (SR trace, after a void)', () => fx('SR-VOID-sub-after-void')],
    ['unpaid [EDITED status]', () => ({ ...clone(SUB), status: 'unpaid' })],
    ['canceled', () => CANCELED],
  ])('status gate before any write: Stripe says %s -> not_now, nothing voided or cancelled', async (_n, sub) => {
    stripe.impl['subscriptions.retrieve'] = () => sub();
    expect(await run()).toBe('not_now');
    expect(stripe.ops()).toEqual(['subscriptions.retrieve']);
    expect(db.calls.filter((c) => c.op !== 'select')).toEqual([]);
  });
});
