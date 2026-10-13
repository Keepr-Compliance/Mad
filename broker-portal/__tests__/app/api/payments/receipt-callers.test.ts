/**
 * @jest-environment node
 *
 * BACKLOG-3848 — C-RCPT callers: both places that send a per-export receipt
 * (the webhook on payment_intent.succeeded and the reconcile cron) pass the
 * Stripe client and the PaymentIntent's own customer, so the receipt goes to
 * the billing contact. The recipient rule itself is pinned in
 * __tests__/lib/billing/billingContact.test.ts. PaymentIntent shapes are
 * synthetic (ids invented), carrying only the fields these paths read.
 * No network.
 */

import { BillingDb } from '../../../helpers/billingDb';

const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockConstructEvent = jest.fn();
const mockPiRetrieve = jest.fn();
const mockDispatch = jest.fn();

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ rpc: mockRpc, from: mockFrom }) }));
jest.mock('@/lib/payments/receipt', () => ({ dispatchReceiptEmail: (...a: unknown[]) => mockDispatch(...a) }));
jest.mock('stripe', () => {
  const StripeMock = jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent: mockConstructEvent },
    paymentIntents: { retrieve: (...a: unknown[]) => mockPiRetrieve(...a) },
  }));
  return { __esModule: true, default: StripeMock };
});

const PI = {
  id: 'pi_FIXTURE_3848',
  object: 'payment_intent',
  status: 'succeeded',
  amount: 1499,
  invoice: null,
  customer: 'cus_FIXTURE_3848',
  metadata: { user_id: 'USER-1', local_transaction_id: 'TX-1', pricing_tier_id: 'TIER-1', quoted_unit_price_cents: '1499' },
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SIGNING_SECRET = 'whsec_dummy';
  process.env.CRON_SECRET = 'secret';
  mockPiRetrieve.mockResolvedValue(PI);
  mockRpc.mockResolvedValue({ data: { unlocked: true, already_fulfilled: false, balance_after: 0 }, error: null });
  mockDispatch.mockResolvedValue(true);
});

it('webhook payment_intent.succeeded -> receipt dispatched with the Stripe client and the PaymentIntent customer', async () => {
  const db = new BillingDb({ payment_intents: [] });
  mockFrom.mockImplementation(db.from);
  mockConstructEvent.mockReturnValue({ id: 'evt_3848', type: 'payment_intent.succeeded', livemode: false, data: { object: { id: PI.id } } });
  const { POST } = await import('@/app/api/payments/webhook/route');
  const res = await POST(new Request('https://x/api/payments/webhook', { method: 'POST', headers: { 'stripe-signature': 'ok' }, body: 'raw' }));
  expect(res.status).toBe(200);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  const [, args] = mockDispatch.mock.calls[0];
  expect(args).toMatchObject({ userId: 'USER-1', customerId: 'cus_FIXTURE_3848' });
  expect(args.stripe).toBeDefined();
});

it('reconcile cron -> receipt dispatched with the Stripe client and the PaymentIntent customer', async () => {
  const db = new BillingDb({
    payment_intents: [
      { id: 'R-1', user_id: 'USER-1', local_transaction_id: 'TX-1', quoted_unit_price_cents: 1499, pricing_tier_id: 'TIER-1', stripe_payment_intent_id: PI.id, stripe_checkout_session_id: null, status: 'succeeded', updated_at: '2026-10-01T00:00:00.000Z', stripe_mode: 'test' },
    ],
  });
  mockFrom.mockImplementation(db.from);
  const { GET } = await import('@/app/api/cron/payment-reconcile/route');
  const res = await GET(new Request('https://x/api/cron/payment-reconcile', { headers: { authorization: 'Bearer secret' } }));
  expect(res.status).toBe(200);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  const [, args] = mockDispatch.mock.calls[0];
  expect(args).toMatchObject({ userId: 'USER-1', customerId: 'cus_FIXTURE_3848' });
  expect(args.stripe).toBeDefined();
});
