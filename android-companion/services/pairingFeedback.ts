/**
 * Pairing failure feedback (Android Companion)
 *
 * BACKLOG-2212: when the phone registers with the desktop at pair time
 * (`registerDevice`), a failure used to be swallowed (catch -> console.warn) and
 * the flow pushed on regardless, so a desktop that was down / on another Wi-Fi /
 * rejecting the account was INVISIBLE. This module is the single source of the
 * distinct, actionable message shown for each failure mode, so the onboarding
 * pair screen and the home re-pair screen stay consistent (coordinate, not
 * duplicate).
 *
 * Failure modes (each gets a distinct, correct message):
 *   - account      → the desktop authoritatively REJECTED the pairing with HTTP
 *                    403 (BACKLOG-2224 verified account-mismatch / could-not-
 *                    verify). Re-attempting with the same account will not help,
 *                    so we guide instead of offering a Retry. The copy is reused
 *                    from `accountMatchMessage` so it matches the 2224 pre-check
 *                    exactly.
 *   - reachability → the phone reached the network but NOT the desktop server
 *                    (connection refused / timeout / connection reset). THIS
 *                    ticket. The desktop app is likely closed or on a different
 *                    Wi-Fi; a Retry once it is open makes sense.
 *   - generic      → any other server error (non-403) or an unknown failure.
 *                    Retry is offered.
 *
 * Note: the 2224 QR *pre-check* mismatch (before anything is sent) is handled
 * upstream by `accountMatchMessage` directly; this module classifies the result
 * of the register round-trip that follows a passing pre-check.
 */

import type { SyncErrorType } from '../types/sync';
import { accountMatchMessage } from './accountMatch';

/**
 * The subset of a failed `registerDevice` result this module reasons about.
 * `status` is the HTTP status of a non-ok desktop response (surfaced by
 * syncService for the 403 account-rejection branch); `errorType` is the network
 * classification for transport-level failures.
 */
export interface RegisterFailure {
  errorType?: SyncErrorType;
  status?: number;
  error?: string;
}

export type PairFailureKind =
  | 'account'
  | 'reachability'
  /**
   * BACKLOG-2956: the destination is not a private LAN address, so the LAN guard
   * in syncService refused the request before it was sent. Never retryable —
   * the same address will be refused again.
   */
  | 'address'
  | 'generic';

/**
 * Classify a FAILED `registerDevice` outcome so the UI can show the right
 * message. A desktop 403 is authoritative account-rejection; the transport
 * error types map to reachability; everything else is generic.
 */
export function classifyPairFailure(result: RegisterFailure): PairFailureKind {
  // Desktop rejected the pairing on account grounds (BACKLOG-2224). Not a
  // reachability problem — the phone DID reach the desktop; it refused.
  if (result.status === 403) {
    return 'account';
  }

  switch (result.errorType) {
    // The phone reached the network but not the desktop server, or the desktop
    // never answered within the bounded timeout, or the connection dropped
    // mid-flight. All resolve to "make sure Keepr is open on the same Wi-Fi".
    case 'connection_refused':
    case 'timeout':
    case 'network_after_connect':
      return 'reachability';
    // BACKLOG-2956: the address itself is off-LAN and was refused before any
    // request. Not reachability — retrying the same address cannot work.
    case 'invalid_address':
      return 'address';
    // A non-403 server error, or an error we could not classify.
    case 'server_error':
    case 'unknown':
    default:
      return 'generic';
  }
}

export interface PairFailureMessage {
  title: string;
  body: string;
  /**
   * true  → offer a Retry that re-attempts the pairing (reachability / generic).
   * false → guidance only; re-attempting the same account cannot succeed.
   */
  retryable: boolean;
}

/** Map a failed `registerDevice` outcome to a user-facing message + retryability. */
export function pairFailureMessage(result: RegisterFailure): PairFailureMessage {
  switch (classifyPairFailure(result)) {
    case 'account': {
      // Reuse the exact 2224 account-mismatch copy so the desktop-side 403 and
      // the phone-side pre-check read identically.
      const { title, body } = accountMatchMessage('account_mismatch');
      return { title, body, retryable: false };
    }
    case 'address':
      // Not a network problem: nothing was sent, and a retry sends nothing
      // again. Reuse the lanAddress module's voice — name the real cause and
      // point at the one action that fixes it.
      return {
        title: 'Not a Local Network Address',
        body: "This pairing points at a computer that isn't on your local network. Keepr only syncs to a computer on your own Wi-Fi or wired network. Scan the QR code shown in the Keepr desktop app on your own computer.",
        retryable: false,
      };
    case 'reachability':
      return {
        title: "Couldn't Reach Keepr",
        body: "Couldn't reach Keepr on your computer. Make sure the Keepr app is open and your phone is on the same Wi-Fi network, then try again.",
        retryable: true,
      };
    case 'generic':
    default:
      return {
        title: 'Pairing Failed',
        body: "Something went wrong while connecting to your computer. Make sure Keepr is open and up to date on your computer, then try again.",
        retryable: true,
      };
  }
}
