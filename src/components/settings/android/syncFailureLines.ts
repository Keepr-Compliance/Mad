/**
 * SR U1 (storyboards H01 / H02, 2026-10-04): a failed Google Messages Sync
 * says WHY in one short line (≤ 45 characters) — on the page box and in
 * Keepr's dashboard bubble alike. The long text stays in See details / Copy
 * details only.
 *
 * The page box (chrome-extension/job.js, plain JS shipped as-is) keeps the
 * SAME table as FAILURE_LINES; a test holds the two identical.
 */

/** The one short line for each failure code. */
export const SYNC_FAILURE_LINES: Readonly<Record<string, string>> = {
  connection_lost: "Lost the connection to your phone.",
  phone_unreachable: "Lost the connection to your phone.",
  not_signed_in: "Google Messages isn't signed in.",
  page_gone: "The Messages tab was closed.",
  page_not_ready: "Google Messages didn't finish loading.",
  not_opened: "Google Messages didn't open.",
  list_not_reachable: "Couldn't open your conversation list.",
  details_stuck: "A chat's details panel didn't close.",
  all_failed: "None of the chats could be read.",
  keepr_error: "Keepr couldn't save the chats.",
  keepr_unreachable: "Keepr closed or restarted.",
  keepr_unknown_job: "Keepr closed or restarted.",
  keepr_refused: "This browser isn't linked.",
  finish_refused: "Keepr couldn't finish the Sync.",
  claim_refused: "Keepr couldn't start this Sync.",
  save_failed: "Keepr couldn't save this Sync.",
  scan_failed: "The Sync stopped unexpectedly.",
  pc_offline: "This computer is offline.",
  keepr_busy: "Keepr is busy. Try again.",
};

/** Any code Keepr doesn't know (a newer extension): still short. */
export const SYNC_FAILURE_FALLBACK = "The Sync stopped unexpectedly.";

/** The short line for a failure code. */
export function syncFailureLine(code: string | null | undefined): string {
  return (code && SYNC_FAILURE_LINES[code]) || SYNC_FAILURE_FALLBACK;
}
