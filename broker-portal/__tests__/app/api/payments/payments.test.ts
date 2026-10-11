/**
 * @jest-environment node
 *
 * Portal-route tests for the Stripe PAYG money path (BACKLOG-2005a).
 *
 * These mock the Stripe SDK and the service Supabase client, so they run with NO
 * live Stripe round-trip. Cases that would require the real Stripe account (live
 * Checkout/PI creation end-to-end) are covered by the SQL smoke suite against the
 * DB RPCs (R1/R3/R4 in the PR description) and are intentionally NOT duplicated here.
 *
 * Live-Stripe activation is BACKLOG-2017; until then, no test needs a real key.
 */

import { NextResponse } from 'next/server';

// ---- Mocks ---------------------------------------------------------------

import { BillingDb, eqValue, type Row } from '../../../helpers/billingDb';

const mockGetUser = jest.fn();
const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockCheckoutCreate = jest.fn();
const mockCheckoutExpire = jest.fn();
const mockCheckoutRetrieve = jest.fn();
const mockConstructEvent = jest.fn();
const mockCustomersCreate = jest.fn();
const mockPaymentIntentsCreate = jest.fn();
const mockPaymentIntentsRetrieve = jest.fn();
const mockCaptureMessage = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  captureException: jest.fn(),
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: mockGetUser } }),
}));

jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

// Error class hierarchy mirrors the real `stripe` SDK: StripeCardError and
// StripeInvalidRequestError both extend the StripeError base. The charge route
// uses `instanceof Stripe.errors.StripeError` and its subclasses (BACKLOG-2088).
class StripeErrorMock extends Error {
  code?: string;
  payment_intent?: unknown;
}
class StripeCardErrorMock extends StripeErrorMock {}
class StripeInvalidRequestErrorMock extends StripeErrorMock {}

jest.mock('stripe', () => {
  const StripeMock = jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockCheckoutCreate, expire: mockCheckoutExpire, retrieve: mockCheckoutRetrieve } },
    customers: { create: mockCustomersCreate },
    paymentIntents: { create: mockPaymentIntentsCreate, retrieve: mockPaymentIntentsRetrieve },
    webhooks: { constructEvent: mockConstructEvent },
  }));
  // Preserve the error classes shape used by the charge route.
  // @ts-expect-error augmenting the mock ctor with error namespaces
  StripeMock.errors = {
    StripeError: StripeErrorMock,
    StripeCardError: StripeCardErrorMock,
    StripeInvalidRequestError: StripeInvalidRequestErrorMock,
  };
  return { __esModule: true, default: StripeMock };
});

function bearer(token: string): Request {
  return new Request('https://app.keeprcompliance.com/api/payments/checkout-session', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ local_transaction_id: 'TX-1' }),
  });
}

// Synthetic ids. The test customer stands in for the P0-a TEST customer
// (scratchpad p0a-fixtures, customer objects); the live one is a placeholder
// never sent to Stripe (plan v3 RC9 C-9 fixture rule).
const TEST_CUSTOMER = 'cus_FX3845test';
const LIVE_CUSTOMER = 'cus_LIVE_PLACEHOLDER';

function customerRow(mode: 'test' | 'live', over: Row = {}): Row {
  return {
    user_id: 'USER-1',
    stripe_customer_id: mode === 'test' ? TEST_CUSTOMER : LIVE_CUSTOMER,
    default_payment_method_id: mode === 'test' ? 'pm_FX3845test' : 'pm_FX3845live',
    created_at: '2026-10-01T00:00:00+00:00',
    updated_at: '2026-10-01T00:00:00+00:00',
    stripe_mode: mode,
    ...over,
  };
}

/** USER-1's personal organization; is_test decides whether test mode serves them. */
function personalOrg(isTest: boolean): Row {
  return { id: 'ORG-P1', personal_owner_user_id: 'USER-1', is_test: isTest };
}

let db: BillingDb;
function useDb(seed: Record<string, Row[]>): BillingDb {
  db = new BillingDb(seed);
  mockFrom.mockImplementation(db.from);
  return db;
}

