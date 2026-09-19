/**
 * @jest-environment node
 *
 * BACKLOG-2960 — database time is measured, and measures the DATABASE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * The `[PRECACHE-TIMING]` line's `elapsedMs` cannot carry the conversion's
 * acceptance bound. Four force re-caches of identical code on the founder's
 * machine spread 40% (pm_comments `ac7a6f40`) because the run is dominated by
 * network fetch, and the promise-conversion changes the data layer instead. The
 * `dbMs` field exists to separate those two, so the bound applies to the part
 * the conversion touches.
 *
 * That makes the claim "this number is database time" load-bearing, and it is a
 * claim a green test can hold vacuously: an accumulator that never advances
 * reports 0, and an accumulator that charges everything reports the wall clock.
 * Both would pass a test that only checked `dbMs >= 0`. So the two controls that
 * matter here are DIFFERENTIAL — plant a delay in a known place and assert the
 * number moves only when the delay is inside the database.
 *
 * ---------------------------------------------------------------------------
 * THE REAL DRIVER, NOT A STAND-IN
 * ---------------------------------------------------------------------------
 * A mock cannot answer whether the instrument survives contact with
 * better-sqlite3: whether statement methods can be shadowed at all, whether a
 * wrapped `transaction()` still returns a callable carrying its variants,
 * whether a rolled-back transaction unwinds the depth. Those are properties of
 * the driver, so the driver is the fixture.
 *
 * Run it with:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron \
 *     node_modules/jest/bin/jest.js \
 *     electron/services/db/core/__tests__/dbTiming.realDriver-2960.test.ts
 *
 * ---------------------------------------------------------------------------
 * TOLERANCES ARE PRE-REGISTERED, NOT FITTED
 * ---------------------------------------------------------------------------
 * Every bound below was written before the suite was first run. They are loose
 * on the "should not move" side (2 ms) and loose on the "should move together"
 * side (15 ms), because a busy-wait on a shared machine overshoots and never
 * undershoots. A tolerance narrowed after seeing a failure would be a fitted
 * number, and is called out in review rather than adjusted.
 */

import * as nodePath from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "node_modules",
    "better-sqlite3-multiple-ciphers",
  ),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import { instrumentDatabaseTiming, readDbTimeMs } from "../dbTiming";

/** Blocks the thread for `ms`. Synchronous on purpose: a DB call cannot await. */
function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* spin */
  }
}

/**
 * Run `fn`, returning how long it took by the wall clock and how much of that
 * the instrument charged to the database. This is the same delta arithmetic
 * `precacheEmails` performs around a run.
 */
function measure(fn: () => void): { wallMs: number; dbMs: number } {
  const dbBefore = readDbTimeMs();
  const wallBefore = performance.now();
  fn();
  return {
    wallMs: performance.now() - wallBefore,
    dbMs: readDbTimeMs() - dbBefore,
  };
}

let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  instrumentDatabaseTiming(db);
  db.exec("CREATE TABLE t (a INTEGER, b TEXT)");
});

afterEach(() => {
  db.close();
});

