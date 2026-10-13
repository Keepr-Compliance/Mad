/**
 * @jest-environment node
 *
 * BACKLOG-3849 PR-2 — nightly Agent-subscription reconcile + billing queue check.
 *
 * Stripe objects are transcribed TEST fixtures (p0a, p3848; see their READMEs).
 * Where a test serves a fixture under another id (a composed pairing), it says
 * so next to the call. Our own rows (stripe_customers, organizations,
 * organization_plans, billing_subscriptions, billing_outbox) are seeded into
 * BillingDb, which APPLIES and RECORDS every filter. No network: the Stripe
 * client is a recording fake and the service client is BillingDb + a mocked rpc.
 */

import fs from 'fs';
import path from 'path';
import type Stripe from 'stripe';
import { BillingDb, type Row } from '../../helpers/billingDb';

const mockCaptureMessage = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  captureException: jest.fn(),
}));

import {
  RECONCILE_LIST_STATUSES,
  RECONCILE_MAX_ITEMS,
  reconcileAgentSubscriptions,
  reportOutboxHealth,
  stripeOverrideEffective,
} from '@/lib/billing/reconcile';
import type { StripeMode } from '@/lib/billing/mode';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FX = path.join(__dirname, '../../fixtures/stripe');
function fx(dir: string, name: string): Obj {
  return JSON.parse(fs.readFileSync(path.join(FX, dir, `${name}.json`), 'utf8'));
}

// ---- fixtures -----------------------------------------------------------------

const SUB_2A = fx('p0a', 'sub-2a-renewal'); // active, latest = INV_2A
const INV_2A = fx('p0a', 'inv-2a-renewal'); // paid, subscription_cycle, line end 1796928475
const CH_2A = fx('p0a', 'ev-2a-charge.succeeded').data.object; // not refunded, not disputed
const SUB_VOID = fx('p3848', 'SR-VOID-sub-after-void'); // active after End plan now's void
const INV_VOID = fx('p3848', 'SR-VOID-inv-voided'); // void
const SUB_VOID_CANCELED = fx('p3848', 'SR-VOID-sub-canceled'); // canceled
const SUB_NU = fx('p3848', 'F1-NU-sub-after-mark'); // active after markUncollectible (NU)
const INV_UNCOLLECTIBLE = fx('p3848', 'F1-RN-inv-uncollectible'); // uncollectible (RN)
const SUB_PAUSED = fx('p0a', 'sub-2cu-paused'); // active with pause_collection

/** A time inside SUB_2A's current period (ends 1796928475 = 2026-12-10). */
const NOW = new Date('2026-11-20T12:00:00.000Z');
const LINE_END_2A = 1796928475;
const paidThrough = (sec: number) => new Date((sec + 7200) * 1000).toISOString();

// ---- recording Stripe fake ----------------------------------------------------

let objects: Map<string, Obj>;
let listed: Obj[]; // what subscriptions.list({ status }) answers from
let stripeCalls: Array<{ op: string; args: unknown[] }>;

function serve(...objs: Obj[]): void {
  for (const o of objs) objects.set(o.id, JSON.parse(JSON.stringify(o)));
}
/** Serve `obj` under a different id (a composed pairing; the test says why). */
function serveAs(id: string, obj: Obj): void {
  objects.set(id, { ...JSON.parse(JSON.stringify(obj)), id });
}
function retrieve(op: string) {
  return async (id: string, ...rest: unknown[]) => {
    stripeCalls.push({ op, args: [id, ...rest] });
    const o = objects.get(id);
    if (!o) throw new Error(`test: no ${op} registered for ${id}`);
    return JSON.parse(JSON.stringify(o));
  };
}
function list(data: Obj[]): Stripe.ApiList<Stripe.Subscription> {
  return { object: 'list', data: data as Stripe.Subscription[], has_more: false, url: '/v1/subscriptions' };
}

const stripe = {
  subscriptions: {
    retrieve: retrieve('subscriptions.retrieve'),
    list: async (params: { status?: string; customer?: string }) => {
      stripeCalls.push({ op: 'subscriptions.list', args: [params] });
      if (params.customer) {
        return list([...objects.values()].filter((o) => o.object === 'subscription' && o.customer === params.customer));
      }
      return list(listed.filter((s) => s.status === params.status));
    },
  },
  invoices: { retrieve: retrieve('invoices.retrieve') },
  charges: { retrieve: retrieve('charges.retrieve') },
} as unknown as Stripe;

// ---- service fake -------------------------------------------------------------

const mockRpc = jest.fn();
let db: BillingDb;

const USER = 'USER-3849';
const ORG = 'ORG-3849';

