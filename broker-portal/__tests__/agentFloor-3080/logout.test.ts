/**
 * /auth/logout — BACKLOG-3080 (C-logout).
 *
 * Middleware and the dashboard layout send a signed-in person who is not a
 * portal user here with `?error=not_authorized`. That branch must end ONLY this
 * browser's portal session. The bare Sign Out link keeps its behaviour.
 *
 * @jest-environment node
 */

const mockSignOut = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ auth: { signOut: mockSignOut } })),
}));

import { GET, POST } from '@/app/auth/logout/route';

const ORIGIN = 'http://localhost:3000';

beforeEach(() => {
  mockSignOut.mockReset();
  mockSignOut.mockResolvedValue({ error: null });
});

describe('/auth/logout', () => {
  it('?error=not_authorized ends only this browser session and passes the error on', async () => {
    const response = await GET(
      new Request(`${ORIGIN}/auth/logout?error=not_authorized`, {
        headers: { cookie: 'sb-fixture-auth-token=abc; sb-fixture-auth-token.1=def; theme=dark' },
      })
    );

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login?error=not_authorized`);

    // The auth cookies are cleared on the response too; unrelated cookies are left.
    const cleared = response.headers
      .getSetCookie()
      .map((c) => c.split('=')[0])
      .sort();
    expect(cleared).toEqual(['sb-fixture-auth-token', 'sb-fixture-auth-token.1']);
  });

  it('the bare Sign Out link is unchanged: signOut() with no arguments, then /login', async () => {
    // Transcribed from app/auth/logout/route.ts before BACKLOG-3080, GET and
    // POST alike: `await supabase.auth.signOut();` then `${origin}/login`.
    for (const handler of [GET, POST]) {
      mockSignOut.mockClear();
      const response = await handler(new Request(`${ORIGIN}/auth/logout`));
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(mockSignOut.mock.calls[0]).toEqual([]);
      expect(response.headers.get('location')).toBe(`${ORIGIN}/login`);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it('does not pass through an error value it does not know', async () => {
    const response = await GET(new Request(`${ORIGIN}/auth/logout?error=x`));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut.mock.calls[0]).toEqual([]);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login`);
  });
});