function quoteRpc(cents = 1499) {
  mockRpc.mockImplementation((fn: string) => {
    if (fn === 'get_next_unlock_quote') {
      return Promise.resolve({
        data: [{ next_unit_index: 1, unit_price_cents: cents, currency: 'usd', pricing_tier_id: 'TIER-1' }],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

function signedIn() {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'USER-1', email: 'u@example.com' } }, error: null });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'whsec_dummy';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon_dummy';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.keeprcompliance.com';
  useDb({ organizations: [personalOrg(true)] });
});

// ---- R5: auth ------------------------------------------------------------

describe('R5 auth — desktop Bearer JWT verification', () => {
  it('rejects a request with no Bearer token (401, no Stripe call)', async () => {
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    const req = new Request('https://app.keeprcompliance.com/api/payments/checkout-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ local_transaction_id: 'TX-1' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it('rejects an invalid/forged token (401, no Stripe call)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    const res = await POST(bearer('forged'));
    expect(res.status).toBe(401);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });
});

// ---- Quote integrity + C-A metadata --------------------------------------

describe('Quote integrity + C-A metadata propagation', () => {
  function wireHappyCheckout(quoteCents: number) {
    signedIn();
    quoteRpc(quoteCents);
    // is_test user with an existing test customer (test-mode key).
    useDb({ organizations: [personalOrg(true)], stripe_customers: [customerRow('test')] });
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe/x', payment_intent: 'pi_1' });
  }

  it('charges the SERVER quote (ignores any client price) and returns checkout_url', async () => {
    wireHappyCheckout(1499);
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    const res = await POST(bearer('valid'));
    const json = await (res as NextResponse).json();
    expect(json.checkout_url).toBe('https://checkout.stripe/x');

    const params = mockCheckoutCreate.mock.calls[0][0];
    // amount comes from the server quote, not the request body
    expect(params.line_items[0].price_data.unit_amount).toBe(1499);
  });

  it('C-A: fulfillment metadata rides payment_intent_data.metadata with the exact tx id', async () => {
    wireHappyCheckout(1499);
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    await POST(bearer('valid'));

    const params = mockCheckoutCreate.mock.calls[0][0];
    // THE load-bearing assertion: the PI metadata (not just session metadata) carries the tx identity.
    expect(params.payment_intent_data.metadata.local_transaction_id).toBe('TX-1');
    expect(params.payment_intent_data.metadata.user_id).toBe('USER-1');
    expect(params.payment_intent_data.setup_future_usage).toBe('off_session');
  });

  it('uses a double-click idempotency key derived from (user, tx, quote)', async () => {
    wireHappyCheckout(1499);
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    await POST(bearer('valid'));
    const opts = mockCheckoutCreate.mock.calls[0][1];
    expect(opts.idempotencyKey).toBe('co:USER-1:TX-1:1499');
  });
});

// ---- Charge route (Flow B off-session) — BACKLOG-2088 --------------------

describe('POST /api/payments/charge — off-session outcomes (BACKLOG-2088)', () => {
  function chargeReq(token = 'valid'): Request {
    return new Request('https://app.keeprcompliance.com/api/payments/charge', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ local_transaction_id: 'TX-1' }),
    });
  }

  // The stripe_customers update(s) and payment_intents insert count, read
  // back from the recording fake.
  let customerUpdates: Array<Record<string, unknown>>;
  let paymentIntentInserts: number;
  function readBack(): void {
    customerUpdates = db.callsTo('stripe_customers', 'update').map((c) => c.payload as Record<string, unknown>);
    paymentIntentInserts = db.callsTo('payment_intents', 'insert').length;
  }

  function wireChargeContext(opts: { savedPm?: string | null } = {}): void {
    const savedPm = opts.savedPm === undefined ? 'pm_saved_1' : opts.savedPm;
    signedIn();
    quoteRpc(1499);
    useDb({
      organizations: [personalOrg(true)],
      stripe_customers: [customerRow('test', { default_payment_method_id: savedPm })],
    });
  }

  it('409 no_saved_card when there is no default payment method (no Stripe call)', async () => {
    wireChargeContext({ savedPm: null });
    const { POST } = await import('@/app/api/payments/charge/route');
    const res = await POST(chargeReq());
    expect(res.status).toBe(409);
    expect(await (res as NextResponse).json()).toMatchObject({ error: 'no_saved_payment_method' });
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
  });

  it('succeeded → { succeeded: true } and records the PI (webhook fulfills)', async () => {
    wireChargeContext();
    mockPaymentIntentsCreate.mockResolvedValue({ id: 'pi_ok', status: 'succeeded' });
    const { POST } = await import('@/app/api/payments/charge/route');
    const res = await POST(chargeReq());
    expect(res.status).toBe(200);
    expect(await (res as NextResponse).json()).toMatchObject({ succeeded: true, payment_intent_id: 'pi_ok' });
    readBack();
    expect(paymentIntentInserts).toBe(1);
  });

  it('hard decline (StripeCardError) → 402 declined, NOT 200', async () => {
    wireChargeContext();
    const err = new StripeCardErrorMock('Your card was declined.');
    err.code = 'card_declined';
    mockPaymentIntentsCreate.mockRejectedValue(err);
    const { POST } = await import('@/app/api/payments/charge/route');
    const res = await POST(chargeReq());
    expect(res.status).toBe(402);
    const json = await (res as NextResponse).json();
    expect(json).toMatchObject({ declined: true, code: 'card_declined' });
    expect(json.invalid_payment_method).toBeUndefined();
  });

  it('invalid/detached PM (StripeInvalidRequestError) → 402 invalid_payment_method + clears stale cache, NEVER 200', async () => {
    wireChargeContext();
    const err = new StripeInvalidRequestErrorMock('No such PaymentMethod: pm_saved_1');
    err.code = 'resource_missing';
    mockPaymentIntentsCreate.mockRejectedValue(err);
    const { POST } = await import('@/app/api/payments/charge/route');
    const res = await POST(chargeReq());

    // Money-safety UX: a failed off-session charge must NOT report success.
    expect(res.status).toBe(402);
    const json = await (res as NextResponse).json();
    expect(json).toMatchObject({ invalid_payment_method: true });
    expect(json.succeeded).toBeUndefined();

    // The stale saved-card cache is cleared so the next attempt routes to Checkout.
    readBack();
    expect(customerUpdates).toContainEqual({ default_payment_method_id: null });
    // No PI row is written for a charge that never created a PaymentIntent.
    expect(paymentIntentInserts).toBe(0);
  });

  it('non-throwing create with a non-terminal status → 402, never a false { succeeded: true }', async () => {
    wireChargeContext();
    // Defense-in-depth: Stripe returned WITHOUT throwing but the PI is not paid.
    mockPaymentIntentsCreate.mockResolvedValue({
      id: 'pi_soft',
      status: 'requires_payment_method',
      last_payment_error: { code: 'card_declined', message: 'Declined' },
    });
    const { POST } = await import('@/app/api/payments/charge/route');
    const res = await POST(chargeReq());
    expect(res.status).toBe(402);
    const json = await (res as NextResponse).json();
    expect(json).toMatchObject({ declined: true });
    expect(json.succeeded).toBeUndefined();
    // No "created" PI row for an unpaid intent.
    readBack();
    expect(paymentIntentInserts).toBe(0);
  });
});