function seed(tables: Record<string, Row[]>): void {
  db = new BillingDb(tables);
}
function personal(userId: string, orgId: string, isTest: boolean): Row {
  return { id: orgId, personal_owner_user_id: userId, is_test: isTest };
}
function plan(orgId: string, override?: unknown): Row {
  return { organization_id: orgId, feature_overrides: override === undefined ? {} : { unlimited_transactions: override } };
}
function customer(userId: string, customerId: string, mode: StripeMode): Row {
  return { user_id: userId, stripe_customer_id: customerId, default_payment_method_id: null, stripe_mode: mode };
}
function mirror(userId: string, subId: string, customerId: string, mode: StripeMode, over: Row = {}): Row {
  return {
    id: `row-${subId}`,
    stripe_mode: mode,
    user_id: userId,
    organization_id: null,
    stripe_customer_id: customerId,
    stripe_subscription_id: subId,
    status: 'active',
    paused: false,
    last_event_created: 1790000000,
    ...over,
  };
}
const effective = (through = '2026-12-10T12:00:00.000Z') => ({ enabled: true, paid_through: through, source: 'stripe' });

function deps(mode: StripeMode = 'test') {
  return { service: { from: db.from, rpc: mockRpc } as never, stripe, mode, now: () => NOW };
}

function rpcCalls(fn: string): Obj[] {
  return mockRpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1]);
}
const grants = () => rpcCalls('grant_unlimited_from_subscription');
const revokes = () => rpcCalls('revoke_unlimited_from_subscription');
function alerts(name: string): Obj[] {
  return mockCaptureMessage.mock.calls.filter((c) => c[0] === `billing alert: ${name}`).map((c) => c[1].extra);
}
/** Every value the code handed to the database or to Stripe, flattened to strings. */
function everyArgument(): string {
  return JSON.stringify([db.calls, stripeCalls, mockRpc.mock.calls]);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  objects = new Map();
  listed = [];
  stripeCalls = [];
  mockRpc.mockImplementation(async (fn: string) => {
    if (fn === 'grant_unlimited_from_subscription') return { data: { status: 'granted' }, error: null };
    if (fn === 'revoke_unlimited_from_subscription') return { data: { status: 'revoked' }, error: null };
    return { data: null, error: null };
  });
});

afterEach(() => jest.restoreAllMocks());

/** SUB_2A's user, test mode, with `override` on the personal organization. */
function renewalUser(override?: unknown, extra: Record<string, Row[]> = {}): void {
  seed({
    organizations: [personal(USER, ORG, true)],
    organization_plans: [plan(ORG, override)],
    stripe_customers: [customer(USER, SUB_2A.customer, 'test')],
    ...extra,
  });
  serve(SUB_2A, INV_2A, CH_2A);
  listed = [SUB_2A];
}

// ---- R10.1 effective-override definition --------------------------------------------

describe('stripeOverrideEffective (R10.1: source stripe AND enabled AND paid_through > now)', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  it.each([
    ['stripe, enabled, 1 ms after now', { source: 'stripe', enabled: true, paid_through: at(1) }, true],
    ['stripe, enabled, exactly now', { source: 'stripe', enabled: true, paid_through: at(0) }, false],
    ['stripe, enabled, 1 ms before now', { source: 'stripe', enabled: true, paid_through: at(-1) }, false],
    ['stripe, enabled false', { source: 'stripe', enabled: false, paid_through: at(60_000) }, false],
    ['stripe, enabled missing', { source: 'stripe', paid_through: at(60_000) }, false],
    ['support override, future', { source: 'support', enabled: true, paid_through: at(60_000) }, false],
    ['no source (manual), future', { enabled: true, paid_through: at(60_000) }, false],
    ['stripe, no paid_through', { source: 'stripe', enabled: true }, false],
    ['stripe, malformed paid_through', { source: 'stripe', enabled: true, paid_through: 'soon' }, false],
    ['absent', undefined, false],
    ['null', null, false],
  ])('%s -> %s', (_label, override, expected) => {
    expect(stripeOverrideEffective(override, NOW)).toBe(expected);
  });
});

// ---- forward: re-grant only through handleInvoicePaid -----------------------------------------

