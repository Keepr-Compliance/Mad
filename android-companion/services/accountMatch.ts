/**
 * Account-match helpers (Android Companion)
 *
 * BACKLOG-2224: cross-account data-leak pre-check. Before the phone sends ANY
 * data to a desktop it just scanned, it compares a SHA-256 hash of its own
 * signed-in Supabase user id against the `desktopUserIdHash` embedded in the QR
 * code. If they differ, the phone is signed into a DIFFERENT Keepr account than
 * the desktop and pairing must be aborted before any texts/contacts leave the
 * device.
 *
 * Hashing uses node-forge (Hermes has no `crypto.subtle`) — the same library
 * `keyDerivation.ts` already uses. `sha256(userId)` here is byte-for-byte
 * identical to the desktop's Node `crypto.createHash('sha256')` output, so the
 * hashes compare cleanly across runtimes.
 */

import forge from 'node-forge';
import { getSession } from './authService';

/**
 * SHA-256 hash (lowercase hex) of a Supabase user id.
 * Matches the desktop's `crypto.createHash('sha256').update(userId).digest('hex')`.
 */
export function hashUserId(userId: string): string {
  const md = forge.md.sha256.create();
  md.update(userId, 'utf8');
  return md.digest().toHex();
}

/** Reason a pairing pre-check aborted (for a targeted user-facing message). */
export type AccountMatchReason = 'account_mismatch' | 'not_signed_in';

export interface AccountMatchResult {
  /** true → proceed with pairing; false → abort (see `reason`). */
  ok: boolean;
  reason?: AccountMatchReason;
}

/**
 * Decide whether pairing may proceed, given the `desktopUserIdHash` from the QR.
 *
 * Back-compat / graceful degradation:
 *   - QR has NO hash (older desktop build) → skip the check, allow pairing.
 *   - Phone has no session but the QR carries a hash → abort (`not_signed_in`);
 *     the phone must be signed in to prove the accounts match.
 *   - Hash present and phone signed in → allow only on an exact hash match.
 *
 * @param desktopUserIdHash - SHA-256 hash (hex) of the desktop user id from the
 *   scanned QR. Undefined when the desktop build predates BACKLOG-2224.
 */
export async function checkDesktopAccountMatch(
  desktopUserIdHash: string | undefined,
): Promise<AccountMatchResult> {
  // Old desktop build — no hash to compare against. Skip gracefully.
  if (!desktopUserIdHash) {
    return { ok: true };
  }

  const session = await getSession();
  const userId = session?.user?.id;

  // The QR expects an account match but this phone has no signed-in user to
  // compare — cannot prove same account, so abort.
  if (!userId) {
    return { ok: false, reason: 'not_signed_in' };
  }

  if (hashUserId(userId) !== desktopUserIdHash) {
    return { ok: false, reason: 'account_mismatch' };
  }

  return { ok: true };
}

/** User-facing message for an aborted account-match pre-check. */
export function accountMatchMessage(reason: AccountMatchReason): {
  title: string;
  body: string;
} {
  if (reason === 'not_signed_in') {
    return {
      title: 'Sign In Required',
      body: 'Please sign in to this app with your Keepr account before pairing with the desktop.',
    };
  }
  return {
    title: 'Different Keepr Account',
    body: 'This phone is signed into a different Keepr account than the desktop app. Sign in with the same account on both devices, then pair again.',
  };
}
