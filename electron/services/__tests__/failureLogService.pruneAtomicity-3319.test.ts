/**
 * @jest-environment node
 *
 * BACKLOG-3319 — the failure-log prune is ONE transaction.
 *
 * `pruneOldEntries` runs two DELETEs (age, then cap) with a COUNT between
 * them. Before 3319 each committed on its own, so a crash after the age DELETE
 * left the log above its 500-row cap.
 *
 * This suite runs the REAL `pruneOldEntries` against the REAL driver and the
 * shipped `schema.sql` DDL for `failure_log`. Every DELETE statement the
 * service prepares is instrumented to, at the moment it runs:
 *   1. record `db.inTransaction`;
 *   2. read the COMMITTED ids through a SECOND connection to the same WAL file
 *      — what a process death at that instant would leave on disk;
 *   3. throw, at write k, to exercise the rollback path.
 * Assertions are on id SETS, never counts.
 *
 * The writeAtomicity guard cannot prove this: it clears a unit as soon as its
 * body contains any dbTransaction, so a DELETE moved outside it stays green
 * there. This file is the proof.
 *
 * Run with the real sqlite driver:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <this file>
 */

import * as os from "os";
import * as fs from "fs";
import * as nodePath from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../supportAccess/trace", () => ({ notifySupportError: jest.fn() }));

import { setDb } from "../db/core/dbConnection";
import failureLogService from "../failureLogService";

const OLD_ROWS = 3;
const CURRENT_ROWS = 510;
const CAP = 500;

/** The failure_log table and its indexes, exactly as `schema.sql` ships them. */
function failureLogDdl(): string {
  const schema = fs.readFileSync(
    nodePath.join(__dirname, "..", "..", "database", "schema.sql"),
    "utf8",
  );
  const table = schema.match(/CREATE TABLE IF NOT EXISTS failure_log \([\s\S]*?\n\);/);
  const indexes = schema.match(/CREATE INDEX IF NOT EXISTS idx_failure_log_\w+ ON failure_log\([^)]*\);/g);
  if (!table || !indexes || indexes.length !== 2) {
    throw new Error("failure_log DDL not found in schema.sql");
  }
  return [table[0], ...indexes].join("\n");
}

/** SQLite `datetime()` format, UTC, `secondsAgo` before now. */
function sqliteTime(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString().slice(0, 19).replace("T", " ");
}

interface WriteRecord {
  inTransaction: boolean;
  committedBefore: number[];
}

interface Fixture {
  dir: string;
  db: DatabaseType;
  reader: DatabaseType;
  writes: WriteRecord[];
  oldIds: number[];
  currentIds: number[];
}

let fx: Fixture | null = null;

function committedIds(reader: DatabaseType): number[] {
  return (reader.prepare("SELECT id FROM failure_log ORDER BY id").all() as { id: number }[]).map(
    (r) => r.id,
  );
}

/**
 * Seed 3 rows 40-42 days old and 510 current rows. Every timestamp is
 * DISTINCT (one minute apart) and ascends with id, so PRUNE_BY_CAP's
 * `ORDER BY timestamp ASC` has no ties and "the newest 500" is one set.
 */
function setup(throwAtWrite: number | null): Fixture {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "failurelog-3319-"));
  const file = nodePath.join(dir, "prune.db");
  const db = new Database(file) as unknown as DatabaseType;
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(failureLogDdl());

  const insert = db.prepare(
    "INSERT INTO failure_log (timestamp, operation, error_message, metadata) VALUES (?, ?, ?, ?)",
  );
  const oldIds: number[] = [];
  const currentIds: number[] = [];
  db.transaction(() => {
    for (let i = 0; i < OLD_ROWS; i++) {
      const daysAgo = 42 - i;
      const r = insert.run(sqliteTime(daysAgo * 86400), "op", "old", null);
      oldIds.push(Number(r.lastInsertRowid));
    }
    for (let i = 0; i < CURRENT_ROWS; i++) {
      const r = insert.run(sqliteTime((CURRENT_ROWS - i) * 60), "op", "current", null);
      currentIds.push(Number(r.lastInsertRowid));
    }
  })();

  const reader = new Database(file, { readonly: true }) as unknown as DatabaseType;
  const writes: WriteRecord[] = [];

  const originalPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = originalPrepare(sql);
    if (/^\s*DELETE\b/i.test(sql)) {
      const realRun = stmt.run.bind(stmt);
      (stmt as unknown as { run: (...a: unknown[]) => unknown }).run = (...args: unknown[]) => {
        const index = writes.length;
        writes.push({ inTransaction: db.inTransaction, committedBefore: committedIds(reader) });
        if (throwAtWrite === index) {
          throw new Error(`injected crash at write ${index}`);
        }
        return realRun(...args);
      };
    }
    return stmt;
  };

  setDb(db);
  fx = { dir, db, reader, writes, oldIds, currentIds };
  return fx;
}

afterEach(() => {
  if (fx) {
    fx.reader.close();
    fx.db.close();
    fs.rmSync(fx.dir, { recursive: true, force: true });
    fx = null;
  }
});

describe("failureLogService.pruneOldEntries is one transaction (BACKLOG-3319)", () => {
  it("clean run: both DELETEs run inside one transaction, nothing is committed between them, and exactly the newest 500 survive", async () => {
    const f = setup(null);
    const all = [...f.oldIds, ...f.currentIds];

    await failureLogService.pruneOldEntries();

    expect(f.writes.map((w) => w.inTransaction)).toEqual([true, true]);
    // Before each write, the committed state is still the full seed: the age
    // DELETE had NOT committed when the cap DELETE ran.
    expect(f.writes.map((w) => w.committedBefore)).toEqual([all, all]);
    // Count taken after the age delete: 510 current -> keep the newest 500.
    expect(committedIds(f.reader)).toEqual(f.currentIds.slice(CURRENT_ROWS - CAP));
  });

  it("crash at the age DELETE (write 0): every seeded row is still committed", async () => {
    const f = setup(0);
    const all = [...f.oldIds, ...f.currentIds];

    await failureLogService.pruneOldEntries();

    expect(f.writes.map((w) => w.inTransaction)).toEqual([true]);
    expect(committedIds(f.reader)).toEqual(all);
  });

  it("crash at the cap DELETE (write 1): the age DELETE is rolled back too — every seeded row is still committed", async () => {
    const f = setup(1);
    const all = [...f.oldIds, ...f.currentIds];

    await failureLogService.pruneOldEntries();

    expect(f.writes.map((w) => w.inTransaction)).toEqual([true, true]);
    // What a process death at the cap DELETE would leave: the full seed, not
    // the seed minus the 3 old rows.
    expect(f.writes[1].committedBefore).toEqual(all);
    expect(committedIds(f.reader)).toEqual(all);
  });

  it("a second prune after a clean one is a no-op on the id set", async () => {
    const f = setup(null);
    await failureLogService.pruneOldEntries();
    const afterFirst = committedIds(f.reader);

    await failureLogService.pruneOldEntries();

    expect(afterFirst).toHaveLength(CAP);
    expect(committedIds(f.reader)).toEqual(afterFirst);
  });
});
