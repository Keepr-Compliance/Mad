/**
 * BACKLOG-3892 W1 — the Mac Messages end-of-sync marker.
 *
 * The end-of-period check (founder 976520e8 / f240c29a) needs to know when each text
 * source was last read up to. Google Messages and iPhone record it; the Mac import did
 * not (message_import_state.last_import_at is written by the deal trigger only). A
 * COMPLETED Mac import (result.success: a cancelled run reports success:false) records
 * when it started as the Mac source's last_sync_at.
 *
 * covered_since is passed as NULL, which leaves it unchanged (SOURCE_COVERAGE_UPSERT_SQL),
 * so the Mac start rule (deepest_import_start, else the oldest Mac text) is untouched.
 * Never throws: a marker that cannot be written must not fail the import it follows.
 */
import { dbAll, dbRun } from "./db/core/dbConnection";
import { SOURCE_COVERAGE_ROWS_SQL, SOURCE_COVERAGE_UPSERT_SQL } from "./db/auditCoverageSql";
import logService from "./logService";

export function recordMacImportRun(userId: string, startedAtMs: number): void {
  try {
    if (!Number.isFinite(startedAtMs)) return;
    dbRun(SOURCE_COVERAGE_UPSERT_SQL, [userId, "mac", null, new Date(startedAtMs).toISOString()]);
  } catch (error) {
    logService.warn("[BACKLOG-3892] Mac import marker not written (non-fatal)", "MacImportMarker", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * BACKLOG-4066 — the Mac source's last_sync_at (the marker written above), or null
 * when it was never written. Reads the same rows the coverage notice reads
 * (SOURCE_COVERAGE_ROWS_SQL), so the trigger and the notice see one value.
 * Never throws: an unreadable marker reads as "unknown" (null), which runs no import.
 */
export function readMacLastImportISO(userId: string): string | null {
  try {
    const rows = dbAll<{ source: string; lastSyncAt: string | null }>(SOURCE_COVERAGE_ROWS_SQL, [userId]);
    return rows.find((r) => r.source === "mac")?.lastSyncAt ?? null;
  } catch (error) {
    logService.warn("[BACKLOG-4066] Mac import marker not readable (non-fatal)", "MacImportMarker", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
