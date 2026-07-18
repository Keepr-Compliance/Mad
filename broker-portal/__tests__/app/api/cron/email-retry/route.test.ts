/**
 * @jest-environment node
 *
 * Tests for the email-retry cron route (BACKLOG-2009).
 */

const mockDrain = jest.fn();

jest.mock('@/lib/email/queue', () => ({
  drainEmailQueue: (...args: unknown[]) => mockDrain(...args),
}));

import { GET } from '../../../../../app/api/cron/email-retry/route';

function req(auth?: string): Request {
  return new Request('https://app.keeprcompliance.com/api/cron/email-retry', {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = 'cron-secret';
});

describe('GET /api/cron/email-retry', () => {
  it('rejects a missing/incorrect bearer token', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockDrain).not.toHaveBeenCalled();

    const res2 = await GET(req('Bearer wrong'));
    expect(res2.status).toBe(401);
  });

  it('drains and returns the summary on a valid token', async () => {
    mockDrain.mockResolvedValueOnce({ scanned: 3, sent: 2, retryScheduled: 1, deadLettered: 0 });

    const res = await GET(req('Bearer cron-secret'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scanned: 3, sent: 2, retryScheduled: 1, deadLettered: 0 });
    expect(mockDrain).toHaveBeenCalledTimes(1);
  });
});