// ---- Webhook signature ---------------------------------------------------

describe('Webhook signature verification', () => {
  it('rejects a request with no signature header (400, no fulfillment)', async () => {
    const { POST } = await import('@/app/api/payments/webhook/route');
    const req = new Request('https://x/api/payments/webhook', { method: 'POST', body: '{}' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects a tampered signature (400, no ledger write)', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('signature mismatch');
    });
    const { POST } = await import('@/app/api/payments/webhook/route');
    const req = new Request('https://x/api/payments/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'bad' },
      body: 'raw',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('fulfills on payment_intent.succeeded via finalize_paid_unlock with PI metadata', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      livemode: false,
      data: {
        object: {
          id: 'pi_1',
          amount: 1499,
          metadata: { user_id: 'USER-1', local_transaction_id: 'TX-1', pricing_tier_id: 'TIER-1', quoted_unit_price_cents: '1499' },
        },
      },
    });
    mockRpc.mockResolvedValue({ data: { unlocked: true, already_fulfilled: false, balance_after: 0 }, error: null });

    const { POST } = await import('@/app/api/payments/webhook/route');
    const req = new Request('https://x/api/payments/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'ok' },
      body: 'raw',
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const finalizeCall = mockRpc.mock.calls.find((c) => c[0] === 'finalize_paid_unlock');
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall![1].p_user_id).toBe('USER-1');
    expect(finalizeCall![1].p_local_transaction_id).toBe('TX-1');
    expect(finalizeCall![1].p_unit_price_cents).toBe(1499);
  });

  it('does NOT fulfill on checkout.session.completed (PM-save only, R4)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_2',
      type: 'checkout.session.completed',
      livemode: false,
      data: { object: { id: 'cs_1', customer: TEST_CUSTOMER, payment_intent: null, metadata: { user_id: 'USER-1' } } },
    });
    const { POST } = await import('@/app/api/payments/webhook/route');
    const req = new Request('https://x/api/payments/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'ok' },
      body: 'raw',
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const finalizeCall = mockRpc.mock.calls.find((c) => c[0] === 'finalize_paid_unlock');
    expect(finalizeCall).toBeUndefined();
  });
});

