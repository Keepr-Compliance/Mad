/**
 * /auth/logout — BACKLOG-3080 (C-logout).
 *
 * Every path ends ONLY this browser's portal session (`scope: 'local'`) and
 * clears the Supabase auth cookies. `?error=not_authorized` (sent by middleware
 * and the dashboard layout) is passed on to /login; other error values are not.
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
    expect(mockSignOut.mock.calls[0]).toEqual([{ scope: 'local' }]);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login?error=not_authorized`);

    // The auth cookies are cleared on the response too; unrelated cookies are left.
    const cleared = response.headers
      .getSetCookie()
      .map((c) => c.split('=')[0])
      .sort();
    expect(cleared).toEqual(['sb-fixture-auth-token', 'sb-fixture-auth-token.1']);
  });

  it('the bare Sign Out link ends only this browser session, clears auth cookies, then /login', async () => {
    // Sidebar.tsx links here with no query; GET and POST behave alike.
    for (const handler of [GET, POST]) {
      mockSignOut.mockClear();
      const response = await handler(
        new Request(`${ORIGIN}/auth/logout`, {
          headers: { cookie: 'sb-fixture-auth-token=abc; sb-fixture-auth-token.1=def; theme=dark' },
        })
      );
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(mockSignOut.mock.calls[0]).toEqual([{ scope: 'local' }]);
      expect(response.headers.get('location')).toBe(`${ORIGIN}/login`);
      const cleared = response.headers
        .getSetCookie()
        .map((c) => c.split('=')[0])
        .sort();
      expect(cleared).toEqual(['sb-fixture-auth-token', 'sb-fixture-auth-token.1']);
    }
  });

  it('a failed sign-out on the bare link still clears the auth cookies', async () => {
    mockSignOut.mockResolvedValue({ error: { message: 'fixture failure' } });
    const response = await GET(
      new Request(`${ORIGIN}/auth/logout`, { headers: { cookie: 'sb-fixture-auth-token=abc' } })
    );
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login`);
    expect(response.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual([
      'sb-fixture-auth-token',
    ]);
  });

  it('does not pass through an error value it does not know', async () => {
    const response = await GET(new Request(`${ORIGIN}/auth/logout?error=x`));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignOut.mock.calls[0]).toEqual([{ scope: 'local' }]);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login`);
  });
});
