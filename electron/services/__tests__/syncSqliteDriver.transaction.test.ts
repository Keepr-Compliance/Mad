/**
 * @jest-environment node
 *
 * BACKLOG-2368 — `TestDb.transaction()` is a REAL transaction, not a passthrough.
 *
 * WHY THIS FILE EXISTS. `syncSqliteDriver` grew a `transaction()` method so that
 * suites can drive production code which calls `ensureDb().transaction(fn)()` —
 * `transactionContactDbService.batchUpdateContactAssignments` is the current
 * caller. The obvious wrong implementation is `return () => fn();`: it satisfies
 * every caller's SHAPE, runs every statement, and makes every consuming suite
 * pass. It just silently stops being atomic.
 *
 * That mutant was run against all 15 consuming suites and both BACKLOG-2368
 * suites — 194 tests, all green. Nothing in the tree could tell a real
 * transaction from a passthrough. A helper documented as atomic, with no test
 * that fails when it isn't, is a claim rather than a property.
 *
 * COMMIT-ON-RETURN alone is not enough: a passthrough satisfies it too, because
 * the writes land either way. ROLLBACK-ON-THROW is the case that separates them,
 * so both are asserted here — the pair is the control.
 *
 * BOTH ENGINES. `openTestDb` prefers `better-sqlite3` and falls back to
 * `node:sqlite` (see its header). This file is engine-agnostic by construction
 * and therefore runs on whichever is present: `better-sqlite3` in CI and under
 * `ELECTRON_RUN_AS_NODE`, `node:sqlite` under plain node on a dev machine whose
 * binary is an Electron build. The resolved engine is asserted to be one of the
 * two so a silent third path could not appear unnoticed.
 */

import { openTestDb, currentEngine, type TestDb } from "./helpers/syncSqliteDriver";

let db: TestDb;

beforeEach(() => {
  db = openTestDb();
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
});

afterEach(() => {
  db.close();
});

/** Every value currently in the table, sorted — exact set, never a count. */
function values(): string[] {
  return (db.prepare("SELECT v FROM t ORDER BY v").all() as Array<{ v: string }>).map(
    (r) => r.v,
  );
}

it("runs on a known engine", () => {
  expect(["better-sqlite3", "node:sqlite"]).toContain(currentEngine());
});

it("COMMITS on return", () => {
  db.transaction(() => {
    db.prepare("INSERT INTO t (v) VALUES (?)").run("a");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("b");
  })();

  expect(values()).toEqual(["a", "b"]);
});

it("returns the callback's value", () => {
  expect(db.transaction(() => 42)()).toBe(42);
});

it("ROLLS BACK on throw — the case a passthrough shim cannot satisfy", () => {
  db.prepare("INSERT INTO t (v) VALUES (?)").run("pre");

  expect(() =>
    db.transaction(() => {
      db.prepare("INSERT INTO t (v) VALUES (?)").run("doomed-1");
      db.prepare("INSERT INTO t (v) VALUES (?)").run("doomed-2");
      throw new Error("boom");
    })(),
  ).toThrow("boom");

  // Under `transaction: (fn) => () => fn()` both doomed rows survive and this
  // reads ["doomed-1", "doomed-2", "pre"].
  expect(values()).toEqual(["pre"]);
});

it("the handle is still usable after a rolled-back transaction", () => {
  expect(() =>
    db.transaction(() => {
      throw new Error("boom");
    })(),
  ).toThrow("boom");

  // A ROLLBACK that left the connection inside an open transaction would make
  // the next write fail, so this pins the unwind as well as the undo.
  db.prepare("INSERT INTO t (v) VALUES (?)").run("after");
  expect(values()).toEqual(["after"]);
});
