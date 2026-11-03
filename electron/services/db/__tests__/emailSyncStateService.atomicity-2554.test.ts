/**
 * @jest-environment node
 *
 * BACKLOG-2554 — recordSyncFailure / recordSyncSuccess are ONE statement each.
 *
 * Before 2554 each ran `ensureSyncStateRow` (INSERT OR IGNORE) and then a
 * separate UPDATE, with no transaction around them. A process death between
 * the two left a brand-new row with `failure_count 0, last_error NULL` — the
 * failure was lost. Each is now a single UPSERT.
 *
 * This suite runs the REAL service against the REAL driver and the shipped
 * `schema.sql` DDL for `email_sync_state`. Every statement that writes the
 * table is instrumented to record, at the moment it runs, the COMMITTED rows
 * as seen through a SECOND connection to the same WAL file — what a process
 * death at that instant would leave on disk.
 *
 * The upsert must also leave `phase`, `cursor` and the cached bounds alone:
 * a Clear'd mailbox stays Clear'd and keeps its delta cursor. `INSERT OR
 * REPLACE` would wipe all of them, which the existing-row cases catch.
 *
 * Run with a Node-ABI build of the sqlite driver:
 *   npx jest <this file>
 * or under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file>
 */

import * as os from "os";
import * as fs from "fs";
import * as nodePath from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("../../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../core/dbConnection";
import { recordSyncFailure, recordSyncSuccess } from "../emailSyncStateService";

const USER = "user-2554";
const ACCT = "acct-2554";
const OLD_STAMP = "2020-01-01 00:00:00";

interface StateRow {
  user_id: string;
  account_id: string;
  provider: string;
  phase: string;
  cursor: string | null;
  newest_cached_at: string | null;
  oldest_cached_at: string | null;
  last_reconciled_at: string | null;
  last_error: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

/** The email_sync_state table, exactly as `schema.sql` ships it. */
function syncStateDdl(): string {
  const schema = fs.readFileSync(
    nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql"),
    "utf8",
  );
  const table = schema.match(/CREATE TABLE IF NOT EXISTS email_sync_state \([\s\S]*?\n\);/);
  if (!table) throw new Error("email_sync_state DDL not found in schema.sql");
  return table[0];
}

interface WriteRecord {
  sql: string;
  inTransaction: boolean;
  committedBefore: StateRow[];
}

interface Fixture {
  dir: string;
  db: DatabaseType;
  reader: DatabaseType;
  writes: WriteRecord[];
}

let fx: Fixture | null = null;

function committedRows(reader: DatabaseType): StateRow[] {
  return reader
    .prepare("SELECT * FROM email_sync_state ORDER BY user_id, account_id")
    .all() as StateRow[];
}

function setup(seed?: Partial<StateRow>): Fixture {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "emailsyncstate-2554-"));
  const file = nodePath.join(dir, "state.db");
  const db = new Database(file) as unknown as DatabaseType;
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Minimal parent for the shipped FK (email_sync_state.user_id -> users_local.id).
  db.exec("CREATE TABLE users_local (id TEXT PRIMARY KEY)");
  db.exec(syncStateDdl());
  db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER);

  if (seed) {
    const row = {
      user_id: USER,
      account_id: ACCT,
      provider: "microsoft",
      phase: "active",
      cursor: null,
      newest_cached_at: null,
      oldest_cached_at: null,
      last_reconciled_at: null,
      last_error: null,
      failure_count: 0,
      created_at: OLD_STAMP,
      updated_at: OLD_STAMP,
      ...seed,
    };
    db.prepare(
      `INSERT INTO email_sync_state (user_id, account_id, provider, phase, cursor,
         newest_cached_at, oldest_cached_at, last_reconciled_at, last_error,
         failure_count, created_at, updated_at)
       VALUES (@user_id, @account_id, @provider, @phase, @cursor, @newest_cached_at,
         @oldest_cached_at, @last_reconciled_at, @last_error, @failure_count,
         @created_at, @updated_at)`,
    ).run(row);
  }

  const reader = new Database(file, { readonly: true }) as unknown as DatabaseType;
  const writes: WriteRecord[] = [];

  const originalPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = originalPrepare(sql);
    if (/^\s*(INSERT|UPDATE|REPLACE|DELETE)\b[\s\S]*\bemail_sync_state\b/i.test(sql)) {
      const realRun = stmt.run.bind(stmt);
      (stmt as unknown as { run: (...a: unknown[]) => unknown }).run = (...args: unknown[]) => {
        writes.push({
          sql,
          inTransaction: db.inTransaction,
          committedBefore: committedRows(reader),
        });
        return realRun(...args);
      };
    }
    return stmt;
  };

  setDb(db);
  fx = { dir, db, reader, writes };
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

