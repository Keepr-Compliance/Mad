/**
 * @jest-environment node
 *
 * BACKLOG-4019 W10: the broker auto-renew action calls set_org_auto_renew with the signed-in
 * user's session client (auth.uid() decides who may switch it), never the service client.
 */

const mockRpc = jest.fn();
const mockGetUser = jest.fn();
const mockServiceClient = jest.fn(() => {
  throw new Error('test: the service client must not be used');
});
const mockBlocked = jest.fn(async () => null as { error: string } | null);

jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: mockRpc, auth: { getUser: mockGetUser } }),
}));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: () => mockServiceClient() }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlocked() }));

import { setAutoRenew } from '@/lib/actions/autoRenew';

const ORG = '4019a000-0000-4000-8000-000000000001';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-4019' } } });
});

describe('setAutoRenew (broker portal)', () => {
  it('W10: the session client calls set_org_auto_renew; the service client is never built', async () => {
    mockRpc.mockResolvedValue({ data: { success: true, changed: true, version: 3 }, error: null });
    await expect(setAutoRenew(ORG, false, 2)).resolves.toEqual({ ok: true, error: null });
    expect(mockRpc).toHaveBeenCalledWith('set_org_auto_renew', { p_org: ORG, p_on: false, p_note: null, p_expected_version: 2 });
    expect(mockServiceClient).not.toHaveBeenCalled();
  });

  it('42501 -> permission sentence', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Not authorized' } });
    expect((await setAutoRenew(ORG, false, 2)).error).toBe('You do not have permission to change auto-renew.');
  });

  it('a suspended brokerage -> "Contact Keepr to change your plan."', async () => {
    mockRpc.mockResolvedValue({ data: { success: false, error: 'deal_suspended' }, error: null });
    expect(await setAutoRenew(ORG, true, 4)).toEqual({ ok: false, error: 'Contact Keepr to change your plan.' });
  });

  it('impersonation and a signed-out caller never reach the database', async () => {
    mockBlocked.mockResolvedValueOnce({ error: 'blocked' });
    expect((await setAutoRenew(ORG, false, 2)).ok).toBe(false);
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    expect((await setAutoRenew(ORG, false, 2)).ok).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