describe('forward scan (Stripe open, DB not entitled)', () => {
  it('lists only active and trialing subscriptions (open, never canceled)', async () => {
    renewalUser(effective());
    await reconcileAgentSubscriptions(deps());
    const statuses = stripeCalls.filter((c) => c.op === 'subscriptions.list').map((c) => (c.args[0] as Obj).status);
    expect([...RECONCILE_LIST_STATUSES]).toEqual(['active', 'trialing']);
    expect(statuses).toEqual(['active', 'trialing']);
  });

  it('missed invoice.paid: no override -> handleInvoicePaid on the latest invoice grants line end + 2 h', async () => {
    renewalUser(undefined);
    const r = await reconcileAgentSubscriptions(deps());
    expect(grants()).toEqual([{ p_user_id: USER, p_paid_through: paidThrough(LINE_END_2A), p_mode: 'test' }]);
    expect(r).toMatchObject({ forwardScanned: 1, regrantAttempted: 1, mismatches: 1 });
    // handleInvoicePaid's own re-fetch (with the charge expanded) is what decided.
    expect(stripeCalls.some((c) => c.op === 'invoices.retrieve' && JSON.stringify(c.args[1]) === '{"expand":["charge"]}')).toBe(true);
  });

  it('effective Stripe override -> in sync: no invoice read, no grant, no alert', async () => {
    renewalUser(effective());
    const r = await reconcileAgentSubscriptions(deps());
    expect(grants()).toEqual([]);
    expect(stripeCalls.filter((c) => c.op === 'invoices.retrieve')).toEqual([]);
    expect(r.mismatches).toBe(0);
    expect(alerts('reconcile_mismatch')).toEqual([]);
  });

  it.each([
    ['expired (paid_through = now)', effective(NOW.toISOString())],
    ['disabled', { ...effective(), enabled: false }],
  ])('override %s is not effective -> re-grant attempted', async (_l, override) => {
    renewalUser(override);
    await reconcileAgentSubscriptions(deps());
    expect(grants()).toHaveLength(1);
  });

  it('never moves the webhook cursor: the mirror row keeps last_event_created', async () => {
    renewalUser(undefined, { billing_subscriptions: [mirror(USER, SUB_2A.id, SUB_2A.customer, 'test')] });
    await reconcileAgentSubscriptions(deps());
    expect(grants()).toHaveLength(1);
    expect(db.rows('billing_subscriptions')[0].last_event_created).toBe(1790000000);
    expect(db.callsTo('billing_subscriptions', 'update').filter((c) => 'last_event_created' in (c.payload as Row))).toEqual([]);
  });

  it('End plan now voided the renewal (sub reads active, latest invoice void) -> no grant, reported', async () => {
    seed({
      organizations: [personal(USER, ORG, true)],
      organization_plans: [plan(ORG, undefined)],
      stripe_customers: [customer(USER, SUB_VOID.customer, 'test')],
    });
    serve(SUB_VOID, INV_VOID);
    listed = [SUB_VOID];
    const r = await reconcileAgentSubscriptions(deps());
    expect(grants()).toEqual([]);
    expect(r).toMatchObject({ mismatches: 1, regrantAttempted: 0 });
    expect(alerts('reconcile_mismatch')).toEqual([expect.objectContaining({ mismatches: 1, subscription_ids: SUB_VOID.id })]);
  });

  it('End plan now cancel still queued -> left alone even if the latest invoice reads paid', async () => {
    seed({
      organizations: [personal(USER, ORG, true)],
      organization_plans: [plan(ORG, undefined)],
      stripe_customers: [customer(USER, SUB_VOID.customer, 'test')],
      billing_outbox: [
        { id: 'OB-1', stripe_mode: 'test', kind: 'agent_end_now_cancel', dedupe_key: `end-now:test:${SUB_VOID.id}`, processed_at: null, run_after: 'infinity', claimed_until: null, user_id: USER },
      ],
    });
    // Composed: SUB_VOID's latest invoice id served as the paid INV_2A, so only the queue guard stands between it and a grant.
    serve(SUB_VOID, CH_2A);
    serveAs(SUB_VOID.latest_invoice, { ...INV_2A, subscription: SUB_VOID.id });
    listed = [SUB_VOID];
    await reconcileAgentSubscriptions(deps());
    expect(grants()).toEqual([]);
    expect(stripeCalls.filter((c) => c.op === 'invoices.retrieve')).toEqual([]);
  });

  it('active subscription whose latest invoice is uncollectible -> no grant, reported', async () => {
    seed({
      organizations: [personal(USER, ORG, true)],
      organization_plans: [plan(ORG, undefined)],
      stripe_customers: [customer(USER, SUB_NU.customer, 'test')],
    });
    // Composed: NU's own R1 invoice was not captured; the RN uncollectible invoice
    // (same spike, same price) is served under NU's latest invoice id.
    serve(SUB_NU);
    serveAs(SUB_NU.latest_invoice, { ...INV_UNCOLLECTIBLE, subscription: SUB_NU.id, customer: SUB_NU.customer });
    listed = [SUB_NU];
    const r = await reconcileAgentSubscriptions(deps());
    expect(grants()).toEqual([]);
    expect(r).toMatchObject({ mismatches: 1, regrantAttempted: 0 });
  });

  it('paused subscription without an override is the right state: no grant, no mismatch', async () => {
    seed({
      organizations: [personal(USER, ORG, true)],
      organization_plans: [plan(ORG, undefined)],
      stripe_customers: [customer(USER, SUB_PAUSED.customer, 'test')],
    });
    serve(SUB_PAUSED);
    listed = [SUB_PAUSED];
    const r = await reconcileAgentSubscriptions(deps());
    expect(grants()).toEqual([]);
    expect(r.mismatches).toBe(0);
  });

  it('a subscription whose customer has no stripe_customers row in this mode is not an Agent subscription', async () => {
    seed({ organizations: [personal(USER, ORG, true)], organization_plans: [plan(ORG, undefined)], stripe_customers: [customer(USER, SUB_2A.customer, 'live')] });
    serve(SUB_2A, INV_2A, CH_2A);
    listed = [SUB_2A];
    const r = await reconcileAgentSubscriptions(deps('test'));
    expect(r.forwardScanned).toBe(0);
    expect(grants()).toEqual([]);
  });
});

// ---- reverse: revoke through the 3846 rule, this mode only -----------------------------------

