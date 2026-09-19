/**
 * @jest-environment node
 *
 * BACKLOG-2960 — the instrument is actually CONNECTED to the live handle.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE IS SEPARATE FROM `dbTiming.realDriver-2960.test.ts`
 * ---------------------------------------------------------------------------
 * That suite calls `instrumentDatabaseTiming` directly, and the pre-cache
 * end-to-end suite instruments its own test handle while mocking
 * `dbConnection`. Both would stay green with the single line in `setDb` that
 * installs the accounting removed — and production would then report `dbMs=0`
 * on every run, forever, with nothing red to say so. A measurement that silently
 * reads zero is the exact failure this whole item exists to prevent, so the wire
 * itself needs a control.
 *
 * So: the REAL `dbConnection`, unmocked. `setDb` a real database, drive the real
 * conduits, and assert the accumulator moved.
 *
 * Run it with:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron \
 *     node_modules/jest/bin/jest.js \
 *     electron/services/db/core/__tests__/dbTiming.setDbWiring-2960.test.ts
 *
 * MUTATION: change `setDb` back to `db = database;` -> RED here, green
 * everywhere else.
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

import { setDb, getRawDatabase, dbRun, dbGet, dbExec } from "../dbConnection";
import { readDbTimeMs } from "../dbTiming";
import { sql } from "../sqlText";

describe("setDb installs database-time accounting on the live handle", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as DatabaseType;
    setDb(db);
    dbExec(sql`CREATE TABLE t (a INTEGER, b TEXT)`);
  });

  afterEach(() => {
    db.close();
  });

  it("charges work driven through the conduits", () => {
    const before = readDbTimeMs();

    for (let i = 0; i < 200; i++) {
      dbRun(sql`INSERT INTO t (a, b) VALUES (?, ?)`, [i, `row-${i}`]);
    }
    const row = dbGet<{ c: number }>(sql`SELECT count(*) AS c FROM t`);

    expect(row?.c).toBe(200);
    expect(readDbTimeMs() - before).toBeGreaterThan(0);
  });

  it("charges work driven through the raw handle, which bypasses the conduits", () => {
    // The pre-cache path's heaviest writes go this way — the batch email INSERT,
    // the force-staging create, the staging->live swap all take the raw handle
    // and drive `prepare`/`transaction` themselves. If only the conduits were
    // instrumented, none of that would appear in `dbMs`.
    const raw = getRawDatabase();
    const before = readDbTimeMs();

    const insert = raw.prepare("INSERT INTO t (a, b) VALUES (?, ?)");
    const tx = raw.transaction(() => {
      for (let i = 0; i < 200; i++) {
        insert.run(i, `raw-${i}`);
      }
    });
    tx();

    expect(readDbTimeMs() - before).toBeGreaterThan(0);
    expect(raw.prepare("SELECT count(*) AS c FROM t").get()).toEqual({ c: 200 });
  });

  it("hands back the same object it was given, so raw-handle holders share the instrument", () => {
    // `databaseService` keeps its own reference (`this.db`) and serves ~20
    // callers from it via `getRawDatabase()`. The accounting is installed by
    // mutating that object rather than by returning a substitute, which is what
    // makes those callers measured without touching any of them.
    expect(getRawDatabase()).toBe(db);
  });
});
