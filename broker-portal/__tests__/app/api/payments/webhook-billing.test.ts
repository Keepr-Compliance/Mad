/**
 * @jest-environment node
 *
 * BACKLOG-3846 — Stripe webhook -> Agent subscription billing state.
 *
 * Every Stripe object comes from __tests__/fixtures/stripe/p0a (TEST mode,
 * transcribed; see its README). Events are the delivered (dahlia) envelopes; the
 * Stripe client is mocked to return the acacia re-fetches by id, which is what
 * the webhook reads (E0). Only our own rows (stripe_customers, organizations,
 * billing_subscriptions) are seeded. No network: Stripe and Supabase are mocked.
 */

import fs from 'fs';
import path from 'path';
import { BillingDb, type Row } from '../../../helpers/billingDb';

const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockConstructEvent = jest.fn();
const mockCaptureMessage = jest.fn();
const mockSubscriptionsCancel = jest.fn();
const mockRetrieve = jest.fn();
const mockVoidInvoice = jest.fn();
const mockSessionsList = jest.fn();
const mockSessionsExpire = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  captureException: jest.fn(),
}));

jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

jest.mock('stripe', () => {
  const r = (kind: string) => (id: string, params?: unknown) => mockRetrieve(kind, id, params);
  const StripeMock = jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent: mockConstructEvent },
    subscriptions: { retrieve: r('subscription'), cancel: mockSubscriptionsCancel },
    invoices: { retrieve: r('invoice'), voidInvoice: (...a: unknown[]) => mockVoidInvoice(...a) },
    charges: { retrieve: r('charge') },
    disputes: { retrieve: r('dispute') },
    refunds: { retrieve: r('refund') },
    paymentIntents: { retrieve: r('payment_intent') },
    checkout: {
      sessions: {
        retrieve: r('checkout.session'),
        list: (...a: unknown[]) => mockSessionsList(...a),
        expire: (...a: unknown[]) => mockSessionsExpire(...a),
      },
    },
    customers: { create: jest.fn() },
  }));
  return { __esModule: true, default: StripeMock };
});

// ---- fixtures ------------------------------------------------------------

const FX = path.join(__dirname, '../../../fixtures/stripe/p0a');
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function fx(name: string): Obj {
  return JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8'));
}

/** Re-fetch registry: Stripe id -> the object `retrieve` returns. */
let objects: Map<string, Obj>;
function serve(...objs: Obj[]): void {
  for (const o of objs) objects.set(o.id, o);
}
/** Serve `obj` under a different id (a composed pairing; the test says why). */
function serveAs(id: string, obj: Obj): void {
  objects.set(id, obj);
}

const USER = 'USER-3846';
const ORG = 'ORG-P3846';

function customerRow(customerId: string, userId = USER): Row {
  return { user_id: userId, stripe_customer_id: customerId, default_payment_method_id: null, stripe_mode: 'test' };
}
function personalOrg(isTest = true, userId = USER): Row {
  return { id: ORG, personal_owner_user_id: userId, is_test: isTest };
}
function subRow(subId: string, customerId: string, over: Row = {}): Row {
  return {
    id: `row-${subId}`,
    stripe_mode: 'test',
    user_id: USER,
    organization_id: ORG,
    stripe_customer_id: customerId,
    stripe_subscription_id: subId,
    status: 'active',
    paused: false,
    last_event_created: null,
    ...over,
  };
}

let db: BillingDb;
function useDb(seed: Record<string, Row[]>): BillingDb {
  db = new BillingDb({ organizations: [personalOrg()], ...seed });
  mockFrom.mockImplementation(db.from);
  return db;
}

function rpcCalls(fn: string): Obj[] {
  return mockRpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1]);
}
const grants = () => rpcCalls('grant_unlimited_from_subscription');
const revokes = () => rpcCalls('revoke_unlimited_from_subscription');
const paidThrough = (periodEnd: number) => new Date((periodEnd + 7200) * 1000).toISOString();

function refusals(): Obj[] {
  return mockCaptureMessage.mock.calls
    .filter((c) => c[0] === 'Stripe billing event refused')
    .map((c) => c[1].extra);
}

async function deliver(event: Obj): Promise<Response> {
  mockConstructEvent.mockReturnValue(event);
  const { POST } = await import('@/app/api/payments/webhook/route');
  return POST(
    new Request('https://x/api/payments/webhook', { method: 'POST', headers: { 'stripe-signature': 'ok' }, body: 'raw' })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'whsec_dummy';
  objects = new Map();
  mockRetrieve.mockImplementation(async (kind: string, id: string) => {
    const o = objects.get(id);
    if (!o) throw new Error(`test: no ${kind} re-fetch registered for ${id}`);
    return JSON.parse(JSON.stringify(o));
  });
  mockRpc.mockImplementation(async (fn: string) => {
    if (fn === 'grant_unlimited_from_subscription') return { data: { status: 'granted' }, error: null };
    if (fn === 'revoke_unlimited_from_subscription') return { data: { status: 'revoked' }, error: null };
    if (fn === 'suspend_account_for_dispute') return { data: { already_suspended: false }, error: null };
    return { data: null, error: null };
  });
  mockSubscriptionsCancel.mockResolvedValue({ status: 'canceled' });
  mockVoidInvoice.mockReset();
  // No Checkout session holds the subscription (the API-made A/C fixtures).
  mockSessionsList.mockReset().mockResolvedValue({ object: 'list', data: [], has_more: false, url: '/v1/checkout/sessions' });
  mockSessionsExpire.mockReset();
  useDb({});
});