describe('reverse scan (DB entitled, nothing open in Stripe)', () => {
  function canceledUser(mode: StripeMode, userId = USER, orgId = ORG, isTest = mode === 'test'): Record<string, Row[]> {
    return {
      organizations: [personal(userId, orgId, isTest)],
      organization_plans: [plan(orgId, effective())],
      stripe_customers: [customer(userId, SUB_VOID_CANCELED.customer, mode)],
      billing_subscriptions: [mirror(userId, SUB_VOID_CANCELED.id, SUB_VOID_CANCELED.customer, mode)],
    };
  }

  it('canceled in Stripe + effective Stripe override -> revoke (and never a grant)', async () => {
    seed(canceledUser('test'));
    serve(SUB_VOID_CANCELED);
    const r = await reconcileAgentSubscriptions(deps());
    expect(revokes()).toEqual([{ p_user_id: USER, p_mode: 'test' }]);
    expect(grants()).toEqual([]);
    expect(r).toMatchObject({ reverseScanned: 1, revokeAttempted: 1, mismatches: 1 });
  });

  it('still active in Stripe -> no revoke', async () => {
    seed({ ...canceledUser('test'), billing_subscriptions: [mirror(USER, SUB_VOID.id, SUB_VOID.customer, 'test')] });
    serve(SUB_VOID);
    await reconcileAgentSubscriptions(deps());
    expect(revokes()).toEqual([]);
  });

  it('override already expired -> nothing to revoke, Stripe not asked', async () => {
    seed({ ...canceledUser('test'), organization_plans: [plan(ORG, effective(NOW.toISOString()))] });
    serve(SUB_VOID_CANCELED);
    await reconcileAgentSubscriptions(deps());
    expect(revokes()).toEqual([]);
    expect(stripeCalls.filter((c) => c.op === 'subscriptions.list' && (c.args[0] as Obj).customer)).toEqual([]);
  });

  it('no customer row in this mode -> reported, never revoked on a guess', async () => {
    seed({ ...canceledUser('test'), stripe_customers: [] });
    const r = await reconcileAgentSubscriptions(deps());
    expect(revokes()).toEqual([]);
    expect(r.mismatches).toBe(1);
  });

  it('LIVE run never touches a test-mode user (the override carries no mode)', async () => {
    const T = 'USER-TEST-ONLY';
    const L = 'USER-LIVE';
    const t = canceledUser('test', T, 'ORG-T', true);
    const l = canceledUser('live', L, 'ORG-L', false);
    seed({
      organizations: [...t.organizations, ...l.organizations],
      organization_plans: [...t.organization_plans, ...l.organization_plans],
      stripe_customers: [...t.stripe_customers, ...l.stripe_customers],
      billing_subscriptions: [
        t.billing_subscriptions[0],
        { ...l.billing_subscriptions[0], id: 'row-live', stripe_subscription_id: 'sub_live_synthetic' },
      ],
    });
    serve(SUB_VOID_CANCELED);
    const r = await reconcileAgentSubscriptions(deps('live'));
    expect(everyArgument()).not.toContain(T);
    expect(r.reverseScanned).toBe(1);
    expect(revokes()).toEqual([{ p_user_id: L, p_mode: 'live' }]);
  });

  it('TEST run never touches a live-mode user', async () => {
    const T = 'USER-TEST';
    const L = 'USER-LIVE-ONLY';
    const t = canceledUser('test', T, 'ORG-T', true);
    const l = canceledUser('live', L, 'ORG-L', false);
    seed({
      organizations: [...t.organizations, ...l.organizations],
      organization_plans: [...t.organization_plans, ...l.organization_plans],
      stripe_customers: [...t.stripe_customers, ...l.stripe_customers],
      billing_subscriptions: [
        t.billing_subscriptions[0],
        { ...l.billing_subscriptions[0], id: 'row-live', stripe_subscription_id: 'sub_live_synthetic' },
      ],
    });
    serve(SUB_VOID_CANCELED);
    await reconcileAgentSubscriptions(deps('test'));
    expect(everyArgument()).not.toContain(L);
    expect(revokes()).toEqual([{ p_user_id: T, p_mode: 'test' }]);
  });
});

describe('reconcile alert', () => {
  it('two mismatches in one run -> ONE reconcile_mismatch alert carrying both', async () => {
    seed({
      organizations: [personal(USER, ORG, true), personal('U2', 'ORG-2', true)],
      organization_plans: [plan(ORG, undefined), plan('ORG-2', undefined)],
      stripe_customers: [customer(USER, SUB_VOID.customer, 'test'), customer('U2', SUB_NU.customer, 'test')],
    });
    serve(SUB_VOID, INV_VOID, SUB_NU);
    serveAs(SUB_NU.latest_invoice, { ...INV_UNCOLLECTIBLE, subscription: SUB_NU.id });
    listed = [SUB_VOID, SUB_NU];
    await reconcileAgentSubscriptions(deps());
    expect(alerts('reconcile_mismatch')).toEqual([expect.objectContaining({ mismatches: 2, subscription_ids: `${SUB_VOID.id},${SUB_NU.id}` })]);
  });
});

