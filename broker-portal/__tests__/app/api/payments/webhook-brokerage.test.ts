/**
 * @jest-environment node
 *
 * BACKLOG-3853 PR-2 — Stripe webhook -> brokerage subscription billing, through the route.
 *
 * Stripe objects: __tests__/fixtures/stripe/p3853 (TEST captures from the PR-0 spike, see its
 * README; edits marked there and [EDITED] here). Envelopes other than ev-sub-pastdue are
 * [SYNTHETIC]: the handler reads only id, type, created, livemode and data.object.id (E0).
 * Our rows: BillingDb + the brokerage RPC model (helpers/brokerageFake.ts). No network.
 *
 * Wall time is frozen at the past_due event's created time (2026-10-17): due dates in the
 * captures are test-clock time (2026-11-15 and later), so "now" must come from the clock.
 */

import fs from 'fs';
import path from 'path';
import { createBrokerageFake, dealRow, type BrokerageFake } from '../../../helpers/brokerageFake';

const mockConstructEvent = jest.fn();
const mockCaptureMessage = jest.fn();
const mockRetrieve = jest.fn();
const mockInvoicesList = jest.fn();
let fake: BrokerageFake;

jest.mock('@sentry/nextjs', () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  captureException: jest.fn(),
}));
jest.mock('@/lib/email', () => ({}));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: () => fake.service }));
jest.mock('stripe', () => {
  const r = (kind: string) => (id: string, params?: unknown) => mockRetrieve(kind, id, params);
  const StripeMock = jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent: mockConstructEvent },
    subscriptions: { retrieve: r('subscription') },
    invoices: { retrieve: r('invoice'), list: (...a: unknown[]) => mockInvoicesList(...a) },
    charges: { retrieve: r('charge') },
    disputes: { retrieve: r('dispute') },
    paymentIntents: { retrieve: r('payment_intent') },
    customers: { retrieve: r('customer') },
    checkout: { sessions: { retrieve: r('checkout.session') } },
    testHelpers: { testClocks: { retrieve: r('test_clock') } },
  }));
  return { __esModule: true, default: StripeMock };
});

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../../fixtures/stripe/p3853');
const fx = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX, `${n}.json`), 'utf8'));
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

const ORG = 'ORG-3853-A';
const SUB_PASTDUE = fx('sub-pastdue');
const SUB_ACTIVE = fx('sub-after-pay');
const CUS = fx('customer');
const INV_LIST = fx('inv-list-open');
const INV_PAID = fx('inv-paid');
const PI_OPEN = fx('pi-open');
const PI_ACTION = fx('pi-requires-action');
const EV_PASTDUE = fx('ev-sub-pastdue');
const CUSTOMER_ID = CUS.id as string;
const OLDEST = INV_LIST.data[INV_LIST.data.length - 1]; // due 1794754800
const SECOND = INV_LIST.data[INV_LIST.data.length - 2]; // due 1797346800
/** Clock A [EDITED frozen_time]: one hour past the oldest invoice's due date. */
const CLOCK_PAST_FIRST_DUE: Obj = { ...fx('clock'), frozen_time: OLDEST.due_date + 3600 };
const WALL_NOW_MS = EV_PASTDUE.created * 1000;

let objects: Map<string, Obj>;
const serve = (...objs: Obj[]) => objs.forEach((o) => objects.set(o.id, o));
const serveAs = (id: string, o: Obj) => objects.set(id, o);
let openInvoices: Obj[];

function envelope(type: string, objectId: string, created = EV_PASTDUE.created + 60, id = `evt_3853_${type}`): Obj {
  // [SYNTHETIC] envelope: only what the route reads.
  return { id, object: 'event', type, created, livemode: false, data: { object: { id: objectId } } };
}

async function deliver(event: Obj): Promise<Response> {
  mockConstructEvent.mockReturnValue(event);
  const { POST } = await import('@/app/api/payments/webhook/route');
  return POST(new Request('https://x/api/payments/webhook', { method: 'POST', headers: { 'stripe-signature': 'ok' }, body: 'raw' }));
}