describe("database time is non-zero and bounded by the span", () => {
  it("charges real work, and charges less than the wall clock of a span that also sleeps outside the database", () => {
    const { wallMs, dbMs } = measure(() => {
      const insert = db.prepare("INSERT INTO t (a, b) VALUES (?, ?)");
      for (let i = 0; i < 500; i++) {
        insert.run(i, `row-${i}`);
      }
      busyWait(60); // outside the database
    });

    expect(dbMs).toBeGreaterThan(0);
    expect(dbMs).toBeLessThan(wallMs);
    // The 60 ms spent outside must be missing from dbMs, so the gap is at least
    // that. Without this the assertion above would pass on an accumulator that
    // charged the whole span minus a rounding error.
    expect(wallMs - dbMs).toBeGreaterThanOrEqual(55);
  });

  it("charges nearly every sub-millisecond statement, where a millisecond-granularity clock charges almost none", () => {
    // THE CONTROL FOR `performance.now()` OVER `Date.now()` (BACKLOG-3166).
    //
    // What separates the two clocks is RESOLUTION, not the total they arrive at.
    // Counting statements each one charges a non-zero amount for is a comparison
    // of two numbers taken on the same machine in the same run, so host speed
    // cancels. The previous form asserted `dbMs >= wallMs * 0.5` — a claim about
    // how much of a span this HOST spends inside SQLite rather than in the JS
    // loop, jest instrumentation and the OS scheduler. It measured 37% on a
    // shared Windows runner and reds every PR into int. On an idle M-series Mac
    // the same loop measures 0.658-0.773 over eight trials: it passes there, but
    // on 1.3-1.5x margin against a threshold that has nothing to do with the
    // code under test.
    //
    // Comparing the two TOTALS does not work either, and the reason is worth
    // recording so it is not reintroduced: a `Date.now()` accumulator charges a
    // full 1 ms for every integer-millisecond boundary landing inside a
    // statement and nothing otherwise. Boundaries arrive once per ms of wall
    // clock and land inside a statement with probability dbMs/wallMs, so the
    // expected `Date.now()` total EQUALS the true total — and when the true
    // total is under 1 ms it overcounts. Measured over five trials, the
    // `performance.now()` total was the greater one once out of five.
    const SAMPLES = 2000;
    const select = db.prepare("SELECT 1 AS one");

    let chargedByInstrument = 0;
    let chargedByMillisecondClock = 0;

    for (let i = 0; i < SAMPLES; i++) {
      const dbBefore = readDbTimeMs();
      const msBefore = Date.now();
      select.get();
      // Read the millisecond clock first, so its bracket is a strict SUPERSET of
      // the span the instrument charges. The stand-in is favoured on purpose:
      // it gets every chance to register a boundary crossing.
      const msAfter = Date.now();
      if (readDbTimeMs() - dbBefore > 0) chargedByInstrument++;
      if (msAfter - msBefore > 0) chargedByMillisecondClock++;
    }

    // Bounds set AFTER a probe, not pre-registered like the rest of this file:
    // measured 2000/2000 and 1-2/2000 over five trials, then given 10x slack on
    // each side. Both are one-sided in the direction a SLOWER host moves them.
    //
    // What this rests on is CLOCK GRANULARITY, not statement speed: a statement
    // registers iff it outlasts one `performance.now()` tick. On the runner that
    // reported the original failure the statements ran 1.79 us (its own 3.5767 ms
    // over 2000) against a 100 ns tick — every figure in that output lands on a
    // 0.0001 ms grid — so roughly 18x. A slower host lengthens the statement and
    // leaves the tick alone, which is why this direction is the safe one.
    expect(chargedByInstrument).toBeGreaterThanOrEqual(SAMPLES * 0.9);

    // Fixture validity, not a second control. It establishes that the statements
    // really are sub-millisecond, which is the precondition for the assertion
    // above to mean anything: on a host slow enough to push a `SELECT 1` past
    // 1 ms, BOTH clocks would charge every statement and the case above would go
    // green under a planted `Date.now()`. Same 1.79 us against the 100 us per
    // statement this bound permits.
    expect(chargedByMillisecondClock).toBeLessThanOrEqual(SAMPLES * 0.1);

    // `expect(dbMs).toBeGreaterThan(0.5)` stood here and was deleted rather than
    // lowered, because it never discriminated: across 20 planted cold runs it
    // returned the same verdict as the ratio in every row, and both were falsely
    // GREEN in 16 of the 20. It was also the same flake in miniature, asserting
    // the host is slower than a threshold — the tightest of 12 unplanted trials
    // came in at 0.5932 ms, a 1.19x margin.
    //
    // Nothing is lost by removing it, which is a weaker statement than the one
    // that stood here before: the count above does NOT entail it. 1800 charges of
    // one 100 ns tick total 0.18 ms, which is under 0.5. The count entails
    // `dbMs > 0`, and it discriminates the two clocks, which `> 0.5` did not.
  });
});

describe("a delay INSIDE the database moves both numbers together", () => {
  it("raises database time by the same amount it raises the wall clock", () => {
    db.function("keepr_busy_wait", (ms: unknown) => {
      busyWait(Number(ms));
      return 1;
    });

    const baseline = measure(() => {
      db.prepare("SELECT 1 AS one").get();
    });
    const delayed = measure(() => {
      db.prepare("SELECT keepr_busy_wait(50) AS x").get();
    });

    const wallRise = delayed.wallMs - baseline.wallMs;
    const dbRise = delayed.dbMs - baseline.dbMs;

    expect(dbRise).toBeGreaterThanOrEqual(45);
    // Both rise, and by the same amount: the delay is inside the measured region.
    expect(Math.abs(wallRise - dbRise)).toBeLessThanOrEqual(15);
  });
});

