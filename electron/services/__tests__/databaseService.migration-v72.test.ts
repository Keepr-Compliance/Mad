/**
 * @jest-environment node
 *
 * BACKLOG-3476 — migration v72, against the REAL driver.
 *
 * v72 rebuilds `transaction_checklists` so a transaction may hold several
 * checklists: `transaction_id … UNIQUE` becomes `UNIQUE (transaction_id,
 * template_id)` and a `sort_order` column is added. Every claim is about
 * SQLite's own behaviour (how RENAME rewrites child FKs, what a CHECK does,
 * what the autoindexes are called after a rename), so only the real driver can
 * answer it.
 *
 * THE OLD-SHAPE FIXTURE. The current schema.sql is exec'd, then
 * `transaction_checklists` alone is dropped (foreign_keys OFF) and recreated
 * from the DDL below — pasted verbatim from `electron/database/schema.sql` at
 * `619e00a07`, the PR #2708 head before this change. The three child tables
 * are unchanged by v72 and reference the parent by name, so this is exactly
 * the database a dev profile holds at v71.
 *
 * EVERY FIXTURE ROW IS SYNTHETIC. This repo is public.
 */

import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { extractFingerprint } from "./helpers/schemaFingerprint";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "database", "schema.sql"),
  "utf8",
);

/** `transaction_checklists` as it stood at 619e00a07 (schema.sql). */
const OLD_SHAPE_DDL_619E00A07 = `CREATE TABLE IF NOT EXISTS transaction_checklists (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE,
  template_id    TEXT NOT NULL,
  template_name  TEXT NOT NULL CHECK (length(trim(template_name)) BETWEEN 1 AND 200),
  selected_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);`;

const CHECKLIST_TABLES = [
  "transaction_checklists",
  "transaction_checklist_items",
  "transaction_checklist_links",
  "transaction_checklist_link_members",
];

const USER = "user-3476-v72";

type Migrate = (d: DatabaseType) => void;

/** The v72 entry, read from the shipped chain rather than re-typed here. */
function v72(): { version: number; migrate: Migrate } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require("../databaseService").default;
  const chain = (svc.constructor as { MIGRATIONS: Array<{ version: number; migrate: Migrate }> })
    .MIGRATIONS;
  const entry = chain.find((m) => m.version === 72);
  if (!entry) throw new Error("v72 is not in DatabaseService.MIGRATIONS");
  return entry;
}

function freshDb(): DatabaseType {
  const db = new RealDatabase(":memory:") as DatabaseType;
  db.exec(SCHEMA);
  db.pragma("foreign_keys = ON");
  return db;
}

/** A database whose checklist table has the pre-v72 shape. */
function oldShapeDb(): DatabaseType {
  const db = freshDb();
  db.pragma("foreign_keys = OFF");
  db.exec("DROP TABLE transaction_checklists");
  db.exec(OLD_SHAPE_DDL_619E00A07);
  db.pragma("foreign_keys = ON");
  return db;
}

/** Run v72 exactly as the runner does: foreign_keys OFF, one transaction. */
function runV72(db: DatabaseType, migrate: Migrate = v72().migrate): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => migrate(db))();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

