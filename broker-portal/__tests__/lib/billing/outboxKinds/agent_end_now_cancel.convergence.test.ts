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

  it('C-END-OUTBOX-NOT-MINE (SR RC1b): the latest invoice is void but not one this row voided [EDITED latest_invoice; SR-VOID-inv-voided served under it] -> parked, nothing cancelled', async () => {
    current = { ...clone(ACTIVE), latest_invoice: 'in_EDITED_voided_elsewhere' };
    stripe.impl['invoices.retrieve'] = (id: string) => ({ ...VOIDED_INV, id });
    await expect(handleEndNowCancelRow(row, ctx())).rejects.toBeInstanceOf(NonRetryableOutboxError);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
  });

  it('C-END-OUTBOX-NOT-VOID (SR RC1b): the voided invoice no longer reads void [EDITED status paid] -> parked, nothing cancelled', async () => {
    stripe.impl['invoices.retrieve'] = (id: string) => ({ ...VOIDED_INV, id, status: 'paid' });
    await expect(handleEndNowCancelRow(row, ctx())).rejects.toBeInstanceOf(NonRetryableOutboxError);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
  });

  it('C-END-OUTBOX-UNCOLLECTIBLE (SR ruling Q3): the latest invoice is the uncollectible one End plan now read [TEST F1-RN-inv-uncollectible under its id] -> cancels once', async () => {
    // TEST RN: after the mark the sub read active (ACTIVE), latest invoice unchanged.
    const uRow: OutboxRow = { ...row, payload: { subscription_id: ACTIVE.id, voided_invoice_ids: [], uncollectible_invoice_id: ACTIVE.latest_invoice } };
    stripe.impl['invoices.retrieve'] = (id: string) => ({ ...fx('F1-RN-inv-uncollectible'), id });
    await handleEndNowCancelRow(uRow, ctx());
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([
      [ACTIVE.id, { prorate: false, invoice_now: false }, { idempotencyKey: outboxIdempotencyKey(uRow, 'cancel') }],
    ]);
    expect(db.rows('billing_subscriptions')[0]).toMatchObject({ status: 'canceled', paused: false });
  });

  it('C-END-OUTBOX-UNCOLLECTIBLE-NOT-MINE: the latest invoice reads uncollectible but this row neither voided nor read it -> parked, nothing cancelled', async () => {
    const uRow: OutboxRow = { ...row, payload: { subscription_id: ACTIVE.id, voided_invoice_ids: [], uncollectible_invoice_id: 'in_EDITED_other' } };
    stripe.impl['invoices.retrieve'] = (id: string) => ({ ...fx('F1-RN-inv-uncollectible'), id }); // [COMPOSED]
    await expect(handleEndNowCancelRow(uRow, ctx())).rejects.toThrow('latest_invoice_not_voided_here');
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

/**
 * Draft hour (BACKLOG-3848 go-live; SR ruling D4): the row was queued while
 * the latest invoice was the next cycle's draft. SR-DRAFT-inv-draft (TEST)
 * [COMPOSED: subscription ids set to ACTIVE.id, created after the previous
 * renewal]; the sub is ACTIVE [EDITED status past_due — the SR trace read
 * past_due in the draft hour — and latest_invoice = the draft]. The previous
 * renewal is SR-VOID-inv-voided (ACTIVE.latest_invoice), served void, paid
 * (pr2-inv-paid) or open [COMPOSED under its id]. OLDER is one cycle earlier,
 * with the opposite status.
 */
describe('agent_end_now_cancel handler, draft hour', () => {
  const DRAFT_RAW = fx('SR-DRAFT-inv-draft');
  const PREV_ID = VOIDED_INV.id;
  const DRAFT = {
    ...DRAFT_RAW,
    subscription: ACTIVE.id,
    parent: { ...DRAFT_RAW.parent, subscription_details: { ...DRAFT_RAW.parent.subscription_details, subscription: ACTIVE.id } },
    created: VOIDED_INV.created + 86_400,
  };
  const draftRow: OutboxRow = {
    ...row,
    payload: { subscription_id: ACTIVE.id, voided_invoice_ids: [PREV_ID], draft_invoice_id: DRAFT.id, previous_renewal_id: PREV_ID },
  };
  const older = (status: 'paid' | 'void') =>
    ({ ...(status === 'paid' ? fx('pr2-inv-paid') : VOIDED_INV), id: 'in_EDITED_older', subscription: ACTIVE.id, created: VOIDED_INV.created - 86_400 });

  function serve(previous: Obj, olderStatus: 'paid' | 'void', draft: Obj = DRAFT, newer: Obj[] = []) {
    current = { ...clone(ACTIVE), status: 'past_due', latest_invoice: DRAFT.id };
    stripe.impl['invoices.list'] = (params: Obj) =>
      params.status === 'open' ? EMPTY : { ...EMPTY, data: [draft, ...newer, previous, older(olderStatus)] };
    stripe.impl['invoices.retrieve'] = (id: string) => (id === DRAFT.id ? draft : previous);
  }

  it('C-DRAFT-OUTBOX-VOIDED: draft still a draft, previous renewal void -> cancels once, mirrors canceled', async () => {
    serve(VOIDED_INV, 'paid');
    await handleEndNowCancelRow(draftRow, ctx());
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([
      [ACTIVE.id, { prorate: false, invoice_now: false }, { idempotencyKey: outboxIdempotencyKey(draftRow, 'cancel') }],
    ]);
    expect(db.rows('billing_subscriptions')[0]).toMatchObject({ status: 'canceled', paused: false });
  });

  it('C-DRAFT-OUTBOX-PAID: previous renewal now paid [pr2-inv-paid under its id] -> parked, nothing cancelled', async () => {
    serve({ ...fx('pr2-inv-paid'), id: PREV_ID, created: VOIDED_INV.created }, 'void');
    await expect(handleEndNowCancelRow(draftRow, ctx())).rejects.toBeInstanceOf(NonRetryableOutboxError);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
  });

  it('C-DRAFT-OUTBOX-UNCOLLECTIBLE (TEST DU): previous renewal marked uncollectible in the draft hour [F1-DU-inv-uncollectible under its id] -> cancels once', async () => {
    serve({ ...fx('F1-DU-inv-uncollectible'), id: PREV_ID, created: VOIDED_INV.created }, 'paid');
    const uRow: OutboxRow = { ...draftRow, payload: { ...draftRow.payload, voided_invoice_ids: [] } };
    await handleEndNowCancelRow(uRow, ctx());
    expect(stripe.callsTo('subscriptions.cancel')).toHaveLength(1);
  });

  it('C-DRAFT-OUTBOX-ANY-REASON: previous cycle renewal paid, a NEWER finalized non-cycle invoice reads void -> parked as paid, nothing cancelled', async () => {
    // [EDITED] the subscription_create invoice of invoices-list-pastdue: subscription ACTIVE.id, status void, created after the previous renewal.
    const createInv = fx('invoices-list-pastdue').data.find((i: Obj) => i.billing_reason === 'subscription_create');
    const nonCycle = { ...createInv, id: 'in_EDITED_noncycle', subscription: ACTIVE.id, status: 'void', created: VOIDED_INV.created + 3_600 };
    serve({ ...fx('pr2-inv-paid'), id: PREV_ID, created: VOIDED_INV.created }, 'void', DRAFT, [nonCycle]);
    await expect(handleEndNowCancelRow(draftRow, ctx())).rejects.toThrow('previous_renewal_paid_meanwhile');
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
  });

  it('C-DRAFT-OUTBOX-OPEN: previous renewal reads open [EDITED status; open list served empty] -> parked, nothing cancelled', async () => {
    serve({ ...VOIDED_INV, status: 'open' }, 'void');
    await expect(handleEndNowCancelRow(draftRow, ctx())).rejects.toBeInstanceOf(NonRetryableOutboxError);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
  });

  it('C-DRAFT-OUTBOX-FINALIZED: the draft was finalized before the drain [EDITED status open] -> parked, nothing cancelled', async () => {
    serve(VOIDED_INV, 'paid', { ...DRAFT, status: 'open' });
    await expect(handleEndNowCancelRow(draftRow, ctx())).rejects.toThrow('draft_now_open');
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
  });
});
