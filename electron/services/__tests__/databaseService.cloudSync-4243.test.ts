/**
 * @jest-environment node
 *
 * BACKLOG-4243 PR-2 — Keepr Cloud tables and triggers on the REAL open path
 * (databaseService.initialize → runMigrations: drop step, schema.sql, the
 * chain, create step). REAL driver, required by absolute path as the v78 suite
 * does; this suite does not fall back to another driver.
 *
 * - upgrade: a database at the current version without the cloud_sync tables
 *   (what every install has today; no version bump) gains the tables and the
 *   triggers at the next open, and nothing is marked;
 * - a migration that throws still ends with the triggers present;
 * - a migration that ran marks every eligible deal of every enabled user.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { CLOUD_SYNC_TABLES, CLOUD_SYNC_TRIGGERS } from "../db/cloudSyncSql";

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

let userDataDir = "/tmp/unset-4243";
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
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
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(true),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

const USER = "user-4243-open-path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

function loadService(): AnyService {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../tests/helpers/installTestCapabilities").installTestCapabilities();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../databaseService").default;
}

function names(db: DatabaseType, type: "table" | "trigger", like: string): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ? ORDER BY name`).all(type, like) as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

function seed(db: DatabaseType): void {
  db.prepare("INSERT OR IGNORE INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'u4243@example.test', 'google', ?)").run(USER, USER);
  db.prepare("INSERT INTO transactions (id, user_id, property_address, status, detection_status) VALUES ('d-1', ?, '1 Test Rd', 'active', 'confirmed')").run(USER);
  db.prepare("INSERT INTO transactions (id, user_id, property_address, status, detection_status) VALUES ('d-2', ?, '2 Test Rd', 'active', 'pending')").run(USER);
}

function dirtyIds(db: DatabaseType): string[] {
  return (db.prepare("SELECT transaction_id FROM cloud_sync_dirty ORDER BY transaction_id").all() as Array<{ transaction_id: string }>).map((r) => r.transaction_id);
}

describe("Keepr Cloud on the real open path (bundled driver)", () => {
  jest.setTimeout(120000);
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-4243-"));
    userDataDir = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("UPGRADE: a database at the current version without the cloud tables gains tables and triggers at the next open, with no version change and no marks", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const db1 = first.db as DatabaseType;
    const version = (db1.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }).version;
    // Today's shipped shape: no cloud tables, no cloud triggers.
    for (const t of CLOUD_SYNC_TRIGGERS) db1.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
    for (const t of CLOUD_SYNC_TABLES) db1.exec(`DROP TABLE IF EXISTS ${t}`);
    seed(db1);
    expect(names(db1, "table", "cloud_sync_%")).toEqual([]);
    await first.close();

    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const db = second.db as DatabaseType;
    expect((db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }).version).toBe(version);
    expect(names(db, "table", "cloud_sync_%")).toEqual([...CLOUD_SYNC_TABLES].sort());
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    expect(dirtyIds(db)).toEqual([]);
    // Never enabled: a write marks nothing. Enabled: a write marks.
    db.prepare("UPDATE transactions SET property_city = 'A' WHERE id = 'd-1'").run();
    expect(dirtyIds(db)).toEqual([]);
    db.prepare("INSERT INTO cloud_sync_settings (project_ref, user_id, enabled) VALUES ('p', ?, 1)").run(USER);
    db.prepare("UPDATE transactions SET property_city = 'B' WHERE id = 'd-1'").run();
    expect(dirtyIds(db)).toEqual(["d-1"]);
    await second.close();
  });

  it("a migration that throws still ends with the triggers present, and a deal write still succeeds", async () => {
    const svc = loadService();
    await expect(svc.initialize()).resolves.toBe(true);
    const db = svc.db as DatabaseType;
    seed(db);
    db.prepare("INSERT INTO cloud_sync_settings (project_ref, user_id, enabled) VALUES ('p', ?, 1)").run(USER);
    const migrations = (svc.constructor as { MIGRATIONS: Array<{ version: number; description: string; migrate: (d: DatabaseType) => void }> }).MIGRATIONS;
    const head = migrations[migrations.length - 1].version;
    migrations.push({ version: head + 1, description: "test: throws", migrate: () => { throw new Error("test migration failure"); } });
    try {
      await expect(svc.runMigrations(db)).rejects.toThrow();
    } finally {
      migrations.pop();
    }
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    db.exec("DELETE FROM cloud_sync_dirty");
    expect(() => db.prepare("UPDATE transactions SET property_city = 'C' WHERE id = 'd-1'").run()).not.toThrow();
    expect(dirtyIds(db)).toEqual(["d-1"]);
    await svc.close();
  });

  it("C2.29: a migration that rebuilds transaction_checklists and its items succeeds with the triggers in place before the open", async () => {
    const svc = loadService();
    await expect(svc.initialize()).resolves.toBe(true);
    const db = svc.db as DatabaseType;
    seed(db);
    db.prepare("INSERT INTO cloud_sync_settings (project_ref, user_id, enabled) VALUES ('p', ?, 1)").run(USER);
    expect(names(db, "trigger", "trg_cloud_sync_item_%").length).toBe(3);
    const rebuild = (d: DatabaseType, table: string) => {
      const ddl = (d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
      d.exec(`${ddl.replace(/^CREATE TABLE\s+("?)[A-Za-z_]+\1/, `CREATE TABLE ${table}_new`)};
        INSERT INTO ${table}_new SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_new RENAME TO ${table};`);
    };
    const migrations = (svc.constructor as { MIGRATIONS: Array<{ version: number; description: string; migrate: (d: DatabaseType) => void }> }).MIGRATIONS;
    const head = migrations[migrations.length - 1].version;
    migrations.push({
      version: head + 1,
      description: "test: rebuilds two checklist tables the repo way",
      migrate: (d) => {
        rebuild(d, "transaction_checklists");
        rebuild(d, "transaction_checklist_items");
      },
    });
    try {
      await expect(svc.runMigrations(db)).resolves.toBeUndefined();
    } finally {
      migrations.pop();
    }
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    expect(dirtyIds(db)).toEqual(["d-1"]);
    await svc.close();
  });

  it("a migration that ran marks every eligible deal of every enabled user (triggers were absent during it)", async () => {
    const svc = loadService();
    await expect(svc.initialize()).resolves.toBe(true);
    const db = svc.db as DatabaseType;
    seed(db);
    db.prepare("INSERT INTO cloud_sync_settings (project_ref, user_id, enabled) VALUES ('p', ?, 1)").run(USER);
    db.exec("DELETE FROM cloud_sync_dirty");
    const migrations = (svc.constructor as { MIGRATIONS: Array<{ version: number; description: string; migrate: (d: DatabaseType) => void }> }).MIGRATIONS;
    const head = migrations[migrations.length - 1].version;
    migrations.push({
      version: head + 1,
      description: "test: writes a deal while the triggers are absent",
      migrate: (d) => {
        d.prepare("UPDATE transactions SET property_city = 'During' WHERE id = 'd-1'").run();
      },
    });
    try {
      await svc.runMigrations(db);
    } finally {
      migrations.pop();
    }
    expect(dirtyIds(db)).toEqual(["d-1"]);
    await svc.close();
  });
});
