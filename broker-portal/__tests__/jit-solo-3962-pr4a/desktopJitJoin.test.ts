/**
 * BACKLOG-3962 PR4a D1: the desktop JIT action runs on a client carrying the person's own access
 * token (never the server role), verifies the token first, skips JIT while an invitation is
 * pending, and reports domain_managed only when the database says so.
 *
 * @jest-environment node
 */

const mockCreateClient = jest.fn();
const mockGetUser = jest.fn();
const mockRpc = jest.fn();
const mockService = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => {
    mockCreateClient(...args);
    return { auth: { getUser: mockGetUser }, rpc: mockRpc };
  },
}));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: (...a: unknown[]) => mockService(...a) }));

import { desktopJitJoin } from '@/lib/actions/desktopJitJoin';

const USER = {
  id: 'user-3962p4',
  email: 'new@a-3962p4.example.test',
  identities: [{ provider: 'azure', updated_at: '2026-11-12T12:00:00Z', identity_data: { custom_claims: { tid: 'fixture-tenant-3962p4' } } }],
};

function replies(map: Record<string, unknown>): void {
  mockRpc.mockImplementation(async (name: string) => ({ data: name in map ? map[name] : null, error: null }));
}
const names = () => mockRpc.mock.calls.map((c) => c[0]);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture.supabase.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'fixture-anon';
  mockGetUser.mockResolvedValue({ data: { user: USER }, error: null });
});

it('uses a bearer client with the person token, verifies it, never the server role', async () => {
  replies({ jit_join_organization: { success: true, organization_id: 'org', role: 'agent' } });
  expect(await desktopJitJoin('person-token')).toEqual({ status: 'ok' });
  const [, key, opts] = mockCreateClient.mock.calls[0];
  expect(key).toBe('fixture-anon');
  expect(opts.global.headers.Authorization).toBe('Bearer person-token');
  expect(mockGetUser).toHaveBeenCalledWith('person-token');
  expect(mockService).not.toHaveBeenCalled();
  expect(names()).toEqual(['caller_has_pending_invite', 'jit_join_organization']);
});

it('an unverifiable token does nothing', async () => {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });
  expect(await desktopJitJoin('person-token')).toEqual({ status: 'ok' });
  expect(mockRpc).not.toHaveBeenCalled();
});

it('a pending invitation: no JIT, no block', async () => {
  replies({ caller_has_pending_invite: true });
  expect(await desktopJitJoin('person-token')).toEqual({ status: 'ok' });
  expect(names()).toEqual(['caller_has_pending_invite']);
});

it('blocked domain after a refused JIT -> domain_managed with the brokerage and domain', async () => {
  replies({
    jit_join_organization: { error: 'domain_not_verified', success: false },
    caller_domain_managed: { domain: 'a-3962p4.example.test', blocked: true, organization_name: 'Fixture Brokerage A' },
  });
  expect(await desktopJitJoin('person-token')).toEqual({
    status: 'domain_managed',
    organizationName: 'Fixture Brokerage A',
    domain: 'a-3962p4.example.test',
  });
});

it('not blocked -> ok', async () => {
  replies({ jit_join_organization: { error: 'existing_account', success: false }, caller_domain_managed: { blocked: false } });
  expect(await desktopJitJoin('person-token')).toEqual({ status: 'ok' });
});

it('a throwing client still answers ok', async () => {
  mockRpc.mockRejectedValue(new Error('network'));
  expect(await desktopJitJoin('person-token')).toEqual({ status: 'ok' });
});
