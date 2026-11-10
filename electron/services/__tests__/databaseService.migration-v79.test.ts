/**
 * @jest-environment node
 *
 * BACKLOG-4219 PR2 — P4: migration v79 (Learn pilot report columns), on the
 * real driver. The pre-v79 table is the learn settings DDL TRANSCRIBED from
 * electron/database/schema.sql at int-portal/learn-pilot aa495f46e.
 *
 *   V79a  an upgraded row (Learn mode ON) gets pilot_report = 0, nothing owed,
 *         nothing sent: nobody shares until they turn it on
 *   V79b  the new columns refuse values other than 0 / 1
 *   V79c  re-runnable, and a no-op on a fresh install (schema.sql has them)
 *   V79d  v79 follows v78 in the chain
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
    getPath: jest.fn(() => "/tmp/unset-4219"),
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

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

/** git show aa495f46e:electron/database/schema.sql (the Learn settings table, pre-v79). */
const PRE_V79_DDL = `CREATE TABLE IF NOT EXISTS learn_mode_settings (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_learn_mode_settings_user_live
  ON learn_mode_settings(user_id) WHERE deleted_at IS NULL;`;

type Migrate = (d: DatabaseType) => void;
type Chain = Array<{ version: number; migrate: Migrate }>;

function chain(): Chain {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require("../databaseService").default;
  return (svc.constructor as { MIGRATIONS: Chain }).MIGRATIONS;
}
function v79(): Migrate {
  const e = chain().find((m) => m.version === 79);
  if (!e) throw new Error("v79 is not in DatabaseService.MIGRATIONS");
  return e.migrate;
}
const USER = "user-4219-v79";
const cols = (db: DatabaseType) =>
  (db.prepare(`PRAGMA table_info(learn_mode_settings)`).all() as Array<{ name: string }>).map((c) => c.name);

function preV79Db(): DatabaseType {
  const db = new RealDatabase(":memory:") as DatabaseType;
  db.exec(SCHEMA);
  db.pragma("foreign_keys = OFF");
  db.exec("DROP TABLE learn_mode_settings");
  db.exec(PRE_V79_DDL);
  db.pragma("foreign_keys = ON");
  db.prepare(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'v@example.test', 'google', 'oa-v')`).run(USER);
  db.prepare(
    `INSERT INTO learn_mode_settings (id, user_id, enabled, created_at, updated_at) VALUES ('lms-v79', ?, 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
  ).run(USER);
  return db;
}

describe("v79 Learn pilot report columns", () => {
  it("V79a an upgraded row is OFF, owes nothing, sent nothing", () => {
    const db = preV79Db();
    expect(cols(db)).not.toContain("pilot_report");
    db.transaction(() => v79()(db))();
    expect(
      db.prepare(`SELECT enabled, pilot_report, pilot_pending_withdraw, pilot_sent_versions, pilot_unsettled_at FROM learn_mode_settings WHERE user_id = ?`).get(USER),
    ).toEqual({ enabled: 1, pilot_report: 0, pilot_pending_withdraw: 0, pilot_sent_versions: null, pilot_unsettled_at: null });
    db.close();
  });

  it("V79b the switch columns refuse anything but 0 / 1", () => {
    const db = preV79Db();
    v79()(db);
    expect(() => db.prepare(`UPDATE learn_mode_settings SET pilot_report = 2`).run()).toThrow(/CHECK/);
    expect(() => db.prepare(`UPDATE learn_mode_settings SET pilot_pending_withdraw = 2`).run()).toThrow(/CHECK/);
    db.close();
  });

  it("V79c re-runnable; a no-op on a fresh install, whose columns match the upgraded ones", () => {
    const db = preV79Db();
    v79()(db);
    expect(() => v79()(db)).not.toThrow();
    const fresh = new RealDatabase(":memory:") as DatabaseType;
    fresh.exec(SCHEMA);
    expect(() => v79()(fresh)).not.toThrow();
    expect([...cols(fresh)].sort()).toEqual([...cols(db)].sort());
    db.close();
    fresh.close();
  });

  it("V79d v79 follows v78", () => {
    const versions = chain().map((m) => m.version);
    expect(versions.indexOf(79)).toBe(versions.indexOf(78) + 1);
  });
});
