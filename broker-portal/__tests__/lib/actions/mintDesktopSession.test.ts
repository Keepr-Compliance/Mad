/**
 * BACKLOG-2332: tests for mintDesktopSession — the desktop gets a fresh, independent session.
 *
 * Focus (SR merge-gating):
 *  - BLOCKING-A: the email fed to generateLink comes ONLY from the VERIFIED getUser(accessToken),
 *    never client input; the verifyOtp client is a dedicated non-persisting client.
 *  - returns the minted session's tokens on success; returns null (never the browser tokens) on
 *    any failure so the caller can fail the login instead of reintroducing the self-kick.
 */

const mockGetUser = jest.fn();
const mockGenerateLink = jest.fn();
const mockVerifyOtp = jest.fn();
const mockCreateClient = jest.fn((..._args: unknown[]) => ({
  auth: { verifyOtp: (...a: unknown[]) => mockVerifyOtp(...a) },
}));

jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    auth: {
      getUser: (...a: unknown[]) => mockGetUser(...a),
      admin: { generateLink: (...a: unknown[]) => mockGenerateLink(...a) },
    },
  }),
}));
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...a: unknown[]) => mockCreateClient(...a),
}));

import { mintDesktopSession } from '@/lib/actions/mintDesktopSession';

const BROWSER_TOKEN = 'browser.access.token';
const VERIFIED_EMAIL = 'user@example.com';

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
});

beforeEach(() => {
  mockGetUser.mockReset();
  mockGenerateLink.mockReset();
  mockVerifyOtp.mockReset();
  mockCreateClient.mockClear();
});

describe('mintDesktopSession', () => {
  it('mints a fresh session and returns its tokens (email sourced from verified getUser)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: VERIFIED_EMAIL } }, error: null });
    mockGenerateLink.mockResolvedValue({ data: { properties: { email_otp: '123456' } }, error: null });
    mockVerifyOtp.mockResolvedValue({
      data: { session: { access_token: 'session2-access', refresh_token: 'session2-refresh' } },
      error: null,
    });

    const result = await mintDesktopSession(BROWSER_TOKEN);
    expect(result).toEqual({ access_token: 'session2-access', refresh_token: 'session2-refresh' });

    // BLOCKING-A: generateLink email is the VERIFIED getUser email, never a client-supplied value.
    expect(mockGetUser).toHaveBeenCalledWith(BROWSER_TOKEN);
    expect(mockGenerateLink).toHaveBeenCalledWith({ type: 'magiclink', email: VERIFIED_EMAIL });
    expect(mockVerifyOtp).toHaveBeenCalledWith({ email: VERIFIED_EMAIL, token: '123456', type: 'email' });

    // Dedicated non-persisting client for verifyOtp (no background refresh timer server-side).
    const [, , cfg] = mockCreateClient.mock.calls[0] as [string, string, { auth: Record<string, unknown> }];
    expect(cfg.auth).toEqual({ autoRefreshToken: false, persistSession: false });
  });

  it('returns null (does not mint) when the browser token cannot be verified', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });
    expect(await mintDesktopSession(BROWSER_TOKEN)).toBeNull();
    expect(mockGenerateLink).not.toHaveBeenCalled();
  });

  it('returns null when the verified user has no email', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: null } }, error: null });
    expect(await mintDesktopSession(BROWSER_TOKEN)).toBeNull();
    expect(mockGenerateLink).not.toHaveBeenCalled();
  });

  it('returns null when generateLink fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: VERIFIED_EMAIL } }, error: null });
    mockGenerateLink.mockResolvedValue({ data: null, error: { message: 'link error' } });
    expect(await mintDesktopSession(BROWSER_TOKEN)).toBeNull();
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it('returns null when verifyOtp fails (never returns partial/browser tokens)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: VERIFIED_EMAIL } }, error: null });
    mockGenerateLink.mockResolvedValue({ data: { properties: { email_otp: '123456' } }, error: null });
    mockVerifyOtp.mockResolvedValue({ data: { session: null }, error: { message: 'otp error' } });
    expect(await mintDesktopSession(BROWSER_TOKEN)).toBeNull();
  });

  it('returns null without calling getUser when the token is empty', async () => {
    expect(await mintDesktopSession('')).toBeNull();
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});