/** A Clear'd mailbox with a delta cursor, cached bounds and two prior failures. */
const CLEARED_FAILED: Partial<StateRow> = {
  phase: "cleared",
  cursor: "CUR",
  newest_cached_at: "2026-03-01",
  oldest_cached_at: "2026-01-01",
  last_reconciled_at: "2026-02-15",
  last_error: "old error",
  failure_count: 2,
};

describe("recordSyncFailure is one statement (BACKLOG-2554)", () => {
  it("C1 new row: a process death at any write leaves no half row (nothing committed before any write)", () => {
    const f = setup();

    recordSyncFailure(USER, ACCT, "microsoft", new Error("boom"));

    expect(f.writes.length).toBeGreaterThan(0);
    for (const w of f.writes) {
      expect(w.committedBefore).toEqual([]);
    }
  });

  it("C5 exactly one write statement per call, new row and existing row", () => {
    const f = setup();
    recordSyncFailure(USER, ACCT, "microsoft", new Error("first"));
    expect(f.writes).toHaveLength(1);

    recordSyncFailure(USER, ACCT, "microsoft", new Error("second"));
    expect(f.writes).toHaveLength(2);
  });

  it("C3 new row: phase active, failure_count 1, last_error set", () => {
    const f = setup();

    recordSyncFailure(USER, ACCT, "google", new Error("boom"));

    const rows = committedRows(f.reader);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: USER,
      account_id: ACCT,
      provider: "google",
      phase: "active",
      cursor: null,
      newest_cached_at: null,
      oldest_cached_at: null,
      last_error: "boom",
      failure_count: 1,
    });
  });

  it("C2 existing Clear'd row: count 2 -> 3, error replaced, phase/cursor/bounds/created_at unchanged, updated_at bumped", () => {
    const f = setup(CLEARED_FAILED);

    recordSyncFailure(USER, ACCT, "microsoft", new Error("boom2"));

    const rows = committedRows(f.reader);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "microsoft",
      phase: "cleared",
      cursor: "CUR",
      newest_cached_at: "2026-03-01",
      oldest_cached_at: "2026-01-01",
      last_reconciled_at: "2026-02-15",
      last_error: "boom2",
      failure_count: 3,
      created_at: OLD_STAMP,
    });
    expect(rows[0].updated_at).not.toBe(OLD_STAMP);
  });

  it("repeated failures keep counting and the stored message is capped at 500 chars", () => {
    const f = setup();
    for (let i = 0; i < 4; i++) {
      recordSyncFailure(USER, ACCT, "microsoft", "x".repeat(800));
    }
    const rows = committedRows(f.reader);
    expect(rows[0].failure_count).toBe(4);
    expect(rows[0].last_error).toHaveLength(500);
  });
});

describe("recordSyncSuccess is one statement (BACKLOG-2554)", () => {
  it("C1 new row: a process death at any write leaves no half row", () => {
    const f = setup();

    recordSyncSuccess(USER, ACCT, "microsoft");

    expect(f.writes.length).toBeGreaterThan(0);
    for (const w of f.writes) {
      expect(w.committedBefore).toEqual([]);
    }
  });

  it("C5 exactly one write statement per call, new row and existing row", () => {
    const f = setup();
    recordSyncSuccess(USER, ACCT, "microsoft");
    expect(f.writes).toHaveLength(1);

    recordSyncSuccess(USER, ACCT, "microsoft");
    expect(f.writes).toHaveLength(2);
  });

  it("new row: phase active, failure_count 0, last_error NULL", () => {
    const f = setup();

    recordSyncSuccess(USER, ACCT, "google");

    const rows = committedRows(f.reader);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "google",
      phase: "active",
      last_error: null,
      failure_count: 0,
    });
  });

  it("C4 existing failed Clear'd row: count 0, error NULL, phase/cursor/bounds unchanged, updated_at bumped", () => {
    const f = setup(CLEARED_FAILED);

    recordSyncSuccess(USER, ACCT, "microsoft");

    const rows = committedRows(f.reader);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      phase: "cleared",
      cursor: "CUR",
      newest_cached_at: "2026-03-01",
      oldest_cached_at: "2026-01-01",
      last_reconciled_at: "2026-02-15",
      last_error: null,
      failure_count: 0,
      created_at: OLD_STAMP,
    });
    expect(rows[0].updated_at).not.toBe(OLD_STAMP);
  });
});
