/**
 * BACKLOG-3952 — wait for a database that is open but not writable yet.
 *
 * Some security software holds a newly updated app for about a minute after
 * install. During that time SQLite opens mad.db read-only without saying so,
 * and the first write at startup fails with SQLITE_READONLY. Copying a backup
 * over the file cannot fix that. Waiting can.
 *
 * Three facts from the real driver shape this module:
 *  - A handle that opened read-only stays read-only after the file becomes
 *    writable again. Every attempt therefore needs a NEW handle.
 *  - `BEGIN IMMEDIATE` succeeds on a read-only file. Only a real page write
 *    proves the handle can write, so the probe rewrites `user_version` with
 *    its current value inside a transaction and rolls back.
 *  - The error is identified by `err.code`, never by message text.
 *
 * HOW THE LIMITS RELATE (keep them in this order):
 *
 *   DB_WRITE_RETRY_BUDGET_MS (90 s)
 *     < DB_WAIT_DEPENDENT_TIMEOUT_MS (120 s = budget + 30 s)
 *
 * The budget is longer than the ~60 s hold observed in the field. Everything
 * that waits for the database during startup must wait at least
 * DB_WAIT_DEPENDENT_TIMEOUT_MS, so it is still waiting when the retry loop
 * finishes. The extra 30 s is the database-ready wait this app used before
 * BACKLOG-3952 (it covered opening plus migrations), so the time left for
 * the rest of startup is unchanged. The waits that use it:
 *   - initializationBroadcaster.DEFAULT_DB_READY_TIMEOUT_MS (imports it)
 *   - systemHandlers.ts, the two "initialization already in progress" waits (import it)
 *   - LoadingOrchestrator.tsx DB_WAITING_MAX_WAIT_MS (renderer; cannot import
 *     from electron/, so it repeats the number and names this constant). It
 *     applies only while the stage is "db-waiting"; the normal 10 s bound
 *     (MAX_WAIT_MS) is unchanged.
 */

import type { Database as DatabaseType } from "better-sqlite3";

/** Total time the startup loop keeps retrying before it asks the user. */
export const DB_WRITE_RETRY_BUDGET_MS = 90_000;

/** Delays between attempts. The last entry repeats until the budget runs out. */
export const DB_WRITE_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 5_000];

/** Hard cap on attempts per round, independent of the clock. */
export const DB_WRITE_MAX_ATTEMPTS = 40;

/** Lower bound for anything that waits on database startup. See header. */
export const DB_WAIT_DEPENDENT_TIMEOUT_MS = DB_WRITE_RETRY_BUDGET_MS + 30_000;

/**
 * busy_timeout used while an attempt is opening and probing. better-sqlite3 is
 * synchronous, so a lock wait blocks the main process for its whole length.
 * Kept short so the window stays responsive during the wait; the normal 5 s
 * value is restored on the handle that succeeds.
 */
export const DB_PROBE_BUSY_TIMEOUT_MS = 250;

/** The busy_timeout the app runs with once the database is open. */
export const DB_NORMAL_BUSY_TIMEOUT_MS = 5_000;

/**
 * True for errors that mean "the database is there but cannot be written right
 * now". READONLY covers every extended code (READONLY_DIRECTORY, _RECOVERY,
 * _CANTLOCK, _ROLLBACK, _DBMOVED, _CANTINIT). IOERR, CANTOPEN, CORRUPT and FULL
 * are real failures and are deliberately NOT retried.
 */
export function isRetryableDbWriteError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  return code.startsWith("SQLITE_READONLY") || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

/** The `code` of an error for telemetry, or "none". */
export function dbErrorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "none";
}

/**
 * Throws the driver's own error when the handle cannot write a page.
 * Nothing is committed: the header write is rolled back.
 *
 * Uses prepare()/pragma(), not exec(), on purpose.
 */
export function probeWritable(db: DatabaseType): void {
  const raw = db.pragma("user_version", { simple: true }) as unknown;
  const current = typeof raw === "number" && Number.isInteger(raw) ? raw : 0;
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    db.pragma(`user_version = ${current}`);
  } finally {
    try {
      db.prepare("ROLLBACK").run();
    } catch {
      /* the write error is the one that matters */
    }
  }
}

/** Sets the handle's busy_timeout. The SQL text lives here (SQL boundary rule). */
export function setBusyTimeout(db: DatabaseType, ms: number): void {
  db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(ms))}`);
}

/** Delay before attempt `attempt + 1` (attempt is 1-based). */
export function retryDelayMs(attempt: number): number {
  const i = Math.min(attempt - 1, DB_WRITE_RETRY_DELAYS_MS.length - 1);
  return DB_WRITE_RETRY_DELAYS_MS[Math.max(0, i)];
}

/** Async wait. Never a synchronous sleep: the main process must keep running. */
export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