// ---- 2a renewal: the grant path ---------------------------------------------

const SUB_2A = fx('sub-2a-renewal');
const INV_2A = fx('inv-2a-renewal');
const CUS_2A = SUB_2A.customer as string;

function renewal2a(chargeFixture = 'ev-2a-charge.succeeded') {
  useDb({ stripe_customers: [customerRow(CUS_2A)] });
  const charge = chargeFixture.startsWith('ev-') ? fx(chargeFixture).data.object : fx(chargeFixture);
  serve(INV_2A, SUB_2A, charge);
  return fx('ev-2a-invoice.paid-cycle');
}

describe('invoice.paid grant (C-G1, E0-C, C-ID)', () => {
  it('C-G1: renewal invoice.paid grants to the subscription line end + 2 h, from the re-fetch', async () => {
    const ev = renewal2a();
    // E0-C premise: the delivered (dahlia) payload has no top-level `subscription`;
    // a handler reading the payload would find nothing to grant.
    expect(ev.data.object.subscription).toBeUndefined();
    expect(INV_2A.lines.data[0].period.end).toBe(1796928475);

    const res = await deliver(ev);
    expect(res.status).toBe(200);
    expect(grants()).toEqual([{ p_user_id: USER, p_paid_through: paidThrough(1796928475), p_mode: 'test' }]);
    expect(INV_2A.period_end).not.toBe(1796928475); // invoice.period_end would be the wrong value
    const [row] = db.rows('billing_subscriptions');
    expect(row).toMatchObject({
      stripe_subscription_id: SUB_2A.id,
      user_id: USER,
      organization_id: ORG,
      status: 'active',
      paused: false,
      last_event_created: null, // insert-if-missing never sets the cursor (R7)
      stripe_mode: 'test',
    });
  });

  it('C-ID (R1): metadata.user_id differs from the stored customer row -> grant to the stored user + warning', async () => {
    const ev = renewal2a();
    expect(SUB_2A.metadata.user_id).toBe('p0a-user-2a-renewal');
    const res = await deliver(ev);
    expect(res.status).toBe(200);
    expect(grants().map((g) => g.p_user_id)).toEqual([USER]);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Stripe subscription metadata user does not match stored customer',
      expect.objectContaining({ level: 'warning' })
    );
  });

  it('C-REF: grant refused (licence_suspended) -> reported, 200', async () => {
    const ev = renewal2a();
    mockRpc.mockImplementation(async (fn: string) =>
      fn === 'grant_unlimited_from_subscription'
        ? { data: { status: 'refused', reason: 'licence_suspended' }, error: null }
        : { data: null, error: null }
    );
    const res = await deliver(ev);
    expect(res.status).toBe(200);
    expect(refusals()).toEqual([expect.objectContaining({ reason: 'licence_suspended', user_id: USER })]);
  });

  it('C-REF: grant raising 42501 (mode / is_test) -> reported, 200, not retried', async () => {
    const ev = renewal2a();
    mockRpc.mockImplementation(async (fn: string) =>
      fn === 'grant_unlimited_from_subscription'
        ? { data: null, error: { code: '42501', message: 'test mode requires an is_test personal organization' } }
        : { data: null, error: null }
    );
    const res = await deliver(ev);
    expect(res.status).toBe(200);
    expect(refusals()).toEqual([expect.objectContaining({ reason: 'grant_unlimited_from_subscription_42501' })]);
  });

  it('a transient grant error -> 500 so Stripe retries', async () => {
    const ev = renewal2a();
    mockRpc.mockImplementation(async (fn: string) =>
      fn === 'grant_unlimited_from_subscription'
        ? { data: null, error: { code: 'PGRST000', message: 'postgrest 503' } }
        : { data: null, error: null }
    );
    expect((await deliver(ev)).status).toBe(500);
  });

  it('a failed re-fetch -> 500 so Stripe retries', async () => {
    const ev = renewal2a();
    objects.delete(INV_2A.id);
    expect((await deliver(ev)).status).toBe(500);
    expect(grants()).toEqual([]);
  });

  it('C-MODE: test event, personal org not is_test -> no row, no grant, refused, 200', async () => {
    const ev = renewal2a();
    useDb({ organizations: [personalOrg(false)], stripe_customers: [customerRow(CUS_2A)] });
    const res = await deliver(ev);
    expect(res.status).toBe(200);
    expect(grants()).toEqual([]);
    expect(db.rows('billing_subscriptions')).toEqual([]);
    expect(refusals()).toEqual([expect.objectContaining({ reason: 'mode_not_allowed' })]);
  });

  it('C-BRK (R6): a paid invoice whose customer has no stripe_customers row -> no grant, no row', async () => {
    renewal2a();
    // No stripe_customers row for the customer. The metadata user has an is_test
    // personal org, so an implementation that falls back to metadata.user_id
    // would get all the way to a grant.
    useDb({ organizations: [personalOrg(true), personalOrg(true, SUB_2A.metadata.user_id)] });
    const res = await deliver(fx('ev-2a-invoice.paid-cycle'));
    expect(res.status).toBe(200);
    expect(grants()).toEqual([]);
    expect(db.rows('billing_subscriptions')).toEqual([]);
  });

  it('C-KIND (R6): metadata.kind present and not "agent" -> refused, no grant [EDITED fixture: kind added]', async () => {
    const ev = renewal2a();
    serve({ ...SUB_2A, metadata: { ...SUB_2A.metadata, kind: 'brokerage' } });
    expect((await deliver(ev)).status).toBe(200);
    expect(grants()).toEqual([]);
    expect(refusals()).toEqual([expect.objectContaining({ reason: 'not_agent_kind' })]);
  });

  it('C-4b (R4): the invoice charge has since been fully refunded -> a replayed invoice.paid does not re-grant', async () => {
    const ev = renewal2a('ch-4-after-refunds');
    // Same charge, not a composed pairing: the 2a renewal invoice's charge.
    expect(fx('ch-4-after-refunds').id).toBe(INV_2A.charge);
    expect(fx('ch-4-after-refunds').refunded).toBe(true);
    expect((await deliver(ev)).status).toBe(200);
    expect(grants()).toEqual([]);
  });

  it('a replayed invoice.paid for an OLDER period -> no grant [EDITED: sub current_period_end moved one period on]', async () => {
    const ev = renewal2a();
    // Same edit as the older-period refund test below: the subscription has since renewed.
    serve({ ...SUB_2A, current_period_end: 1799520475 });
    expect(INV_2A.lines.data.find((l: Obj) => l.type === 'subscription').period.end).toBeLessThan(1799520475);
    expect((await deliver(ev)).status).toBe(200);
    expect(grants()).toEqual([]);
  });

  it('invoice.paid while the subscription is past_due -> no grant [EDITED: sub status set to past_due]', async () => {
    const ev = renewal2a();
    serve({ ...SUB_2A, status: 'past_due' });
    expect((await deliver(ev)).status).toBe(200);
    expect(grants()).toEqual([]);
  });

  it('grant-side other-open-subscription check: another open row for the user -> no grant [SEEDED: mirror drift, a state the one-open index forbids]', async () => {
    const ev = renewal2a();
    useDb({
      stripe_customers: [customerRow(CUS_2A)],
      billing_subscriptions: [
        subRow(SUB_2A.id, CUS_2A),
        subRow('sub_OTHER_OPEN', 'cus_OTHER', { status: 'past_due' }),
      ],
    });
    expect((await deliver(ev)).status).toBe(200);
    expect(grants()).toEqual([]);
  });
});

