/**
 * BACKLOG-2326: tests for the enforceSingleDesktopSession server action.
 *
 * Focus (mirrors the SR merge-gating conditions):
 *  - identity is derived from the VERIFIED getUser(access_token), never a client-supplied id;
 *  - ordering is LIST -> REVOKE -> TRACK (current tracked last);
 *  - the companion is never in the revoke set;
 *  - any failure resolves to { ok: false } and never throws, so a desktop login is not blocked.
 */

const mockGetUser = jest.fn();
const mockRpc = jest.fn();

jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}));

import { enforceSingleDesktopSession } from '@/lib/actions/enforceSingleDesktopSession';

// A token whose `sub` deliberately DIFFERS from the getUser-verified id, to prove identity comes
// from getUser and not from the (unverified) token contents.
function makeToken(claims: Record<string, unknown>): string {
  const b64url = (o: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
}

const VERIFIED_USER = 'verified-user-id';
const CURRENT_SESSION = 'sess-current';
const OTHER_DESKTOP = 'sess-other-desktop';
const COMPANION = 'sess-companion';
const TOKEN = makeToken({ session_id: CURRENT_SESSION, sub: 'attacker-claimed-sub' });

/** Configure the rpc mock's responses per RPC name. */
function setRpc(opts: {
  list?: { data?: unknown; error?: unknown };
  revoke?: { data?: unknown; error?: unknown };
  track?: { data?: unknown; error?: unknown } | (() => never);
}) {
  mockRpc.mockImplementation((fn: string) => {
    if (fn === 'list_other_desktop_sessions') {
      return Promise.resolve(opts.list ?? { data: [], error: null });
    }
    if (fn === 'revoke_desktop_sessions') {
      return Promise.resolve(opts.revoke ?? { data: 0, error: null });
    }
    if (fn === 'track_desktop_session') {
      if (typeof opts.track === 'function') return opts.track();
      return Promise.resolve(opts.track ?? { data: null, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

beforeEach(() => {
  mockGetUser.mockReset();
  mockRpc.mockReset();
});

describe('enforceSingleDesktopSession', () => {
  it('founder scenario: {current desktop, other desktop, WEB, companion} → revokes ONLY the other desktop; spares web + companion', async () => {
    // "computer" = the desktop Keepr app, not the web portal. Only desktop-app logins are tracked
    // (via the desktop callback), so list_other_desktop_sessions returns ONLY tracked desktops —
    // the user's web session and companion session are never tracked and therefore never appear
    // as revoke candidates (spared by construction). The current desktop is tracked LAST, so it is
    // not in the "others" set either.
    mockGetUser.mockResolvedValue({ data: { user: { id: VERIFIED_USER } }, error: null });
    setRpc({
      // The RPC's join with desktop_login_sessions yields ONLY the other tracked desktop; the WEB
      // and companion sessions the user also holds are simply not present here.
      list: {
        data: [{ session_id: OTHER_DESKTOP, user_agent: 'node' }],
        error: null,
      },
      revoke: { data: 1, error: null },
    });

    const result = await enforceSingleDesktopSession(TOKEN);
    expect(result).toEqual({ ok: true, revoked: 1 });

    const revokeArgs = mockRpc.mock.calls.find((c) => c[0] === 'revoke_desktop_sessions')![1] as {
      p_session_ids: string[];
    };
    expect(revokeArgs.p_session_ids).toEqual([OTHER_DESKTOP]);
    expect(revokeArgs.p_session_ids).not.toContain(CURRENT_SESSION);
    expect(revokeArgs.p_session_ids).not.toContain(COMPANION);
  });

  it('derives identity from getUser (not the token sub) and revokes only the other desktop', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: VERIFIED_USER } }, error: null });
    setRpc({
      list: {
        data: [
          { session_id: OTHER_DESKTOP, user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' },
          { session_id: COMPANION, user_agent: 'okhttp/4.9.2' },
        ],
        error: null,
      },
      revoke: { data: 1, error: null },
    });

    const result = await enforceSingleDesktopSession(TOKEN);
    expect(result).toEqual({ ok: true, revoked: 1 });

    // Ordering: LIST -> REVOKE -> TRACK.
    const order = mockRpc.mock.calls.map((c) => c[0]);
    expect(order).toEqual([
      'list_other_desktop_sessions',
      'revoke_desktop_sessions',
      'track_desktop_session',
    ]);

    // Every RPC uses the VERIFIED user id, never the token's claimed sub.
    for (const call of mockRpc.mock.calls) {
      expect((call[1] as { p_user_id: string }).p_user_id).toBe(VERIFIED_USER);
    }

    // Revoke set excludes the companion.
    const revokeArgs = mockRpc.mock.calls.find((c) => c[0] === 'revoke_desktop_sessions')![1] as {
      p_session_ids: string[];
    };
    expect(revokeArgs.p_session_ids).toEqual([OTHER_DESKTOP]);
    expect(revokeArgs.p_session_ids).not.toContain(COMPANION);

    // Tracks the current session LAST.
    const trackArgs = mockRpc.mock.calls.find((c) => c[0] === 'track_desktop_session')![1] as {
      p_session_id: string;
    };
    expect(trackArgs.p_session_id).toBe(CURRENT_SESSION);
  });

  it('revokes nothing (but still tracks) when there are no other desktop sessions', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: VERIFIED_USER } }, error: null });
    setRpc({ list: { data: [], error: null } });

    const result = await enforceSingleDesktopSession(TOKEN);
    expect(result).toEqual({ ok: true, revoked: 0 });

    const called = mockRpc.mock.calls.map((c) => c[0]);
    expect(called).toContain('list_other_desktop_sessions');
    expect(called).not.toContain('revoke_desktop_sessions'); // no ids -> no revoke call
    expect(called).toContain('track_desktop_session');
  });

  it('never revokes a companion even if one is mis-listed (backstop in selection)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: VERIFIED_USER } }, error: null });
    setRpc({
      list: { data: [{ session_id: COMPANION, user_agent: 'okhttp/4.9.2' }], error: null },
    });

    const result = await enforceSingleDesktopSession(TOKEN);
    expect(result).toEqual({ ok: true, revoked: 0 });
    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('revoke_desktop_sessions');
  });

  it('does nothing when the token cannot be verified (getUser error) — no track, no revoke', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid token' } });

    const result = await enforceSingleDesktopSession(TOKEN);
    expect(result).toEqual({ ok: false, revoked: 0, reason: 'unverified' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns { ok: false } without calling getUser when the token is empty', async () => {
    const result = await enforceSingleDesktopSession('');
    expect(result).toEqual({ ok: false, revoked: 0, reason: 'no_token' });
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('login proceeds (no throw) when the revoke RPC errors', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: VERIFIED_USER } }, error: null });
    setRpc({
      list: { data: [{ session_id: OTHER_DESKTOP, user_agent: 'node' }], error: null },
      revoke: { data: null, error: { message: 'boom' } },
    });

    const result = await enforceSingleDesktopSession(TOKEN);
    expect(result).toEqual({ ok: false, revoked: 0, reason: 'revoke_error' });
  });

  it('login proceeds (no throw) when an RPC throws unexpectedly', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: VERIFIED_USER } }, error: null });
    setRpc({
      list: { data: [{ session_id: OTHER_DESKTOP, user_agent: 'node' }], error: null },
      revoke: { data: 1, error: null },
      track: () => {
        throw new Error('track exploded');
      },
    });

    // A track failure is non-fatal: revoke already succeeded, result stays ok.
    const result = await enforceSingleDesktopSession(TOKEN);
    expect(result).toEqual({ ok: true, revoked: 1 });
  });
});
