/**
 * @jest-environment node
 *
 * BACKLOG-3848 — billing_outbox kind `agent_end_now_cancel`: the retry of an
 * End-plan-now cancel that failed after the voids (SR R4d).
 *
 * Convergence: it reads Stripe first; a subscription already canceled is only
 * mirrored, so running the row again cancels nothing more.
 * Objects: fixtures/stripe/p3848 SR-VOID-sub-after-void (active after the
 * void) and SR-VOID-sub-canceled (TEST, SR trace), pr2-invoices-list-sub-open;
 * SR-VOID-inv-voided is that subscription's latest_invoice (same id) after the
 * void, so it is what the handler re-fetches. pr2-inv-paid stands for a
 * next-cycle invoice paid before the drain ran [COMPOSED under an edited id].
 */

import fs from 'fs';
import path from 'path';
import { BillingDb } from '../../../helpers/billingDb';
import { clone, createStripeStub, type StripeStub } from '../../../helpers/stripeStub';

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

import { handleEndNowCancelRow } from '@/lib/billing/endPlanNow';
import { NonRetryableOutboxError, outboxIdempotencyKey, type OutboxRow } from '@/lib/billing/outboxKinds';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../../fixtures/stripe/p3848');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));

const ACTIVE = fx('SR-VOID-sub-after-void');
const CANCELED = fx('SR-VOID-sub-canceled');
const EMPTY = { ...fx('pr2-invoices-list-sub-open'), data: [] }; // [EDITED] no open invoice left after the voids
const USER = 'USER-3848-END';
const VOIDED_INV = fx('SR-VOID-inv-voided');

let db: BillingDb;
let stripe: StripeStub;
let current: Obj;

const row: OutboxRow = {
  id: 'outbox-end-1',
  stripe_mode: 'test',
  kind: 'agent_end_now_cancel',
  user_id: USER,
  organization_id: null,
  dedupe_key: `end-now:test:${ACTIVE.id}`,
  run_after: '2026-10-13T00:00:00Z',
  payload: { subscription_id: ACTIVE.id, voided_invoice_ids: [ACTIVE.latest_invoice] },
  attempts: 1,
  last_error: null,
  claimed_until: null,
  created_at: '2026-10-13T00:00:00Z',
  processed_at: null,
};

function ctx() {
  return { stripe: stripe.client, service: { from: db.from } as never, mode: 'test' as const, deadline: new Date(Date.now() + 60_000) };
}

beforeEach(() => {
  db = new BillingDb({
    stripe_customers: [{ user_id: USER, stripe_customer_id: ACTIVE.customer, default_payment_method_id: null, stripe_mode: 'test' }],
    billing_subscriptions: [{ id: 'row-1', stripe_mode: 'test', user_id: USER, stripe_subscription_id: ACTIVE.id, status: 'active', paused: false }],
  });
  current = ACTIVE;
  stripe = createStripeStub({
    'subscriptions.retrieve': () => current,
    'invoices.list': () => EMPTY,
    'invoices.retrieve': (id: string) => (id === VOIDED_INV.id ? VOIDED_INV : { ...fx('pr2-inv-paid'), id }),
    'subscriptions.cancel': () => {
      current = CANCELED;
      return CANCELED;
    },
  });
});

describe('agent_end_now_cancel handler', () => {
  it('cancels once with the row key, mirrors canceled; a second run cancels nothing more', async () => {
    await handleEndNowCancelRow(row, ctx());
    await handleEndNowCancelRow({ ...row, attempts: 2 }, ctx());
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([
      [ACTIVE.id, { prorate: false, invoice_now: false }, { idempotencyKey: outboxIdempotencyKey(row, 'cancel') }],
    ]);
    expect(db.rows('billing_subscriptions')[0]).toMatchObject({ status: 'canceled', paused: false });
  });

  it('an open invoice reappeared -> parked, nothing cancelled', async () => {
    stripe.impl['invoices.list'] = () => fx('pr2-invoices-list-sub-open');
    await expect(handleEndNowCancelRow(row, ctx())).rejects.toBeInstanceOf(NonRetryableOutboxError);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
  });

  it('C-END-OUTBOX-NEWCYCLE (SR RC1b): a new-cycle invoice was created and paid before the drain [EDITED latest_invoice] -> parked, nothing cancelled', async () => {
    current = { ...clone(ACTIVE), latest_invoice: 'in_EDITED_newcycle' };
    await expect(handleEndNowCancelRow(row, ctx())).rejects.toBeInstanceOf(NonRetryableOutboxError);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
  });

  it('C-END-OUTBOX-NOT-VOID (SR RC1b): the voided invoice no longer reads void [EDITED status paid] -> parked, nothing cancelled', async () => {
    stripe.impl['invoices.retrieve'] = (id: string) => ({ ...VOIDED_INV, id, status: 'paid' });
    await expect(handleEndNowCancelRow(row, ctx())).rejects.toBeInstanceOf(NonRetryableOutboxError);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
  });

  it('a row queued before RC1b (no voided_invoice_ids) -> parked as bad_payload, zero Stripe calls', async () => {
    await expect(handleEndNowCancelRow({ ...row, payload: { subscription_id: ACTIVE.id } }, ctx())).rejects.toThrow('bad_payload');
    expect(stripe.ops()).toEqual([]);
  });

  it('the subscription belongs to another user\'s customer -> parked, nothing cancelled', async () => {
    current = { ...clone(ACTIVE), customer: 'cus_EDITED_other' };
    await expect(handleEndNowCancelRow(row, ctx())).rejects.toBeInstanceOf(NonRetryableOutboxError);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
  });
});