describe('invoice.paid gates on real fixtures (C-3b, C-D3, C-D2, C-D2b)', () => {
  it('C-3b: trial invoice total 0 -> no grant (re-fetches taken while trialing)', async () => {
    const sub = fx('sub-E-trialing');
    const inv = fx('inv-E-trial');
    // Every other gate passes, so total > 0 is the only thing in the way.
    expect([sub.status, inv.status, inv.total, inv.billing_reason]).toEqual(['trialing', 'paid', 0, 'subscription_create']);
    expect(inv.lines.data[0].period.end).toBe(sub.current_period_end);
    useDb({ stripe_customers: [customerRow(sub.customer)] });
    serve(inv, sub);
    expect((await deliver(fx('ev-E-trial-invoice.paid'))).status).toBe(200);
    expect(grants()).toEqual([]);
  });

  it('C-3c: invoice.paid while the subscription is paused -> no grant [COMPOSED: resume invoice, paused sub re-fetch]', async () => {
    const sub = fx('sub-2cu-paused');
    const inv = fx('inv-2cu-resume');
    expect(sub.id).toBe(inv.subscription);
    expect([sub.status, sub.pause_collection?.behavior]).toEqual(['active', 'mark_uncollectible']);
    useDb({ stripe_customers: [customerRow(sub.customer)] });
    serve(inv, sub, fx('ev-2cu-resume-charge.succeeded').data.object);
    expect((await deliver(fx('ev-2cu-resume-invoice.paid'))).status).toBe(200);
    expect(grants()).toEqual([]);
  });

  it('C-D3: credit-settled renewal (total 1999, amount_paid 0, no charge) -> grant', async () => {
    const sub = fx('sub-2b-credit');
    const inv = fx('inv-2b-credit');
    expect([inv.total, inv.amount_paid, inv.charge]).toEqual([1999, 0, null]);
    useDb({ stripe_customers: [customerRow(sub.customer)] });
    serve(inv, sub);
    expect((await deliver(fx('ev-2b-invoice.paid-cycle'))).status).toBe(200);
    expect(grants().map((g) => g.p_paid_through)).toEqual([paidThrough(1796928475)]);
  });

  it('C-D2: void-pause resume (subscription_update) -> grant to the new period end', async () => {
    const sub = fx('sub-2cv-resume');
    useDb({ stripe_customers: [customerRow(sub.customer)] });
    const charge = fx('ev-2cv-resume-charge.succeeded').data.object; // the resume charge as delivered
    expect(charge.id).toBe(fx('inv-2cv-resume').charge);
    serve(fx('inv-2cv-resume'), sub, charge);
    expect((await deliver(fx('ev-2cv-resume-invoice.paid'))).status).toBe(200);
    expect(grants().map((g) => g.p_paid_through)).toEqual([paidThrough(1797792475)]);
  });

  it('C-D2b (R5): uncollectible resume, lines[0] is a proration item -> grant from the subscription line', async () => {
    const sub = fx('sub-2cu-resume');
    const inv = fx('inv-2cu-resume');
    expect(inv.lines.data[0]).toMatchObject({ type: 'invoiceitem', proration: true });
    useDb({ stripe_customers: [customerRow(sub.customer)] });
    const charge = fx('ev-2cu-resume-charge.succeeded').data.object; // the resume charge as delivered
    expect(charge.id).toBe(inv.charge);
    serve(inv, sub, charge);
    expect((await deliver(fx('ev-2cu-resume-invoice.paid'))).status).toBe(200);
    expect(grants().map((g) => g.p_paid_through)).toEqual([paidThrough(1797792475)]);
  });
});

