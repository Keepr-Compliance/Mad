/**
 * BACKLOG-3991: the desktop sign-in's server action. Identity is the VERIFIED
 * getUser(accessToken) result, and the names go through a client that carries that
 * same access token (so auth.uid() is that user). supabase-js is mocked: no network.
 *
 * @jest-environment node
 */

import { AZURE_METADATA, FIXTURE_TOKEN, spyConsole } from './fixtures';

const mockCreateClient = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: (...a: unknown[]) => mockCreateClient(...a) }));

import { syncDesktopIdpNames } from '@/lib/actions/syncDesktopIdpNames';

const ACCESS = 'fixture-access-token-3991';
let rpc: jest.Mock;
let getUser: jest.Mock;
let consoleSpy: ReturnType<typeof spyConsole>;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture.supabase.example.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'fixture-anon-key';
  rpc = jest.fn(async () => ({ data: { success: true, updated: true }, error: null }));
  getUser = jest.fn(async () => ({
    data: { user: { id: 'u-3991', app_metadata: { provider: 'azure' }, user_metadata: AZURE_METADATA } },
    error: null,
  }));
  mockCreateClient.mockReturnValue({ auth: { getUser }, rpc });
  consoleSpy = spyConsole();
});
afterEach(() => consoleSpy.restore());

it('verifies the token, then writes through a client carrying that token', async () => {
  await syncDesktopIdpNames(ACCESS, FIXTURE_TOKEN);
  expect(getUser).toHaveBeenCalledWith(ACCESS);
  const [, , opts] = mockCreateClient.mock.calls[0];
  expect(opts.global.headers.Authorization).toBe(`Bearer ${ACCESS}`);
  expect(opts.auth).toEqual({ autoRefreshToken: false, persistSession: false });
  expect(rpc).toHaveBeenCalledWith('sync_profile_names_from_idp', { p_first: 'Avery', p_last: 'Stone', p_display: 'Avery Stone' });
});

it('an unverified token writes nothing', async () => {
  getUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });
  await syncDesktopIdpNames(ACCESS, FIXTURE_TOKEN);
  expect(rpc).not.toHaveBeenCalled();
});

it('no access token: nothing is created or called', async () => {
  await syncDesktopIdpNames('', FIXTURE_TOKEN);
  expect(mockCreateClient).not.toHaveBeenCalled();
});

it('never throws, never logs a token', async () => {
  getUser.mockRejectedValue(new Error(`boom ${ACCESS} ${FIXTURE_TOKEN}`));
  await expect(syncDesktopIdpNames(ACCESS, FIXTURE_TOKEN)).resolves.toBeUndefined();
  const lines = consoleSpy.calls();
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((l) => l.includes(ACCESS) || l.includes(FIXTURE_TOKEN))).toEqual([]);
});