// ---- SR fix-up round 1 (PR #3007 review) ------------------------------------------------------

/**
 * Composed: no non-Agent subscription exists in either Stripe account to
 * transcribe. SUB_VOID (transcribed, active, kind 'agent', customer
 * cus_VQohssQXi8riIA) under a new id with metadata.kind 'brokerage' stands in
 * for a future brokerage subscription on an Agent's customer.
 */
const SUB_BROKERAGE: Obj = { ...SUB_VOID, id: 'sub_composed_brokerage', metadata: { kind: 'brokerage' } };

describe('reverse: re-subscriber with several mirror rows (RC-1)', () => {
  /**
   * Old subscription A canceled (mirror reads canceled); current subscription
   * (SUB_VOID_CANCELED, transcribed) canceled in Stripe but its mirror row still
   * reads 'active' because the deleted webhook was missed. A is composed:
   * SUB_VOID_CANCELED served under another id.
   */
  function reSubscriber(order: 'old-first' | 'current-first', currentStatus = 'active') {
    const A = { ...SUB_VOID_CANCELED, id: 'sub_OLD_canceled' };
    serve(SUB_VOID_CANCELED);
    serveAs(A.id, A);
    const old = mirror(USER, A.id, SUB_VOID_CANCELED.customer, 'test', { id: 'row-old', status: 'canceled' });
    const cur = mirror(USER, SUB_VOID_CANCELED.id, SUB_VOID_CANCELED.customer, 'test', { status: currentStatus });
    seed({
      organizations: [personal(USER, ORG, true)],
      organization_plans: [plan(ORG, effective())],
      stripe_customers: [customer(USER, SUB_VOID_CANCELED.customer, 'test')],
      billing_subscriptions: order === 'old-first' ? [old, cur] : [cur, old],
    });
  }

  it.each(['current-first', 'old-first'] as const)('mirror rows %s -> exactly one revoke, counted once', async (order) => {
    reSubscriber(order);
    const r = await reconcileAgentSubscriptions(deps());
    expect(revokes()).toEqual([{ p_user_id: USER, p_mode: 'test' }]);
    expect(r).toMatchObject({ reverseScanned: 1, revokeAttempted: 1, mismatches: 1 });
    expect(alerts('reconcile_mismatch')).toEqual([expect.objectContaining({ revoke_attempted: 1, subscription_ids: SUB_VOID_CANCELED.id })]);
  });

  it('both mirror rows read open -> reported, nothing revoked, nothing counted as attempted', async () => {
    reSubscriber('old-first');
    db = new BillingDb({
      organizations: [personal(USER, ORG, true)],
      organization_plans: [plan(ORG, effective())],
      stripe_customers: [customer(USER, SUB_VOID_CANCELED.customer, 'test')],
      billing_subscriptions: [
        mirror(USER, 'sub_OLD_canceled', SUB_VOID_CANCELED.customer, 'test', { id: 'row-old', status: 'past_due' }),
        mirror(USER, SUB_VOID_CANCELED.id, SUB_VOID_CANCELED.customer, 'test', { status: 'active' }),
      ],
    });
    const r = await reconcileAgentSubscriptions(deps());
    expect(revokes()).toEqual([]);
    expect(r).toMatchObject({ revokeAttempted: 0, mismatches: 1 });
    expect(alerts('reconcile_mismatch')).toEqual([
      expect.objectContaining({ revoke_attempted: 0, subscription_ids: `sub_OLD_canceled,${SUB_VOID_CANCELED.id}` }),
    ]);
  });
});

describe('reverse: revokeAttempted counts only revokes that reached the RPC (RC-1)', () => {
  it('open mirror row beyond the 1000-row read -> revokeIfCurrent declines, revokeAttempted 0', async () => {
    // The user's open row sits after RECONCILE_MAX_ITEMS * 5 rows, so the reverse
    // read sees only their canceled row; hasOtherOpenSubscription still finds the
    // open one and declines. Fillers are other users with no organization.
    const fillers = Array.from({ length: RECONCILE_MAX_ITEMS * 5 - 1 }, (_, i) =>
      mirror(`FILL-${i}`, `sub_fill_${i}`, 'cus_fill', 'test', { id: `row-fill-${i}`, status: 'canceled' })
    );
    seed({
      organizations: [personal(USER, ORG, true)],
      organization_plans: [plan(ORG, effective())],
      stripe_customers: [customer(USER, SUB_VOID_CANCELED.customer, 'test')],
      billing_subscriptions: [
        mirror(USER, 'sub_OLD_canceled', SUB_VOID_CANCELED.customer, 'test', { id: 'row-old', status: 'canceled' }),
        ...fillers,
        mirror(USER, SUB_VOID_CANCELED.id, SUB_VOID_CANCELED.customer, 'test', { status: 'active' }),
      ],
    });
    serve(SUB_VOID_CANCELED);
    const r = await reconcileAgentSubscriptions(deps());
    expect(revokes()).toEqual([]);
    expect(r).toMatchObject({ revokeAttempted: 0, mismatches: 1, truncated: true });
  });
});

