/**
 * @jest-environment node
 *
 * BACKLOG-3519 — migration v72, against the REAL driver.
 *
 * SR review (pm_comments 9d652b50 on BACKLOG-3519, addendum A3): v72's
 * `!hasCol` branch -- the path every existing installed database takes -- was
 * exercised by no test at all. The schema-parity suite's own "fresh vs
 * upgraded converge" control only ever builds a FRESH database (`schema.sql`
 * already carries the columns, so `hasCol` is always true there) and cannot
 * see the ALTER TABLE branch fail or diverge. This file follows
 * `databaseService.migration-v71.test.ts`'s pattern: the frozen chain-v69
 * transcript, stamped at baseline 70, is a real pre-v72 database (v71 never
 * touches `transactions`, so the transcript needs no v71 pass first).
 *
 * WHY THE REAL DRIVER. The claim under test is about SQLite's own behaviour --
 * that `PRAGMA table_info` reports the added columns with the right type
 * affinity, that a second run is a no-op, that a fresh-install shape (columns
 * already present from schema.sql) does not throw. A mocked driver cannot
 * answer any of these.
 *
 * EVERY FIXTURE ROW IS SYNTHETIC. This repo is public; no mailbox-derived
 * data appears here.
 */

import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { V72_ADD_COMMISSION_COLUMNS_SQL } from "../db/migrationV72Sql";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const FROZEN = fs.readFileSync(
  path.join(__dirname, "fixtures", "chain-v69-schema.sql"),
  "utf8",
);

/** The v72 entry, read from the shipped chain rather than re-typed here. */
function v72(): { version: number; migrate: (d: DatabaseType) => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require("../databaseService").default;
  const chain = (
    svc.constructor as {
      MIGRATIONS: Array<{ version: number; migrate: (d: DatabaseType) => void }>;
    }
  ).MIGRATIONS;
  const entry = chain.find((m) => m.version === 72);
  if (!entry) throw new Error("v72 is not in DatabaseService.MIGRATIONS");
  return entry;
}

/** A pre-v72 database: the frozen transcript, stamped at the baseline. */
function v70Fixture(): DatabaseType {
  const db = new RealDatabase(":memory:") as DatabaseType;
  db.exec(FROZEN);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
             id INTEGER PRIMARY KEY CHECK (id = 1),
             version INTEGER NOT NULL DEFAULT 1,
             updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
             migrated_at TEXT DEFAULT (datetime('now')));
           INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 70);
           INSERT INTO users_local (id, email, oauth_provider, oauth_id)
             VALUES ('u1', 'synthetic@example.test', 'google', 'oid-1');`);
  return db;
}

/** Run v72 exactly as the runner does: one transaction, foreign_keys OFF for the loop. */
function runV72(db: DatabaseType): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => v72().migrate(db))();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function transactionsColumns(db: DatabaseType): Array<{ name: string; type: string }> {
  return (db.prepare("PRAGMA table_info(transactions)").all() as Array<{
    name: string;
    type: string;
  }>).map((c) => ({ name: c.name, type: c.type }));
}

describe("migration v72 — BACKLOG-3519 commission figure columns", () => {
  let db: DatabaseType;
  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  });

  it("PRECONDITION: the v70 fixture's transactions table has none of the four columns", () => {
    db = v70Fixture();
    const names = transactionsColumns(db).map((c) => c.name);
    for (const col of [
      "commission_offered_rate",
      "commission_actual_rate",
      "commission_gross_amount",
      "commission_adjustment_reason",
    ]) {
      expect(names).not.toContain(col);
    }
  });

  it("CONTROL: the upgrade path adds all four columns with the declared types", () => {
    db = v70Fixture();
    runV72(db);
    const cols = transactionsColumns(db);
    expect(cols).toEqual(
      expect.arrayContaining([
        { name: "commission_offered_rate", type: "REAL" },
        { name: "commission_actual_rate", type: "REAL" },
        { name: "commission_gross_amount", type: "REAL" },
        { name: "commission_adjustment_reason", type: "TEXT" },
      ]),
    );
  });

  it("the columns are usable immediately after the upgrade — insert and read back", () => {
    db = v70Fixture();
    runV72(db);
    db.exec(`INSERT INTO transactions
               (id, user_id, property_address, commission_offered_rate,
                commission_actual_rate, commission_gross_amount, commission_adjustment_reason)
             VALUES
               ('t1', 'u1', '123 Main St', 2.5, 2.375, 2375.0, 'negotiated at closing')`);
    const row = db
      .prepare(
        `SELECT commission_offered_rate, commission_actual_rate,
                commission_gross_amount, commission_adjustment_reason
           FROM transactions WHERE id = 't1'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      commission_offered_rate: 2.5,
      commission_actual_rate: 2.375,
      commission_gross_amount: 2375.0,
      commission_adjustment_reason: "negotiated at closing",
    });
  });

  it("is a no-op on a FRESH install shape, where schema.sql already added the columns", () => {
    db = v70Fixture();
    db.exec(`ALTER TABLE transactions ADD COLUMN commission_offered_rate REAL;
             ALTER TABLE transactions ADD COLUMN commission_actual_rate REAL;
             ALTER TABLE transactions ADD COLUMN commission_gross_amount REAL;
             ALTER TABLE transactions ADD COLUMN commission_adjustment_reason TEXT;`);
    expect(() => runV72(db)).not.toThrow();
    const names = transactionsColumns(db).map((c) => c.name);
    // Exactly one of each -- a re-run would throw "duplicate column name" if the
    // hasCol guard failed to skip it.
    for (const col of [
      "commission_offered_rate",
      "commission_actual_rate",
      "commission_gross_amount",
      "commission_adjustment_reason",
    ]) {
      expect(names.filter((n) => n === col)).toHaveLength(1);
    }
  });

  it("CONTROL: running v72 twice on an UPGRADED database does not throw and adds nothing twice", () => {
    db = v70Fixture();
    runV72(db);
    expect(() => runV72(db)).not.toThrow();
    const names = transactionsColumns(db).map((c) => c.name);
    expect(names.filter((n) => n === "commission_offered_rate")).toHaveLength(1);
  });

  it("the ALTER text is fully static -- nothing here is built by interpolating a caller's value", () => {
    // Mirrors migration-v71.test.ts's SQL-text control: determinism/safety of a
    // named exported constant is a property of the STATEMENT, not of one run.
    expect(V72_ADD_COMMISSION_COLUMNS_SQL).toMatch(
      /ALTER TABLE transactions ADD COLUMN commission_offered_rate REAL/,
    );
    expect(V72_ADD_COMMISSION_COLUMNS_SQL).toMatch(
      /ALTER TABLE transactions ADD COLUMN commission_adjustment_reason TEXT/,
    );
  });
});