// ---- customer.subscription.* -----------------------------------------------

describe('customer.subscription.* (C-3, C-ORD, C-PF)', () => {
  it('C-3: paused (void) subscription.updated -> no grant, revoked', async () => {
    const sub = fx('sub-2cv-paused');
    expect(sub.status).toBe('active');
    expect(sub.pause_collection).toEqual({ behavior: 'void', resumes_at: null });
    useDb({ stripe_customers: [customerRow(sub.customer)] });
    serve(sub);
    expect((await deliver(fx('ev-2cv-sub.updated-paused'))).status).toBe(200);
    expect(grants()).toEqual([]);
    expect(revokes()).toEqual([{ p_user_id: USER, p_mode: 'test' }]);
    expect(db.rows('billing_subscriptions')[0]).toMatchObject({ paused: true, last_event_created: 1791658137 });
  });

  const SUB_2D = fx('sub-2d-cardfail');
  function seed2d(cursor: number | null, status = 'active') {
    useDb({
      stripe_customers: [customerRow(SUB_2D.customer)],
      billing_subscriptions: [subRow(SUB_2D.id, SUB_2D.customer, { status, last_event_created: cursor })],
    });
    serve(SUB_2D);
  }

  it('C-ORD (a): an event older than the stored cursor changes nothing in the mirror', async () => {
    seed2d(1791658164);
    const ev = fx('ev-2d-sub.updated-active');
    expect(ev.created).toBe(1791658129);
    expect((await deliver(ev)).status).toBe(200);
    expect(db.rows('billing_subscriptions')[0]).toMatchObject({ status: 'active', last_event_created: 1791658164 });
  });

  it('C-ORD (b): same-second event -> mirror unchanged, revoke still decided from the re-fetch (R7)', async () => {
    seed2d(1791658164);
    const ev = fx('ev-2d-sub.updated-past_due');
    expect(ev.created).toBe(1791658164);
    expect((await deliver(ev)).status).toBe(200);
    expect(db.rows('billing_subscriptions')[0]).toMatchObject({ status: 'active', last_event_created: 1791658164 });
    expect(revokes()).toEqual([{ p_user_id: USER, p_mode: 'test' }]);
  });

  it('C-ORD (c): a newer event updates the mirror and advances the cursor; a NULL cursor counts as older', async () => {
    seed2d(null);
    expect((await deliver(fx('ev-2d-sub.updated-past_due'))).status).toBe(200);
    expect(db.rows('billing_subscriptions')[0]).toMatchObject({ status: 'past_due', last_event_created: 1791658164 });
  });

  it('C-PF: invoice.payment_failed revokes now; the past_due subscription.updated keeps it revoked', async () => {
    useDb({ stripe_customers: [customerRow(SUB_2D.customer)] });
    serve(fx('inv-2d-cardfail'), SUB_2D);
    expect(fx('inv-2d-cardfail').status).toBe('open');
    expect((await deliver(fx('ev-2d-invoice.payment_failed'))).status).toBe(200);
    expect(revokes()).toHaveLength(1);
    expect((await deliver(fx('ev-2d-sub.updated-past_due'))).status).toBe(200);
    expect(revokes()).toHaveLength(2);
    expect(grants()).toEqual([]);
  });

  it.each(['unpaid', 'incomplete_expired'])(
    'a subscription.updated that leaves the subscription %s -> revoked [EDITED: sub status]',
    async (status) => {
      seed2d(null);
      serve({ ...SUB_2D, status });
      expect((await deliver(fx('ev-2d-sub.updated-past_due'))).status).toBe(200);
      expect(revokes()).toEqual([{ p_user_id: USER, p_mode: 'test' }]);
    }
  );

  it('C-PF2: payment_failed whose invoice is now paid -> no revoke [COMPOSED: 2d event, 2a paid invoice re-fetch]', async () => {
    useDb({ stripe_customers: [customerRow(SUB_2D.customer)] });
    serveAs(fx('ev-2d-invoice.payment_failed').data.object.id, INV_2A);
    serve(SUB_2D);
    expect((await deliver(fx('ev-2d-invoice.payment_failed'))).status).toBe(200);
    expect(revokes()).toEqual([]);
  });
});

