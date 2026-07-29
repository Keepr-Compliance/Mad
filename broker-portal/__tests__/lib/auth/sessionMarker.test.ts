/**
 * BACKLOG-2326: unit tests for single active (non-companion) session enforcement selection logic.
 *
 * Rule: revoke ALL of the user's sessions EXCEPT the current/new desktop session and the Android
 * companion. These cover the security-critical guarantees WITHOUT a live Supabase:
 *  - the companion is spared by EITHER an explicit mark OR a companion user_agent,
 *  - the current session is never revoked,
 *  - fail-safe: an unknown current session id revokes NOTHING.
 */

import {
  isCompanionUserAgent,
  decodeSessionId,
  selectSessionsToRevoke,
  type UserSession,
} from '@/lib/auth/sessionMarker';

// Build a JWT-shaped token (header.payload.signature) with the given claims. The signature is
// never verified by decodeSessionId — it only reads the payload.
function makeToken(claims: Record<string, unknown>): string {
  const b64url = (o: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.signature`;
}

describe('isCompanionUserAgent — companion is identified, desktop/web is not', () => {
  it('identifies the companion at every lifecycle stage', () => {
    expect(
      isCompanionUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome'),
    ).toBe(true);
    expect(isCompanionUserAgent('okhttp/4.9.2')).toBe(true);
    expect(isCompanionUserAgent('KeeprCompanion (Android)')).toBe(true);
    expect(isCompanionUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(true);
  });

  it('does NOT classify desktop/web/server sessions as companion', () => {
    expect(isCompanionUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false);
    expect(isCompanionUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(isCompanionUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
    expect(isCompanionUserAgent('node')).toBe(false);
    expect(isCompanionUserAgent('Vercel Edge Functions')).toBe(false);
  });

  it('treats null / undefined / empty UA as unknown (false), never as a spare authorization', () => {
    expect(isCompanionUserAgent(null)).toBe(false);
    expect(isCompanionUserAgent(undefined)).toBe(false);
    expect(isCompanionUserAgent('')).toBe(false);
  });
});

describe('decodeSessionId — reads the session_id claim', () => {
  it('extracts session_id from a well-formed access token', () => {
    expect(decodeSessionId(makeToken({ session_id: 'sess-123', sub: 'user-abc' }))).toBe('sess-123');
  });

  it('returns null when the session_id claim is absent', () => {
    expect(decodeSessionId(makeToken({ sub: 'user-abc' }))).toBeNull();
  });

  it('returns null for malformed / non-JWT input', () => {
    expect(decodeSessionId('garbage')).toBeNull();
    expect(decodeSessionId('only.two')).toBeNull();
    expect(decodeSessionId('')).toBeNull();
    expect(decodeSessionId(null)).toBeNull();
    expect(decodeSessionId(undefined)).toBeNull();
  });
});

describe('selectSessionsToRevoke — revoke all except current + companion', () => {
  const CURRENT = 'sess-current-desktop';
  const OLD_DESKTOP = 'sess-old-desktop';
  const WEB = 'sess-web';
  const COMPANION = 'sess-companion';

  it('{current desktop, old desktop, web, companion} → revokes {old desktop, web}, spares current + companion', () => {
    const sessions: UserSession[] = [
      { session_id: CURRENT, user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', is_companion: false },
      { session_id: OLD_DESKTOP, user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', is_companion: false },
      { session_id: WEB, user_agent: 'node', is_companion: false }, // refreshed broker web session
      { session_id: COMPANION, user_agent: 'okhttp/4.9.2', is_companion: true },
    ];
    const result = selectSessionsToRevoke(sessions, CURRENT);
    expect(result.sort()).toEqual([OLD_DESKTOP, WEB].sort());
    expect(result).not.toContain(CURRENT);
    expect(result).not.toContain(COMPANION);
  });

  it('spares a companion that is UA-only (not yet marked) — race-window backstop', () => {
    const sessions: UserSession[] = [
      { session_id: CURRENT, user_agent: 'Mozilla/5.0 (Macintosh)', is_companion: false },
      { session_id: OLD_DESKTOP, user_agent: 'Mozilla/5.0 (Windows NT 10.0)', is_companion: false },
      // Companion logged in but has NOT finished marking; only the Android UA identifies it.
      { session_id: COMPANION, user_agent: 'Mozilla/5.0 (Linux; Android 13) Chrome', is_companion: false },
    ];
    const result = selectSessionsToRevoke(sessions, CURRENT);
    expect(result).toEqual([OLD_DESKTOP]);
    expect(result).not.toContain(COMPANION);
  });

  it('spares a marked companion even if its UA looks like a desktop (mark wins)', () => {
    const sessions: UserSession[] = [
      { session_id: CURRENT, user_agent: 'Mozilla/5.0 (Macintosh)', is_companion: false },
      // Defensive: mark set, but UA does not look mobile — mark alone must spare it.
      { session_id: COMPANION, user_agent: 'node', is_companion: true },
    ];
    expect(selectSessionsToRevoke(sessions, CURRENT)).toEqual([]);
  });

  it('FAIL-SAFE: unknown current session id revokes NOTHING', () => {
    const sessions: UserSession[] = [
      { session_id: OLD_DESKTOP, user_agent: 'Mozilla/5.0 (Windows NT 10.0)', is_companion: false },
      { session_id: COMPANION, user_agent: 'okhttp/4.9.2', is_companion: true },
    ];
    expect(selectSessionsToRevoke(sessions, null)).toEqual([]);
  });

  it('only-current + companion → revokes nothing', () => {
    const sessions: UserSession[] = [
      { session_id: CURRENT, user_agent: 'Mozilla/5.0 (Macintosh)', is_companion: false },
      { session_id: COMPANION, user_agent: 'okhttp/4.9.2', is_companion: true },
    ];
    expect(selectSessionsToRevoke(sessions, CURRENT)).toEqual([]);
  });
});
