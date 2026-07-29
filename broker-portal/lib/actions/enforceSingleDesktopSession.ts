'use server';

/**
 * BACKLOG-2326 / PR #2122 — Option B: enforce ONE desktop session per user.
 *
 * Called from the broker desktop-login CALLBACK (app/auth/desktop/callback/page.tsx) after the
 * new session is confirmed real. Revokes the user's OTHER desktop-app sessions while sparing:
 *   - the Android companion (phone) session — so pairing keeps working, and
 *   - the user's broker-portal web sessions — by construction (only desktop logins are tracked).
 *
 * This does NOT replace #2122's `signOut({ scope: 'local' })` login hygiene or the reason-
 * specific 403 fix — it ADDS server-side single-desktop enforcement on top of them. The
 * user-initiated "Sign Out All Devices" flow (signOutAllDevices.ts, scope 'global') is untouched.
 *
 * SECURITY (SR merge-gating conditions):
 *  - Identity is derived from a VERIFIED getUser(access_token), never from a client-supplied
 *    user_id. Server actions are directly-invocable POST endpoints; trusting a passed user_id
 *    would let an attacker force-logout an arbitrary user.
 *  - The revoke primitive (service-role RPCs) is scoped to the verified user and carries a hard
 *    companion-UA backstop in SQL.
 *
 * FAIL-SAFE: best-effort. Any error resolves to { ok: false } (never throws) so a desktop login
 * is never blocked by enforcement, and the companion is never revoked.
 */

import { createServiceClient } from '@/lib/supabase/service';
import {
  decodeSessionId,
  selectSessionsToRevoke,
  type TrackedDesktopSession,
} from '@/lib/auth/sessionMarker';

export interface EnforceSingleDesktopResult {
  ok: boolean;
  /** Number of other desktop sessions revoked (0 when none / on skip). */
  revoked: number;
  /** Why enforcement did nothing, when ok is false. */
  reason?: 'no_token' | 'unverified' | 'list_error' | 'revoke_error' | 'error';
}

export async function enforceSingleDesktopSession(
  accessToken: string,
): Promise<EnforceSingleDesktopResult> {
  try {
    if (!accessToken) return { ok: false, revoked: 0, reason: 'no_token' };

    const supabase = createServiceClient();

    // Identity from the VERIFIED token — never a client-supplied id (SR BLOCKING-1).
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(accessToken);
    if (userError || !user) {
      return { ok: false, revoked: 0, reason: 'unverified' };
    }
    const userId = user.id;

    // Secondary belt only: exclude the just-created session from the revoke set. Identity above
    // is authoritative; this decode is not (TRACK runs last, so the current session is not yet
    // tracked and cannot appear in the "others" list regardless of this value).
    const currentSessionId = decodeSessionId(accessToken);

    // Order: LIST -> REVOKE -> TRACK (SR BLOCKING-4).
    const { data: others, error: listError } = await supabase.rpc('list_other_desktop_sessions', {
      p_user_id: userId,
      p_current_session_id: currentSessionId,
    });
    if (listError) {
      return { ok: false, revoked: 0, reason: 'list_error' };
    }

    const ids = selectSessionsToRevoke(
      (others ?? []) as TrackedDesktopSession[],
      currentSessionId,
    );

    let revoked = 0;
    if (ids.length > 0) {
      const { data: count, error: revokeError } = await supabase.rpc('revoke_desktop_sessions', {
        p_user_id: userId,
        p_session_ids: ids,
      });
      if (revokeError) {
        return { ok: false, revoked: 0, reason: 'revoke_error' };
      }
      revoked = typeof count === 'number' ? count : 0;
    }

    // Track the current session LAST so the NEXT desktop login revokes it. A track failure must
    // not undo a successful revoke or block login — swallow it.
    if (currentSessionId) {
      try {
        await supabase.rpc('track_desktop_session', {
          p_user_id: userId,
          p_session_id: currentSessionId,
        });
      } catch (trackErr) {
        console.error('[enforceSingleDesktopSession] track failed (non-fatal):', trackErr);
      }
    }

    return { ok: true, revoked };
  } catch (err) {
    // Never block a desktop login on enforcement failure.
    console.error('[enforceSingleDesktopSession] unexpected error:', err);
    return { ok: false, revoked: 0, reason: 'error' };
  }
}