// ---- deleted / duplicates ------------------------------------------------------

const SUB_C1 = fx('sub-C-1'); // the customer's first (incumbent) subscription
const CUS_C = SUB_C1.customer as string;

describe('subscription.deleted and duplicates (C-DEL+, C-DEL, C-DUP, C-DUP2)', () => {
  it('C-DEL+ (R2): deleted for the current subscription -> revoked', async () => {
    const sub = fx('sub-B-deleted');
    useDb({
      stripe_customers: [customerRow(sub.customer)],
      billing_subscriptions: [subRow(sub.id, sub.customer)],
    });
    serve(sub);
    expect((await deliver(fx('ev-B-sub.deleted'))).status).toBe(200);
    expect(revokes()).toEqual([{ p_user_id: USER, p_mode: 'test' }]);
    expect(db.rows('billing_subscriptions')[0]).toMatchObject({ status: 'canceled' });
  });

  it('C-DEL+ (R2): deleted arriving before any row was stored -> revoked', async () => {
    const sub = fx('sub-B-deleted');
    useDb({ stripe_customers: [customerRow(sub.customer)] });
    serve(sub);
    expect((await deliver(fx('ev-B-sub.deleted'))).status).toBe(200);
    expect(revokes()).toHaveLength(1);
  });

  it('C-DEL: deleted for a duplicate while the incumbent is open -> no revoke', async () => {
    const dup = fx('sub-D-2-canceled');
    expect(dup.customer).toBe(CUS_C);
    useDb({
      stripe_customers: [customerRow(CUS_C)],
      billing_subscriptions: [subRow(SUB_C1.id, CUS_C)],
    });
    serve(dup);
    expect((await deliver(fx('ev-D-sub.deleted-dup'))).status).toBe(200);
    expect(revokes()).toEqual([]);
  });

  it('C-DUP: a second open subscription -> newcomer cancelled once; replay cancels nothing more', async () => {
    // [COMPOSED delivery order] The newcomer's event is its later `deleted`
    // envelope (E0 reads only its id); the re-fetch is the newcomer while open.
    useDb({ stripe_customers: [customerRow(CUS_C)], billing_subscriptions: [subRow(SUB_C1.id, CUS_C)] });
    const open = fx('sub-D-2-open');
    serve(open, SUB_C1);
    const res = await deliver(fx('ev-D-sub.deleted-dup'));
    expect(res.status).toBe(200);
    expect(mockSubscriptionsCancel.mock.calls).toEqual([
      [open.id, { prorate: false, invoice_now: false }, { idempotencyKey: `dup-cancel:${open.id}` }],
    ]);
    expect(mockCaptureMessage).toHaveBeenCalledWith('Duplicate Agent subscription cancelled', expect.objectContaining({ level: 'error' }));
    expect(db.rows('billing_subscriptions').map((r) => r.stripe_subscription_id)).toEqual([SUB_C1.id]);
    expect(revokes()).toEqual([]);

    // Replay: Stripe now reports the newcomer cancelled.
    serve(fx('sub-D-2-canceled'));
    expect((await deliver(fx('ev-D-sub.deleted-dup'))).status).toBe(200);
    expect(mockSubscriptionsCancel).toHaveBeenCalledTimes(1);
    expect(revokes()).toEqual([]);
  });

  it('C-DUP2 (R3): the stored incumbent is closed in Stripe -> newcomer kept, nothing cancelled', async () => {
    const staleIncumbent = fx('sub-D-3-canceled');
    expect(staleIncumbent.status).toBe('canceled');
    useDb({ stripe_customers: [customerRow(CUS_C)], billing_subscriptions: [subRow(staleIncumbent.id, CUS_C)] });
    const open = fx('sub-D-2-open');
    serve(open, staleIncumbent);
    expect((await deliver(fx('ev-D-sub.deleted-dup'))).status).toBe(200);
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    const byId = Object.fromEntries(db.rows('billing_subscriptions').map((r) => [r.stripe_subscription_id, r.status]));
    expect(byId).toEqual({ [staleIncumbent.id]: 'canceled', [open.id]: 'active' });
  });
});

