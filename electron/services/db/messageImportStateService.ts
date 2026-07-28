// ============================================
// MESSAGE IMPORT STATE SERVICE (BACKLOG-2292)
//
// Per-user STALENESS watermarks for the audit-window messages-completeness
// system — the messages twin of emailSyncStateService. Reads/writes the
// `message_import_state` table (schema.sql + migration v53).
//
// DESIGN (SR-correction b): this table is NOT the floor-of-record. The messages
// import floor is always computed as MIN(sent_at) over non-reaction sms/imessage
// rows (see auditCoverageService.getMessagesFloorISO) — a single stored
// watermark would understate coverage once an audit-driven import reaches below
// the global lookback. This service stores only:
//   - last_import_at    : when a targeted audit messages import last RAN
//   - last_expansion_at : when expandAttachedThreadsForUser last COMPLETED
// so the export gate can detect "imported but expansion has not run since" (a
// silent-incompleteness risk) without a second device scan.
// ============================================

import { dbGet, dbRun } from "./core/dbConnection";

export interface MessageImportStateRow {
  user_id: string;
  last_import_at: string | null;
  last_expansion_at: string | null;
  updated_at: string;
}

/** Read the per-user message-import state row, if it exists. */
export function getState(userId: string): MessageImportStateRow | undefined {
  return dbGet<MessageImportStateRow>(
    "SELECT * FROM message_import_state WHERE user_id = ?",
    [userId],
  );
}

/**
 * Record that a targeted audit messages import RAN. Sets last_import_at to now.
 * Upsert — leaves last_expansion_at untouched (so a fresh import correctly makes
 * expansion "stale" until recordExpansionRun catches up).
 */
export function recordImport(userId: string): void {
  dbRun(
    `INSERT INTO message_import_state (user_id, last_import_at, updated_at)
     VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       last_import_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`,
    [userId],
  );
}

/**
 * Record that expandAttachedThreadsForUser COMPLETED. Sets last_expansion_at to
 * now. Upsert.
 *
 * SR-correction (g): callers MUST only invoke this on OBSERVED expansion success
 * (the expansion call resolved without throwing) — never in a catch/finally — so
 * a silently-failed expansion leaves last_expansion_at behind last_import_at and
 * the export gate keeps re-prompting instead of falsely reporting complete.
 */
export function recordExpansionRun(userId: string): void {
  dbRun(
    `INSERT INTO message_import_state (user_id, last_expansion_at, updated_at)
     VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       last_expansion_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`,
    [userId],
  );
}

/**
 * Whether a targeted audit messages import has EVER run for this user (via the
 * trigger). Used by the export gate as the "we have attempted to fetch back to
 * the audit start" signal — a floor still above the audit start after an import
 * just means no older texts exist on the device, which is COMPLETE, not a gap.
 * (SR-correction b sanctions message_import_state for exactly this
 * import/expansion staleness, never as the gap-detection floor-of-record.)
 */
export function hasImportRun(userId: string): boolean {
  return !!getState(userId)?.last_import_at;
}

/**
 * Staleness test: TRUE when a targeted import has run but expansion has NOT run
 * since (last_import_at newer than last_expansion_at, or expansion never ran
 * after an import). FALSE when no import has been recorded (nothing to expand)
 * so email-only / never-imported users are never flagged.
 *
 * Compared by epoch-ms (SR-correction f) — never Date-vs-string coercion.
 */
export function isExpansionStale(userId: string): boolean {
  const row = getState(userId);
  if (!row || !row.last_import_at) return false;
  if (!row.last_expansion_at) return true;
  return new Date(row.last_import_at).getTime() > new Date(row.last_expansion_at).getTime();
}
