/**
 * BACKLOG-2326: unit tests for single-desktop enforcement selection logic.
 *
 * These cover the security-critical guarantees WITHOUT a live Supabase:
 *  - a companion/mobile session is recognized and always spared,
 *  - a desktop/browser session (including a refreshed one whose UA drifted to "node") is not
 *    mistaken for a companion,
 *  - the revoke set never includes the current session or any companion session.
 */

import {
  isCompanionUserAgent,
  decodeSessionId,
  selectSessionsToRevoke,
  type TrackedDesktopSession,
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

describe('isCompanionUserAgent — companion is identified, desktop is not', () => {
  it('identifies the companion at every lifecycle stage', () => {
    // In-app browser UA at session creation (empirical companion value)
    expect(
      isCompanionUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome'),
    ).toBe(true);
    // Raw React Native HTTP client after refresh (empirical value)
    expect(isCompanionUserAgent('okhttp/4.9.2')).toBe(true);
    // Explicit defense-in-depth marker the companion sets
    expect(isCompanionUserAgent('KeeprCompanion (Android)')).toBe(true);
    // Defensive iOS coverage
    expect(isCompanionUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(true);
  });

  it('does NOT classify desktop/web/server sessions as companion', () => {
    expect(isCompanionUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false);
    expect(isCompanionUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(isCompanionUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
    // Refreshed desktop-app / broker web sessions drift to these — must be revokable, not spared
    expect(isCompanionUserAgent('node')).toBe(false);
    expect(isCompanionUserAgent('Vercel Edge Functions')).toBe(false);
  });

  it('treats null / undefined / empty UA as unknown (false), never as a spare authorization', () => {
    expect(isCompanionUserAgent(null)).toBe(false);
    expect(isCompanionUserAgent(undefined)).toBe(false);
    expect(isCompanionUserAgent('')).toBe(false);
  });
});

describe('decodeSessionId — reads the session_id claim, never trusts structure', () => {
  it('extracts session_id from a well-formed access token', () => {
    const token = makeToken({ session_id: 'sess-123', sub: 'user-abc' });
    expect(decodeSessionId(token)).toBe('sess-123');
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

describe('selectSessionsToRevoke — spares current + companion, revokes other desktops', () => {
  const CURRENT = 'sess-current-desktop';
  const OTHER = 'sess-other-desktop';
  const COMPANION = 'sess-companion';

  const scenario: TrackedDesktopSession[] = [
    { session_id: CURRENT, user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    { session_id: OTHER, user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    { session_id: COMPANION, user_agent: 'okhttp/4.9.2' },
  ];

  it('{current desktop, other desktop, companion} → revokes ONLY the other desktop', () => {
    const result = selectSessionsToRevoke(scenario, CURRENT);
    expect(result).toEqual([OTHER]);
    expect(result).not.toContain(CURRENT);
    expect(result).not.toContain(COMPANION);
  });

  it('{current desktop, companion} → revokes nothing', () => {
    const twoOnly: TrackedDesktopSession[] = [
      { session_id: CURRENT, user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      { session_id: COMPANION, user_agent: 'okhttp/4.9.2' },
    ];
    expect(selectSessionsToRevoke(twoOnly, CURRENT)).toEqual([]);
  });

  it('revokes a refreshed old desktop whose UA drifted to "node"', () => {
    const refreshedDesktop: TrackedDesktopSession[] = [
      { session_id: OTHER, user_agent: 'node' },
      { session_id: COMPANION, user_agent: 'KeeprCompanion (Android)' },
    ];
    expect(selectSessionsToRevoke(refreshedDesktop, CURRENT)).toEqual([OTHER]);
  });

  it('never revokes a companion even when the current id is unknown (null)', () => {
    const result = selectSessionsToRevoke(scenario, null);
    expect(result).not.toContain(COMPANION);
    // With no known current, both desktop sessions are "other" and revokable; companion spared.
    expect(result).toEqual([CURRENT, OTHER]);
  });

  it('a list of only companion sessions revokes nothing', () => {
    const companionsOnly: TrackedDesktopSession[] = [
      { session_id: 'c1', user_agent: 'okhttp/4.9.2' },
      { session_id: 'c2', user_agent: 'Mozilla/5.0 (Linux; Android 13) Chrome' },
    ];
    expect(selectSessionsToRevoke(companionsOnly, CURRENT)).toEqual([]);
  });
});