describe('metadata.kind pins (RC-2, RC-3)', () => {
  it('reverse: canceled Agent sub + an active brokerage sub on the same customer -> revoke', async () => {
    seed({
      organizations: [personal(USER, ORG, true)],
      organization_plans: [plan(ORG, effective())],
      stripe_customers: [customer(USER, SUB_VOID_CANCELED.customer, 'test')],
      billing_subscriptions: [mirror(USER, SUB_VOID_CANCELED.id, SUB_VOID_CANCELED.customer, 'test', { status: 'canceled' })],
    });
    serve(SUB_VOID_CANCELED, SUB_BROKERAGE);
    const r = await reconcileAgentSubscriptions(deps());
    expect(revokes()).toEqual([{ p_user_id: USER, p_mode: 'test' }]);
    expect(r).toMatchObject({ revokeAttempted: 1, mismatches: 1 });
  });

  it('forward: an active brokerage sub on an Agent customer is not scanned', async () => {
    seed({
      organizations: [personal(USER, ORG, true)],
      organization_plans: [plan(ORG, undefined)],
      stripe_customers: [customer(USER, SUB_BROKERAGE.customer, 'test')],
    });
    serve(SUB_BROKERAGE, INV_2A);
    listed = [SUB_BROKERAGE];
    const r = await reconcileAgentSubscriptions(deps());
    expect(r).toMatchObject({ forwardScanned: 0, regrantAttempted: 0, mismatches: 0 });
    expect(stripeCalls.filter((c) => c.op === 'invoices.retrieve')).toEqual([]);
    expect(grants()).toEqual([]);
    expect(alerts('reconcile_mismatch')).toEqual([]);
  });
});

describe('cap (RC-4): above RECONCILE_MAX_ITEMS the rest is reported, not processed', () => {
  it('forward: 201 listed subscriptions -> 200 scanned, truncated, one alert', async () => {
    renewalUser(effective()); // every one is in sync, so only the cap can raise the alert
    // Composed: SUB_2A (transcribed) under 201 distinct ids.
    listed = Array.from({ length: RECONCILE_MAX_ITEMS + 1 }, (_, i) => ({ ...SUB_2A, id: `sub_cap_${i}` }));
    const r = await reconcileAgentSubscriptions(deps());
    expect(r).toMatchObject({ forwardScanned: RECONCILE_MAX_ITEMS, mismatches: 0, truncated: true });
    expect(alerts('reconcile_mismatch')).toEqual([expect.objectContaining({ mismatches: 0, truncated: true })]);
  });

  it('forward: exactly RECONCILE_MAX_ITEMS -> not truncated, no alert', async () => {
    renewalUser(effective());
    listed = Array.from({ length: RECONCILE_MAX_ITEMS }, (_, i) => ({ ...SUB_2A, id: `sub_cap_${i}` }));
    const r = await reconcileAgentSubscriptions(deps());
    expect(r.truncated).toBe(false);
    expect(alerts('reconcile_mismatch')).toEqual([]);
  });

  it('reverse: 201 users with mirror rows -> 200 scanned, truncated', async () => {
    seed({
      billing_subscriptions: Array.from({ length: RECONCILE_MAX_ITEMS + 1 }, (_, i) =>
        mirror(`U-${i}`, `sub_r_${i}`, SUB_VOID_CANCELED.customer, 'test', { id: `row-${i}` })
      ),
    });
    const r = await reconcileAgentSubscriptions(deps());
    expect(r).toMatchObject({ reverseScanned: RECONCILE_MAX_ITEMS, truncated: true });
  });
});

