/**
 * BACKLOG-2326 / PR #2122 — Option B: single-desktop session enforcement helpers.
 *
 * Pure, side-effect-free logic for the `enforceSingleDesktopSession` server action. Kept
 * separate so the security-sensitive selection logic (which sessions get revoked, which are
 * always spared) is unit-testable without a live Supabase or a running server.
 *
 * Design context (see the BACKLOG-2326 SR plan review):
 *  - Desktop sessions are identified POSITIVELY via the `public.desktop_login_sessions`
 *    tracking table, not by user_agent — GoTrue overwrites `user_agent` on refresh, so a
 *    refreshed desktop-app session and a broker web session both look like `node`.
 *  - The companion (phone) is spared BY CONSTRUCTION (never tracked as a desktop login). The
 *    UA matcher below is a defense-in-depth backstop that mirrors the SQL backstop in
 *    `revoke_desktop_sessions`, in case a companion session were ever mis-tracked.
 */

/** A tracked desktop session row as returned by the `list_other_desktop_sessions` RPC. */
export interface TrackedDesktopSession {
  session_id: string;
  user_agent: string | null;
}

/**
 * Companion / mobile user-agent backstop. Mirrors the SQL regex in `revoke_desktop_sessions`.
 * Matches the Android companion at every lifecycle stage: the in-app browser UA at session
 * creation ("...Android...Chrome"), the raw React Native HTTP client after refresh
 * ("okhttp/x.y.z"), and the explicit defense-in-depth marker the companion sets
 * ("KeeprCompanion"). Also covers iOS UAs defensively.
 */
const COMPANION_UA_RE = /(android|iphone|ipad|ipod|mobile|okhttp|keepr[-_ ]?companion)/i;

/**
 * True when a user-agent string identifies a companion / mobile client that must NEVER be
 * revoked by single-desktop enforcement. NULL / undefined / empty UAs return false (unknown),
 * so this is only ever used to ADD protection (spare), never to authorize a delete.
 */
export function isCompanionUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === 'string' && COMPANION_UA_RE.test(userAgent);
}

/**
 * Decode the `session_id` claim from a Supabase access-token JWT WITHOUT verifying the
 * signature. This value is only ever used as a secondary belt to exclude the just-created
 * session from the revoke set — identity (the user id) is always taken from a verified
 * `getUser(access_token)` call in the server action, never from this decode. Returns null on
 * any malformed input or a missing claim.
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
 * From the user's OTHER tracked desktop sessions, choose which to revoke. Spares:
 *  - the current session (belt — the SQL LIST already excludes it, and TRACK runs last), and
 *  - any session whose user_agent marks it a companion/mobile client (defense-in-depth).
 *
 * Pure function: given {current desktop, other desktop, companion} it returns only the other
 * desktop; given {current desktop, companion} it returns nothing.
 */
export function selectSessionsToRevoke(
  others: TrackedDesktopSession[],
  currentSessionId: string | null,
): string[] {
  return others
    .filter((s) => s.session_id !== currentSessionId)
    .filter((s) => !isCompanionUserAgent(s.user_agent))
    .map((s) => s.session_id);
}
