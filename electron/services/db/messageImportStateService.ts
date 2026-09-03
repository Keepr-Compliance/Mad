// ============================================
// MESSAGE IMPORT STATE SERVICE (BACKLOG-2292)
//
// Per-user watermarks for the audit-window messages-completeness system — the
// messages twin of emailSyncStateService. Reads/writes the `message_import_state`
// table (schema.sql + migration v53).
//
// DESIGN (SR-correction b): this table is NOT the gap-detection floor-of-record.
// The messages import floor is always MIN(sent_at) over non-reaction sms/imessage
// rows (see auditCoverageService.getMessagesFloorISO). This service stores only:
//   - last_import_at       : when a targeted audit messages import last RAN
//   - last_expansion_at    : when expandAttachedThreadsForUser last COMPLETED
//   - deepest_import_start  : the EARLIEST auditPeriodStart any targeted import
//       has actually scanned the device back to. The export completeness gate
//       requires deepest_import_start <= the audit start (SR D2 fix) — so a
//       prior SHALLOW import cannot latch a later-WIDENED window "complete"
//       (e.g. Full Disk Access lost after a shallow import, then the audit start
//       moved earlier and the widening import can no longer run).
// ============================================

import { dbGet, dbRun } from "./core/dbConnection";
import { unsafeSql } from "./core/sqlText";

export interface MessageImportStateRow {
  user_id: string;
  last_import_at: string | null;
  last_expansion_at: string | null;
  /** Earliest auditPeriodStart ever scanned (ISO). Null until a targeted import. */
  deepest_import_start: string | null;
  updated_at: string;
}

/** Read the per-user message-import state row, if it exists. */
export function getState(userId: string): MessageImportStateRow | undefined {
  return dbGet<MessageImportStateRow>(
    unsafeSql("SELECT * FROM message_import_state WHERE user_id = ?"),
    [userId],
  );
}

/**
 * Record that a targeted audit messages import RAN, having scanned the device
 * back to `reachedStartISO` (the auditPeriodStart passed to the importer). Sets
 * last_import_at to now and advances deepest_import_start to the EARLIER (MIN) of
 * its current value and reachedStartISO — coverage only ever grows deeper.
 *
 * Upsert — leaves last_expansion_at untouched (so a fresh import correctly makes
 * expansion "stale" until recordExpansionRun catches up).
 *
 * SR D2: deepest_import_start is what the export gate checks against the audit
 * start, so a null/newer reach can never falsely mark a widened window complete.
 */
export function recordImport(userId: string, reachedStartISO: string | null): void {
  const existing = getState(userId);
  let deepest = existing?.deepest_import_start ?? null;
  if (reachedStartISO) {
    if (!deepest || new Date(reachedStartISO).getTime() < new Date(deepest).getTime()) {
      deepest = reachedStartISO;
    }
  }
  dbRun(
    unsafeSql(`INSERT INTO message_import_state (user_id, last_import_at, deepest_import_start, updated_at)
     VALUES (?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       last_import_at = CURRENT_TIMESTAMP,
       deepest_import_start = ?,
       updated_at = CURRENT_TIMESTAMP`),
    [userId, deepest, deepest],
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
    unsafeSql(`INSERT INTO message_import_state (user_id, last_expansion_at, updated_at)
     VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       last_expansion_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`),
    [userId],
  );
}

/**
 * The earliest auditPeriodStart any targeted import has scanned the device back
 * to (ISO), or null if no targeted import has run. The export completeness gate
 * treats a widened window as complete only when this reaches back to (or before)
 * the audit start — see auditCoverageService.checkExportCompleteness (SR D2).
 */
export function getDeepestImportStart(userId: string): string | null {
  return getState(userId)?.deepest_import_start ?? null;
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
