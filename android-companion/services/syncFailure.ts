/**
 * Sync-failure messaging (Android Companion).
 *
 * BACKLOG-2296: turns a failed sync result into the ONE persistent "sync
 * disconnected" banner shown on the home screen — with the correct cause message
 * and, for a desktop-unreachable failure, a Re-connect CTA. This is the phone-UI
 * counterpart to services/pairingFeedback.ts (which does the same for the
 * pair-time `registerDevice` round-trip); the two coordinate rather than
 * duplicate.
 *
 * The two founder-specified causes:
 *   (a) desktop unreachable — the phone IS on Wi-Fi but the desktop Keepr app is
 *       closed / the LAN server refused the connection or timed out
 *       (`connection_refused` / `timeout` / `network_after_connect`). Copy:
 *       "Can't reach Keepr on your computer — make sure Keepr is open, then
 *       re-connect." → offer Re-connect.
 *   (b) phone offline — the phone has no Wi-Fi / is not on the same LAN
 *       (`phone_offline`, detected via NetInfo BEFORE trusting the desktop
 *       fetch). Copy: "You're not connected to Wi-Fi — reconnect to the same
 *       network as your computer." Reconnecting Wi-Fi is the fix, so NO
 *       Re-connect (re-pair) CTA.
 *
 * Pure + side-effect free (NO NetInfo import — the connectivity probe happens in
 * the sync layer and is already reflected in `errorType`) so the mapping is
 * trivially unit-tested and safe to import from the render tree.
 */

import type { SyncErrorType } from "../types/sync";

/** Which side of the connection is the problem. */
export type SyncDisconnectionCause = "phone_offline" | "desktop_unreachable";

export interface SyncDisconnection {
  cause: SyncDisconnectionCause;
  title: string;
  body: string;
  /**
   * Whether to offer the "Re-connect" CTA (re-run the guided pair flow). Only
   * for a desktop-unreachable failure — re-pairing cannot fix a phone that is
   * off Wi-Fi, where reconnecting Wi-Fi is the actual remedy.
   */
  showReconnect: boolean;
}

/** The subset of a sync result this module reasons about. */
export interface SyncFailureLike {
  error?: string;
  errorType?: SyncErrorType;
}

/**
 * Map a failed sync result to the persistent "sync disconnected" banner
 * descriptor — or `null` when the failure is NOT a connectivity problem and so
 * must NOT render the disconnected banner:
 *   - `server_error` (e.g. a 403 account rejection, BACKLOG-2284) — the desktop
 *     WAS reached and answered; this is an account/identity failure, never
 *     "desktop unreachable". Guarding this is the 2284 regression contract.
 *   - `unknown` / no `errorType` — surfaced through the existing generic path.
 *   - a successful result (no `error`).
 */
export function syncDisconnection(
  result: SyncFailureLike,
): SyncDisconnection | null {
  // No error → nothing disconnected (also guards a false positive on success).
  if (!result.error) return null;

  switch (result.errorType) {
    // Case (b): the phone itself is off Wi-Fi / not on the LAN.
    case "phone_offline":
      return {
        cause: "phone_offline",
        title: "You're not connected to Wi-Fi",
        body: "Reconnect to the same Wi-Fi network as your computer, then sync again.",
        showReconnect: false,
      };

    // Case (a): the phone is on Wi-Fi but the desktop app is unreachable.
    case "connection_refused":
    case "timeout":
    case "network_after_connect":
      return {
        cause: "desktop_unreachable",
        title: "Can't reach Keepr on your computer",
        body: "Make sure Keepr is open on your computer, then re-connect.",
        showReconnect: true,
      };

    // server_error (403 account rejection — 2284), unknown, or unset: NOT a
    // connectivity banner. Never reclassify a 403 as desktop-unreachable.
    case "server_error":
    case "unknown":
    default:
      return null;
  }
}

/**
 * BACKLOG-2301 (SR note N1): has a successful sync landed SINCE the disconnected
 * banner was raised? Used on foreground (AppState -> active) to clear a stale
 * disconnected banner after a SILENT background/catch-up recovery — the manual
 * sync that raised the banner never updates on its own, so a background success
 * would otherwise leave the danger banner up indefinitely.
 *
 * Pure + side-effect free (trivially unit-tested). Compares the persisted
 * "last successful sync" timestamp against the wall-clock moment the banner was
 * raised (both from the same device clock):
 *   - `disconnectedAtMs === null` → no banner is up → nothing to clear (false).
 *   - a missing / unparseable `lastSuccessfulSyncAt` → no recorded success →
 *     cannot have recovered (false).
 *   - otherwise recovered iff the success is strictly NEWER than the failure, so
 *     a success that predates the failure (the pre-failure baseline) never
 *     spuriously clears a legitimate current failure.
 *
 * @param disconnectedAtMs Date.now() captured when the banner was raised, or null.
 * @param lastSuccessfulSyncAt freshly-loaded ISO (or epoch-ms) success timestamp.
 */
export function hasSyncedSince(
  disconnectedAtMs: number | null,
  lastSuccessfulSyncAt: string | number | null | undefined,
): boolean {
  if (disconnectedAtMs === null) return false;
  if (lastSuccessfulSyncAt === null || lastSuccessfulSyncAt === undefined) {
    return false;
  }
  const ts = new Date(lastSuccessfulSyncAt).getTime();
  if (Number.isNaN(ts)) return false;
  return ts > disconnectedAtMs;
}
