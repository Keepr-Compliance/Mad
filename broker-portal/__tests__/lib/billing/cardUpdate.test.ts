/**
 * @jest-environment node
 *
 * BACKLOG-3848 — Update card: applyCardUpdate / payAfterCardUpdate.
 *
 * Stripe objects: fixtures/stripe/p3848 (TEST, acacia; README). One customer
 * whose Agent subscription went past_due on a failing card; a setup-mode
 * Checkout session created with the action's own parameters; a SetupIntent
 * confirmed with pm_card_visa on that customer. Stripe refuses to confirm a
 * Checkout-made SetupIntent through the API ("You cannot confirm SetupIntents
 * created by Checkout"), so the session is served with `status` [EDITED]
 * complete and its setup_intent id answered by the standalone succeeded
 * SetupIntent of the SAME customer [COMPOSED].
 * Our rows (stripe_customers, organizations, billing_subscriptions, licenses)
 * live in BillingDb. No network.
 */

import fs from 'fs';
import path from 'path';
import { BillingDb, type Row } from '../../helpers/billingDb';
import { clone, createStripeStub, stripeError, type StripeStub } from '../../helpers/stripeStub';

const mockCaptureMessage = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCaptureMessage(...a), captureException: jest.fn() }));

import { applyCardUpdate, payAfterCardUpdate } from '@/lib/billing/cardUpdate';
import { mirrorState } from '@/lib/billing/sync';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../fixtures/stripe/p3848');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));

const CS_OPEN = fx('pr2-cs-setup-open');
const CS = { ...clone(CS_OPEN), status: 'complete' }; // [EDITED] captured open
const SI = fx('pr2-seti-succeeded');
const SI_BEFORE = fx('pr2-seti-before');
const SUB_PD = fx('pr2-sub-past_due');
const SUB_ACTIVE = fx('pr2-sub-after-pay');
const INV_OPEN = fx('pr2-inv-open');
const INV_PAID = fx('pr2-inv-paid');
const INV_AFTER_3DS = fx('pr2-inv-after-3ds');
const CUS_ID = CS.customer as string;
const PM = SI.payment_method as string;
/** The customer as Stripe returned it after the default was set; [EDITED] default back to the failing card for "before". */
const CUS_BEFORE = (() => {
  const c = fx('pr2-cus-update-default');
  c.invoice_settings.default_payment_method = SUB_PD.default_payment_method;
  return c;
})();
const CUS_AFTER = fx('pr2-cus-update-default');

const USER = 'USER-3848-PR2-ROW'; // synthetic; differs from the session's metadata user on purpose
const ORG = 'ORG-3848-PR2';
const OTHER = 'USER-3848-OTHER';

let db: BillingDb;
let stripe: StripeStub;
let subQueue: Obj[];

function seed(over: { mirror?: Row | null; customerRow?: Row; licences?: Row[]; isTest?: boolean } = {}): void {
  db = new BillingDb({
    organizations: [{ id: ORG, personal_owner_user_id: USER, is_test: over.isTest ?? true }],
    stripe_customers: [
      over.customerRow ?? { user_id: USER, stripe_customer_id: CUS_ID, default_payment_method_id: 'pm_SEEDED_old', stripe_mode: 'test' },
    ],
    billing_subscriptions:
      over.mirror === null
        ? []
        : [over.mirror ?? { id: 'row-1', stripe_mode: 'test', user_id: USER, stripe_subscription_id: SUB_PD.id, ...mirrorState(SUB_PD as never) }],
    licenses: over.licences ?? [],
  });
}

function ctx() {
  return { service: { from: db.from } as never, stripe: stripe.client, mode: 'test' as const };
}

