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

const mockGetUser = jest.fn();
const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockCheckoutCreate = jest.fn();
const mockConstructEvent = jest.fn();
const mockCustomersCreate = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: mockGetUser } }),
}));

jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));

jest.mock('stripe', () => {
  const StripeMock = jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockCheckoutCreate } },
    customers: { create: mockCustomersCreate },
    webhooks: { constructEvent: mockConstructEvent },
  }));
  // Preserve the error classes shape used by the charge route.
  // @ts-expect-error augmenting the mock ctor with error namespaces
  StripeMock.errors = { StripeCardError: class StripeCardError extends Error {} };
  return { __esModule: true, default: StripeMock };
});

function bearer(token: string): Request {
  return new Request('https://app.keeprcompliance.com/api/payments/checkout-session', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ local_transaction_id: 'TX-1' }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'whsec_dummy';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon_dummy';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.keeprcompliance.com';
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
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'USER-1', email: 'u@example.com' } },
      error: null,
    });
    // service.rpc('get_next_unlock_quote') -> row
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'get_next_unlock_quote') {
        return Promise.resolve({
          data: [{ next_unit_index: 1, unit_price_cents: quoteCents, currency: 'usd', pricing_tier_id: 'TIER-1' }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    // service.from(...) chainable: stripe_customers select -> existing customer; insert -> ok
    mockFrom.mockImplementation((table: string) => {
      if (table === 'stripe_customers') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { stripe_customer_id: 'cus_1' }, error: null }) }) }),
        };
      }
      // payment_intents insert
      return { insert: () => Promise.resolve({ error: null }) };
    });
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
      data: {
        object: {
          id: 'pi_1',
          amount: 1499,
          metadata: { user_id: 'USER-1', local_transaction_id: 'TX-1', pricing_tier_id: 'TIER-1', quoted_unit_price_cents: '1499' },
        },
      },
    });
    mockRpc.mockResolvedValue({ data: { unlocked: true, already_fulfilled: false, balance_after: 0 }, error: null });
    mockFrom.mockImplementation(() => ({
      update: () => ({ eq: () => ({ in: () => Promise.resolve({ error: null }) }) }),
      insert: () => Promise.resolve({ error: null }),
    }));

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
      data: { object: { id: 'cs_1', customer: 'cus_1', payment_intent: null, metadata: { user_id: 'USER-1' } } },
    });
    mockFrom.mockImplementation(() => ({
      update: () => ({ eq: () => ({ in: () => Promise.resolve({ error: null }) }) }),
    }));
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