describe('non-Stripe overrides (RC-5): mirror the grant RPC refusal', () => {
  const future = '2026-12-10T12:00:00.000Z';

  it.each([
    ['support, enabled', { source: 'support', enabled: true, paid_through: future }],
    ['manual (no source), enabled', { enabled: true }],
  ])('forward: %s override + open paid sub -> in sync, no grant call, no alert', async (_l, override) => {
    renewalUser(override);
    const r = await reconcileAgentSubscriptions(deps());
    expect(r).toMatchObject({ forwardScanned: 1, regrantAttempted: 0, mismatches: 0, overrideBlocked: 0 });
    expect(grants()).toEqual([]);
    expect(stripeCalls.filter((c) => c.op === 'invoices.retrieve')).toEqual([]);
    expect(alerts('reconcile_mismatch')).toEqual([]);
  });

  it('forward: support override present but disabled -> overrideBlocked, no grant call, one alert', async () => {
    renewalUser({ source: 'support', enabled: false });
    const r = await reconcileAgentSubscriptions(deps());
    expect(r).toMatchObject({ regrantAttempted: 0, mismatches: 0, overrideBlocked: 1 });
    expect(grants()).toEqual([]);
    expect(stripeCalls.filter((c) => c.op === 'invoices.retrieve')).toEqual([]);
    expect(alerts('reconcile_mismatch')).toHaveLength(1);
  });

  it('forward: enabled support override with expired paid_through -> overrideBlocked, one alert', async () => {
    renewalUser({ source: 'support', enabled: true, paid_through: '2026-01-01T00:00:00.000Z' });
    const r = await reconcileAgentSubscriptions(deps());
    expect(r).toMatchObject({ regrantAttempted: 0, mismatches: 0, overrideBlocked: 1 });
    expect(grants()).toEqual([]);
    expect(alerts('reconcile_mismatch')).toHaveLength(1);
  });

  it('forward: support override with no `enabled` key -> in sync (absent counts as enabled), no alert', async () => {
    renewalUser({ source: 'support', paid_through: future });
    const r = await reconcileAgentSubscriptions(deps());
    expect(r).toMatchObject({ regrantAttempted: 0, mismatches: 0, overrideBlocked: 0 });
    expect(grants()).toEqual([]);
    expect(alerts('reconcile_mismatch')).toEqual([]);
  });

  it('reverse: support override + nothing open in Stripe -> no revoke call, Stripe not asked', async () => {
    seed({
      organizations: [personal(USER, ORG, true)],
      organization_plans: [plan(ORG, { source: 'support', enabled: true, paid_through: future })],
      stripe_customers: [customer(USER, SUB_VOID_CANCELED.customer, 'test')],
      billing_subscriptions: [mirror(USER, SUB_VOID_CANCELED.id, SUB_VOID_CANCELED.customer, 'test', { status: 'canceled' })],
    });
    serve(SUB_VOID_CANCELED);
    const r = await reconcileAgentSubscriptions(deps());
    expect(revokes()).toEqual([]);
    expect(r).toMatchObject({ reverseScanned: 1, revokeAttempted: 0, mismatches: 0 });
    expect(stripeCalls.filter((c) => c.op === 'subscriptions.list' && (c.args[0] as Obj).customer)).toEqual([]);
  });
});

// ---- queue check ---------------------------------------------------------------------------

