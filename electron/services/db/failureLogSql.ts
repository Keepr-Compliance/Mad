/**
 * SQL for the `failure_log` table — BACKLOG-3044.
 *
 * Moved out of `electron/services/failureLogService.ts` (11 sites), which authored
 * every one of these statements outside the layer and handed the text to the
 * `dbRun`/`dbAll`/`dbGet`/`dbExec` conduit as a plain string. The conduit's own
 * `.prepare()` is inside `db/`, so `scripts/ci/check-sql-boundary.mjs` classified the
 * execution COMPLIANT and never enumerated the callers at all. That blindness is what
 * BACKLOG-3044 was filed to record; moving the text here is what closes it.
 *
 * The service keeps its own `dbRun(...)` / `dbAll(...)` calls. Only the TEXT moved.
 * That is deliberate rather than incidental: `failureLogService.test.ts` mocks the
 * resolved `db/core/dbConnection` module and asserts on the SQL string the conduit
 * received, so keeping the call at the caller leaves those assertions pointed at the
 * same conduit — the existing suite becomes a behavioural control on this move
 * instead of collateral to be rewritten.
 *
 * ## The indentation inside these templates is load-bearing. Do not tidy it.
 *
 * `PRUNE_BY_CAP_SQL` and `CREATE_FAILURE_LOG_TABLE_SQL` carry the exact leading
 * whitespace they had at their old call sites, several indentation levels deep inside
 * a class method. Re-indenting them to suit their new position at module scope would
 * change the bytes reaching SQLite, and this item's whole claim is that it does not.
 * The move is verified by `scripts/ci/sql-move-identity.mjs`, which hashes the COOKED
 * text of every statement before and after and fails on a single changed space.
 *
 * SQLite does not care about the whitespace. The control does, and the control is the
 * only reason anyone can believe the move was safe.
 */

import { sql } from "./core/sqlText";

/**
 * Append one failure row. Three bound parameters: operation, error message, metadata
 * JSON (nullable).
 *
 * Used by BOTH `logFailure` and `logEvent` — the two spelled out the identical
 * statement at two call sites before this move. `logEvent` (BACKLOG-1831) writes a
 * fixed non-error marker into the NOT NULL `error_message` column, so the row shape is
 * genuinely the same and one constant is correct rather than a convenience.
 */
export const INSERT_FAILURE_LOG_SQL = sql`INSERT INTO failure_log (operation, error_message, metadata) VALUES (?, ?, ?)`;

/** Newest failures first. One bound parameter: the row limit. */
export const RECENT_FAILURES_SQL = sql`SELECT * FROM failure_log ORDER BY timestamp DESC LIMIT ?`;

/** Failures at or after an ISO-8601 instant, newest first. One bound parameter. */
export const FAILURES_SINCE_SQL = sql`SELECT * FROM failure_log WHERE timestamp >= ? ORDER BY timestamp DESC`;

/** How many failures are still unacknowledged. No bound parameters. */
export const UNACKNOWLEDGED_COUNT_SQL = sql`SELECT COUNT(*) as count FROM failure_log WHERE acknowledged = 0`;

/** Acknowledge every outstanding failure. No bound parameters. */
export const ACKNOWLEDGE_ALL_SQL = sql`UPDATE failure_log SET acknowledged = 1 WHERE acknowledged = 0`;

/** Empty the log completely. No bound parameters. */
export const CLEAR_FAILURE_LOG_SQL = sql`DELETE FROM failure_log`;

/**
 * Retention by AGE. One bound parameter: a SQLite modifier string such as
 * `-30 days`, bound rather than spliced — the caller passes the interval as a value.
 */
export const PRUNE_BY_AGE_SQL = sql`DELETE FROM failure_log WHERE timestamp < datetime('now', ?)`;

/** Total rows, for the retention cap check. No bound parameters. */
export const FAILURE_LOG_COUNT_SQL = sql`SELECT COUNT(*) as count FROM failure_log`;

/**
 * Retention by COUNT — delete the oldest `?` rows. One bound parameter: how many rows
 * are over the cap.
 *
 * The interior indentation is the original's. See the note in this file's header.
 */
export const PRUNE_BY_CAP_SQL = sql`DELETE FROM failure_log WHERE id IN (
            SELECT id FROM failure_log ORDER BY timestamp ASC LIMIT ?
          )`;

/**
 * Defensive create, run at startup. The table is created by the migration; this
 * covers the case where a version starts before its migration has run.
 *
 * The interior indentation, the leading newline and the trailing newline-plus-spaces
 * are the original's. See the note in this file's header.
 */
export const CREATE_FAILURE_LOG_TABLE_SQL = sql`
        CREATE TABLE IF NOT EXISTS failure_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          operation TEXT NOT NULL,
          error_message TEXT NOT NULL,
          metadata TEXT,
          acknowledged INTEGER NOT NULL DEFAULT 0
        )
      `;
