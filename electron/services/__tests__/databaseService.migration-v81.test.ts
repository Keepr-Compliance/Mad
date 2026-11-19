/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-3 — migration v81 (todo due date, install_removed_at, todo tables), on the real
 * driver. The pre-v81 tables are the DDL TRANSCRIBED from electron/database/schema.sql at
 * int-portal/release-2.49 b869f3911 (v80). Synthetic ids only.
 *
 *   V81a  both columns are added, NULL on every existing row; no existing row changes; the todo
 *         tables exist
 *   V81b  re-runnable (twice = same rows), and a no-op on a fresh install, whose columns match
 *   V81c  due_date accepts YYYY-MM-DD between 2000 and 2100 and refuses everything else
 *   V81d  v81 follows v80 and the chain has no gap
 */
import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/tmp/unset-4263"),
    isPackaged: true,
    isReady: jest.fn(() => true),
    whenReady: jest.fn(() => Promise.resolve()),
    quit: jest.fn(),
  },
  dialog: { showMessageBox: jest.fn().mockResolvedValue({ response: 0 }) },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

import { CLOUD_SYNC_TODO_TABLES } from "../db/cloudSyncTodoSql";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

/** git show b869f3911:electron/database/schema.sql (the item and settings tables, pre-v81). */
const PRE_V81_ITEMS_DDL = `CREATE TABLE IF NOT EXISTS transaction_checklist_items (
  id                     TEXT PRIMARY KEY,
  checklist_id           TEXT NOT NULL,
  title                  TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  description            TEXT CHECK (description IS NULL OR length(description) <= 2000),
  is_required            INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0, 1)),
  expected_document_type TEXT CHECK (expected_document_type IS NULL OR expected_document_type IN
                           ('offer', 'inspection', 'disclosure', 'contract', 'appraisal',
                            'amendment', 'addendum', 'title', 'closing', 'other')),
  is_checked             INTEGER NOT NULL DEFAULT 0 CHECK (is_checked IN (0, 1)),
  checked_at             DATETIME,
  note                   TEXT,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  created_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK ((is_checked = 0) = (checked_at IS NULL)),
  FOREIGN KEY (checklist_id) REFERENCES transaction_checklists(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist
  ON transaction_checklist_items(checklist_id, sort_order);`;