// ---- Chargeback → suspension (BACKLOG-2077) ------------------------------

describe('Webhook charge.dispute.created → account suspension', () => {
  it('suspends the user resolved from the payment_intents row with the exact dispute fields', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_dispute_1',
      type: 'charge.dispute.created',
      livemode: false,
      data: {
        object: {
          id: 'dp_123',
          payment_intent: 'pi_disputed',
          amount: 1499,
          created: 1_700_000_000, // unix seconds
        },
      },
    });
    // The stored row that maps this PI to a user (identity comes from OUR row, never dispute md).
    useDb({
      payment_intents: [
        { id: 'PIROW-1', user_id: 'USER-DISPUTED', local_transaction_id: 'TX-DISPUTED', stripe_payment_intent_id: 'pi_disputed', stripe_mode: 'test' },
      ],
    });
    mockRpc.mockResolvedValue({
      data: { already_suspended: false, user_id: 'USER-DISPUTED' },
      error: null,
    });

    const { POST } = await import('@/app/api/payments/webhook/route');
    const req = new Request('https://x/api/payments/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'ok' },
      body: 'raw',
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const suspendCall = mockRpc.mock.calls.find((c) => c[0] === 'suspend_account_for_dispute');
    expect(suspendCall).toBeDefined();
    // Load-bearing: the EXACT user (from our PI row) + dispute identity are passed.
    expect(suspendCall![1]).toMatchObject({
      p_user_id: 'USER-DISPUTED',
      p_stripe_dispute_id: 'dp_123',
      p_payment_intent_id: 'pi_disputed',
      p_local_transaction_id: 'TX-DISPUTED',
      p_amount_cents: 1499,
    });
    // created (unix seconds) becomes an ISO timestamp.
    expect(suspendCall![1].p_dispute_created_at).toBe(
      new Date(1_700_000_000 * 1000).toISOString()
    );
  });

  it('does NOT suspend when no payment_intents row maps the disputed PI (200, no RPC)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_dispute_2',
      type: 'charge.dispute.created',
      livemode: false,
      data: { object: { id: 'dp_orphan', payment_intent: 'pi_unknown', amount: 500, created: 1 } },
    });
    useDb({ payment_intents: [] });

    const { POST } = await import('@/app/api/payments/webhook/route');
    const req = new Request('https://x/api/payments/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'ok' },
      body: 'raw',
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockRpc.mock.calls.find((c) => c[0] === 'suspend_account_for_dispute')).toBeUndefined();
  });

  it('returns non-2xx (Stripe retries) when the payment_intents READ errors — a DB blip is not "no row"', async () => {
    // B1 (SR): a transient lookup failure must NOT be swallowed as "no row" (200,
    // no retry). It must throw so Stripe re-delivers and the suspension is not lost.
    mockConstructEvent.mockReturnValue({
      id: 'evt_dispute_read_err',
      type: 'charge.dispute.created',
      livemode: false,
      data: { object: { id: 'dp_readfail', payment_intent: 'pi_readfail', amount: 700, created: 3 } },
    });
    // data:null AND error set = a real DB/PostgREST failure, distinct from
    // the benign {data:null, error:null} genuinely-no-row case above.
    useDb({ payment_intents: [] }).failNext['payment_intents.select'] = { code: 'PGRST000', message: 'postgrest 503' };

    const { POST } = await import('@/app/api/payments/webhook/route');
    const req = new Request('https://x/api/payments/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'ok' },
      body: 'raw',
    });
    const res = await POST(req);
    // Non-2xx so Stripe retries; the suspend RPC is never reached (nothing to
    // suspend yet — the identity read itself failed).
    expect(res.status).toBe(500);
    expect(mockRpc.mock.calls.find((c) => c[0] === 'suspend_account_for_dispute')).toBeUndefined();
  });

  it('returns non-2xx (Stripe retries) when the suspend RPC errors — never silently drops it', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_dispute_3',
      type: 'charge.dispute.created',
      livemode: false,
      data: { object: { id: 'dp_err', payment_intent: 'pi_x', amount: 999, created: 2 } },
    });
    useDb({ payment_intents: [{ id: 'PIROW-3', user_id: 'U', local_transaction_id: 'T', stripe_payment_intent_id: 'pi_x', stripe_mode: 'test' }] });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db down' } });

    const { POST } = await import('@/app/api/payments/webhook/route');
    const req = new Request('https://x/api/payments/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'ok' },
      body: 'raw',
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});

