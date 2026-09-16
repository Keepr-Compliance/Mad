/**
 * Remembering that this browser tab was opened BY the desktop app (BACKLOG-3394)
 *
 * ============================================================================
 * THE BUG THIS EXISTS FOR
 * ============================================================================
 *
 * `/auth/desktop/callback` decided whether to show "Download Keepr" by querying
 * the `devices` table for the signed-in user. Device registration happens in
 * the desktop app, inside its deep-link handler, AFTER the callback page has
 * already rendered. So on a user's first-ever desktop sign-in — the one moment
 * they demonstrably DO have the app, because they launched it to get here —
 * the row does not exist yet and the page told them to download it.
 *
 * The `devices` check is a proxy for "has ever completed a desktop sign-in",
 * dressed up as "has the app installed". It is kept as the fallback for a
 * genuine browser-first visitor, who really might not have the app; what is
 * added here is a direct answer for the case where we KNOW.
 *
 * ============================================================================
 * WHY sessionStorage AND NOT A QUERY PARAM ALL THE WAY THROUGH
 * ============================================================================
 *
 * The desktop app appends `?from=desktop` when it opens the browser, but that
 * URL is the START of the flow. Between it and the callback page the browser
 * leaves this origin entirely for Google's or Microsoft's consent screen and is
 * redirected back by Supabase to a URL we do not control the query string of.
 * The parameter does not survive; `sessionStorage` does — it is per-origin and
 * per-tab, and the whole round trip happens in one tab on one origin.
 *
 * ============================================================================
 * WHY THE WRITE IS ADDITIVE AND THE READ NEVER CLEARS
 * ============================================================================
 *
 * Two paths re-enter `/auth/desktop` WITHOUT the parameter after the marker has
 * been set: the stale-session bounce (`/auth/desktop?error=session_expired`)
 * and the "Try Again" link on the error state. If the absence of the parameter
 * cleared the marker, a user whose first attempt hit either of those would land
 * on the download screen for their second — which is the very bug being fixed,
 * reached by a slightly longer road. So `markArrivedFromDesktop` only ever
 * writes, and `arrivedFromDesktop` only ever reads.
 *
 * ============================================================================
 * THE LIMIT
 * ============================================================================
 *
 * sessionStorage is per-TAB. The magic-link sign-in opens its callback from the
 * user's mail client, which is a new tab with no marker, so that path still
 * falls through to the `devices` check and a first-ever desktop user arriving
 * that way can still be shown Download. Narrowing that needs a different
 * carrier than sessionStorage and is not attempted here.
 */

/** Query parameter the desktop app appends when it opens the browser. */
export const FROM_DESKTOP_PARAM = 'from';

/** Value of that parameter which means "the desktop app opened this". */
export const FROM_DESKTOP_VALUE = 'desktop';

/** sessionStorage key the marker is carried in across the OAuth round trip. */
export const FROM_DESKTOP_STORAGE_KEY = 'keepr:auth:from-desktop';

/**
 * Record that this tab was opened by the desktop app.
 *
 * Write-only by design (see the header). Safe to call when the parameter is
 * absent — it does nothing — and safe in a browser that refuses storage
 * (private mode, blocked site data), where it degrades to the `devices` check.
 */
export function markArrivedFromDesktop(fromParam: string | null): void {
  if (fromParam !== FROM_DESKTOP_VALUE) return;
  try {
    window.sessionStorage.setItem(FROM_DESKTOP_STORAGE_KEY, '1');
  } catch {
    // Storage unavailable: the callback page falls back to the devices check,
    // which is exactly the behaviour that existed before this marker.
  }
}

/**
 * Did the desktop app open this tab?
 *
 * Read-only by design: it must not consume the marker, because the flow can
 * legitimately pass back through `/auth/desktop` and reach the callback twice.
 */
export function arrivedFromDesktop(): boolean {
  try {
    return window.sessionStorage.getItem(FROM_DESKTOP_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
