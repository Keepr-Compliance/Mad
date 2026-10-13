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
 *   - pr2-sub-past_due.latest_invoice IS the open renewal (same id), so the
 *     step-3 re-fetch of the latest invoice is served VOIDED once voided.
 * The SR trace ran on another TEST subscription than pr2-sub-past_due; the
 * outcome objects are served for it [COMPOSED]. No network.
 */

import fs from 'fs';
import path from 'path';
import { BillingDb } from '../../helpers/billingDb';
import { clone, createStripeStub, stripeError, type StripeStub } from '../../helpers/stripeStub';

const mockCaptureMessage = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCaptureMessage(...a), captureException: jest.fn() }));

import { endPlanNow, endNowVoidKey, END_NOW_KIND } from '@/lib/billing/endPlanNow';
import { mirrorState } from '@/lib/billing/sync';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../fixtures/stripe/p3848');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));

const SUB = fx('pr2-sub-past_due');
const OPEN_LIST = fx('pr2-invoices-list-sub-open');
const INV = OPEN_LIST.data[0];
const VOIDED = { ...fx('SR-VOID-inv-voided'), id: INV.id }; // [COMPOSED] SR trace object under this invoice id
const CANCELED = { ...fx('SR-VOID-sub-canceled'), id: SUB.id, customer: SUB.customer }; // [COMPOSED]
// TEST trace, fix-up round 1 (README "Fix-up round 1"): R1 marked uncollectible.
const UNCOLLECTIBLE_RACE = fx('F1-RN-inv-uncollectible'); // outside the draft hour, marked after the status read
const UNCOLLECTIBLE_DRAFT_HOUR = fx('F1-DU-inv-uncollectible'); // marked in the draft hour
const USER = 'USER-3848-END';
const OTHER = 'USER-3848-OTHER';
const NOW = new Date('2026-10-13T06:00:30Z');
const MINUTE_BUCKET = Math.floor(NOW.getTime() / 60_000);

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

async function run(now: Date = NOW) {
  return endPlanNow({ stripe: stripe.client, service: { from: db.from } as never, mode: 'test', userId: USER, subscriptionId: SUB.id, now });
}
const mine = () => db.rows('billing_subscriptions').find((r) => r.id === 'row-mine')!;

beforeEach(() => {
  jest.clearAllMocks();
  seed();
  stripe = createStripeStub({
    'subscriptions.retrieve': () => SUB,
    'invoices.list': () => OPEN_LIST,
    'invoices.voidInvoice': () => VOIDED,
    // Step 3 re-fetch of SUB.latest_invoice (= INV.id) after the void.
    'invoices.retrieve': (id: string) => ({ ...VOIDED, id }),
    'subscriptions.cancel': () => CANCELED,
  });
});

