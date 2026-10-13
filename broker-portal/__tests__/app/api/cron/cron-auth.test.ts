/**
 * @jest-environment node
 *
 * Cron route authorization (BACKLOG-3928).
 *
 * Both scheduled routes must refuse every request when CRON_SECRET is not
 * configured, and otherwise accept only `Bearer <CRON_SECRET>`.
 */

const mockDrain = jest.fn();
const mockLimit = jest.fn();

jest.mock('@/lib/email/queue', () => ({
  drainEmailQueue: (...args: unknown[]) => mockDrain(...args),
}));

jest.mock('@/lib/supabase/service', () => {
  // payment-reconcile filters on status and stripe_mode (BACKLOG-3845), so eq chains.
  const filter: Record<string, unknown> = {};
  filter.eq = () => filter;
  filter.lt = () => ({
    limit: (...args: unknown[]) => mockLimit(...args),
  });
  return {
    createServiceClient: () => ({
      from: () => ({
        select: () => filter,
      }),
    }),
  };
});

jest.mock('@/lib/billing/mode', () => ({
  currentStripeMode: () => 'test',
}));

jest.mock('@/lib/stripe', () => ({
  getStripe: () => ({}),
}));

jest.mock('@/lib/payments/fulfillment', () => ({
  fulfillPaidUnlock: jest.fn(),
  emitPaymentSucceeded: jest.fn(),
}));

jest.mock('@/lib/payments/receipt', () => ({
  dispatchReceiptEmail: jest.fn(),
}));

import { GET as emailRetry } from '../../../../app/api/cron/email-retry/route';
import { GET as paymentReconcile } from '../../../../app/api/cron/payment-reconcile/route';
import { isAuthorizedCronRequest } from '../../../../lib/auth/cronAuth';

const ORIGINAL = process.env.CRON_SECRET;

function req(auth?: string): Request {
  return new Request('https://x/api/cron/test', {
    method: 'GET',
    headers: auth !== undefined ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDrain.mockResolvedValue({ scanned: 0, sent: 0, retryScheduled: 0, deadLettered: 0 });
  mockLimit.mockResolvedValue({ data: [], error: null });
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

const routes: Array<[string, (r: Request) => Promise<Response>, () => jest.Mock]> = [
  ['email-retry', emailRetry, () => mockDrain],
  ['payment-reconcile', paymentReconcile, () => mockLimit],
];

describe.each(routes)('GET /api/cron/%s authorization', (_name, GET, work) => {
  describe('secret not configured', () => {
    beforeEach(() => {
      delete process.env.CRON_SECRET;
    });

    it('refuses a request with no header', async () => {
      const res = await GET(req());
      expect(res.status).toBe(401);
      expect(work()).not.toHaveBeenCalled();
    });

    it('refuses when the cron secret is not configured', async () => {
      const res = await GET(req(`Bearer ${process.env.CRON_SECRET}`));
      expect(res.status).toBe(401);
      expect(work()).not.toHaveBeenCalled();
    });

    it('refuses an empty secret with an empty bearer', async () => {
      process.env.CRON_SECRET = '';
      const res = await GET(req('Bearer '));
      expect(res.status).toBe(401);
      expect(work()).not.toHaveBeenCalled();
    });
  });

  describe('secret configured', () => {
    beforeEach(() => {
      process.env.CRON_SECRET = 'cron-secret-value';
    });

    it('refuses a request with no header', async () => {
      const res = await GET(req());
      expect(res.status).toBe(401);
      expect(work()).not.toHaveBeenCalled();
    });

    it('refuses a wrong secret (same length and different length)', async () => {
      expect((await GET(req('Bearer cron-secret-valuX'))).status).toBe(401);
      expect((await GET(req('Bearer wrong'))).status).toBe(401);
      expect((await GET(req('cron-secret-value'))).status).toBe(401);
      expect(work()).not.toHaveBeenCalled();
    });

    it('accepts the configured secret and runs the job', async () => {
      const res = await GET(req('Bearer cron-secret-value'));
      expect(res.status).toBe(200);
      expect(work()).toHaveBeenCalledTimes(1);
    });
  });
});

describe('isAuthorizedCronRequest', () => {
  it('is false for every header when the secret is unset or empty', () => {
    delete process.env.CRON_SECRET;
    const unsetHeader = `Bearer ${process.env.CRON_SECRET}`;
    const nullHeader = `Bearer ${String(null)}`;
    for (const secret of [undefined, '']) {
      for (const header of [null, '', 'Bearer ', unsetHeader, nullHeader]) {
        expect(isAuthorizedCronRequest(header, secret)).toBe(false);
      }
    }
  });

  it('is true only for the exact bearer value', () => {
    expect(isAuthorizedCronRequest('Bearer s3cret', 's3cret')).toBe(true);
    expect(isAuthorizedCronRequest('Bearer s3creT', 's3cret')).toBe(false);
    expect(isAuthorizedCronRequest('Bearer s3cret ', 's3cret')).toBe(false);
    expect(isAuthorizedCronRequest('bearer s3cret', 's3cret')).toBe(false);
    expect(isAuthorizedCronRequest(null, 's3cret')).toBe(false);
  });
});