describe('reportOutboxHealth (daily queue check)', () => {
  const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
  function row(id: string, over: Row): Row {
    return { id, stripe_mode: 'test', kind: 'agent_receipt', processed_at: null, run_after: ago(30), claimed_until: null, user_id: USER, ...over };
  }

  it('one alert per category per run, counted over this mode only', async () => {
    seed({
      billing_outbox: [
        row('S1', { run_after: ago(11) }),
        row('S2', { run_after: ago(600), kind: 'agent_end_now_cancel' }),
        row('S3', { run_after: ago(60), claimed_until: ago(1) }), // lease expired: stale
        row('L1', { run_after: ago(60), claimed_until: new Date(NOW.getTime() + 60_000).toISOString() }), // leased: working
        row('F1', { run_after: ago(9) }), // not yet ten minutes late
        row('A1', { run_after: new Date(NOW.getTime() + 300 * 86_400_000).toISOString() }), // scheduled renewal-time work
        row('P1', { run_after: 'infinity' }),
        row('P2', { run_after: 'infinity', kind: 'agent_end_now_cancel' }),
        row('D1', { processed_at: ago(5) }),
        row('X1', { stripe_mode: 'live', run_after: ago(600) }),
        row('X2', { stripe_mode: 'live', run_after: 'infinity' }),
      ],
    });
    const h = await reportOutboxHealth(deps('test'));
    expect(h).toEqual({ stale: 3, parked: 2 });
    expect(alerts('outbox_stale_daily')).toEqual([
      { stale_rows: 3, oldest_run_after: ago(600), kinds: 'agent_end_now_cancel,agent_receipt' },
    ]);
    expect(alerts('outbox_parked')).toEqual([
      { parked_rows: 2, kinds: 'agent_end_now_cancel,agent_receipt', outbox_ids: 'P1,P2' },
    ]);
  });

  it('nothing stale or parked -> no alert', async () => {
    seed({ billing_outbox: [row('F1', { run_after: ago(1) }), row('D1', { processed_at: ago(5) })] });
    expect(await reportOutboxHealth(deps('test'))).toEqual({ stale: 0, parked: 0 });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

// ---- BACKLOG-3878 R7: suspension safety net ------------------------------------------------
// Objects: fixtures/stripe/p3878 (TEST, see README). x1-sub-past-due-before-pause is an
// unpaused Agent plan still collecting; x2-sub-after-void-and-pause is a paused one.

describe('3878 R7: suspended licence with a plan still collecting', () => {
  const UNPAUSED = fx('p3878', 'x1-sub-past-due-before-pause');
  const PAUSED = fx('p3878', 'x2-sub-after-void-and-pause');
  const LIC_UPDATED = '2026-10-13T10:00:00.000Z';

  function suspendedUser(licStatus: string, sub: Obj, extra: Record<string, Row[]> = {}) {
    seed({
      organizations: [personal(USER, ORG, true)],
      organization_plans: [plan(ORG, undefined)],
      stripe_customers: [customer(USER, sub.customer, 'test')],
      licenses: [{ user_id: USER, status: licStatus, updated_at: LIC_UPDATED }],
      ...extra,
    });
    serve(sub);
    listed = [];
  }
  const pauseRows = () => db.rows('billing_outbox').filter((r) => r.kind === 'pause_agent_subscription');

  it('suspended + unpaused plan -> one pause row (reconcile dedupe key) and one alert', async () => {
    suspendedUser('suspended', UNPAUSED);
    expect([UNPAUSED.status, UNPAUSED.pause_collection]).toEqual(['past_due', null]);
    const r = await reconcileAgentSubscriptions(deps());
    expect(pauseRows()).toEqual([
      expect.objectContaining({ stripe_mode: 'test', user_id: USER, dedupe_key: `pause:test:${USER}:reconcile:${LIC_UPDATED}` }),
    ]);
    expect(alerts('suspended_subscription_unpaused')).toEqual([expect.objectContaining({ count: 1, subscription_ids: UNPAUSED.id })]);
    expect(r.suspendedUnpaused).toBe(1);
    expect(stripeCalls.find((c) => c.op === 'subscriptions.list' && (c.args[0] as Obj).customer)?.args[0]).toMatchObject({ customer: UNPAUSED.customer, status: 'all' });
  });

  it('a pause row already waiting -> no second row, still alerted', async () => {
    suspendedUser('suspended', UNPAUSED, {
      billing_outbox: [{ id: 'ob-1', stripe_mode: 'test', kind: 'pause_agent_subscription', user_id: USER, dedupe_key: 'pause:test:trigger', processed_at: null }],
    });
    await reconcileAgentSubscriptions(deps());
    expect(pauseRows()).toHaveLength(1);
    expect(alerts('suspended_subscription_unpaused')).toHaveLength(1);
  });

  it('a second nightly run adds no second row (same licence -> same key)', async () => {
    suspendedUser('suspended', UNPAUSED);
    await reconcileAgentSubscriptions(deps());
    db.rows('billing_outbox')[0].processed_at = '2026-10-13T11:00:00.000Z'; // drained, but Stripe still unpaused
    await reconcileAgentSubscriptions(deps());
    expect(pauseRows()).toHaveLength(1);
  });

  it('suspended + already paused -> nothing enqueued, no alert', async () => {
    suspendedUser('suspended', PAUSED);
    await reconcileAgentSubscriptions(deps());
    expect(pauseRows()).toEqual([]);
    expect(alerts('suspended_subscription_unpaused')).toEqual([]);
  });

  it('licence active + unpaused plan -> nothing (only suspended licences are read)', async () => {
    suspendedUser('active', UNPAUSED);
    await reconcileAgentSubscriptions(deps());
    expect(pauseRows()).toEqual([]);
    expect(alerts('suspended_subscription_unpaused')).toEqual([]);
  });

  it('customer only in the other mode -> not this run\'s concern', async () => {
    suspendedUser('suspended', UNPAUSED);
    db.rows('stripe_customers')[0].stripe_mode = 'live';
    await reconcileAgentSubscriptions(deps('test'));
    expect(pauseRows()).toEqual([]);
  });
});

describe('3878 R7: paused plan whose licence is active', () => {
  const PAUSED = fx('p3878', 'x2-sub-after-void-and-pause');

  function pausedUser(licStatus: string, extra: Record<string, Row[]> = {}) {
    seed({
      organizations: [personal(USER, ORG, true)],
      organization_plans: [plan(ORG, undefined)],
      stripe_customers: [customer(USER, PAUSED.customer, 'test')],
      licenses: [{ user_id: USER, status: licStatus, updated_at: '2026-10-13T10:00:00.000Z' }],
      ...extra,
    });
    serve(PAUSED);
    listed = [PAUSED];
  }

  it('licence active, no resume waiting -> alert only (no Stripe write, no outbox row)', async () => {
    pausedUser('active');
    const r = await reconcileAgentSubscriptions(deps());
    expect(alerts('paused_subscription_licence_active')).toEqual([expect.objectContaining({ count: 1, subscription_ids: PAUSED.id })]);
    expect(r.pausedLicenceActive).toBe(1);
    expect(db.rows('billing_outbox')).toEqual([]);
    expect(grants()).toEqual([]);
  });

  it('a resume row still waiting -> no alert', async () => {
    pausedUser('active', {
      billing_outbox: [{ id: 'ob-r', stripe_mode: 'test', kind: 'resume_agent_subscription', user_id: USER, dedupe_key: 'resume:test:x', processed_at: null }],
    });
    await reconcileAgentSubscriptions(deps());
    expect(alerts('paused_subscription_licence_active')).toEqual([]);
  });

  it('a processed resume row does not count as waiting -> alert', async () => {
    pausedUser('active', {
      billing_outbox: [{ id: 'ob-r', stripe_mode: 'test', kind: 'resume_agent_subscription', user_id: USER, dedupe_key: 'resume:test:x', processed_at: '2026-10-13T11:00:00.000Z' }],
    });
    await reconcileAgentSubscriptions(deps());
    expect(alerts('paused_subscription_licence_active')).toHaveLength(1);
  });

  it('licence suspended -> paused is the right state, no alert', async () => {
    pausedUser('suspended');
    await reconcileAgentSubscriptions(deps());
    expect(alerts('paused_subscription_licence_active')).toEqual([]);
  });
});
