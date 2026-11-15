/**
 * @jest-environment node
 *
 * BACKLOG-3962 PR3a: the hourly capture switch route warns once, with counts by reason only,
 * when switches were deferred.
 */

const mockRun = jest.fn();

jest.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({}) }));
jest.mock('@/lib/auth/cronAuth', () => ({ isAuthorizedCronRequest: () => true }));
jest.mock('@/lib/domain/captureSwitch', () => ({
  runCaptureSwitch: (...args: unknown[]) => mockRun(...args),
}));

import { GET } from '@/app/api/cron/domain-capture-switch/route';

function summary(deferred: Record<string, number>) {
  return {
    status: 'ok', due: 3, switched: 1, unassigned: 0, cancelled: {}, deferred,
    failed: 0, switchedEmails: 1, seatAlerts: 0,
  };
}

describe('domain-capture-switch cron: deferred warning', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    mockRun.mockReset();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('warns once with the counts by reason when something was deferred', async () => {
    mockRun.mockResolvedValue(summary({ billing_not_ready: 2, dns_not_fresh: 1 }));
    const res = await GET(new Request('http://localhost/api/cron/domain-capture-switch'));
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ billing_not_ready: 2, dns_not_fresh: 1 });
  });

  it('does not warn when nothing was deferred', async () => {
    mockRun.mockResolvedValue(summary({}));
    await GET(new Request('http://localhost/api/cron/domain-capture-switch'));
    expect(warn).not.toHaveBeenCalled();
  });
});