beforeEach(() => {
  jest.clearAllMocks();
  seed();
  subQueue = [SUB_PD, SUB_PD, SUB_ACTIVE];
  const invoices: Record<string, Obj[]> = { [INV_OPEN.id]: [INV_OPEN] };
  stripe = createStripeStub({
    'checkout.sessions.retrieve': (id: string) => (id === CS.id ? CS : Promise.reject(new Error('no session'))),
    'setupIntents.retrieve': (id: string) => (id === CS.setup_intent ? SI : Promise.reject(new Error('no si'))), // [COMPOSED]
    'customers.retrieve': () => CUS_BEFORE,
    'customers.update': () => CUS_AFTER,
    'subscriptions.retrieve': () => (subQueue.length > 1 ? subQueue.shift() : subQueue[0]),
    'subscriptions.update': () => fx('pr2-sub-update-default'),
    'invoices.retrieve': (id: string) => {
      const q = invoices[id];
      if (!q) throw new Error(`no invoice ${id}`);
      return q.length > 1 ? q.shift() : q[0];
    },
    'invoices.pay': () => {
      invoices[INV_OPEN.id] = [INV_PAID];
      return INV_PAID;
    },
  });
});

const cardWrites = () => db.callsTo('stripe_customers', 'update');
const writesOf = (s: StripeStub) => s.ops().filter((o) => /update|pay|cancel|void|create/.test(o));

describe('C-SETUP: a completed Update-card session', () => {
  it('fixture check: the renewal line pays the current period (the 3846 grant rule holds for the real invoice)', () => {
    expect(INV_OPEN.lines.data.find((l: Obj) => l.type === 'subscription').period.end).toBe(SUB_PD.current_period_end);
    expect([SI.status, SI.customer]).toEqual(['succeeded', CUS_ID]);
    expect(CS.metadata).toEqual({ kind: 'agent_card_update', user_id: 'USER-3848-PR2' });
  });

  it('writes customer default, subscription default, stored card (in that order), then pays the open renewal with the new card', async () => {
    const out = await applyCardUpdate(ctx(), CS.id, { onPayError: 'throw' });
    expect(out).toEqual({ kind: 'updated', paymentMethodId: PM, pay: { kind: 'paid' } });
    expect(writesOf(stripe)).toEqual(['customers.update', 'subscriptions.update', 'invoices.pay']);
    expect(stripe.callsTo('customers.update')).toEqual([[CUS_ID, { invoice_settings: { default_payment_method: PM } }]]);
    expect(stripe.callsTo('subscriptions.update')).toEqual([[SUB_PD.id, { default_payment_method: PM }]]);
    expect(stripe.callsTo('invoices.pay')).toEqual([
      [INV_OPEN.id, { payment_method: PM }, { idempotencyKey: `card-update-pay:${INV_OPEN.id}:${PM}` }],
    ]);
    expect(db.rows('stripe_customers')[0].default_payment_method_id).toBe(PM);
    expect(cardWrites().map((c) => c.payload!.default_payment_method_id)).toEqual([PM]);
  });

  it('C-SETUP-OWNER: the user is the stored customer row, not session metadata (metadata names someone else)', async () => {
    expect(CS.metadata.user_id).not.toBe(USER);
    const out = await applyCardUpdate(ctx(), CS.id, { callerUserId: USER, onPayError: 'report' });
    expect(out.kind).toBe('updated');
  });

  it('C-SETUP-OWNER: on the return page the session must be the caller\'s -> another caller is refused, zero writes', async () => {
    const out = await applyCardUpdate(ctx(), CS.id, { callerUserId: OTHER, onPayError: 'report' });
    expect(out).toEqual({ kind: 'refused', reason: 'not_caller' });
    expect(writesOf(stripe)).toEqual([]);
    expect(cardWrites()).toEqual([]);
  });

  it('a customer with no stored row in THIS mode (only a live row) -> refused, zero writes', async () => {
    seed({ customerRow: { user_id: USER, stripe_customer_id: CUS_ID, default_payment_method_id: null, stripe_mode: 'live' } });
    expect(await applyCardUpdate(ctx(), CS.id, { onPayError: 'throw' })).toEqual({ kind: 'refused', reason: 'unknown_customer' });
    expect(writesOf(stripe)).toEqual([]);
  });

  it.each([
    ['open (captured as is)', () => CS_OPEN, 'not_complete'],
    ['no kind [EDITED metadata {}]', () => ({ ...clone(CS), metadata: {} }), 'not_card_update'],
  ])('session %s -> refused, zero writes', async (_n, session, reason) => {
    stripe.impl['checkout.sessions.retrieve'] = () => session();
    expect(await applyCardUpdate(ctx(), CS.id, { onPayError: 'throw' })).toEqual({ kind: 'refused', reason });
    expect(writesOf(stripe)).toEqual([]);
    expect(cardWrites()).toEqual([]);
  });

  it('the same card already everywhere -> no write at all (a second caller is a no-op), no pay when the plan is active', async () => {
    seed({
      customerRow: { user_id: USER, stripe_customer_id: CUS_ID, default_payment_method_id: PM, stripe_mode: 'test' },
      mirror: { id: 'row-1', stripe_mode: 'test', user_id: USER, stripe_subscription_id: SUB_ACTIVE.id, ...mirrorState(SUB_ACTIVE as never) },
    });
    stripe.impl['customers.retrieve'] = () => CUS_AFTER;
    subQueue = [{ ...clone(SUB_ACTIVE), default_payment_method: PM }]; // [EDITED] default already the new card
    const out = await applyCardUpdate(ctx(), CS.id, { onPayError: 'throw' });
    expect(out).toEqual({ kind: 'updated', paymentMethodId: PM, pay: { kind: 'none' } });
    expect(writesOf(stripe)).toEqual([]);
    expect(cardWrites()).toEqual([]);
  });
});