const PRE_V81_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS cloud_sync_settings (
  project_ref        TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  local_confirmed_at TEXT,
  notice_version     INTEGER,
  accepted_at        TEXT,
  last_state_json    TEXT,
  last_state_at      TEXT,
  turn_off_owed_at   TEXT,
  PRIMARY KEY (project_ref, user_id)
);`;

type Migrate = (d: DatabaseType) => void;
type Chain = Array<{ version: number; migrate: Migrate }>;

function svcClass(): { MIGRATIONS: Chain; validateNoVersionGaps: (m: Chain) => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require("../databaseService").default;
  return svc.constructor;
}
function v81(): Migrate {
  const e = svcClass().MIGRATIONS.find((m) => m.version === 81);
  if (!e) throw new Error("v81 is not in DatabaseService.MIGRATIONS");
  return e.migrate;
}
const cols = (db: DatabaseType, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
const tableExists = (db: DatabaseType, name: string) =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
const rows = (db: DatabaseType, t: string, c: string[]) =>
  db.prepare(`SELECT ${c.join(", ")} FROM ${t} ORDER BY rowid`).all();

/** A v80 database: the current schema with the item and settings tables as they were and no todo tables. */
function preV81Db(): DatabaseType {
  const db = new RealDatabase(":memory:") as DatabaseType;
  db.exec(SCHEMA);
  db.pragma("foreign_keys = OFF");
  for (const t of CLOUD_SYNC_TODO_TABLES) db.exec(`DROP TABLE ${t}`);
  db.exec("DROP TABLE transaction_checklist_items; DROP TABLE cloud_sync_settings");
  db.exec(PRE_V81_ITEMS_DDL);
  db.exec(PRE_V81_SETTINGS_DDL);
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u1', 'v81@example.test', 'google', 'oa-v81')").run();
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('t1', 'u1', '1 Example Ave')").run();
  db.prepare("INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c1', 't1', 'tpl', 'List')").run();
  db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title, is_checked, checked_at, note, sort_order) VALUES ('i1', 'c1', 'A', 1, '2026-11-01 00:00:00', 'n', 0)").run();
  db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title, sort_order) VALUES ('i2', 'c1', 'B', 1)").run();
  db.prepare("INSERT INTO cloud_sync_settings (project_ref, user_id, enabled, turn_off_owed_at) VALUES ('p', 'u1', 1, NULL), ('p', 'u2', 0, '2026-11-02')").run();
  return db;
}

const ITEM_COLS_V80 = ["id", "checklist_id", "title", "description", "is_required", "expected_document_type", "is_checked", "checked_at", "note", "sort_order", "created_at"];
const SETTINGS_COLS_V80 = ["project_ref", "user_id", "enabled", "local_confirmed_at", "notice_version", "accepted_at", "last_state_json", "last_state_at", "turn_off_owed_at"];

describe("v81 todo due date, install_removed_at and todo tables", () => {
  it("V81a adds both columns (NULL everywhere), changes no existing row, creates the todo tables", () => {
    const db = preV81Db();
    expect(cols(db, "transaction_checklist_items")).toEqual(ITEM_COLS_V80);
    expect(cols(db, "cloud_sync_settings")).toEqual(SETTINGS_COLS_V80);
    const items = rows(db, "transaction_checklist_items", ITEM_COLS_V80);
    const settings = rows(db, "cloud_sync_settings", SETTINGS_COLS_V80);
    db.transaction(() => v81()(db))();
    expect(cols(db, "transaction_checklist_items")).toEqual([...ITEM_COLS_V80, "due_date"]);
    expect(cols(db, "cloud_sync_settings")).toEqual([...SETTINGS_COLS_V80, "install_removed_at"]);
    expect(rows(db, "transaction_checklist_items", ITEM_COLS_V80)).toEqual(items);
    expect(rows(db, "cloud_sync_settings", SETTINGS_COLS_V80)).toEqual(settings);
    expect(rows(db, "transaction_checklist_items", ["due_date"])).toEqual([{ due_date: null }, { due_date: null }]);
    expect(rows(db, "cloud_sync_settings", ["install_removed_at"])).toEqual([{ install_removed_at: null }, { install_removed_at: null }]);
    for (const t of CLOUD_SYNC_TODO_TABLES) expect([t, tableExists(db, t)]).toEqual([t, true]);
    db.close();
  });

  it("V81b re-runnable; a no-op on a fresh install, whose columns match the upgraded ones", () => {
    const db = preV81Db();
    v81()(db);
    const snap = JSON.stringify([rows(db, "transaction_checklist_items", ["*"]), rows(db, "cloud_sync_settings", ["*"])]);
    const cookie = db.pragma("schema_version", { simple: true });
    expect(() => v81()(db)).not.toThrow();
    expect(JSON.stringify([rows(db, "transaction_checklist_items", ["*"]), rows(db, "cloud_sync_settings", ["*"])])).toBe(snap);
    expect(db.pragma("schema_version", { simple: true })).toBe(cookie);

    const fresh = new RealDatabase(":memory:") as DatabaseType;
    fresh.exec(SCHEMA);
    const freshCookie = fresh.pragma("schema_version", { simple: true });
    expect(() => v81()(fresh)).not.toThrow();
    expect(fresh.pragma("schema_version", { simple: true })).toBe(freshCookie);
    const shape = (d: DatabaseType, t: string) =>
      (d.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>).map(
        (c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`,
      );
    for (const t of ["transaction_checklist_items", "cloud_sync_settings", ...CLOUD_SYNC_TODO_TABLES]) {
      expect([t, shape(fresh, t)]).toEqual([t, shape(db, t)]);
    }
    db.close();
    fresh.close();
  });

  it("V81c due_date accepts YYYY-MM-DD between 2000 and 2100 and refuses everything else, upgraded and fresh alike", () => {
    const up = preV81Db();
    v81()(up);
    const fresh = new RealDatabase(":memory:") as DatabaseType;
    fresh.exec(SCHEMA);
    fresh.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u1', 'f@example.test', 'google', 'oa-f')").run();
    fresh.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('t1', 'u1', '1 Example Ave')").run();
    fresh.prepare("INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c1', 't1', 'tpl', 'List')").run();
    fresh.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title) VALUES ('i1', 'c1', 'A')").run();
    for (const db of [up, fresh]) {
      const set = (v: unknown) => () => db.prepare("UPDATE transaction_checklist_items SET due_date = ? WHERE id = 'i1'").run(v);
      for (const ok of ["2026-11-20", "2000-01-01", "2100-12-31", null]) expect(set(ok)).not.toThrow();
      for (const bad of ["1999-12-31", "2101-01-01", "2026-02-30", "2026-1-5", "2026-11-20T00:00:00", "tomorrow", ""]) {
        expect(set(bad)).toThrow(/CHECK/);
      }
    }
    up.close();
    fresh.close();
  });

  it("V81d v81 follows v80 and the chain has no gap", () => {
    const cls = svcClass();
    const versions = cls.MIGRATIONS.map((m) => m.version);
    expect(versions.indexOf(81)).toBe(versions.indexOf(80) + 1);
    // BACKLOG-4263 PR-4b: v82 (the todo cursor's horizon and full-pull kind) follows v81.
    expect(versions.indexOf(82)).toBe(versions.indexOf(81) + 1);
    // BACKLOG-4263 PR-4c: v83 (the deal archive) follows v82.
    expect(versions.indexOf(83)).toBe(versions.indexOf(82) + 1);
    // BACKLOG-4263 PR-6: v84 (the notices index and changed_json) follows v83.
    expect(versions.indexOf(84)).toBe(versions.indexOf(83) + 1);
    // BACKLOG-4263 PR-11c: v85 (the item author columns) follows v84.
    expect(versions.indexOf(85)).toBe(versions.indexOf(84) + 1);
    expect(Math.max(...versions)).toBe(85);
    expect(() => cls.validateNoVersionGaps(cls.MIGRATIONS)).not.toThrow();
  });
});
