/**
 * BACKLOG-2326 / PR #2122 — single active (non-companion) session enforcement helpers.
 *
 * Pure, side-effect-free logic for the `enforceSingleDesktopSession` server action. Kept separate
 * so the security-sensitive selection logic (which sessions get revoked, which are ALWAYS spared)
 * is unit-testable without a live Supabase.
 *
 * Rule: on desktop login, revoke ALL of the user's sessions EXCEPT the current/new desktop
 * session and the Android companion session(s). A misidentification of the companion KICKS THE
 * PHONE — the exact bug being fixed — so companion detection uses TWO independent signals and the
 * fail-safe always errs toward SPARING:
 *   1. an explicit mark (is_companion) recorded by the companion via mark_companion_session(), and
 *   2. a user_agent backstop (android / okhttp / KeeprCompanion) covering the race window where a
 *      companion has logged in but not finished marking, plus legacy sessions.
 * A session is revoked ONLY if NEITHER signal says companion.
 */

/** A session row as returned by the `list_user_sessions_with_companion_flag` RPC. */
export interface UserSession {
  session_id: string;
  user_agent: string | null;
  /** True when this session has been explicitly marked as a companion session. */
  is_companion: boolean;
}

/**
 * Companion / mobile user-agent backstop. Mirrors the SQL regex in `revoke_sessions`. Matches the
 * Android companion at every lifecycle stage: the in-app browser UA at session creation
 * ("...Android...Chrome"), the raw React Native HTTP client after refresh ("okhttp/x.y.z"), and
 * the explicit defense-in-depth marker the companion sets ("KeeprCompanion"). Also covers iOS.
 */
const COMPANION_UA_RE = /(android|iphone|ipad|ipod|mobile|okhttp|keepr[-_ ]?companion)/i;

/**
 * True when a user-agent string identifies a companion / mobile client that must NEVER be revoked.
 * NULL / undefined / empty UAs return false (unknown) — this is only ever used to ADD protection
 * (spare), never to authorize a delete.
 */
export function isCompanionUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === 'string' && COMPANION_UA_RE.test(userAgent);
}

/**
 * Decode the `session_id` claim from a Supabase access-token JWT WITHOUT verifying the signature.
 * Used only to identify the just-created session to SPARE — identity (the user id) always comes
 * from a verified `getUser(access_token)` call in the server action, never from this decode.
 * Returns null on any malformed input or a missing claim.
 */
export function decodeSessionId(accessToken: string | null | undefined): string | null {
  if (typeof accessToken !== 'string') return null;
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    const claims = JSON.parse(json) as { session_id?: unknown };
    return typeof claims.session_id === 'string' && claims.session_id.length > 0
      ? claims.session_id
      : null;
  } catch {
    return null;
  }
}

/**
 * From ALL of the user's sessions, choose which to revoke: everything EXCEPT the current session
 * and any companion session. Spares:
 *  - the current/new desktop session (never revoke the one that just logged in), and
 *  - any session that is companion-marked OR has a companion user_agent (either signal spares it).
 *
 * FAIL-SAFE: when the current session id is unknown (null), returns [] and revokes NOTHING — we
 * never revoke blind, because we could not guarantee sparing the current session.
 *
 * Pure function: given {current desktop, old desktop, web, companion} it returns
 * {old desktop, web}; the current and companion are spared.
 */
export function selectSessionsToRevoke(
  sessions: UserSession[],
  currentSessionId: string | null,
): string[] {
  if (!currentSessionId) return [];
  return sessions
    .filter((s) => s.session_id !== currentSessionId) // spare the new desktop
    .filter((s) => !s.is_companion) // spare explicitly-marked companion (primary signal)
    .filter((s) => !isCompanionUserAgent(s.user_agent)) // spare companion-UA (backstop signal)
    .map((s) => s.session_id);
}