describe('endPlanNow (R4)', () => {
  it('C-END-ORDER: status read, open invoices listed, every one voided, THEN cancel; mirror row canceled, paused false', async () => {
    expect(await run()).toBe('ended');
    expect(stripe.ops()).toEqual(['subscriptions.retrieve', 'invoices.list', 'invoices.voidInvoice', 'invoices.retrieve', 'subscriptions.cancel']);
    expect(stripe.callsTo('invoices.voidInvoice')).toEqual([[INV.id, {}, { idempotencyKey: `end-now-void:${INV.id}:${MINUTE_BUCKET}` }]]);
    expect(stripe.callsTo('invoices.retrieve')).toEqual([[SUB.latest_invoice]]);
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
        payload: { subscription_id: SUB.id, voided_invoice_ids: [INV.id] },
      }),
    ]);
    expect(mockCaptureMessage).toHaveBeenCalledWith('billing alert: end_now_cancel_failed', expect.anything());
  });

  it('C-END-LIST-EMPTY (SR RC1): the renewal was paid after the status read, before the list -> nothing to void, latest invoice reads paid -> paid_meanwhile, zero cancel', async () => {
    // [EDITED data: []] the list as Stripe answers once the renewal is paid; pr2-inv-paid served under the latest invoice id [COMPOSED].
    stripe.impl['invoices.list'] = () => ({ ...clone(OPEN_LIST), data: [] });
    stripe.impl['invoices.retrieve'] = (id: string) => ({ ...fx('pr2-inv-paid'), id });
    expect(await run()).toBe('paid_meanwhile');
    expect(stripe.callsTo('invoices.retrieve')).toEqual([[SUB.latest_invoice]]);
    expect(stripe.callsTo('invoices.voidInvoice')).toEqual([]);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
    expect(mine()).toMatchObject({ status: 'past_due' });
    expect(db.rows('billing_outbox')).toEqual([]);
  });

  it('C-END-LATEST-OPEN: after the voids the latest invoice still reads open [served INV] -> try_again, zero cancel', async () => {
    stripe.impl['invoices.list'] = () => ({ ...clone(OPEN_LIST), data: [] }); // [EDITED data: []]
    stripe.impl['invoices.retrieve'] = () => INV;
    expect(await run()).toBe('try_again');
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
  });

  it('C-END-UNCOLLECTIBLE (SR ruling Q3, TEST race RN): the latest renewal reads uncollectible after the status read -> ended, one cancel, it is NOT voided', async () => {
    // TEST: status read past_due, R1 marked uncollectible, then nothing open; F1-RN-inv-uncollectible served under SUB.latest_invoice [COMPOSED].
    stripe.impl['invoices.list'] = () => ({ ...clone(OPEN_LIST), data: [] }); // [EDITED data: []] as Stripe answered once R1 was uncollectible
    stripe.impl['invoices.retrieve'] = (id: string) => ({ ...UNCOLLECTIBLE_RACE, id });
    expect(await run()).toBe('ended');
    // The TEST trace's own op sequence.
    expect(stripe.ops()).toEqual(['subscriptions.retrieve', 'invoices.list', 'invoices.retrieve', 'subscriptions.cancel']);
    expect(stripe.callsTo('invoices.voidInvoice')).toEqual([]);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([
      [SUB.id, { prorate: false, invoice_now: false }, { idempotencyKey: `end-now-cancel:${SUB.id}` }],
    ]);
    expect(mine()).toMatchObject({ status: 'canceled', paused: false });
  });

  it('C-END-UNCOLLECTIBLE-CANCEL-FAIL: a failed cancel queues the uncollectible invoice id (not as voided)', async () => {
    stripe.impl['invoices.list'] = () => ({ ...clone(OPEN_LIST), data: [] }); // [EDITED data: []]
    stripe.impl['invoices.retrieve'] = (id: string) => ({ ...UNCOLLECTIBLE_RACE, id }); // [COMPOSED]
    stripe.impl['subscriptions.cancel'] = () => {
      throw Object.assign(new Error('api down'), { type: 'StripeAPIError' });
    };
    expect(await run()).toBe('finalizing');
    expect(db.rows('billing_outbox')).toEqual([
      expect.objectContaining({ payload: { subscription_id: SUB.id, voided_invoice_ids: [], uncollectible_invoice_id: SUB.latest_invoice } }),
    ]);
  });

  it('C-END-VOID-KEY: a double submit in the same minute reuses the void key; a retry a minute later gets a fresh one', async () => {
    await run(NOW);
    seed();
    await run(new Date(NOW.getTime() + 20_000)); // same minute bucket
    seed();
    await run(new Date(NOW.getTime() + 60_000)); // next bucket
    const keys = stripe.callsTo('invoices.voidInvoice').map((a) => a[2].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[2]).toBe(endNowVoidKey(INV.id, new Date(NOW.getTime() + 60_000)));
  });

  it('S3: a write-through that matches no mirror row is logged (the webhook writes it later)', async () => {
    db.rows('billing_subscriptions').splice(0, db.rows('billing_subscriptions').length);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await run()).toBe('ended');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('matched no mirror row'));
    warn.mockRestore();
  });

  it.each([
    ['active (SR trace, after a void)', () => fx('SR-VOID-sub-after-void')],
    ['active (TEST NU: R1 marked uncollectible at rest, outside the draft hour)', () => fx('F1-NU-sub-after-mark')],
    ['unpaid [EDITED status]', () => ({ ...clone(SUB), status: 'unpaid' })],
    ['canceled', () => CANCELED],
  ])('status gate before any write: Stripe says %s -> not_now, nothing voided or cancelled', async (_n, sub) => {
    stripe.impl['subscriptions.retrieve'] = () => sub();
    expect(await run()).toBe('not_now');
    expect(stripe.ops()).toEqual(['subscriptions.retrieve']);
    expect(db.calls.filter((c) => c.op !== 'select')).toEqual([]);
  });
});