// ---- refunds -------------------------------------------------------------------

describe('charge.refunded (C-4, R11, current-period rule)', () => {
  function seedRefund2a() {
    useDb({ stripe_customers: [customerRow(CUS_2A)], billing_subscriptions: [subRow(SUB_2A.id, CUS_2A)] });
    serve(fx('ch-4-after-refunds'), INV_2A, SUB_2A);
  }

  it('C-4: full refund of the current-period invoice charge -> revoked', async () => {
    seedRefund2a();
    expect(fx('ch-4-after-refunds').invoice).toBe(INV_2A.id);
    expect((await deliver(fx('ev-4-charge.refunded-full'))).status).toBe(200);
    expect(revokes()).toEqual([{ p_user_id: USER, p_mode: 'test' }]);
    expect(rpcCalls('record_refund')).toEqual([]);
  });

  it('C-4 partial (R11): partial refund (mid-refund re-fetch, refunded=false) -> not revoked', async () => {
    const ch = fx('ch-C-partial-expand-invoice');
    expect([ch.refunded, ch.amount_refunded]).toEqual([false, 500]);
    useDb({ stripe_customers: [customerRow(CUS_C)], billing_subscriptions: [subRow(SUB_C1.id, CUS_C)] });
    serve(ch, SUB_C1);
    expect((await deliver(fx('ev-C-charge.refunded-partial'))).status).toBe(200);
    expect(revokes()).toEqual([]);
  });

  it('a full refund of an OLDER period invoice -> not revoked [EDITED: sub current_period_end moved one period on]', async () => {
    seedRefund2a();
    serve({ ...SUB_2A, current_period_end: 1799520475 });
    expect((await deliver(fx('ev-4-charge.refunded-full'))).status).toBe(200);
    expect(revokes()).toEqual([]);
  });
});

// ---- disputes ------------------------------------------------------------------

describe('charge.dispute.created on a subscription invoice (C-R4)', () => {
  it('suspends the stored Agent user and revokes', async () => {
    const sub = fx('sub-A');
    const dp = fx('dp-A');
    const pi = fx('pi-A-expand-invoice');
    expect(pi.invoice.subscription).toBe(sub.id);
    useDb({
      stripe_customers: [customerRow(sub.customer)],
      billing_subscriptions: [subRow(sub.id, sub.customer)],
      payment_intents: [],
    });
    serve(dp, pi, sub);
    const res = await deliver(fx('ev-A-dispute.created'));
    expect(res.status).toBe(200);
    expect(rpcCalls('suspend_account_for_dispute')).toEqual([
      {
        p_user_id: USER,
        p_stripe_dispute_id: dp.id,
        p_payment_intent_id: pi.id,
        p_local_transaction_id: null,
        p_amount_cents: 1999,
        p_dispute_created_at: new Date(dp.created * 1000).toISOString(),
      },
    ]);
    expect(revokes()).toEqual([{ p_user_id: USER, p_mode: 'test' }]);
    expect(mockRetrieve).toHaveBeenCalledWith('payment_intent', pi.id, { expand: ['invoice'] });
  });

  it('suspend RPC error -> 500 (Stripe retries)', async () => {
    const sub = fx('sub-A');
    useDb({ stripe_customers: [customerRow(sub.customer)], payment_intents: [] });
    serve(fx('dp-A'), fx('pi-A-expand-invoice'), sub);
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db down' } });
    expect((await deliver(fx('ev-A-dispute.created'))).status).toBe(500);
  });
});

// ---- W-1 / W-2 -----------------------------------------------------------------

describe('W-1 / W-2 hazards', () => {
  it('W-1: subscription-mode checkout.session.completed never touches the saved card or payment_intents', async () => {
    const cs = fx('cs-W1-B');
    expect([cs.mode, cs.payment_intent, cs.metadata.user_id]).toEqual(['subscription', null, 'p0a-user-3']);
    useDb({ stripe_customers: [customerRow(cs.customer)] });
    serve(cs);
    // Hand-made envelope: E0 reads only id/type/livemode/created and data.object.id.
    const ev = { id: 'evt_FX3846_cs', type: 'checkout.session.completed', livemode: false, created: 1791700000, data: { object: { id: cs.id } } };
    expect((await deliver(ev)).status).toBe(200);
    expect(db.callsTo('stripe_customers', 'update')).toEqual([]);
    expect(db.callsTo('payment_intents')).toEqual([]);
  });

  it('W-2: an invoice PaymentIntent with unlock metadata never unlocks or writes payment_intents', async () => {
    const pi = fx('pi-W2');
    expect(pi.invoice).toBeTruthy();
    expect(pi.metadata.local_transaction_id).toBeTruthy();
    useDb({ payment_intents: [] });
    serve(pi);
    expect((await deliver(fx('ev-W2-pi.succeeded'))).status).toBe(200);
    expect(rpcCalls('finalize_paid_unlock')).toEqual([]);
    expect(db.callsTo('payment_intents')).toEqual([]);
  });
});