// ---- Cron auth -----------------------------------------------------------

describe('Reconciliation cron auth', () => {
  it('rejects a request without the CRON_SECRET bearer (401)', async () => {
    process.env.CRON_SECRET = 'secret';
    const { GET } = await import('@/app/api/cron/payment-reconcile/route');
    const req = new Request('https://x/api/cron/payment-reconcile', { headers: { authorization: 'Bearer wrong' } });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});

// ---- BACKLOG-3845: Stripe-mode separation --------------------------------

describe('BACKLOG-3845 mode guard before any Stripe call (SR req. 10)', () => {
  it('test key + personal org not is_test → 403, no customer, no session', async () => {
    signedIn();
    quoteRpc();
    useDb({ organizations: [personalOrg(false)], stripe_customers: [] });
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    const res = await POST(bearer('valid'));
    expect(res.status).toBe(403);
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it('test key + no personal org → 403 (fails closed)', async () => {
    signedIn();
    quoteRpc();
    useDb({ organizations: [], stripe_customers: [] });
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    const res = await POST(bearer('valid'));
    expect(res.status).toBe(403);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it('charge: test key + non-test user → 403, no PaymentIntent', async () => {
    signedIn();
    quoteRpc();
    useDb({ organizations: [personalOrg(false)], stripe_customers: [customerRow('test')] });
    const { POST } = await import('@/app/api/payments/charge/route');
    const res = await POST(bearer('valid'));
    expect(res.status).toBe(403);
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
  });

  it('live key → no is_test read; a non-test user checks out', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_dummy';
    signedIn();
    quoteRpc();
    useDb({ organizations: [personalOrg(false)], stripe_customers: [customerRow('live')] });
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_live_1', url: 'https://checkout.stripe/live', payment_intent: null });
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    const res = await POST(bearer('valid'));
    expect(res.status).toBe(200);
    expect(db.callsTo('organizations')).toHaveLength(0);
  });
});

describe('BACKLOG-3845 C-9: a user with a test and a live customer row', () => {
  function seedBoth(isTest = true) {
    signedIn();
    quoteRpc();
    return useDb({ organizations: [personalOrg(isTest)], stripe_customers: [customerRow('test'), customerRow('live')] });
  }

  it('checkout (test key) uses the test customer and filters by mode', async () => {
    seedBoth();
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_t', url: 'https://checkout.stripe/t', payment_intent: null });
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    const res = await POST(bearer('valid'));
    expect(res.status).toBe(200);
    expect(mockCheckoutCreate.mock.calls[0][0].customer).toBe(TEST_CUSTOMER);
    expect(eqValue(db.callsTo('stripe_customers', 'select')[0], 'stripe_mode')).toBe('test');
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  it('checkout (live key) uses the live customer', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_dummy';
    seedBoth(false);
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_l', url: 'https://checkout.stripe/l', payment_intent: null });
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    const res = await POST(bearer('valid'));
    expect(res.status).toBe(200);
    expect(mockCheckoutCreate.mock.calls[0][0].customer).toBe(LIVE_CUSTOMER);
  });

  it('checkout (live key) with only a test row creates a live customer and leaves the test row alone', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_dummy';
    signedIn();
    quoteRpc();
    useDb({ organizations: [personalOrg(false)], stripe_customers: [customerRow('test')] });
    mockCustomersCreate.mockResolvedValue({ id: 'cus_FX3845new' });
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_l2', url: 'https://checkout.stripe/l2', payment_intent: null });
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    await POST(bearer('valid'));
    expect(mockCustomersCreate).toHaveBeenCalledTimes(1);
    expect(mockCheckoutCreate.mock.calls[0][0].customer).toBe('cus_FX3845new');
    expect(db.rows('stripe_customers')).toEqual([
      customerRow('test'),
      { user_id: 'USER-1', stripe_customer_id: 'cus_FX3845new', stripe_mode: 'live' },
    ]);
  });

  it('charge (live key) charges the live customer and saved card', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_dummy';
    seedBoth(false);
    mockPaymentIntentsCreate.mockResolvedValue({ id: 'pi_live_ok', status: 'succeeded' });
    const { POST } = await import('@/app/api/payments/charge/route');
    const res = await POST(bearer('valid'));
    expect(res.status).toBe(200);
    expect(mockPaymentIntentsCreate.mock.calls[0][0]).toMatchObject({ customer: LIVE_CUSTOMER, payment_method: 'pm_FX3845live' });
  });

  it('charge (test key) charges the test customer and saved card', async () => {
    seedBoth();
    mockPaymentIntentsCreate.mockResolvedValue({ id: 'pi_test_ok', status: 'succeeded' });
    const { POST } = await import('@/app/api/payments/charge/route');
    const res = await POST(bearer('valid'));
    expect(res.status).toBe(200);
    expect(mockPaymentIntentsCreate.mock.calls[0][0]).toMatchObject({ customer: TEST_CUSTOMER, payment_method: 'pm_FX3845test' });
  });

  it('charge card-clear (live key) clears only the live row', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_dummy';
    seedBoth(false);
    const err = new StripeInvalidRequestErrorMock('No such PaymentMethod');
    err.code = 'resource_missing';
    mockPaymentIntentsCreate.mockRejectedValue(err);
    const { POST } = await import('@/app/api/payments/charge/route');
    const res = await POST(bearer('valid'));
    expect(res.status).toBe(402);
    expect(db.rows('stripe_customers')).toEqual([
      customerRow('test'),
      customerRow('live', { default_payment_method_id: null }),
    ]);
  });

  it('webhook checkout.session.completed (test event, test key) saves the card on the test row only', async () => {
    seedBoth();
    mockConstructEvent.mockReturnValue({
      id: 'evt_cs_t',
      type: 'checkout.session.completed',
      livemode: false,
      data: { object: { id: 'cs_t9', customer: TEST_CUSTOMER, payment_intent: 'pi_t9', metadata: { user_id: 'USER-1' } } },
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({ id: 'pi_t9', payment_method: 'pm_FX3845new' });
    const { POST } = await import('@/app/api/payments/webhook/route');
    const res = await POST(new Request('https://x/api/payments/webhook', { method: 'POST', headers: { 'stripe-signature': 'ok' }, body: 'raw' }));
    expect(res.status).toBe(200);
    const [testRow, liveRow] = db.rows('stripe_customers');
    expect(testRow.default_payment_method_id).toBe('pm_FX3845new');
    expect(liveRow).toEqual(customerRow('live'));
  });
});

describe('BACKLOG-3845 every payment_intents insert carries stripe_mode; failures are not silent', () => {
  it('checkout insert carries the key mode', async () => {
    signedIn();
    quoteRpc();
    useDb({ organizations: [personalOrg(true)], stripe_customers: [customerRow('test')] });
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_m', url: 'https://checkout.stripe/m', payment_intent: null });
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    await POST(bearer('valid'));
    expect(db.callsTo('payment_intents', 'insert')[0].payload).toMatchObject({ stripe_checkout_session_id: 'cs_m', stripe_mode: 'test' });
  });

  it('checkout insert failure → session expired, 500, no checkout URL (SR req. 8)', async () => {
    signedIn();
    quoteRpc();
    useDb({ organizations: [personalOrg(true)], stripe_customers: [customerRow('test')] }).failNext['payment_intents.insert'] = {
      code: '23502',
      message: 'null value in column violates not-null constraint',
    };
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_fail', url: 'https://checkout.stripe/fail', payment_intent: null });
    const { POST } = await import('@/app/api/payments/checkout-session/route');
    const res = await POST(bearer('valid'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await (res as NextResponse).json())).not.toContain('checkout.stripe/fail');
    expect(mockCheckoutExpire).toHaveBeenCalledWith('cs_fail');
    expect(mockCaptureMessage).toHaveBeenCalledWith('payment_intents insert failed at checkout', expect.anything());
  });

  it('charge inserts carry the key mode (live)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_dummy';
    signedIn();
    quoteRpc();
    useDb({ organizations: [personalOrg(false)], stripe_customers: [customerRow('live')] });
    mockPaymentIntentsCreate.mockResolvedValue({ id: 'pi_m', status: 'succeeded' });
    const { POST } = await import('@/app/api/payments/charge/route');
    await POST(bearer('valid'));
    expect(db.callsTo('payment_intents', 'insert')[0].payload).toMatchObject({ stripe_payment_intent_id: 'pi_m', stripe_mode: 'live' });
  });

  it('charge insert failure after a successful charge → still succeeded, reported (SR req. 8)', async () => {
    signedIn();
    quoteRpc();
    useDb({ organizations: [personalOrg(true)], stripe_customers: [customerRow('test')] }).failNext['payment_intents.insert'] = {
      code: '42703',
      message: 'column does not exist',
    };
    mockPaymentIntentsCreate.mockResolvedValue({ id: 'pi_after', status: 'succeeded' });
    const { POST } = await import('@/app/api/payments/charge/route');
    const res = await POST(bearer('valid'));
    expect(res.status).toBe(200);
    expect(mockCaptureMessage).toHaveBeenCalledWith('payment_intents insert failed at charge', expect.anything());
  });
});

describe('BACKLOG-3845 E0: webhook drops events from the other mode', () => {
  function liveEventOnTestKey() {
    mockConstructEvent.mockReturnValue({
      id: 'evt_wrong_mode',
      type: 'payment_intent.succeeded',
      livemode: true,
      data: { object: { id: 'pi_w', amount: 1499, metadata: { user_id: 'USER-1', local_transaction_id: 'TX-1', quoted_unit_price_cents: '1499' } } },
    });
  }

  it('live event on a test key → 200, nothing written, no fulfillment', async () => {
    liveEventOnTestKey();
    const { POST } = await import('@/app/api/payments/webhook/route');
    const res = await POST(new Request('https://x/api/payments/webhook', { method: 'POST', headers: { 'stripe-signature': 'ok' }, body: 'raw' }));
    expect(res.status).toBe(200);
    expect(await (res as NextResponse).json()).toMatchObject({ ignored: 'mode_mismatch' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
    expect(mockCaptureMessage).toHaveBeenCalledWith('Stripe webhook event mode does not match key mode', expect.anything());
  });

  it('test event on a live key → 200, nothing written', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_dummy';
    mockConstructEvent.mockReturnValue({
      id: 'evt_test_on_live',
      type: 'checkout.session.completed',
      livemode: false,
      data: { object: { id: 'cs_x', customer: TEST_CUSTOMER, payment_intent: null, metadata: { user_id: 'USER-1' } } },
    });
    const { POST } = await import('@/app/api/payments/webhook/route');
    const res = await POST(new Request('https://x/api/payments/webhook', { method: 'POST', headers: { 'stripe-signature': 'ok' }, body: 'raw' }));
    expect(res.status).toBe(200);
    expect(db.calls).toHaveLength(0);
  });
});

describe('BACKLOG-3845 RC8: reconcile sweeps only the key mode', () => {
  it('live key → only live rows are read and retrieved from Stripe', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_dummy';
    process.env.CRON_SECRET = 'secret';
    const old = '2026-10-01T00:00:00.000Z';
    useDb({
      payment_intents: [
        { id: 'R-LIVE', user_id: 'USER-1', local_transaction_id: 'TX-L', quoted_unit_price_cents: 1499, pricing_tier_id: 'TIER-1', stripe_payment_intent_id: 'pi_live_stuck', stripe_checkout_session_id: null, status: 'succeeded', updated_at: old, stripe_mode: 'live' },
        { id: 'R-TEST', user_id: 'USER-1', local_transaction_id: 'TX-T', quoted_unit_price_cents: 1499, pricing_tier_id: 'TIER-1', stripe_payment_intent_id: 'pi_test_stuck', stripe_checkout_session_id: null, status: 'succeeded', updated_at: old, stripe_mode: 'test' },
      ],
    });
    mockPaymentIntentsRetrieve.mockResolvedValue({ status: 'requires_payment_method' });
    const { GET } = await import('@/app/api/cron/payment-reconcile/route');
    const res = await GET(new Request('https://x/api/cron/payment-reconcile', { headers: { authorization: 'Bearer secret' } }));
    expect(res.status).toBe(200);
    expect(await (res as NextResponse).json()).toMatchObject({ scanned: 1 });
    expect(mockPaymentIntentsRetrieve.mock.calls.map((c) => c[0])).toEqual(['pi_live_stuck']);
  });
});
