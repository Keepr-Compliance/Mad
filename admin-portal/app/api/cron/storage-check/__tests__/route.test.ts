/**
 * Storage-check cron authorization (BACKLOG-3928).
 *
 * The route must refuse every request when CRON_SECRET is not configured,
 * and otherwise accept only `Bearer <CRON_SECRET>`.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const mockRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}));

import { GET } from '../route';
import { isAuthorizedCronRequest } from '@/lib/auth/cronAuth';

const ORIGINAL = process.env.CRON_SECRET;

function req(auth?: string): Request {
  return new Request('https://x/api/cron/storage-check', {
    method: 'GET',
    headers: auth !== undefined ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Below threshold, so no alert is posted (and no outbound fetch happens).
  mockRpc.mockResolvedValue({ data: [], error: null });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe('GET /api/cron/storage-check — secret not configured', () => {
  beforeEach(() => {
    delete process.env.CRON_SECRET;
  });

  it('refuses a request with no header', async () => {
    expect((await GET(req())).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('refuses when the cron secret is not configured', async () => {
    expect((await GET(req(`Bearer ${process.env.CRON_SECRET}`))).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/storage-check — secret configured', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'cron-secret-value';
  });

  it('refuses no header and wrong secrets', async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req('Bearer cron-secret-valuX'))).status).toBe(401);
    expect((await GET(req('Bearer wrong'))).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('accepts the configured secret and runs the check', async () => {
    const res = await GET(req('Bearer cron-secret-value'));
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

describe('isAuthorizedCronRequest (admin-portal)', () => {
  it('is false for every header when the secret is unset or empty', () => {
    delete process.env.CRON_SECRET;
    const unsetHeader = `Bearer ${process.env.CRON_SECRET}`;
    for (const secret of [undefined, '']) {
      for (const header of [null, '', 'Bearer ', unsetHeader]) {
        expect(isAuthorizedCronRequest(header, secret)).toBe(false);
      }
    }
  });

  it('is true only for the exact bearer value', () => {
    expect(isAuthorizedCronRequest('Bearer s3cret', 's3cret')).toBe(true);
    expect(isAuthorizedCronRequest('Bearer s3creT', 's3cret')).toBe(false);
    expect(isAuthorizedCronRequest('Bearer s3cret ', 's3cret')).toBe(false);
  });
});