// ---- BACKLOG-3847: half-made incumbent (F2, SR R1b) and the write-through cursor (R6) ----------

describe('3847: incomplete incumbent + paid newcomer (C-INC, C-INC2, C-VOID-WH)', () => {
  // Real TEST objects, one customer (fixtures/stripe/p3847). The envelope is
  // hand-made: E0 reads only id/type/livemode/created and data.object.id.
  const FX47 = path.join(__dirname, '../../../fixtures/stripe/p3847');
  const fx47 = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FX47, `${n}.json`), 'utf8'));
  const A = fx47('sub-A-incomplete');
  const A_AFTER = fx47('sub-A-after-void');
  const C_INC = fx47('sub-C-incomplete');
  const C_ACTIVE = fx47('sub-C-active-after-pay');
  const CUS = A.customer as string;
  const created = (sub: Obj) => ({
    id: `evt_FX3847_${sub.id}`,
    type: 'customer.subscription.created',
    livemode: false,
    created: sub.created,
    data: { object: { id: sub.id } },
  });
  const statusById = () => Object.fromEntries(db.rows('billing_subscriptions').map((r) => [r.stripe_subscription_id, r.status]));

  it('C-INC + SR-P1b: stored incumbent still incomplete -> its invoice voided, incumbent closed, paid newcomer kept', async () => {
    expect([A.status, C_ACTIVE.status, C_ACTIVE.customer]).toEqual(['incomplete', 'active', CUS]);
    useDb({ stripe_customers: [customerRow(CUS)], billing_subscriptions: [subRow(A.id, CUS, { status: 'incomplete' })] });
    serve(A, C_ACTIVE);
    mockVoidInvoice.mockImplementation(async () => {
      serve(A_AFTER); // Stripe moves A to incomplete_expired synchronously (measured)
      return fx47('inv-A-void');
    });
    expect((await deliver(created(C_ACTIVE))).status).toBe(200);
    expect(mockVoidInvoice.mock.calls).toEqual([[A.latest_invoice, {}, { idempotencyKey: `incomplete-void:${A.latest_invoice}` }]]);
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    expect(statusById()).toEqual({ [A.id]: 'incomplete_expired', [C_ACTIVE.id]: 'active' });
  });

  it('C-INC2: incumbent already incomplete_expired in Stripe -> newcomer kept, nothing voided or cancelled', async () => {
    useDb({ stripe_customers: [customerRow(CUS)], billing_subscriptions: [subRow(A.id, CUS, { status: 'incomplete' })] });
    serve(A_AFTER, C_ACTIVE);
    expect((await deliver(created(C_ACTIVE))).status).toBe(200);
    expect(mockVoidInvoice).not.toHaveBeenCalled();
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    expect(statusById()).toEqual({ [A.id]: 'incomplete_expired', [C_ACTIVE.id]: 'active' });
  });

  it('C-VOID-WH: the incumbent was paid meanwhile (void refused) -> incumbent NOT cancelled; the newcomer is the duplicate [COMPOSED newcomer id]', async () => {
    const err = fx47('inv-C-void-refused').error;
    const newcomer = { ...C_ACTIVE, id: 'sub_COMPOSED_newcomer' };
    useDb({ stripe_customers: [customerRow(CUS)], billing_subscriptions: [subRow(C_INC.id, CUS, { status: 'incomplete' })] });
    serve(C_INC, newcomer);
    mockVoidInvoice.mockImplementation(async () => {
      serve(C_ACTIVE); // paid out of band before our void (TEST: invoices.pay, then void -> refused)
      throw Object.assign(new Error(err.message), { type: 'StripeInvalidRequestError', rawType: err.type });
    });
    expect((await deliver(created(newcomer))).status).toBe(200);
    expect(mockSubscriptionsCancel.mock.calls.map((c) => c[0])).toEqual([newcomer.id]);
    expect(statusById()).toEqual({ [C_INC.id]: 'incomplete' });
  });

  // BACKLOG-3847 QA3: the incumbent was made by Checkout (3DS failed) and its
  // session is still open. Stripe refuses the void while that session is open
  // and ends the subscription itself when the session is expired (measured,
  // fixtures/stripe/p3847-qa3). The newcomer is C_ACTIVE [COMPOSED: same TEST
  // customer, a different capture].
  it('C-QA3-WH: incumbent held by an open Checkout session -> session expired FIRST, nothing voided, incumbent closed, newcomer kept', async () => {
    const FXQ = path.join(__dirname, '../../../fixtures/stripe/p3847-qa3');
    const fxq = (n: string): Obj => JSON.parse(fs.readFileSync(path.join(FXQ, `${n}.json`), 'utf8'));
    const Q = fxq('sub-Q-incomplete');
    const CS = fxq('cs-Q-open');
    expect([Q.status, Q.customer, CS.status, CS.subscription, CS.invoice]).toEqual(['incomplete', CUS, 'open', Q.id, Q.latest_invoice]);
    const refusedOpen = fxq('inv-Q-void-refused-open-session').error;
    const refusedNotOpen = fxq('inv-Q-void-refused-not-open').error;
    let expired = false;
    useDb({ stripe_customers: [customerRow(CUS)], billing_subscriptions: [subRow(Q.id, CUS, { status: 'incomplete' })] });
    serve(Q, C_ACTIVE);
    // [COMPOSED] the by-subscription listing before expiry: the captured
    // after-expiry listing with its one session swapped for the open capture.
    mockSessionsList.mockImplementation(async () =>
      expired ? fxq('sessions-by-sub-Q-after-expire') : { ...fxq('sessions-by-sub-Q-after-expire'), data: [CS] }
    );
    mockSessionsExpire.mockImplementation(async () => {
      expired = true;
      serve(fxq('sub-Q-after-expire'));
      return fxq('cs-Q-expire');
    });
    mockVoidInvoice.mockImplementation(async () => {
      const e = expired ? refusedNotOpen : refusedOpen;
      throw Object.assign(new Error(e.message), { type: 'StripeInvalidRequestError', rawType: e.type });
    });
    expect((await deliver(created(C_ACTIVE))).status).toBe(200);
    expect(mockSessionsList.mock.calls[0][0]).toEqual({ subscription: Q.id });
    expect(mockSessionsExpire.mock.calls).toEqual([[CS.id]]);
    expect(mockVoidInvoice).not.toHaveBeenCalled();
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    expect(statusById()).toEqual({ [Q.id]: 'incomplete_expired', [C_ACTIVE.id]: 'active' });
  });

  it('a failed void on a subscription that is still incomplete -> 500 so Stripe retries; nothing cancelled', async () => {
    useDb({ stripe_customers: [customerRow(CUS)], billing_subscriptions: [subRow(A.id, CUS, { status: 'incomplete' })] });
    serve(A, C_ACTIVE);
    mockVoidInvoice.mockRejectedValue(new Error('network'));
    expect((await deliver(created(C_ACTIVE))).status).toBe(500);
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
  });
});

