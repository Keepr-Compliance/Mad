/**
 * BACKLOG-3601 — the admin portal's two server sign-out sites.
 *
 * Only the Supabase server clients are mocked. The real
 * `lib/auth/signOutLocal.ts` runs, so the argument asserted below is the one
 * the helper actually passes (the guard test fails if any test mocks it).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockSignOut = vi.fn();
const mockRpc = vi.fn();
const mockExchangeCodeForSession = vi.fn();

/** Every query in the callback ends in `.single()` / `.maybeSingle()`: no row. */
function emptyQuery(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'insert', 'delete', 'update']) chain[m] = () => chain;
  chain.single = async () => ({ data: null, error: null });
  chain.maybeSingle = async () => ({ data: null, error: null });
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mockGetUser,
      signOut: mockSignOut,
      exchangeCodeForSession: mockExchangeCodeForSession,
    },
    rpc: mockRpc,
    from: () => emptyQuery(),
  })),
  createServiceClient: vi.fn(() => ({ from: () => emptyQuery() })),
}));

import { POST as logout } from '@/app/api/auth/logout/route';
import { GET as callback } from '@/app/auth/callback/route';

const ORIGIN = 'http://localhost:3002';
const USER = { id: 'fixture-user-3601', email: 'staff@fixture-3601.example.test', app_metadata: { provider: 'azure' } };
const COOKIE = 'sb-fixture-auth-token=abc; sb-fixture-auth-token.1=def; theme=dark';

function clearedCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((c) => c.split('=')[0])
    .sort();
}

function logoutRequest(): NextRequest {
  return new NextRequest(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers: { cookie: COOKIE } });
}

function auditCalls(): unknown[][] {
  return mockRpc.mock.calls.filter((c) => c[0] === 'log_admin_action');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: USER } });
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockSignOut.mockResolvedValue({ error: null });
});

describe('POST /api/auth/logout', () => {
  it('writes the auth.logout audit row, THEN ends this browser session only, and clears cookies', async () => {
    const response = await logout(logoutRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockSignOut.mock.calls).toEqual([[{ scope: 'local' }]]);

    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0][1]).toMatchObject({ p_action: 'auth.logout', p_target_id: USER.id });
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockSignOut.mock.invocationCallOrder[0]);

    expect(clearedCookies(response)).toEqual(['sb-fixture-auth-token', 'sb-fixture-auth-token.1']);
  });

  it('on a Supabase auth error: 500 with its message, audit row still written first, cookies still cleared', async () => {
    mockSignOut.mockResolvedValue({ error: new AuthError('fixture sign-out failure', 500) });

    const response = await logout(logoutRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'fixture sign-out failure' });
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0][1]).toMatchObject({ p_action: 'auth.logout' });
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockSignOut.mock.invocationCallOrder[0]);
    expect(clearedCookies(response)).toEqual(['sb-fixture-auth-token', 'sb-fixture-auth-token.1']);
  });

  it('on a failure that is not a Supabase auth error: 500 with a fixed message, cookies cleared', async () => {
    mockSignOut.mockRejectedValue({ internal: 'fixture object that must not be echoed' });

    const response = await logout(logoutRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Sign-out failed' });
    expect(auditCalls()).toHaveLength(1);
    expect(clearedCookies(response)).toEqual(['sb-fixture-auth-token', 'sb-fixture-auth-token.1']);
  });

  it('still signs out when the audit write throws', async () => {
    mockRpc.mockRejectedValue(new Error('fixture audit failure'));
    const response = await logout(logoutRequest());
    expect(response.status).toBe(200);
    expect(mockSignOut.mock.calls).toEqual([[{ scope: 'local' }]]);
  });
});

describe('GET /auth/callback — signed in without an internal role', () => {
  it('logs auth.login_denied, ends this browser session only, clears cookies, sends to /login', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await callback(
      new Request(`${ORIGIN}/auth/callback?code=fixture-code-3601`, { headers: { cookie: COOKIE } })
    );

    expect(response.headers.get('location')).toBe(`${ORIGIN}/login?error=not_authorized`);
    expect(mockSignOut.mock.calls).toEqual([[{ scope: 'local' }]]);
    const denied = mockRpc.mock.calls.filter((c) => (c[1] as { p_action?: string })?.p_action === 'auth.login_denied');
    expect(denied).toHaveLength(1);
    expect(clearedCookies(response)).toEqual(['sb-fixture-auth-token', 'sb-fixture-auth-token.1']);
  });
});
