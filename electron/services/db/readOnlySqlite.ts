/**
 * The ONE place this codebase opens a `node-sqlite3` database.
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `new sqlite3.Database(path, mode)` — no third argument — does NOT throw when
 * the file is missing or unreadable. It reports the failure by **emitting an
 * `error` event on the handle**, and an `error` event on an EventEmitter with no
 * listener is an uncaught exception. In the Electron main process that is not a
 * failed query, it is a **dead app**.
 *
 * Wrapping the queries in `try`/`catch` does not help: the open fails before any
 * query callback runs, so the `catch` never executes. Verified against the real
 * driver on Node 22 — a missing path, a `chmod 000` file, and a file inside a
 * `chmod 000` directory each took the process down with `SQLITE_CANTOPEN` while
 * every query call sat inside `try`/`catch`.
 *
 * This shape reached SEVEN call sites (BACKLOG-2392 fixed the first, 2403 the
 * other six) because it is four lines that look obviously fine. It is shared
 * here rather than repeated so there is exactly one copy to get right, and an
 * ESLint rule (`no-restricted-syntax` in `eslint.config.js`) fails the build if
 * a bare construction reappears anywhere else.
 *
 * ─── WHY IT MATTERS MOST FOR THE MESSAGES DATABASE ───────────────────────────
 *
 * `~/Library/Messages/chat.db` sits behind Full Disk Access, which users grant
 * *after* first launch. "The file is unreadable" is therefore a normal step in
 * onboarding, not an edge case: open a conversation before granting access,
 * after revoking it, or on a Mac that has never used Messages, and the old shape
 * quit Keepr with no dialog and no log line. From the user's side the app
 * randomly crashes on messages.
 *
 * ─── TWO GUARDS, BOTH LOAD-BEARING ───────────────────────────────────────────
 *
 * 1. The open callback turns a failed open into a rejected promise the caller
 *    can catch and surface.
 * 2. The `error` listener **stays attached for the life of the handle**. Before
 *    the promise settles it is the backstop for failures the driver routes to
 *    the event instead of the callback. Afterwards it must NOT be removed: a
 *    post-open `error` event on a listener-less handle is the same uncaught
 *    exception, so it stays on as a logger. Removing it "because we already
 *    settled" reintroduces the crash for late failures.
 *
 * The `settled` flag is what keeps those two paths from double-settling.
 */

import sqlite3 from "sqlite3";
import { promisify } from "util";
import logService from "../logService";

const LOG_CONTEXT = "ReadOnlySqlite";

/**
 * The read-only surface callers get. Deliberately small: `all`, `get`, `close`.
 * Anything wanting more should extend this rather than open its own handle.
 */
export interface ReadOnlySqliteHandle {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  /** Run a query and return every row. */
  all<T = any>(sql: string, params?: unknown): Promise<T[]>;
  /** Run a query and return the first row, or `undefined` if there is none. */
  get<T = any>(sql: string, params?: unknown): Promise<T | undefined>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  /** Release the handle. */
  close(): Promise<void>;
}

/**
 * Open a SQLite database read-only, in place.
 *
 * REJECTS — never throws synchronously, never crashes the process — when the
 * file is missing, unreadable, permission-denied, or not a database. The caller
 * is responsible for turning that rejection into something the user can see.
 *
 * The database is opened AT ITS REAL PATH and never copied. These stores are
 * often in WAL mode with another process holding the writer, so recent changes
 * live in the sibling `-wal` file; copying the main file elsewhere and reading
 * the copy returns stale contents **with no error at all**.
 *
 * @param dbPath Absolute path to the database file.
 * @param context Log context for post-open driver errors (e.g. "MessagesImport").
 */
export function openSqliteReadOnly(
  dbPath: string,
  context: string = LOG_CONTEXT,
): Promise<ReadOnlySqliteHandle> {
  return new Promise((resolve, reject) => {
    let settled = false;

    // The ONLY sanctioned construction in the codebase. Three arguments: the
    // callback is what makes a failed open a rejection instead of a crash.
    // eslint-disable-next-line no-restricted-syntax
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (settled) return;
      settled = true;

      if (err) {
        reject(err);
        return;
      }

      resolve({
        all: promisify(db.all.bind(db)) as ReadOnlySqliteHandle["all"],
        get: promisify(db.get.bind(db)) as ReadOnlySqliteHandle["get"],
        close: promisify(db.close.bind(db)) as ReadOnlySqliteHandle["close"],
      });
    });

    db.on("error", (err: Error) => {
      if (settled) {
        // Post-open driver error. This listener exists so the event has somewhere
        // to go — without it Node turns it into an uncaught exception. Log rather
        // than swallow so a late failure is at least diagnosable.
        logService.error(
          `SQLite error after open: ${err.message}`,
          context,
          { error: err },
        );
        return;
      }
      settled = true;
      reject(err);
    });
  });
}
