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

/**
 * ===========================================================================
 * NESTING (BACKLOG-2496)
 * ===========================================================================
 * Every contact write became atomic, and that makes callers nest: an edit is
 * wrapped so it is all-or-nothing, and the `syncContactEmails` /
 * `syncContactPhones` inside it are each atomic in themselves so they are also
 * safe called directly. Production supports this — better-sqlite3's native
 * `db.transaction()` escalates a nested call to a SAVEPOINT.
 *
 * This helper did not, and said so ("NOT nestable ... No caller nests"). Had it
 * stayed that way, every nested-transaction suite would have failed on
 * "cannot start a transaction within a transaction" — a failure about the
 * HELPER, in a test whose subject is the app.
 *
 * The measurement that chose SAVEPOINT over BEGIN, run on both engines:
 *
 *   nested BEGIN      better-sqlite3 throws "cannot start a transaction within
 *                     a transaction"; node:sqlite throws the same
 *   nested SAVEPOINT  better-sqlite3 commits ["ci","co"], inner throw leaves [];
 *                     node:sqlite IDENTICAL
 */
describe("nesting", () => {
  it("COMMITS both levels when the outer returns", () => {
    db.transaction(() => {
      db.prepare("INSERT INTO t (v) VALUES (?)").run("outer");
      db.transaction(() => {
        db.prepare("INSERT INTO t (v) VALUES (?)").run("inner");
      })();
    })();

    expect(values()).toEqual(["inner", "outer"]);
  });

  it("a throw in the INNER rolls back the OUTER's writes too", () => {
    db.prepare("INSERT INTO t (v) VALUES (?)").run("pre");

    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t (v) VALUES (?)").run("outer-doomed");
        db.transaction(() => {
          db.prepare("INSERT INTO t (v) VALUES (?)").run("inner-doomed");
          throw new Error("boom");
        })();
      })(),
    ).toThrow("boom");

    // THE CASE THAT MATTERS. An implementation that opened a real savepoint but
    // let the outer commit anyway would leave ["outer-doomed", "pre"] — a
    // half-written edit, which is the exact state this sweep exists to remove.
    expect(values()).toEqual(["pre"]);
  });

  it("an inner rollback the outer CATCHES leaves the outer's own writes intact", () => {
    let innerError: Error | null = null;

    db.transaction(() => {
      db.prepare("INSERT INTO t (v) VALUES (?)").run("kept");
      try {
        db.transaction(() => {
          db.prepare("INSERT INTO t (v) VALUES (?)").run("discarded");
          throw new Error("inner-only");
        })();
      } catch (error) {
        // Deliberately swallowed: the outer decides to carry on.
        innerError = error as Error;
      }
      db.prepare("INSERT INTO t (v) VALUES (?)").run("also-kept");
    })();

    /**
     * ASSERTED FIRST, AND THE REASON THIS TEST EXISTS IN THIS SHAPE.
     *
     * The row assertion below CANNOT distinguish nesting from no nesting, and
     * was caught doing exactly that: run against the old non-nesting helper it
     * still passed, because `db.exec("BEGIN")` sat OUTSIDE that implementation's
     * try block. The nested BEGIN threw before "discarded" was ever inserted and
     * before any ROLLBACK ran, so the outer transaction survived untouched and
     * the table read ["also-kept", "kept"] either way — the right answer for the
     * wrong reason.
     *
     * WHICH ERROR ARRIVED is what separates them. Under a working savepoint the
     * inner runs its INSERT and fails on its OWN error; under a broken one the
     * caller gets SQLite complaining about the BEGIN, which is a different fact
     * about a different failure.
     */
    expect(innerError).not.toBeNull();
    expect((innerError as unknown as Error).message).toBe("inner-only");

    // And this is what a SAVEPOINT buys over an all-or-nothing outer BEGIN:
    // the outer's writes are still there on either side of the failed inner.
    expect(values()).toEqual(["also-kept", "kept"]);
  });

  it("the handle is usable, and depth is unwound, after a nested rollback", () => {
    expect(() =>
      db.transaction(() => {
        db.transaction(() => {
          throw new Error("boom");
        })();
      })(),
    ).toThrow("boom");

    // A leaked savepoint or an un-decremented depth would make the NEXT
    // top-level transaction open a SAVEPOINT with no enclosing BEGIN, and its
    // writes would never commit. So this asserts the counter, not just the row.
    db.transaction(() => {
      db.prepare("INSERT INTO t (v) VALUES (?)").run("after");
    })();
    expect(values()).toEqual(["after"]);
  });

  it("survives three levels", () => {
    db.transaction(() => {
      db.prepare("INSERT INTO t (v) VALUES (?)").run("L1");
      db.transaction(() => {
        db.prepare("INSERT INTO t (v) VALUES (?)").run("L2");
        db.transaction(() => {
          db.prepare("INSERT INTO t (v) VALUES (?)").run("L3");
        })();
      })();
    })();

    expect(values()).toEqual(["L1", "L2", "L3"]);
  });
});
