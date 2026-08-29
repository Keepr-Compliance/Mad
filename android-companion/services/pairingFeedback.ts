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

export type PairFailureKind = 'account' | 'reachability' | 'generic';

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
    case 'reachability':
      // BACKLOG-2956 — this copy was challenged and DELIBERATELY KEPT. The
      // failure that prompted the challenge was an Android cleartext block
      // (the OS refusing the request before a socket opens), which this message
      // reports as a Wi-Fi problem — the same wrong-generic-message class as
      // BACKLOG-2913. The reason it stays is that the client genuinely CANNOT
      // tell the two apart:
      //
      //   node_modules/whatwg-fetch/dist/fetch.umd.js:567
      //     xhr.onerror = ... reject(new TypeError('Network request failed'))
      //
      // React Native's `fetch` is whatwg-fetch (Libraries/Network/fetch.js is a
      // side-effectful re-export), and that message is a HARDCODED constant.
      // The native cause — 'java.io.IOException: Cleartext HTTP traffic to
      // <ip> not permitted' vs a real ECONNREFUSED — never reaches JS, so
      // `classifySyncError` sees one indistinguishable string for both. Writing
      // a cleartext-specific branch would mean inventing a fixture for a string
      // this layer can never observe.
      //
      // The cleartext cause is instead removed at the source (the release
      // manifest now permits it — plugins/withLanCleartext.js), and the one
      // related failure the app CAN identify precisely, a desktop address
      // outside the local network, has its own distinct message in
      // services/lanAddress.ts rather than being funnelled in here.
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
