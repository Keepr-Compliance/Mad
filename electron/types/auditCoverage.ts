// ============================================
// AUDIT-WINDOW COVERAGE — SHARED IPC TYPES (BACKLOG-2292)
//
// Shared by the main-side auditCoverageService, the IPC handlers, the preload
// bridge, and the renderer hook so the window.api boundary is fully typed (no
// `any`) — SR-correction (f).
//
// FLOOR CONVENTION (SR-correction f): every floor/date crosses IPC as an ISO
// STRING (or null), never a Date. Both sides compare by epoch-ms via
// isBeforeFloor() below — no Date-vs-string coercion (the BACKLOG-1898 class).
// ============================================

/**
 * True when `proposedStartISO` is strictly EARLIER than `floorISO` (i.e. the
 * chosen audit start predates the imported/cached history and a gap exists).
 * A null floor means "no coverage baseline" — callers decide per channel:
 *   - messages: null floor ⇒ nothing imported ⇒ NOT a gap we can heal by
 *     re-import (targeted import only widens an existing floor), so returns false.
 *   - email: a null LOWER bound on an active account is treated as a gap by the
 *     service directly (see getAuditCoverage), not via this helper.
 * A null/invalid proposed date returns false (cannot be "before" anything).
 */
export function isBeforeFloor(
  proposedStartISO: string | null | undefined,
  floorISO: string | null | undefined,
): boolean {
  if (!proposedStartISO || !floorISO) return false;
  const p = new Date(proposedStartISO).getTime();
  const f = new Date(floorISO).getTime();
  if (Number.isNaN(p) || Number.isNaN(f)) return false;
  return p < f;
}

/** Result of transactions:get-audit-coverage. All dates are ISO strings. */
export interface AuditCoverageResult {
  success: boolean;
  /**
   * MIN(sent_at) over the user's non-reaction sms/imessage rows — the messages
   * floor-of-record. Null when no texts are imported.
   */
  messagesFloorISO: string | null;
  /**
   * MAX(oldest_cached_at) across ACTIVE email accounts, but ONLY when every
   * active account is lower-bounded. Null when there is a gap (an active account
   * has no oldest_cached_at, or there are no active accounts) — see
   * needsEmailBackfill for the gap signal.
   */
  emailFloorISO: string | null;
  /** proposedStart predates the messages floor (floor non-null and proposed < floor). */
  needsMessagesImport: boolean;
  /**
   * proposedStart predates the email cache floor, OR an active email account has
   * no lower bound (unbounded ⇒ cannot prove coverage back to proposedStart).
   */
  needsEmailBackfill: boolean;
  /** A targeted import ran but expandAttachedThreadsForUser has not run since. */
  expansionStale: boolean;
  /** macOS + Full Disk Access — whether a targeted messages import can run here. */
  messagesImporterAvailable: boolean;
  error?: string;
}

/** Result of transactions:check-export-completeness. All dates are ISO strings. */
export interface ExportCompletenessResult {
  success: boolean;
  /** messages floor <= the transaction's audit start AND expansion is not stale. */
  complete: boolean;
  messagesFloorISO: string | null;
  /** The transaction's computed audit start (started_at → created_at fallback). */
  auditStartISO: string | null;
  needsMessagesImport: boolean;
  expansionStale: boolean;
  messagesImporterAvailable: boolean;
  error?: string;
}

/** Result of transactions:ensure-messages-coverage (the "Update now" action). */
export interface EnsureMessagesCoverageResult {
  success: boolean;
  /** Whether any work (import and/or expansion) ran. */
  ran: boolean;
  /** Whether a real device IMPORT ran (vs expansion-only). The export gate uses
   * this to proceed after "Update now": once the device was scanned back to the
   * audit start, a floor still above it means no older texts exist (complete). */
  importRan: boolean;
  reason: string;
  /** Messages imported by the targeted import (0 when skipped/covered). */
  imported: number;
  /**
   * The messages floor AFTER the import+expansion attempt, re-queried from the
   * DB (observe-by-requery; BACKLOG-1875). Callers re-derive completeness from
   * this — never assume success from the absence of an error.
   */
  messagesFloorISO: string | null;
  skipped?: string;
  error?: string;
}