const run = (db: DatabaseType, q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));
const count = (db: DatabaseType, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** One transaction carrying one checklist with an item, a group and a member. */
function seed(db: DatabaseType): void {
  run(db, `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'synthetic@example.test', 'google', 'oid')`, USER);
  run(db, `INSERT INTO transactions (id, user_id, property_address) VALUES ('tx1', ?, '1 Test Road')`, USER);
  run(
    db,
    `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at)
     VALUES ('e1', ?, 'ext-1', 'outlook', 'acct', 'Offer', 's@example.test', 'me@example.test', '2026-03-01T10:00:00Z')`,
    USER,
  );
  run(db, `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, selected_at)
           VALUES ('c1', 'tx1', 'tpl-a', 'Listing', '2026-09-01 10:00:00')`);
  run(db, `INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required, sort_order)
           VALUES ('i1', 'c1', 'Offer received', 1, 0)`);
  run(db, `INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('l1', 'i1', 'email', 'Offer')`);
  run(db, `INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES ('m1', 'l1', 'email', 'e1')`);
}

function checklistFingerprint(db: DatabaseType) {
  const fp = extractFingerprint(db);
  const tables = Object.fromEntries(CHECKLIST_TABLES.map((t) => [t, fp.tables[t]]));
  const indexes = Object.fromEntries(
    Object.entries(fp.indexes).filter(([, info]) => CHECKLIST_TABLES.includes(info.table)),
  );
  const triggers = Object.fromEntries(
    Object.entries(fp.triggers).filter(([name]) => name.startsWith("trg_checklist")),
  );
  return { tables, indexes, triggers };
}

describe("migration v72 — BACKLOG-3476 several checklists per transaction", () => {
  let db: DatabaseType;
  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  });

  it("PRECONDITION: the old-shape fixture refuses a second checklist on one transaction", () => {
    db = oldShapeDb();
    seed(db);
    expect(() =>
      run(db, `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name)
               VALUES ('c2', 'tx1', 'tpl-b', 'Buyer')`),
    ).toThrow(/UNIQUE constraint failed: transaction_checklists.transaction_id/);
  });

  it("V1: after v72 a second checklist (different template) lands; the same template twice is refused", () => {
    db = oldShapeDb();
    seed(db);
    runV72(db);
    run(db, `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order)
             VALUES ('c2', 'tx1', 'tpl-b', 'Buyer', 1)`);
    expect(count(db, "transaction_checklists")).toBe(2);
    expect(() =>
      run(db, `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name)
               VALUES ('c3', 'tx1', 'tpl-a', 'Listing again')`),
    ).toThrow(/UNIQUE constraint failed: transaction_checklists.transaction_id, transaction_checklists.template_id/);
  });

  it("V2: children still reference transaction_checklists, the cascade works, and foreign_key_check is empty", () => {
    db = oldShapeDb();
    seed(db);
    runV72(db);
    const fks = db.prepare("PRAGMA foreign_key_list(transaction_checklist_items)").all() as Array<{ table: string }>;
    expect(fks.map((f) => f.table)).toEqual(["transaction_checklists"]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    run(db, "DELETE FROM transaction_checklists WHERE id = 'c1'");
    expect(count(db, "transaction_checklist_items")).toBe(0);
    expect(count(db, "transaction_checklist_links")).toBe(0);
    expect(count(db, "transaction_checklist_link_members")).toBe(0);
  });

  it("V3: pre-existing rows keep id, transaction, template, name and selected_at; sort_order is 0; children untouched", () => {
    db = oldShapeDb();
    seed(db);
    const before = db
      .prepare("SELECT id, transaction_id, template_id, template_name, selected_at FROM transaction_checklists")
      .all();
    runV72(db);
    const after = db
      .prepare("SELECT id, transaction_id, template_id, template_name, selected_at, sort_order FROM transaction_checklists")
      .all() as Array<Record<string, unknown>>;
    expect(after.map(({ sort_order: _s, ...rest }) => rest)).toEqual(before);
    expect(after.map((r) => r.sort_order)).toEqual([0]);
    expect(count(db, "transaction_checklist_items")).toBe(1);
    expect(count(db, "transaction_checklist_links")).toBe(1);
    expect(count(db, "transaction_checklist_link_members")).toBe(1);
  });

  it("V4: running v72 twice is identical to running it once, and a fresh database is not rebuilt", () => {
    db = oldShapeDb();
    seed(db);
    runV72(db);
    const master = () =>
      db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE '%checklist%' ORDER BY name").all();
    const once = master();
    runV72(db);
    expect(master()).toEqual(once);
    db.close();

    db = freshDb();
    const execs: string[] = [];
    const real = v72().migrate;
    const spy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "exec") {
          return (sqlText: string) => {
            execs.push(sqlText);
            return target.exec(sqlText);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    runV72(db, () => real(spy as DatabaseType));
    expect(execs).toEqual([]);
    const stored = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_checklists'")
      .get() as { sql: string };
    // A rebuilt table is stored under its renamed, quoted name; a fresh one is not.
    expect(stored.sql.startsWith("CREATE TABLE transaction_checklists")).toBe(true);
  });

  it("V5: the upgraded database's four checklist tables fingerprint identically to a fresh schema.sql database", () => {
    const fresh = freshDb();
    const expected = checklistFingerprint(fresh);
    fresh.close();

    db = oldShapeDb();
    seed(db);
    runV72(db);
    expect(checklistFingerprint(db)).toEqual(expected);
    expect(Object.keys(expected.indexes).sort()).toEqual(
      expect.arrayContaining([
        "sqlite_autoindex_transaction_checklists_1",
        "sqlite_autoindex_transaction_checklists_2",
      ]),
    );
  });

  it("V5b: the upgraded table keeps the template_name CHECK (invisible to the fingerprint)", () => {
    db = oldShapeDb();
    seed(db);
    runV72(db);
    expect(() =>
      run(db, `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name)
               VALUES ('c9', 'tx1', 'tpl-z', '   ')`),
    ).toThrow(/CHECK constraint failed/);
  });
});