const outbox = () => fake.db.rows('billing_outbox');
const amRows = (reason?: string) =>
  outbox().filter((r) => r.kind === 'notify_account_manager' && (!reason || (r.payload as Obj).reason === reason));
const mirror = () => fake.db.rows('org_billing_stripe').find((r) => r.organization_id === ORG)!;
const deal = () => fake.db.rows('org_deals').find((r) => r.organization_id === ORG)!;
const agentRefusals = () => mockCaptureMessage.mock.calls.filter((c) => c[0] === 'Stripe billing event refused');
const alerts = (name: string) => mockCaptureMessage.mock.calls.filter((c) => c[0] === `billing alert: ${name}`);
const retrieves = (kind: string) => mockRetrieve.mock.calls.filter((c) => c[0] === kind);

function seed(over: { deal?: Obj; mirror?: Obj; noMirror?: boolean } = {}) {
  fake = createBrokerageFake({
    organizations: [{ id: ORG, name: 'Brokerage 3853', is_test: true }],
    org_deals: [dealRow(ORG, over.deal ?? {})],
    org_billing_stripe: over.noMirror
      ? []
      : [
          {
            organization_id: ORG,
            stripe_mode: 'test',
            stripe_customer_id: CUSTOMER_ID,
            stripe_subscription_id: SUB_PASTDUE.id,
            status: 'active',
            cancel_at_period_end: false,
            last_event_created: null,
            ...(over.mirror ?? {}),
          },
        ],
    billing_outbox: [],
    stripe_customers: [],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(WALL_NOW_MS);
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'whsec_dummy';
  objects = new Map();
  openInvoices = clone(INV_LIST.data);
  mockRetrieve.mockImplementation(async (kind: string, id: string) => {
    const o = objects.get(id);
    if (!o) throw new Error(`test: no ${kind} re-fetch registered for ${id}`);
    return clone(o);
  });
  mockInvoicesList.mockImplementation(async (p: Obj) => ({
    object: 'list',
    data: clone(openInvoices.filter((i) => i.customer === p.customer && (!p.status || i.status === p.status))),
    has_more: false,
  }));
  serve(SUB_PASTDUE, CUS, CLOCK_PAST_FIRST_DUE, PI_OPEN);
  seed();
});

afterEach(() => jest.restoreAllMocks());

describe('dispatch: brokerage events never reach the Agent / per-export path', () => {
  it('C-5: subscription.updated on a brokerage customer -> mirrored, no Agent refusal, no Agent lookups', async () => {
    const res = await deliver(EV_PASTDUE);
    expect(res.status).toBe(200);
    expect(agentRefusals()).toEqual([]);
    expect(fake.db.callsTo('stripe_customers')).toEqual([]);
    expect(fake.db.callsTo('billing_subscriptions')).toEqual([]);
    expect(mirror()).toMatchObject({ status: 'past_due', last_event_created: EV_PASTDUE.created });
  });

  it('C-5b: kind=brokerage with no stored customer row -> 200 + orphan alert, Agent path never runs', async () => {
    seed({ noMirror: true });
    const res = await deliver(EV_PASTDUE);
    expect(res.status).toBe(200);
    expect(alerts('brokerage_orphan_object')).toHaveLength(1);
    expect(agentRefusals()).toEqual([]);
    expect(fake.db.callsTo('stripe_customers')).toEqual([]);
    expect(fake.rpcCalls).toEqual([]);
  });

  it('C-5c: payment_intent.succeeded / checkout.session.completed make no brokerage lookup and no extra Stripe read', async () => {
    serve({ id: 'pi_3853_unlock', invoice: null, metadata: {} });
    await deliver(envelope('payment_intent.succeeded', 'pi_3853_unlock'));
    serve({ id: 'cs_3853', mode: 'payment', metadata: {}, customer: null, payment_intent: null });
    await deliver(envelope('checkout.session.completed', 'cs_3853'));
    expect(fake.db.callsTo('org_billing_stripe')).toEqual([]);
    expect(retrieves('payment_intent')).toHaveLength(1);
    expect(retrieves('checkout.session')).toHaveLength(1);
    expect(retrieves('customer')).toHaveLength(0);
  });

  it('C-5d: a lookup failure is not "no row": 500 so Stripe retries, Agent path not reached', async () => {
    fake.db.failNext['org_billing_stripe.select'] = { code: 'PGRST000', message: 'fixture: read failed' };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await deliver(EV_PASTDUE);
    expect(res.status).toBe(500);
    expect(agentRefusals()).toEqual([]);
  });

  it('C-D: dispute on a brokerage payment -> alert + account-manager row, never suspend_account_for_dispute', async () => {
    serve({ id: 'dp_3853', payment_intent: PI_OPEN.id, charge: 'ch_3853' }); // [SYNTHETIC] dispute
    const res = await deliver(envelope('charge.dispute.created', 'dp_3853'));
    expect(res.status).toBe(200);
    expect(fake.callsTo('suspend_account_for_dispute')).toEqual([]);
    expect(fake.db.callsTo('payment_intents')).toEqual([]);
    expect(alerts('brokerage_refund_or_dispute')).toHaveLength(1);
    expect(amRows('dispute')).toHaveLength(1);
    expect(amRows('dispute')[0]).toMatchObject({ organization_id: ORG, stripe_mode: 'test' });
    expect(amRows('dispute')[0].user_id).toBeUndefined();
  });

  it('C-D2: refund on a brokerage payment -> alert + account-manager row, per-export refund path not run', async () => {
    serve({ id: 'ch_3853', customer: CUSTOMER_ID, invoice: OLDEST.id, payment_intent: PI_OPEN.id }); // [SYNTHETIC] charge
    const res = await deliver(envelope('charge.refunded', 'ch_3853'));
    expect(res.status).toBe(200);
    expect(fake.db.callsTo('payment_intents')).toEqual([]);
    expect(amRows('refund')).toHaveLength(1);
  });
});

describe('overdue: emails the account manager, never suspends', () => {
  it('C-1: past_due -> mirror past_due + one overdue row for the oldest overdue invoice; nothing suspends', async () => {
    await deliver(EV_PASTDUE);
    expect(mirror().status).toBe('past_due');
    expect(amRows('overdue')).toHaveLength(1);
    expect(amRows('overdue')[0]).toMatchObject({
      dedupe_key: `notify_account_manager:test:${ORG}:overdue:${OLDEST.id}`,
      payload: { organization_id: ORG, reason: 'overdue', stripe_object_id: OLDEST.id },
    });
    const called = fake.rpcCalls.map((c) => c.fn);
    expect(called).not.toContain('_billing_suspend_org');
    expect(called).not.toContain('admin_suspend_org');
    expect(called).not.toContain('suspend_account_for_dispute');
    expect(deal().status).toBe('active');
  });

  it('C-OD2: "now" is the test clock: wall time is before every due date, the clock is past the first', async () => {
    expect(Date.now() / 1000).toBeLessThan(OLDEST.due_date);
    expect(CLOCK_PAST_FIRST_DUE.frozen_time).toBeGreaterThan(OLDEST.due_date);
    await deliver(EV_PASTDUE);
    expect(retrieves('test_clock')).toHaveLength(1);
    expect(amRows('overdue')).toHaveLength(1);
  });

  it.each(['processing', 'requires_action'])(
    'C-OD: the oldest overdue invoice has a payment %s -> no email',
    async (status) => {
      serveAs(PI_OPEN.id, { ...clone(PI_ACTION), id: PI_OPEN.id, status }); // [EDITED] id + status
      await deliver(EV_PASTDUE);
      expect(amRows()).toEqual([]);
    }
  );

  it('C-OD: redelivery and a second past_due event for the same invoice -> still one row', async () => {
    await deliver(EV_PASTDUE);
    await deliver(EV_PASTDUE);
    await deliver({ ...clone(EV_PASTDUE), id: 'evt_3853_again', created: EV_PASTDUE.created + 5 });
    expect(amRows('overdue')).toHaveLength(1);
  });

  it('C-OD3: once the oldest is paid, the next overdue invoice gets its own row', async () => {
    await deliver(EV_PASTDUE);
    openInvoices = openInvoices.filter((i) => i.id !== OLDEST.id);
    serveAs(CLOCK_PAST_FIRST_DUE.id, { ...CLOCK_PAST_FIRST_DUE, frozen_time: SECOND.due_date + 3600 }); // [EDITED]
    serveAs(SECOND.payment_intent, { ...clone(PI_OPEN), id: SECOND.payment_intent }); // [EDITED] id
    await deliver({ ...clone(EV_PASTDUE), id: 'evt_3853_second', created: EV_PASTDUE.created + 100 });
    expect(amRows('overdue').map((r) => (r.payload as Obj).stripe_object_id)).toEqual([OLDEST.id, SECOND.id]);
  });
});

describe('invoice.payment_failed', () => {
  it('C-PF: PaymentIntent requires_action (ACH verification) -> no email', async () => {
    const inv = { ...clone(OLDEST), payment_intent: PI_ACTION.id };
    serve(inv, PI_ACTION);
    await deliver(envelope('invoice.payment_failed', inv.id));
    expect(amRows()).toEqual([]);
  });

  it('C-PF2: a real failure (requires_payment_method) -> one payment_failed row', async () => {
    serve(OLDEST);
    await deliver(envelope('invoice.payment_failed', OLDEST.id));
    expect(amRows('payment_failed')).toHaveLength(1);
  });
});

describe('auto-reinstate (non-payment suspensions only, after a payment)', () => {
  const SUSPENDED_AT = new Date((EV_PASTDUE.created - 3600) * 1000).toISOString();
  const suspended = (reason: 'non_payment' | 'other') => seed({ deal: { status: 'suspended', suspended_reason: reason, suspended_at: SUSPENDED_AT } });
  const paidEnvelope = () => envelope('invoice.paid', INV_PAID.id, EV_PASTDUE.created + 120, 'evt_3853_paid');
  const activeEnvelope = () => envelope('customer.subscription.updated', SUB_ACTIVE.id, EV_PASTDUE.created + 130, 'evt_3853_active');

  beforeEach(() => {
    // Every invoice paid: nothing open.
    openInvoices = [];
  });

  it('C-12b: invoice.paid while the re-fetch still reads past_due -> stays suspended; then ->active reinstates', async () => {
    suspended('non_payment');
    serve(INV_PAID, SUB_PASTDUE);
    await deliver(paidEnvelope());
    expect(mirror().last_invoice_paid_event_created).toBe(EV_PASTDUE.created + 120);
    expect(deal().status).toBe('suspended');

    serve(SUB_ACTIVE); // same id as SUB_PASTDUE: the subscription is active now
    await deliver(activeEnvelope());
    expect(mirror().status).toBe('active');
    expect(deal().status).toBe('active');
  });

  it('C-12: an open invoice still past due -> not reinstated', async () => {
    suspended('non_payment');
    openInvoices = clone(INV_LIST.data).filter((i: Obj) => i.id === OLDEST.id);
    serve(INV_PAID, SUB_ACTIVE);
    await deliver(paidEnvelope());
    expect(fake.callsTo('_billing_auto_reinstate')).toEqual([]);
    expect(deal().status).toBe('suspended');
  });

  it('C-12c: a suspension for "other" never lifts on payment', async () => {
    suspended('other');
    serve(INV_PAID, SUB_ACTIVE);
    await deliver(paidEnvelope());
    expect(deal().status).toBe('suspended');
  });

  it('C-12f: subscription.updated -> active with no invoice.paid since the suspension -> not reinstated', async () => {
    suspended('non_payment');
    serve(SUB_ACTIVE);
    await deliver(activeEnvelope());
    expect(mirror().status).toBe('active');
    expect(deal().status).toBe('suspended');
  });
});