/**
 * Draft hour (BACKLOG-3848 go-live; SR ruling, delta review D4). The latest
 * invoice is the next cycle's DRAFT while the previous renewal decides.
 * SR-DRAFT-inv-draft is the TEST draft [COMPOSED: its subscription ids set to
 * SUB.id; `created` one day after INV so it is the newest, as in the trace].
 * The previous renewal is INV (the open renewal), served void (VOIDED), paid
 * (pr2-inv-paid) or open (INV) under INV.id. OLDER is a renewal one cycle
 * earlier [COMPOSED from pr2-inv-paid / VOIDED, edited id and created] whose
 * status is the opposite of the case's, so a decision on the wrong renewal
 * reads differently.
 */
describe('endPlanNow draft hour (previous renewal decides)', () => {
  const DRAFT_RAW = fx('SR-DRAFT-inv-draft');
  const DRAFT: Obj = {
    ...DRAFT_RAW,
    subscription: SUB.id,
    parent: { ...DRAFT_RAW.parent, subscription_details: { ...DRAFT_RAW.parent.subscription_details, subscription: SUB.id } },
    created: INV.created + 86_400,
  };
  const SUB_DRAFT = { ...clone(SUB), latest_invoice: DRAFT.id }; // [EDITED latest_invoice]
  const older = (status: 'paid' | 'void') =>
    ({ ...(status === 'paid' ? fx('pr2-inv-paid') : fx('SR-VOID-inv-voided')), id: 'in_EDITED_older', subscription: SUB.id, created: INV.created - 86_400 });

  function serve(opts: { open: Obj[]; previous: Obj; olderStatus: 'paid' | 'void'; newer?: Obj[] }) {
    stripe.impl['subscriptions.retrieve'] = () => SUB_DRAFT;
    stripe.impl['invoices.list'] = (params: Obj) =>
      params.status === 'open'
        ? { ...clone(OPEN_LIST), data: opts.open }
        : { ...clone(OPEN_LIST), data: [DRAFT, ...(opts.newer ?? []), opts.previous, older(opts.olderStatus)] }; // newest first, as Stripe lists
    stripe.impl['invoices.retrieve'] = (id: string) => (id === DRAFT.id ? DRAFT : opts.previous);
  }

  it('C-DRAFT-VOIDED: previous renewal voided by this run, latest is a draft -> ended, one cancel, the draft is never touched', async () => {
    serve({ open: [INV], previous: { ...VOIDED, id: INV.id, created: INV.created }, olderStatus: 'paid' });
    expect(await run()).toBe('ended');
    expect(stripe.callsTo('invoices.voidInvoice').map((a) => a[0])).toEqual([INV.id]);
    expect(stripe.callsTo('invoices.list').map((a) => a[0])).toEqual([
      { subscription: SUB.id, status: 'open', limit: 100 },
      { subscription: SUB.id, limit: 100 },
    ]);
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([
      [SUB.id, { prorate: false, invoice_now: false }, { idempotencyKey: `end-now-cancel:${SUB.id}` }],
    ]);
    expect(stripe.ops().filter((o) => o.startsWith('invoices.') && !['invoices.list', 'invoices.retrieve', 'invoices.voidInvoice'].includes(o))).toEqual([]);
    expect(mine()).toMatchObject({ status: 'canceled', paused: false });
  });

  it('C-DRAFT-PAID (RC1 in the draft hour): previous renewal paid after the status read -> paid_meanwhile, zero cancel', async () => {
    serve({ open: [], previous: { ...fx('pr2-inv-paid'), id: INV.id }, olderStatus: 'void' }); // [EDITED data: []] nothing open once paid
    expect(await run()).toBe('paid_meanwhile');
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
    expect(mine()).toMatchObject({ status: 'past_due' });
    expect(db.rows('billing_outbox')).toEqual([]);
  });

  it('C-DRAFT-UNCOLLECTIBLE (TEST DU): previous renewal marked uncollectible in the draft hour -> ended, one cancel, nothing voided', async () => {
    // TEST: after the mark the sub still read past_due with the draft latest (F1-DU-sub-after-mark), nothing open.
    // F1-DU-inv-uncollectible served under INV.id [COMPOSED]; OLDER paid.
    serve({ open: [], previous: { ...UNCOLLECTIBLE_DRAFT_HOUR, id: INV.id, created: INV.created }, olderStatus: 'paid' });
    expect(await run()).toBe('ended');
    // The TEST trace's own op sequence.
    expect(stripe.ops()).toEqual(['subscriptions.retrieve', 'invoices.list', 'invoices.retrieve', 'invoices.list', 'subscriptions.cancel']);
    expect(stripe.callsTo('subscriptions.cancel')).toHaveLength(1);
    expect(mine()).toMatchObject({ status: 'canceled', paused: false });
  });

  it('C-DRAFT-ANY-REASON: previous cycle renewal paid, a NEWER finalized non-cycle invoice reads void -> paid_meanwhile, zero cancel', async () => {
    // [EDITED] the subscription_create invoice of invoices-list-pastdue: subscription SUB.id, status void, created after INV.
    const createInv = fx('invoices-list-pastdue').data.find((i: Obj) => i.billing_reason === 'subscription_create');
    const nonCycle = { ...createInv, id: 'in_EDITED_noncycle', subscription: SUB.id, status: 'void', created: INV.created + 3_600 };
    serve({ open: [], previous: { ...fx('pr2-inv-paid'), id: INV.id, created: INV.created }, olderStatus: 'void', newer: [nonCycle] });
    expect(await run()).toBe('paid_meanwhile');
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
    expect(mine()).toMatchObject({ status: 'past_due' });
    expect(db.rows('billing_outbox')).toEqual([]);
  });

  it('C-DRAFT-OPEN: previous renewal still open [EDITED: open list served empty] -> try_again, zero cancel', async () => {
    serve({ open: [], previous: INV, olderStatus: 'void' });
    expect(await run()).toBe('try_again');
    expect(stripe.callsTo('subscriptions.cancel')).toEqual([]);
    expect(mine()).toMatchObject({ status: 'past_due' });
  });

  it('C-DRAFT-CANCEL-FAIL: a failed cancel in the draft hour queues the draft and the previous renewal in the payload', async () => {
    serve({ open: [INV], previous: { ...VOIDED, id: INV.id, created: INV.created }, olderStatus: 'paid' });
    stripe.impl['subscriptions.cancel'] = () => {
      throw Object.assign(new Error('api down'), { type: 'StripeAPIError' });
    };
    expect(await run()).toBe('finalizing');
    expect(db.rows('billing_outbox')).toEqual([
      expect.objectContaining({
        payload: { subscription_id: SUB.id, voided_invoice_ids: [INV.id], draft_invoice_id: DRAFT.id, previous_renewal_id: INV.id },
      }),
    ]);
  });
});
