/**
 * Open a real, synchronous, in-memory SQLite database for a test — on whichever
 * engine this machine actually has (BACKLOG-2427).
 *
 * ===========================================================================
 * WHY THIS IS NOT JUST `require("better-sqlite3-multiple-ciphers")`
 * ===========================================================================
 * Neither engine is available everywhere, and the gap is in opposite directions:
 *
 *   CI (Node 20)          better-sqlite3 works. `node:sqlite` DOES NOT EXIST —
 *                         it landed in Node 22.5, and the runner is pinned to
 *                         20.x ("No such built-in module: node:sqlite").
 *
 *   Dev machine (Node 22) `node:sqlite` works. better-sqlite3 CANNOT LOAD — the
 *                         binary in `node_modules` is an ELECTRON build
 *                         (NODE_MODULE_VERSION 139) and plain node is 127. It
 *                         is shared by 50+ worktrees, so rebuilding it to suit
 *                         one test run is not an option.
 *
 * A suite written against either engine alone is therefore red somewhere, for
 * reasons that have nothing to do with the code under test. Preferring the real
 * driver and falling back gives the strictly better outcome: **CI exercises the
 * production driver**, and the same assertions remain executable while writing
 * them.
 *
 * That ordering is deliberate and is the answer to "was this only ever verified
 * on a sibling engine?" — no. `node:sqlite` is the fallback, never the thing CI
 * signs off on.
 *
 * ===========================================================================
 * WHY THE JEST MOCK HAS TO BE BYPASSED
 * ===========================================================================
 * `jest.config.js` maps `^better-sqlite3-multiple-ciphers$` to a stub so that
 * suites which merely import the db layer do not need a native binary. A test
 * that wants the REAL engine must therefore resolve it by PATH, which is what
 * the existing identity suites do and what this does.
 *
 * The two APIs are compatible over the surface used here — `prepare().run/get/all`,
 * `exec`, `close`, `@named` parameters, `json_each`, window functions — which is
 * why one helper can serve both. `run()` is normalised because `node:sqlite` may
 * return `BigInt` where better-sqlite3 returns `number`.
 */

import path from "path";

/** The slice of a synchronous SQLite handle these suites use. */
export interface TestDb {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
  close(): void;
  /**
   * `better-sqlite3`'s `db.transaction(fn)` shape: wraps `fn` and returns a
   * CALLABLE that runs it inside a real SQLite transaction (BACKLOG-2368).
   *
   * Needed because production code reached through `ensureDb()` uses it —
   * `transactionContactDbService.batchUpdateContactAssignments` is
   * `const op = db.transaction(() => {...}); op();`. A suite whose handle lacks
   * it dies on "db.transaction is not a function" before asserting anything.
   *
   * Implemented with BEGIN / COMMIT / ROLLBACK rather than delegating to
   * better-sqlite3's native method, because `node:sqlite` — the fallback engine
   * this helper exists to support — has no equivalent. Both engines run the
   * same statements, so this is a REAL transaction on either, not a shim that
   * merely calls the function: a throw inside `fn` rolls the writes back, which
   * is the property the production path depends on.
   *
   * That property is pinned by `../syncSqliteDriver.transaction.test.ts`, which
   * exists because NO CONSUMING SUITE CAN TELL THE DIFFERENCE. Downgrading this
   * to `return () => fn();` leaves all 15 consumers green — atomicity is not
   * observable from any of them, so the guarantee needs its own test or it is
   * only a comment.
   *
   * NOT nestable. better-sqlite3's native version escalates a nested call to a
   * SAVEPOINT; this does not, and SQLite rejects a nested BEGIN. No caller nests.
   */
  transaction<T>(fn: () => T): () => T;
}

export type SqliteEngine = "better-sqlite3" | "node:sqlite";

let resolvedEngine: SqliteEngine | null = null;

/** Which engine the last `openTestDb()` used. For a suite that wants to say so. */
export function currentEngine(): SqliteEngine | null {
  return resolvedEngine;
}

/** Normalise `run()` so `changes` is a number on both engines. */
function wrap(db: {
  prepare(sql: string): {
    run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
  };
  exec(sql: string): void;
  close(): void;
}): TestDb {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]) => {
          const r = stmt.run(...params);
          return {
            changes: Number(r.changes),
            lastInsertRowid: Number(r.lastInsertRowid),
          };
        },
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params),
      };
    },
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
    transaction<T>(fn: () => T): () => T {
      return () => {
        db.exec("BEGIN");
        try {
          const result = fn();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          // Best-effort unwind: if the failure already aborted the transaction
          // the ROLLBACK itself throws, and re-throwing THAT would mask the
          // real error the caller needs to see.
          try {
            db.exec("ROLLBACK");
          } catch {
            /* transaction already unwound */
          }
          throw error;
        }
      };
    },
  };
}

/**
 * A fresh database on the best available engine — `:memory:` by default.
 *
 * Foreign keys are ON, matching production and both sibling identity suites.
 *
 * `file` exists for the ONE property an in-memory handle cannot demonstrate:
 * that a write is still there after the process that made it is gone
 * (BACKLOG-2528). A `:memory:` database dies with its handle, so "the rename
 * survived a restart" asserted against one is not an assertion at all — it
 * cannot fail for the reason it claims to test. Pass a path under `os.tmpdir()`,
 * close the handle, reopen the same path, and the read genuinely comes off
 * disk. Every other caller keeps the default and is unaffected.
 */
export function openTestDb(file: string = ":memory:"): TestDb {
  // 1. The REAL production driver, resolved by path to defeat the jest mock.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RealDatabase = require(
      path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
    ) as new (file: string) => never;
    const db = new RealDatabase(file) as unknown as Parameters<typeof wrap>[0];
    resolvedEngine = "better-sqlite3";
    const wrapped = wrap(db);
    wrapped.exec("PRAGMA foreign_keys = ON");
    return wrapped;
  } catch {
    // ABI mismatch (Electron build under plain node), or not installed.
  }

  // 2. Node's own SQLite. Same engine family, no binary to build.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  // `file`, not `":memory:"`. Hard-coding it here while the branch above
  // honoured the argument made `openTestDb(path)` silently engine-dependent:
  // the same call persisted on better-sqlite3 and evaporated on node:sqlite, so
  // a close/reopen test reopened an EMPTY database and died on
  // "no such table: contacts" — under the fallback engine only. Caught by the
  // pre-push hook, which runs plain node.
  const db = new DatabaseSync(file) as unknown as Parameters<typeof wrap>[0];
  resolvedEngine = "node:sqlite";
  const wrapped = wrap(db);
  wrapped.exec("PRAGMA foreign_keys = ON");
  return wrapped;
}
