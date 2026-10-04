/**
 * Google Messages Sync — the short line for each failure code (BACKLOG-3671 P2).
 *
 * The SAME table as the desktop app's SYNC_FAILURE_LINES
 * (src/components/settings/android/syncFailureLines.ts) and the extension's
 * FAILURE_LINES: what the user saw is what this report names. A test holds
 * the three identical. The admin portal is its own package, so it carries a
 * copy rather than an import.
 *
 * Plus the two stop codes Keepr records for a cancelled run (portal only).
 */

export const GM_FAILURE_LINES: Readonly<Record<string, string>> = {
  connection_lost: 'Lost the connection to your phone.',
  phone_unreachable: 'Lost the connection to your phone.',
  not_signed_in: "Google Messages isn't signed in.",
  page_gone: 'The Messages tab was closed.',
  page_not_ready: "Google Messages didn't finish loading.",
  not_opened: "Google Messages didn't open.",
  list_not_reachable: "Couldn't open your conversation list.",
  details_stuck: "A chat's details panel didn't close.",
  all_failed: 'None of the chats could be read.',
  keepr_error: "Keepr couldn't save the chats.",
  keepr_unreachable: 'Keepr closed or restarted.',
  keepr_unknown_job: 'Keepr closed or restarted.',
  keepr_refused: "This browser isn't linked.",
  finish_refused: "Keepr couldn't finish the Sync.",
  claim_refused: "Keepr couldn't start this Sync.",
  save_failed: "Keepr couldn't save this Sync.",
  scan_failed: 'The Sync stopped unexpectedly.',
};

export const GM_FAILURE_FALLBACK = 'The Sync stopped unexpectedly.';

/** A cancelled run's stop codes (recorded by Keepr, never shown to the user). */
export const GM_STOP_LINES: Readonly<Record<string, string>> = {
  user_stop: 'Stopped on the page (Stop sync).',
  keepr_cancel: 'Cancelled in Keepr.',
};

/** The line for a run's reason code; null when it has none. */
export function gmReasonLine(code: string | null | undefined): string | null {
  if (!code) return null;
  return GM_STOP_LINES[code] ?? GM_FAILURE_LINES[code] ?? GM_FAILURE_FALLBACK;
}
