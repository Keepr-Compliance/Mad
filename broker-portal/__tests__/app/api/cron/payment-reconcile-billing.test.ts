/**
 * @jest-environment node
 *
 * BACKLOG-3849 PR-2 — the nightly payment-reconcile route runs the Agent
 * subscription reconcile and the billing queue check after its PaymentIntent
 * loop, only while BILLING_ENABLED is on, each isolated from the other and from
 * the loop. No network: Stripe is a recording fake, Supabase is BillingDb.
 */

import { BillingDb } from '../../../helpers/billingDb';

const mockRpc = jest.fn();
const mockCaptureMessage = jest.fn();
let db: BillingDb;
const stripeCalls: string[] = [];
let subscriptionsList: jest.Mock;

jest.mock('@sentry/nextjs', () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  captureException: jest.fn(),
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: (t: string) => db.from(t), rpc: (...a: unknown[]) => mockRpc(...a) }),
}));
jest.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    paymentIntents: {
      retrieve: async (id: string) => {
        stripeCalls.push(`paymentIntents.retrieve:${id}`);
        return { id, status: 'requires_payment_method' };
      },
    },
    checkout: { sessions: { retrieve: async () => ({}) } },
    subscriptions: {
      list: (...a: unknown[]) => {
        stripeCalls.push('subscriptions.list');
        return subscriptionsList(...a);
      },
      retrieve: async () => {
        stripeCalls.push('subscriptions.retrieve');
        throw new Error('unexpected');
      },
    },
    invoices: {
      retrieve: async () => {
        stripeCalls.push('invoices.retrieve');
        throw new Error('unexpected');
      },
    },
  }),
}));
jest.mock('@/lib/payments/fulfillment', () => ({ fulfillPaidUnlock: jest.fn(), emitPaymentSucceeded: jest.fn() }));
jest.mock('@/lib/payments/receipt', () => ({ dispatchReceiptEmail: jest.fn() }));

import { GET } from '@/app/api/cron/payment-reconcile/route';

const OLD = '2026-10-01T00:00:00.000Z';
const ENV = { ...process.env };

function call(): Promise<Response> {
  return GET(new Request('https://x/api/cron/payment-reconcile', { headers: { authorization: 'Bearer secret' } }));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  process.env.CRON_SECRET = 'secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  stripeCalls.length = 0;
  subscriptionsList = jest.fn().mockResolvedValue({ object: 'list', data: [], has_more: false, url: '/v1/subscriptions' });
  mockRpc.mockResolvedValue({ data: null, error: null });
  db = new BillingDb({
    payment_intents: [
      { id: 'R-1', user_id: 'U1', local_transaction_id: 'TX', quoted_unit_price_cents: 1499, pricing_tier_id: 'T1', stripe_payment_intent_id: 'pi_stuck', stripe_checkout_session_id: null, status: 'succeeded', updated_at: OLD, stripe_mode: 'test' },
    ],
    billing_subscriptions: [],
    billing_outbox: [
      { id: 'P1', stripe_mode: 'test', kind: 'agent_receipt', processed_at: null, run_after: 'infinity', claimed_until: null, user_id: 'U1' },
    ],
  });
});

afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

const billingTables = () => db.calls.filter((c) => c.table !== 'payment_intents');

describe('BILLING_ENABLED off', () => {
  it.each([undefined, 'false', '1', 'TRUE'])('flag %s -> PaymentIntent loop only: zero billing Stripe, table or RPC calls', async (flag) => {
    if (flag === undefined) delete process.env.BILLING_ENABLED;
    else process.env.BILLING_ENABLED = flag;
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reconciled: 0, skipped: 1, scanned: 1, billing: { disabled: true } });
    expect(stripeCalls).toEqual(['paymentIntents.retrieve:pi_stuck']);
    expect(billingTables()).toEqual([]);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

describe('BILLING_ENABLED on', () => {
  beforeEach(() => {
    process.env.BILLING_ENABLED = 'true';
  });

  it('runs after the PaymentIntent loop, which is unchanged', async () => {
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ reconciled: 0, skipped: 1, scanned: 1 });
    expect(body.billing.outbox).toEqual({ stale: 0, parked: 1 });
    expect(stripeCalls[0]).toBe('paymentIntents.retrieve:pi_stuck');
    expect(stripeCalls.slice(1)).toEqual(['subscriptions.list', 'subscriptions.list']);
  });

  it('a Stripe failure in the reconcile does not stop the queue check or the PaymentIntent result', async () => {
    subscriptionsList.mockRejectedValue(Object.assign(new Error('boom'), { type: 'StripeConnectionError' }));
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ reconciled: 0, skipped: 1, scanned: 1, billing: { subscriptions: { error: true }, outbox: { stale: 0, parked: 1 } } });
    expect(mockCaptureMessage.mock.calls.map((c) => c[0])).toEqual(['billing alert: outbox_parked']);
  });

  it('a failing queue read does not stop the reconcile result', async () => {
    db.failNext['billing_outbox.select'] = { code: 'XX000', message: 'down' };
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.billing).toMatchObject({ outbox: { error: true }, subscriptions: { forwardScanned: 0, reverseScanned: 0 } });
  });
});
