/**
 * BACKLOG-3892 S5 — the "Get older texts" backfill's IPC shapes (main and renderer).
 * Channels: sync:backfill-availability, sync:backfill-older, sync:backfill-cancel
 * (invoke) and sync:backfill-progress (event). See iphoneBackfillService.ts.
 */

/** Why a backfill is not offered, did not run, or stopped. A code for S6; never a sentence. */
export type BackfillReason =
  | "no-deal"
  | "locked"
  | "no-phone"
  | "no-gap"
  | "nothing-older"
  | "busy"
  | "missing"
  | "apple-encrypted"
  | "key-unavailable"
  | "damaged"
  | "key-missing"
  | "disk-space"
  | "unreadable"
  | "cancelled"
  | "error";

export interface BackfillAvailability {
  available: boolean;
  reason?: BackfillReason;
  /** What would be read: [floorMs, ceilingMs) (epoch ms). */
  floorMs?: number;
  ceilingMs?: number;
  /** The phone's oldest text, not the deal start, limits how far back it can go. */
  cappedByPhone?: boolean;
  /** The deal's iPhone covered-since after it (epoch ms), projected. */
  coveredSinceAfterMs?: number;
  /** Set only from a founder-approved sentence (missing / damaged / cannot decrypt). */
  message?: string;
  /** reason "busy" because a backfill is running: the deal it is running for. */
  busyWith?: string;
}

export interface BackfillResult {
  success: boolean;
  reason?: BackfillReason;
  messagesStored: number;
  /** Coverage advanced (false after a failed chat read: the texts are stored, the gap stays). */
  coverageRecorded: boolean;
  /** The deal's iPhone covered-since afterwards (ISO), read back. */
  coveredSinceAfter?: string;
  cappedByPhone?: boolean;
  /** Set only from a founder-approved sentence (missing / damaged / cannot decrypt); never error text. */
  message?: string;
}

export type BackfillPhase = "copying" | "reading" | "saving" | "linking";

export interface BackfillProgress {
  transactionId: string;
  phase: BackfillPhase;
  /** 0-100 within the whole run. */
  percent: number;
}