describe("a delay OUTSIDE the database moves only the wall clock", () => {
  it("leaves database time flat while the wall clock rises", () => {
    // THE CONTROL THAT MATTERS MOST. Separating database time from total elapsed
    // is the entire purpose of the field; an accumulator that charged the whole
    // span would satisfy every other assertion in this file and fail this one.
    // The delay sits BETWEEN two database calls, not after the last one. That
    // placement is the point: an accumulator that charged the gap between calls
    // — "database time" that is really elapsed time — reports the same number as
    // a correct one when the delay trails the final call, and this suite would
    // not notice. Between two calls, it has to charge the gap or not.
    const baseline = measure(() => {
      db.prepare("SELECT 1 AS one").get();
      db.prepare("SELECT 2 AS two").get();
    });
    const delayed = measure(() => {
      db.prepare("SELECT 1 AS one").get();
      busyWait(50);
      db.prepare("SELECT 2 AS two").get();
    });

    expect(delayed.wallMs - baseline.wallMs).toBeGreaterThanOrEqual(45);
    expect(Math.abs(delayed.dbMs - baseline.dbMs)).toBeLessThanOrEqual(2);
  });
});

describe("transactions", () => {
  it("counts a transaction once rather than adding its statements on top", () => {
    db.function("keepr_busy_wait_tx", (ms: unknown) => {
      busyWait(Number(ms));
      return 1;
    });

    // One statement inside a transaction, spending a known 50 ms in the driver.
    // Charging the transaction AND the statement would report ~100 ms.
    const { dbMs } = measure(() => {
      const tx = db.transaction(() => {
        db.prepare("SELECT keepr_busy_wait_tx(50) AS x").get();
      });
      tx();
    });

    expect(dbMs).toBeGreaterThanOrEqual(45);
    expect(dbMs).toBeLessThan(90);
  });

  it("charges the span the transaction is open, not merely its statements", () => {
    // Timing `transaction()` instead of the callable it RETURNS leaves the
    // transaction span unmeasured while the statements inside it are still
    // charged individually — so a test that only sums statement time cannot tell
    // the two apart. What separates them is time inside the body that is not
    // itself a database call: BEGIN/COMMIT, and on the batch-insert path the
    // per-row encryption that runs with the write transaction open.
    const { dbMs } = measure(() => {
      const tx = db.transaction(() => {
        busyWait(50);
        db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(9, "in-tx");
      });
      tx();
    });

    expect(dbMs).toBeGreaterThanOrEqual(45);
  });

  it("returns a callable that still carries better-sqlite3's transaction variants", () => {
    const tx = db.transaction((n: number) => {
      db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(n, "v");
    }) as unknown as Record<string, unknown> & ((n: number) => void);

    expect(typeof tx).toBe("function");
    for (const variant of ["default", "deferred", "immediate", "exclusive"]) {
      expect(typeof tx[variant]).toBe("function");
    }

    tx(1);
    (tx.immediate as (n: number) => void)(2);
    expect(db.prepare("SELECT count(*) AS c FROM t").get()).toEqual({ c: 2 });
  });

  it("charges a rolled-back transaction and leaves the depth unwound", () => {
    expect(() => {
      const tx = db.transaction(() => {
        db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(1, "x");
        throw new Error("rollback");
      });
      tx();
    }).toThrow("rollback");

    expect(db.prepare("SELECT count(*) AS c FROM t").get()).toEqual({ c: 0 });

    // If the throw had stranded the depth counter above zero, every later call
    // would be treated as nested and charge nothing at all.
    const after = measure(() => {
      db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(2, "y");
    });
    expect(after.dbMs).toBeGreaterThan(0);
  });

  it("charges a throwing statement and leaves the depth unwound", () => {
    expect(() => db.prepare("SELECT * FROM does_not_exist").get()).toThrow();

    const after = measure(() => {
      db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(3, "z");
    });
    expect(after.dbMs).toBeGreaterThan(0);
  });
});

