/**
 * BACKLOG-3962: a signed-out visit keeps its query through sign-in (the capture email links to
 * /dashboard?capture=join). middleware.ts stores path + query when safeNextPath accepts it, else
 * the path alone. Harness as __tests__/plan-summary-3863/middleware.test.ts.
 *
 * @jest-environment node
 */

import { createPostgrestEmulator } from '../helpers/postgrestEmulator';

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

async function bounce(path: string): Promise<{ redirectTo: string | null; cookie: string | undefined; to: URL }> {
  mockGetUser.mockResolvedValue({ data: { user: null } });
  const response = await middleware(new NextRequest(`${ORIGIN}${path}`));
  const to = new URL(response.headers.get('location')!);
  const raw = response.headers.getSetCookie().find((c) => c.startsWith(`${NEXT_PATH_COOKIE_NAME}=`));
  const cookie = raw ? decodeURIComponent(raw.split(';')[0].split('=').slice(1).join('=')) : undefined;
  return { redirectTo: to.searchParams.get('redirectTo'), cookie, to };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
});

describe('signed out: the query survives the sign-in bounce', () => {
  it.each(['/dashboard?capture=join', '/dashboard?capture=keep', '/dashboard/billing?tab=plan'])('%s', async (path) => {
    const b = await bounce(path);
    expect(b.to.pathname).toBe('/login');
    expect(b.redirectTo).toBe(path);
    expect(b.cookie).toBe(path);
  });

  it('a query safeNextPath refuses falls back to the path alone', async () => {
    const b = await bounce('/dashboard?capture=join&x=..');
    expect(b.to.pathname).toBe('/login');
    expect(b.redirectTo).toBe('/dashboard');
    expect(b.cookie).toBe('/dashboard');
  });

  it('no query: the path, as before', async () => {
    const b = await bounce('/dashboard/account');
    expect(b.redirectTo).toBe('/dashboard/account');
    expect(b.cookie).toBe('/dashboard/account');
  });
});