describe('3847 R6: the write-through never takes the webhook cursor (C-WT-CURSOR)', () => {
  it('write-through, then the action\'s own subscription.updated in the same second -> applied', async () => {
    const FX47 = path.join(__dirname, '../../../fixtures/stripe/p3847');
    const pending = JSON.parse(fs.readFileSync(path.join(FX47, 'sub-C-cancel-at-period-end.json'), 'utf8'));
    const { writeThroughCancelFlag } = await import('@/lib/billing/sync');
    const { createServiceClient } = await import('@/lib/supabase/service');
    // [SEEDED] a row whose period is stale, so the event's own write is visible.
    useDb({
      stripe_customers: [customerRow(pending.customer)],
      billing_subscriptions: [subRow(pending.id, pending.customer, { current_period_end: null, cancel_at_period_end: false, last_event_created: 1791000000 })],
    });
    serve(pending);
    await writeThroughCancelFlag(createServiceClient(), pending);
    const second = Math.floor(Date.now() / 1000);
    const ev = { id: 'evt_FX3847_upd', type: 'customer.subscription.updated', livemode: false, created: second, data: { object: { id: pending.id } } };
    expect((await deliver(ev)).status).toBe(200);
    expect(db.rows('billing_subscriptions')[0]).toMatchObject({
      cancel_at_period_end: true,
      current_period_end: new Date(pending.current_period_end * 1000).toISOString(),
      last_event_created: second,
    });
  });

  it('the write-through leaves a closed row alone', async () => {
    const FX47 = path.join(__dirname, '../../../fixtures/stripe/p3847');
    const pending = JSON.parse(fs.readFileSync(path.join(FX47, 'sub-C-cancel-at-period-end.json'), 'utf8'));
    const { writeThroughCancelFlag } = await import('@/lib/billing/sync');
    const { createServiceClient } = await import('@/lib/supabase/service');
    useDb({ billing_subscriptions: [subRow(pending.id, pending.customer, { status: 'canceled', cancel_at_period_end: false })] });
    await writeThroughCancelFlag(createServiceClient(), pending);
    expect(db.rows('billing_subscriptions')[0]).toMatchObject({ status: 'canceled', cancel_at_period_end: false });
  });
});