describe("installation is safe to repeat and safe on partial handles", () => {
  it("does not stack a second wrapper when the same handle is instrumented twice", () => {
    db.function("keepr_busy_wait_twice", (ms: unknown) => {
      busyWait(Number(ms));
      return 1;
    });

    instrumentDatabaseTiming(db);
    instrumentDatabaseTiming(db);

    const { dbMs } = measure(() => {
      db.prepare("SELECT keepr_busy_wait_twice(50) AS x").get();
    });

    // Double-wrapping would still measure ~50 ms per layer, but the outer layer
    // would be the only one charging (the inner sees depth > 0). The failure
    // this guards is unbounded wrapper growth across repeated setDb() calls, so
    // the observable claim is that the figure stays a single 50 ms.
    expect(dbMs).toBeGreaterThanOrEqual(45);
    expect(dbMs).toBeLessThan(90);
  });

  it("leaves a jest-mocked database still usable as a mock", () => {
    // REGRESSION. The first version of this instrument replaced `exec`,
    // `prepare` and the statement methods with plain closures. Suites that hand
    // `setDb()` a mocked better-sqlite3 then lost the mock surface —
    // `mockStatement.get.mockReturnValue(...)` threw "is not a function", and
    // `expect(mockDb.exec).toHaveBeenCalledWith("VACUUM")` reported "received
    // value must be a mock or spy function". 26 tests in
    // `databaseService.edgeCases.test.ts` went red.
    //
    // An instrument has to be transparent to the thing it measures. Carrying the
    // original's property descriptors — including jest's NON-enumerable
    // `_isMockFunction` — is what makes it so.
    const statement = { get: jest.fn().mockReturnValue({ a: 1 }), run: jest.fn() };
    const mockDb = {
      prepare: jest.fn().mockReturnValue(statement),
      exec: jest.fn(),
    };

    instrumentDatabaseTiming(mockDb);

    mockDb.exec("VACUUM");
    const row = mockDb.prepare("SELECT a FROM t").get();

    expect(row).toEqual({ a: 1 });
    expect(mockDb.exec).toHaveBeenCalledWith("VACUUM");
    expect(mockDb.prepare).toHaveBeenCalledWith("SELECT a FROM t");
    expect(statement.get).toHaveBeenCalledTimes(1);
    // Still configurable after instrumentation.
    expect(() => statement.get.mockReturnValue({ a: 2 })).not.toThrow();
    expect(mockDb.prepare("SELECT a FROM t").get()).toEqual({ a: 2 });
  });

  it("declines to instrument a handle whose methods are synthesised per read", () => {
    // REGRESSION. `transactionEligibilitySql.boundStatus-3103` hands `setDb` a
    // recording Proxy whose `get` trap builds a fresh `prepare` on every read
    // and whose handler defines no `set` trap. Assigning a wrapper onto it wrote
    // THROUGH to the database behind the proxy, while reads kept returning the
    // trap's function — the two then called each other and the suite died with
    // "Maximum call stack size exceeded" on its first query.
    //
    // The first write is unrecoverable, so the check has to happen before it.
    let synthesised = 0;
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        synthesised++;
        return (text: string) => target.prepare(text);
      },
    });

    instrumentDatabaseTiming(proxy);

    expect(synthesised).toBeGreaterThan(0);
    proxy.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(1, "via-proxy");
    expect(db.prepare("SELECT count(*) AS c FROM t").get()).toEqual({ c: 1 });
  });

  it("returns objects that lack the driver's methods untouched", () => {
    const partial = { prepare: undefined, notADatabase: true };
    expect(instrumentDatabaseTiming(partial)).toBe(partial);
    expect(instrumentDatabaseTiming(null)).toBeNull();
    expect(instrumentDatabaseTiming(undefined)).toBeUndefined();
  });

  it("instruments only the methods a partial handle actually has", () => {
    let execCalls = 0;
    const partial = { exec: (_sql: string) => { execCalls++; } };
    instrumentDatabaseTiming(partial);

    const { dbMs } = measure(() => {
      partial.exec("SELECT 1");
    });
    expect(execCalls).toBe(1);
    expect(dbMs).toBeGreaterThanOrEqual(0);
  });
});
