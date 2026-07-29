'use server';

/**
 * BACKLOG-2326 / PR #2122 — enforce a single active (non-companion) session per user.
 *
 * Called from the broker desktop-login CALLBACK (app/auth/desktop/callback/page.tsx) after the
 * new session is confirmed real. Revokes ALL of the user's OTHER sessions (old sessions on this
 * computer, other computers, other browsers, web) while ALWAYS sparing:
 *   - the current/new desktop session (the one that just logged in), and
 *   - the Android companion (phone) session(s).
 *
 * This does NOT replace #2122's `signOut({ scope: 'local' })` login hygiene or the reason-specific
 * 403 fix — it ADDS server-side single-session enforcement on top of them. The user-initiated
 * "Sign Out All Devices" flow (signOutAllDevices.ts, scope 'global') is untouched.
 *
 * SECURITY / SAFETY:
 *  - Identity is derived from a VERIFIED getUser(access_token), never a client-supplied user_id
 *    (server actions are directly-invocable POST endpoints; trusting a passed id would let an
 *    attacker force-logout an arbitrary user).
 *  - The companion is spared by TWO signals (explicit mark OR companion UA); the revoke RPC also
 *    carries both as hard SQL backstops, so a misidentification can never kick the phone.
 *  - If the current session id cannot be derived, NOTHING is revoked (never revoke blind).
 *
 * FAIL-SAFE: best-effort. Any error resolves to { ok: false } (never throws) so a desktop login is
 * never blocked by enforcement, and nothing is wrongly revoked.
 */

import { createServiceClient } from '@/lib/supabase/service';
import {
  decodeSessionId,
  selectSessionsToRevoke,
  type UserSession,
} from '@/lib/auth/sessionMarker';

export interface EnforceSingleDesktopResult {
  ok: boolean;
  /** Number of other sessions revoked (0 when none / on skip). */
  revoked: number;
  /** Why enforcement did nothing, when ok is false. */
  reason?: 'no_token' | 'unverified' | 'no_current_session' | 'list_error' | 'revoke_error' | 'error';
}

export async function enforceSingleDesktopSession(
  accessToken: string,
): Promise<EnforceSingleDesktopResult> {
  try {
    if (!accessToken) return { ok: false, revoked: 0, reason: 'no_token' };

    const supabase = createServiceClient();

    // Identity from the VERIFIED token — never a client-supplied id.
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(accessToken);
    if (userError || !user) {
      return { ok: false, revoked: 0, reason: 'unverified' };
    }
    const userId = user.id;

    // The session to SPARE. If we cannot identify it, revoke nothing (never revoke blind — we
    // must be certain we are not deleting the session that just logged in).
    const currentSessionId = decodeSessionId(accessToken);
    if (!currentSessionId) {
      return { ok: false, revoked: 0, reason: 'no_current_session' };
    }

    // List every session for the user, annotated with the explicit companion mark.
    const { data: sessions, error: listError } = await supabase.rpc(
      'list_user_sessions_with_companion_flag',
      { p_user_id: userId },
    );
    if (listError) {
      return { ok: false, revoked: 0, reason: 'list_error' };
    }

    // Revoke everything except the current session and companion sessions (mark OR UA).
    const ids = selectSessionsToRevoke((sessions ?? []) as UserSession[], currentSessionId);
    if (ids.length === 0) {
      return { ok: true, revoked: 0 };
    }

    const { data: count, error: revokeError } = await supabase.rpc('revoke_sessions', {
      p_user_id: userId,
      p_session_ids: ids,
    });
    if (revokeError) {
      return { ok: false, revoked: 0, reason: 'revoke_error' };
    }

    return { ok: true, revoked: typeof count === 'number' ? count : 0 };
  } catch (err) {
    // Never block a desktop login on enforcement failure.
    console.error('[enforceSingleDesktopSession] unexpected error:', err);
    return { ok: false, revoked: 0, reason: 'error' };
  }
}
