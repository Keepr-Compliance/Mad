/**
 * middleware.ts and the post-login destination — BACKLOG-3863 PR-2 (R7) and BACKLOG-3705.
 *
 *  - A signed-in visit to /login?redirectTo=<x> goes to safeNextPath(x), always on this origin.
 *  - A signed-out visit to a /dashboard path sets the post-login path cookie (httpOnly, Secure,
 *    SameSite=Lax, Path=/auth, 30 minutes) to that path, and still redirects to /login.
 *
 * @jest-environment node
 */

import {
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
} from '../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();

jest.mock('@supabase/ssr', () => ({
  createServerClient: jest.fn(() => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockEmulator.from(table),
    rpc: async () => ({ data: false, error: null }),
  })),
}));

import { middleware } from '@/middleware';
import { NextRequest } from 'next/server';
import { NEXT_PATH_COOKIE_NAME } from '@/lib/auth/safeNextPath';

const ORIGIN = 'http://localhost:3000';

function signedIn(): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID } } });
  mockEmulator.set({
    columnPresent: true,
    rows: {
      organization_members: [{ ...brokerageMembership('admin'), license_status: 'active' }],
      licenses: [{ user_id: FIXTURE_USER_ID, status: 'active' }],
    },
  });
}

function signedOut(): void {
  mockGetUser.mockResolvedValue({ data: { user: null } });
}

async function location(path: string): Promise<URL> {
  const response = await middleware(new NextRequest(`${ORIGIN}${path}`));
  const to = response.headers.get('location');
  if (!to) throw new Error(`no redirect for ${path}`);
  return new URL(to);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
});

describe('signed in on /login: redirectTo stays on this origin (BACKLOG-3705)', () => {
  it.each([
    ['//evil.test', '/dashboard'],
    ['//evil.test/dashboard', '/dashboard'],
    ['/\\evil.test', '/dashboard'],
    ['/dashboard/../admin', '/dashboard'],
    ['/settings', '/dashboard'],
    ['/dashboard/billing', '/dashboard/billing'],
  ])('redirectTo=%s -> %s', async (raw, expected) => {
    signedIn();
    const to = await location(`/login?redirectTo=${encodeURIComponent(raw)}`);
    expect(to.origin).toBe(ORIGIN);
    expect(to.pathname).toBe(expected);
  });

  it('no redirectTo -> /dashboard', async () => {
    signedIn();
    const to = await location('/login');
    expect(`${to.origin}${to.pathname}`).toBe(`${ORIGIN}/dashboard`);
  });
});

describe('signed out on a /dashboard path: post-login path cookie', () => {
  function cookieOf(response: Response): string | undefined {
    return response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${NEXT_PATH_COOKIE_NAME}=`));
  }

  it('sets the cookie to the path, with its attributes, and still goes to /login', async () => {
    signedOut();
    const response = await middleware(new NextRequest(`${ORIGIN}/dashboard/billing`));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
    const cookie = cookieOf(response);
    expect(cookie).toBeDefined();
    const parts = cookie!.split(';').map((p) => p.trim().toLowerCase());
    expect(decodeURIComponent(cookie!.split(';')[0].split('=').slice(1).join('='))).toBe('/dashboard/billing');
    expect(parts).toEqual(
      expect.arrayContaining(['path=/auth', 'max-age=1800', 'httponly', 'secure', 'samesite=lax'])
    );
  });

});
