/**
 * BACKLOG-2326: tests for the enforceSingleDesktopSession server action.
 *
 * Rule: revoke ALL the user's sessions except the current desktop and the companion.
 * Focus (mirrors the SR merge-gating conditions + founder rule):
 *  - identity is derived from the VERIFIED getUser(access_token), never a client-supplied id;
 *  - revoke set = everything except current + companion (marked OR companion-UA);
 *  - unknown current session id => revoke NOTHING (never revoke blind);
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
const OLD_DESKTOP = 'sess-old-desktop';
const WEB = 'sess-web';
const COMPANION = 'sess-companion';
const TOKEN = makeToken({ session_id: CURRENT_SESSION, sub: 'attacker-claimed-sub' });
const TOKEN_NO_SID = makeToken({ sub: 'someone' }); // no session_id claim

function setRpc(opts: {
  list?: { data?: unknown; error?: unknown };
  revoke?: { data?: unknown; error?: unknown };
}) {
  mockRpc.mockImplementation((fn: string) => {
    if (fn === 'list_user_sessions_with_companion_flag') {
      return Promise.resolve(opts.list ?? { data: [], error: null });
    }
    if (fn === 'revoke_sessions') {
      return Promise.resolve(opts.revoke ?? { data: 0, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

beforeEach(() => {
  mockGetUser.mockReset();
  mockRpc.mockReset();
});

describe('enforceSingleDesktopSession', () => {
  it('revokes all except current + companion, using the getUser-verified id (not the token sub)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: VERIFIED_USER } }, error: null });
    setRpc({
      list: {
        data: [
          { session_id: CURRENT_SESSION, user_agent: 'Mozilla/5.0 (Macintosh)', is_companion: false },
          { session_id: OLD_DESKTOP, user_agent: 'Mozilla/5.0 (Windows NT 10.0)', is_companion: false },
          { session_id: WEB, user_agent: 'node', is_companion: false },
          { session_id: COMPANION, user_agent: 'okhttp/4.9.2', is_companion: true },
        ],
        error: null,
      },
      revoke: { data: 2, error: null },
    });

    const result = await enforceSingleDesktopSession(TOKEN);
    expect(result).toEqual({ ok: true, revoked: 2 });

    // Uses the VERIFIED user id on both RPCs, never the token's claimed sub.
    for (const call of mockRpc.mock.calls) {
      expect((call[1] as { p_user_id: string }).p_user_id).toBe(VERIFIED_USER);
    }

    // Revoke set = {old desktop, web}; current + companion spared.
    const revokeArgs = mockRpc.mock.calls.find((c) => c[0] === 'revoke_sessions')![1] as {
      p_session_ids: string[];
    };
    expect(revokeArgs.p_session_ids.sort()).toEqual([OLD_DESKTOP, WEB].sort());
    expect(revokeArgs.p_session_ids).not.toContain(CURRENT_SESSION);
    expect(revokeArgs.p_session_ids).not.toContain(COMPANION);
  });

  it('spares a UA-only companion that has not finished marking (backstop)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: VERIFIED_USER } }, error: null });
    setRpc({
      list: {
        data: [
          { session_id: CURRENT_SESSION, user_agent: 'Mozilla/5.0 (Macintosh)', is_companion: false },
          { session_id: COMPANION, user_agent: 'Mozilla/5.0 (Linux; Android 13) Chrome', is_companion: false },
        ],
        error: null,
      },
    });

    const result = await enforceSingleDesktopSession(TOKEN);
    expect(result).toEqual({ ok: true, revoked: 0 });
    // Nothing to revoke -> revoke_sessions not called.
    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('revoke_sessions');
  });

  it('does nothing when the token cannot be verified (getUser error) — no list, no revoke', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid token' } });

    const result = await enforceSingleDesktopSession(TOKEN);
    expect(result).toEqual({ ok: false, revoked: 0, reason: 'unverified' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('revokes NOTHING when the current session id cannot be derived (never revoke blind)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: VERIFIED_USER } }, error: null });
    setRpc({ list: { data: [], error: null } });

    const result = await enforceSingleDesktopSession(TOKEN_NO_SID);
    expect(result).toEqual({ ok: false, revoked: 0, reason: 'no_current_session' });
    expect(mockRpc).not.toHaveBeenCalled(); // bails before listing
  });

  it('returns { ok: false } without calling getUser when the token is empty', async () => {
    const result = await enforceSingleDesktopSession('');
    expect(result).toEqual({ ok: false, revoked: 0, reason: 'no_token' });
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('login proceeds (no throw) when the revoke RPC errors', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: VERIFIED_USER } }, error: null });
    setRpc({
      list: {
        data: [
          { session_id: CURRENT_SESSION, user_agent: 'Mozilla/5.0 (Macintosh)', is_companion: false },
          { session_id: OLD_DESKTOP, user_agent: 'node', is_companion: false },
        ],
        error: null,
      },
      revoke: { data: null, error: { message: 'boom' } },
    });

    const result = await enforceSingleDesktopSession(TOKEN);
    expect(result).toEqual({ ok: false, revoked: 0, reason: 'revoke_error' });
  });

  it('login proceeds (no throw) when an RPC throws unexpectedly', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: VERIFIED_USER } }, error: null });
    mockRpc.mockImplementation(() => {
      throw new Error('rpc exploded');
    });

    const result = await enforceSingleDesktopSession(TOKEN);
    expect(result).toEqual({ ok: false, revoked: 0, reason: 'error' });
  });
});
