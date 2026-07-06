/**
 * Failure Log Service
 * TASK-2058: Persists network operation failures locally in SQLite
 * for offline diagnostics.
 *
 * Provides:
 * - logFailure(): Record a network operation failure
 * - getRecentFailures(): Query recent failure entries
 * - getFailuresSince(): Query failures after a timestamp
 * - getFailureCount(): Count unacknowledged failures
 * - acknowledgeAll(): Mark all failures as acknowledged
 * - clearLog(): Remove all failure entries
 * - pruneOldEntries(): Retention policy enforcement
 */

import { dbRun, dbAll, dbGet, dbExec } from "./db/core/dbConnection";
import logService from "./logService";

/** Shape of a failure log entry as stored in SQLite */
export interface FailureLogEntry {
  id: number;
  timestamp: string;
  operation: string;
  error_message: string;
  metadata: string | null;
  acknowledged: number;
}

/** Maximum entries before pruning oldest */
const MAX_ENTRIES = 500;
/** Maximum age in days before pruning */
const MAX_AGE_DAYS = 30;

class FailureLogService {
  /**
   * Log a network operation failure.
   * @param operation - Snake_case identifier (e.g. 'outlook_contacts_sync')
   * @param error - Error message string
   * @param metadata - Optional JSON-serializable context
   */
  async logFailure(
    operation: string,
    error: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      const metadataJson = metadata ? JSON.stringify(metadata) : null;
      dbRun(
        `INSERT INTO failure_log (operation, error_message, metadata) VALUES (?, ?, ?)`,
        [operation, error, metadataJson]
      );
      await logService.debug(
        `[FailureLog] Logged failure: ${operation}`,
        "FailureLogService",
        { error: error.substring(0, 100) }
      );
    } catch (err) {
      // Failure logging must never crash the app
      await logService.warn(
        "[FailureLog] Failed to log failure entry",
        "FailureLogService",
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  /**
   * BACKLOG-1831: log a generic (non-failure) diagnostic event into the same
   * failure_log table, so experiments can accumulate durable rows across days
   * with ZERO new schema. The row's counts live in `metadata` (JSON); the NOT
   * NULL `error_message` column carries a fixed non-error marker. Subject to the
   * table's retention policy (MAX_ENTRIES=500 rows / MAX_AGE_DAYS=30) — fine for
   * a bounded experiment. Never throws (mirrors logFailure).
   *
   * @param operation - Snake_case event identifier (e.g. 'email_cache_hitmiss')
   * @param metadata - JSON-serializable event payload (the counts)
   */
  async logEvent(
    operation: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      const metadataJson = metadata ? JSON.stringify(metadata) : null;
      dbRun(
        `INSERT INTO failure_log (operation, error_message, metadata) VALUES (?, ?, ?)`,
        [operation, "(event)", metadataJson]
      );
      await logService.debug(
        `[FailureLog] Logged event: ${operation}`,
        "FailureLogService"
      );
    } catch (err) {
      // Event logging must never crash the app
      await logService.warn(
        "[FailureLog] Failed to log event entry",
        "FailureLogService",
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  /**
   * Get recent failure log entries, newest first.
   * @param limit - Max entries to return (default 50)
   */
  async getRecentFailures(limit: number = 50): Promise<FailureLogEntry[]> {
    return dbAll<FailureLogEntry>(
      `SELECT * FROM failure_log ORDER BY timestamp DESC LIMIT ?`,
      [limit]
    );
  }

  /**
   * Get all failures since a given timestamp.
   * @param timestamp - ISO 8601 date string
   */
  async getFailuresSince(timestamp: string): Promise<FailureLogEntry[]> {
    return dbAll<FailureLogEntry>(
      `SELECT * FROM failure_log WHERE timestamp >= ? ORDER BY timestamp DESC`,
      [timestamp]
    );
  }

  /**
   * Get count of unacknowledged failures.
   */
  async getFailureCount(): Promise<number> {
    const row = dbGet<{ count: number }>(
      `SELECT COUNT(*) as count FROM failure_log WHERE acknowledged = 0`
    );
    return row?.count ?? 0;
  }

  /**
   * Mark all failures as acknowledged.
   */
  async acknowledgeAll(): Promise<void> {
    dbRun(`UPDATE failure_log SET acknowledged = 1 WHERE acknowledged = 0`);
  }

  /**
   * Clear the entire failure log.
   */
  async clearLog(): Promise<void> {
    dbRun(`DELETE FROM failure_log`);
    await logService.info("[FailureLog] Log cleared", "FailureLogService");
  }

  /**
   * Prune old entries based on retention policy:
   * - Remove entries older than MAX_AGE_DAYS
   * - Keep at most MAX_ENTRIES (remove oldest first)
   *
   * Called on service initialization.
   */
  async pruneOldEntries(): Promise<void> {
    try {
      // 1. Delete entries older than 30 days
      const ageResult = dbRun(
        `DELETE FROM failure_log WHERE timestamp < datetime('now', ?)`,
        [`-${MAX_AGE_DAYS} days`]
      );

      // 2. Cap at MAX_ENTRIES (keep newest)
      const countRow = dbGet<{ count: number }>(
        `SELECT COUNT(*) as count FROM failure_log`
      );
      const totalCount = countRow?.count ?? 0;

      let capDeleted = 0;
      if (totalCount > MAX_ENTRIES) {
        const excess = totalCount - MAX_ENTRIES;
        const result = dbRun(
          `DELETE FROM failure_log WHERE id IN (
            SELECT id FROM failure_log ORDER BY timestamp ASC LIMIT ?
          )`,
          [excess]
        );
        capDeleted = result.changes;
      }

      const totalPruned = ageResult.changes + capDeleted;
      if (totalPruned > 0) {
        await logService.info(
          `[FailureLog] Pruned ${totalPruned} entries (${ageResult.changes} by age, ${capDeleted} by cap)`,
          "FailureLogService"
        );
      }
    } catch (err) {
      await logService.warn(
        "[FailureLog] Pruning failed",
        "FailureLogService",
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  /**
   * Initialize: create table if not exists and run pruning.
   * Called during app startup after DB is initialized.
   */
  async initialize(): Promise<void> {
    try {
      // The table is created by the migration, but we ensure it exists
      // for safety (e.g., if migration hasn't run yet on this version)
      dbExec(`
        CREATE TABLE IF NOT EXISTS failure_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          operation TEXT NOT NULL,
          error_message TEXT NOT NULL,
          metadata TEXT,
          acknowledged INTEGER NOT NULL DEFAULT 0
        )
      `);
      await this.pruneOldEntries();
      await logService.debug(
        "[FailureLog] Service initialized",
        "FailureLogService"
      );
    } catch (err) {
      await logService.warn(
        "[FailureLog] Initialization failed (non-critical)",
        "FailureLogService",
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  }
}

// Export singleton
const failureLogService = new FailureLogService();
export default failureLogService;
