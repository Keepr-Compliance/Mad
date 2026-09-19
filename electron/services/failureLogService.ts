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
import {
  ACKNOWLEDGE_ALL_SQL,
  CLEAR_FAILURE_LOG_SQL,
  CREATE_FAILURE_LOG_TABLE_SQL,
  FAILURES_SINCE_SQL,
  FAILURE_LOG_COUNT_SQL,
  INSERT_FAILURE_LOG_SQL,
  PRUNE_BY_AGE_SQL,
  PRUNE_BY_CAP_SQL,
  RECENT_FAILURES_SQL,
  UNACKNOWLEDGED_COUNT_SQL,
} from "./db/failureLogSql";
import logService from "./logService";
// BACKLOG-2393: a no-op unless a user has granted a support window. Imported
// from the weightless trace seam rather than the support-access bundle, because
// the bundle's diagnostics collector reads this very table.
import { notifySupportError } from "./supportAccess/trace";

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
        INSERT_FAILURE_LOG_SQL,
        [operation, error, metadataJson]
      );
      await logService.debug(
        `[FailureLog] Logged failure: ${operation}`,
        "FailureLogService",
        { error: error.substring(0, 100) }
      );
      // BACKLOG-2393: capture a report near the failure rather than waiting for
      // the next scheduled hour, when the state that explains it may be gone.
      // Debounced to once per 5 minutes downstream, so a crash loop does not
      // become a fire hose, and inert outside a granted window.
      notifySupportError();
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
        INSERT_FAILURE_LOG_SQL,
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
      RECENT_FAILURES_SQL,
      [limit]
    );
  }

  /**
   * Get all failures since a given timestamp.
   * @param timestamp - ISO 8601 date string
   */
  async getFailuresSince(timestamp: string): Promise<FailureLogEntry[]> {
    return dbAll<FailureLogEntry>(
      FAILURES_SINCE_SQL,
      [timestamp]
    );
  }

  /**
   * Get count of unacknowledged failures.
   */
  async getFailureCount(): Promise<number> {
    const row = dbGet<{ count: number }>(
      UNACKNOWLEDGED_COUNT_SQL
    );
    return row?.count ?? 0;
  }

  /**
   * Mark all failures as acknowledged.
   */
  async acknowledgeAll(): Promise<void> {
    dbRun(ACKNOWLEDGE_ALL_SQL);
  }

  /**
   * Clear the entire failure log.
   */
  async clearLog(): Promise<void> {
    dbRun(CLEAR_FAILURE_LOG_SQL);
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
        PRUNE_BY_AGE_SQL,
        [`-${MAX_AGE_DAYS} days`]
      );

      // 2. Cap at MAX_ENTRIES (keep newest)
      const countRow = dbGet<{ count: number }>(
        FAILURE_LOG_COUNT_SQL
      );
      const totalCount = countRow?.count ?? 0;

      let capDeleted = 0;
      if (totalCount > MAX_ENTRIES) {
        const excess = totalCount - MAX_ENTRIES;
        const result = dbRun(
          PRUNE_BY_CAP_SQL,
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
      dbExec(CREATE_FAILURE_LOG_TABLE_SQL);
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