describe('C-SETUP-SI: the SetupIntent decides', () => {
  it('SetupIntent not succeeded (the Checkout one before confirmation, captured) -> refused, zero writes', async () => {
    expect(SI_BEFORE.status).toBe('requires_payment_method');
    stripe.impl['setupIntents.retrieve'] = () => SI_BEFORE;
    expect(await applyCardUpdate(ctx(), CS.id, { onPayError: 'throw' })).toEqual({ kind: 'refused', reason: 'setup_not_succeeded' });
    expect(writesOf(stripe)).toEqual([]);
    expect(cardWrites()).toEqual([]);
  });

  it('SetupIntent of another customer [EDITED customer] -> refused, zero writes', async () => {
    stripe.impl['setupIntents.retrieve'] = () => ({ ...clone(SI), customer: 'cus_EDITED_other' });
    expect(await applyCardUpdate(ctx(), CS.id, { onPayError: 'throw' })).toEqual({ kind: 'refused', reason: 'setup_other_customer' });
    expect(writesOf(stripe)).toEqual([]);
    expect(cardWrites()).toEqual([]);
  });
});

describe('R3: paying the failed renewal', () => {
  const base = { subscriptionId: SUB_PD.id, customerId: CUS_ID, paymentMethodId: PM, suspended: false } as const;

  it('C-PAY-FRESH: mirror past_due but Stripe already active -> no pay', async () => {
    subQueue = [SUB_ACTIVE];
    expect(await payAfterCardUpdate(ctx(), { ...base, onError: 'throw' })).toEqual({ kind: 'none' });
    expect(stripe.callsTo('invoices.pay')).toEqual([]);
  });

  it('C-PAY-FRESH: mirror active but Stripe past_due -> paid (the mirror is never read for this)', async () => {
    seed({ mirror: { id: 'row-1', stripe_mode: 'test', user_id: USER, stripe_subscription_id: SUB_PD.id, ...mirrorState(SUB_ACTIVE as never) } });
    const out = await applyCardUpdate(ctx(), CS.id, { onPayError: 'throw' });
    expect(out).toMatchObject({ pay: { kind: 'paid' } });
    expect(stripe.callsTo('invoices.pay')).toHaveLength(1);
  });

  it('C-PAY-PREDICATE: the open invoice pays a period ending before the current one [EDITED line period.end - 1] -> no pay', async () => {
    const stale = clone(INV_OPEN);
    stale.lines.data[0].period.end = SUB_PD.current_period_end - 1;
    stripe.impl['invoices.retrieve'] = () => stale;
    expect(await payAfterCardUpdate(ctx(), { ...base, onError: 'throw' })).toEqual({ kind: 'none' });
    expect(stripe.callsTo('invoices.pay')).toEqual([]);
  });

  it('an open invoice of another customer [EDITED customer] -> no pay', async () => {
    stripe.impl['invoices.retrieve'] = () => ({ ...clone(INV_OPEN), customer: 'cus_EDITED_other' });
    expect(await payAfterCardUpdate(ctx(), { ...base, onError: 'throw' })).toEqual({ kind: 'none' });
    expect(stripe.callsTo('invoices.pay')).toEqual([]);
  });

  it('C-PAY-ALREADY: pay answers "Invoice is already paid" (captured) and the invoice reads paid -> success, no throw', async () => {
    let n = 0;
    stripe.impl['invoices.retrieve'] = () => (n++ === 0 ? INV_OPEN : INV_PAID);
    stripe.impl['invoices.pay'] = () => {
      throw stripeError(fx('pr2-pay-already-paid'));
    };
    expect(await payAfterCardUpdate(ctx(), { ...base, onError: 'throw' })).toEqual({ kind: 'paid' });
  });

  it('declined (captured card_declined) -> outcome "declined", never a throw, even on the webhook path', async () => {
    stripe.impl['invoices.pay'] = () => {
      throw stripeError(fx('SR-PAY-decline'));
    };
    expect(await payAfterCardUpdate(ctx(), { ...base, onError: 'throw' })).toEqual({ kind: 'declined' });
  });

  it('the bank wants confirmation (captured invoice_payment_intent_requires_action) -> action_required with the invoice page', async () => {
    let n = 0;
    stripe.impl['invoices.retrieve'] = () => (n++ === 0 ? INV_OPEN : INV_AFTER_3DS);
    stripe.impl['invoices.pay'] = () => {
      throw stripeError(fx('pr2-pay-auth-required'));
    };
    expect(await payAfterCardUpdate(ctx(), { ...base, onError: 'throw' })).toEqual({
      kind: 'action_required',
      invoiceUrl: INV_AFTER_3DS.hosted_invoice_url,
    });
  });

  it('a non-card error: the webhook path rethrows (Stripe retries); the return page reads "pending"', async () => {
    const boom = Object.assign(new Error('api down'), { type: 'StripeAPIError' });
    stripe.impl['invoices.pay'] = () => {
      throw boom;
    };
    await expect(payAfterCardUpdate(ctx(), { ...base, onError: 'throw' })).rejects.toBe(boom);
    subQueue = [SUB_PD];
    expect(await payAfterCardUpdate(ctx(), { ...base, onError: 'report' })).toEqual({ kind: 'not_paid', reason: 'pending' });
  });

  it('unpaid [EDITED status] -> not paid (untraced in TEST, SR R3f)', async () => {
    subQueue = [{ ...clone(SUB_PD), status: 'unpaid' }];
    expect(await payAfterCardUpdate(ctx(), { ...base, onError: 'throw' })).toEqual({ kind: 'not_paid', reason: 'unpaid' });
    expect(stripe.callsTo('invoices.pay')).toEqual([]);
  });

  it('suspended (licences row [SEEDED]) -> the card is saved, nothing is paid', async () => {
    seed({ licences: [{ id: 'lic-SEEDED', user_id: USER, status: 'suspended' }] });
    const out = await applyCardUpdate(ctx(), CS.id, { onPayError: 'throw' });
    expect(out).toEqual({ kind: 'updated', paymentMethodId: PM, pay: { kind: 'not_paid', reason: 'suspended' } });
    expect(stripe.callsTo('invoices.pay')).toEqual([]);
    expect(db.rows('stripe_customers')[0].default_payment_method_id).toBe(PM);
  });

  it('paused [EDITED pause_collection] -> nothing is paid', async () => {
    subQueue = [{ ...clone(SUB_PD), pause_collection: { behavior: 'void', resumes_at: null } }];
    expect(await payAfterCardUpdate(ctx(), { ...base, onError: 'throw' })).toEqual({ kind: 'not_paid', reason: 'paused' });
  });

  it('paid but the subscription is not active afterwards [served past_due again] -> alert', async () => {
    subQueue = [SUB_PD, SUB_PD];
    expect(await payAfterCardUpdate(ctx(), { ...base, onError: 'throw' })).toEqual({ kind: 'paid' });
    expect(mockCaptureMessage).toHaveBeenCalledWith('billing alert: card_update_pay_not_active', expect.anything());
  });
});
