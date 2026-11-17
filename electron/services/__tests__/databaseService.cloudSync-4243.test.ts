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

/** The local half of turning Keepr Cloud on (the real writer: triggers, flag and marks in one transaction). */
function turnOn(db: DatabaseType, userId: string = USER): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { enableForUser } = require("../db/cloudSyncDbService") as typeof import("../db/cloudSyncDbService");
  enableForUser(db as never, "p", userId, { noticeVersion: 1, acceptedAt: null });
  db.exec("DELETE FROM cloud_sync_dirty");
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

  it("UPGRADE: a database at the current version without the cloud tables gains the tables at the next open, no triggers until Keepr Cloud is turned on, no version change and no marks", async () => {
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
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual([]);
    expect(dirtyIds(db)).toEqual([]);
    // Never enabled: a write marks nothing. Turned on: the triggers exist and a write marks.
    db.prepare("UPDATE transactions SET property_city = 'A' WHERE id = 'd-1'").run();
    expect(dirtyIds(db)).toEqual([]);
    turnOn(db);
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    db.prepare("UPDATE transactions SET property_city = 'B' WHERE id = 'd-1'").run();
    expect(dirtyIds(db)).toEqual(["d-1"]);
    await second.close();
  });

  it("a migration that throws still ends with the triggers present, and a deal write still succeeds", async () => {
    const svc = loadService();
    await expect(svc.initialize()).resolves.toBe(true);
    const db = svc.db as DatabaseType;
    seed(db);
    turnOn(db);
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
    turnOn(db);
    // BACKLOG-4263 PR-4a: the item triggers are the todo capture ones now (3 on the items table).
    expect(names(db, "trigger", "trg_cloud_sync_todo_item_%").length).toBe(3);
    expect(names(db, "trigger", "trg_cloud_sync_item_%")).toEqual([]);
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

  it("PR-3: a migration that rebuilds contacts (and the views that read it) succeeds and ends with the contact triggers", async () => {
    const svc = loadService();
    await expect(svc.initialize()).resolves.toBe(true);
    const db = svc.db as DatabaseType;
    seed(db);
    turnOn(db);
    db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES ('ct-4243', ?, 'Person')").run(USER);
    db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES ('pt-4243', 'd-1', 'ct-4243')").run();
    const migrations = (svc.constructor as { MIGRATIONS: Array<{ version: number; description: string; migrate: (d: DatabaseType) => void }> }).MIGRATIONS;
    const head = migrations[migrations.length - 1].version;
    migrations.push({
      version: head + 1,
      description: "test: rebuilds contacts the repo way",
      migrate: (d) => {
        const views = d.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' AND sql LIKE '%contacts%'").all() as Array<{ name: string; sql: string }>;
        const ddl = (d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'contacts'").get() as { sql: string }).sql;
        for (const v of views) d.exec(`DROP VIEW ${v.name}`);
        d.exec(`${ddl.replace(/^CREATE TABLE\s+("?)[A-Za-z_]+\1/, "CREATE TABLE contacts_new")};
          INSERT INTO contacts_new SELECT * FROM contacts; DROP TABLE contacts; ALTER TABLE contacts_new RENAME TO contacts;`);
        for (const v of views) d.exec(v.sql);
      },
    });
    try {
      await expect(svc.runMigrations(db)).resolves.toBeUndefined();
    } finally {
      migrations.pop();
    }
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    db.exec("DELETE FROM cloud_sync_dirty");
    db.prepare("UPDATE contacts SET display_name = 'Renamed' WHERE id = 'ct-4243'").run();
    expect(dirtyIds(db)).toEqual(["d-1"]);
    await svc.close();
  });

  /**
   * Opens a fresh profile, then turns it into a v78 file with Keepr Cloud on: an enabled user, a
   * deal with a person, every cloud trigger, and the Learn objects v79 and v80 add removed.
   * Returns the open service; the caller runs the chain with runMigrations, as the next open would.
   */
  async function v78ProfileWithCloud(): Promise<{ svc: AnyService; db: DatabaseType }> {
    const svc = loadService();
    await expect(svc.initialize()).resolves.toBe(true);
    const d = svc.db as DatabaseType;
    seed(d);
    turnOn(d);
    d.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES ('ct-v78', ?, 'Person')").run(USER);
    d.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES ('pt-v78', 'd-1', 'ct-v78')").run();
    expect(names(d, "trigger", "trg_cloud_sync_%")).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    d.pragma("foreign_keys = OFF");
    for (const c of ["pilot_report", "pilot_pending_withdraw", "pilot_sent_versions", "pilot_unsettled_at"]) {
      d.exec(`ALTER TABLE learn_mode_settings DROP COLUMN ${c}`);
    }
    d.exec("DROP TABLE IF EXISTS learn_sender_overrides");
    d.exec("ALTER TABLE learn_bulk_answers DROP COLUMN sender_key");
    d.pragma("foreign_keys = ON");
    d.prepare("UPDATE schema_version SET version = 78 WHERE id = 1").run();
    d.exec("DELETE FROM cloud_sync_dirty");
    return { svc, db: d };
  }

  type Chain = Array<{ version: number; description: string; migrate: (d: DatabaseType) => void }>;
  const chainOf = (svc: AnyService) => (svc.constructor as { MIGRATIONS: Chain }).MIGRATIONS;
  const versionOf = (db: DatabaseType) => (db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }).version;

  it("RELEASE 2.49: a v78 profile with Keepr Cloud on runs v79 and v80, ends at v80 with every cloud trigger, v80's objects, and its deal marked", async () => {
    const { svc, db } = await v78ProfileWithCloud();
    expect(versionOf(db)).toBe(78);
    await expect(svc.runMigrations(db)).resolves.toBeUndefined();
    const head = chainOf(svc).at(-1)!.version;
    expect(head).toBeGreaterThanOrEqual(80);
    expect(versionOf(db)).toBe(head);
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    expect(dirtyIds(db)).toEqual(["d-1"]);
    expect(names(db, "table", "learn_sender_overrides")).toEqual(["learn_sender_overrides"]);
    expect((db.prepare("PRAGMA table_info(learn_bulk_answers)").all() as Array<{ name: string }>).map((c) => c.name)).toContain("sender_key");
    expect((db.prepare("PRAGMA table_info(learn_mode_settings)").all() as Array<{ name: string }>).map((c) => c.name)).toContain("pilot_report");
    db.exec("DELETE FROM cloud_sync_dirty");
    db.prepare("UPDATE contacts SET display_name = 'Renamed' WHERE id = 'ct-v78'").run();
    expect(dirtyIds(db)).toEqual(["d-1"]);
    await svc.close();
  });

  it("RELEASE 2.49: the same v78 profile with v80 made to throw (after v79 ran) ends with every cloud trigger present", async () => {
    const { svc, db } = await v78ProfileWithCloud();
    const v80 = chainOf(svc).find((m) => m.version === 80)!;
    const real = v80.migrate;
    v80.migrate = () => {
      throw new Error("test: v80 fails");
    };
    try {
      await expect(svc.runMigrations(db)).rejects.toThrow();
    } finally {
      v80.migrate = real;
    }
    expect(versionOf(db)).toBe(79);
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    db.exec("DELETE FROM cloud_sync_dirty");
    expect(() => db.prepare("UPDATE transactions SET property_city = 'C' WHERE id = 'd-1'").run()).not.toThrow();
    expect(dirtyIds(db)).toEqual(["d-1"]);
    await svc.close();
  });

  it("RELEASE 2.49 control: a migration in this chain that rebuilds transaction_contacts succeeds because the triggers are dropped first", async () => {
    const { svc, db } = await v78ProfileWithCloud();
    const v80 = chainOf(svc).find((m) => m.version === 80)!;
    const real = v80.migrate;
    v80.migrate = (d) => {
      real(d);
      const views = d.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' AND sql LIKE '%transaction_contacts%'").all() as Array<{ name: string; sql: string }>;
      const ddl = (d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_contacts'").get() as { sql: string }).sql;
      for (const v of views) d.exec(`DROP VIEW ${v.name}`);
      d.exec(`${ddl.replace(/^CREATE TABLE\s+("?)[A-Za-z_]+\1/, "CREATE TABLE transaction_contacts_new")};
        INSERT INTO transaction_contacts_new SELECT * FROM transaction_contacts; DROP TABLE transaction_contacts;
        ALTER TABLE transaction_contacts_new RENAME TO transaction_contacts;`);
      for (const v of views) d.exec(v.sql);
    };
    try {
      await expect(svc.runMigrations(db)).resolves.toBeUndefined();
    } finally {
      v80.migrate = real;
    }
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    db.exec("DELETE FROM cloud_sync_dirty");
    db.prepare("UPDATE transaction_contacts SET notes = 'x' WHERE id = 'pt-v78'").run();
    expect(dirtyIds(db)).toEqual(["d-1"]);
    await svc.close();
  });

  it("REGULAR PROFILE (C-a): a fresh profile with Keepr Cloud never on opens, takes a bulk write, and opens again — no cloud trigger, no mark, the schema cookie unchanged", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const d1 = first.db as DatabaseType;
    seed(d1);
    d1.exec("BEGIN");
    for (let i = 0; i < 300; i++) {
      d1.prepare("INSERT INTO transactions (id, user_id, property_address, status, detection_status) VALUES (?, ?, 'x', 'active', 'confirmed')").run(`imp-${i}`, USER);
      d1.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, 'P')").run(`c-${i}`, USER);
      d1.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, ?)").run(`p-${i}`, `imp-${i}`, `c-${i}`);
    }
    d1.exec("COMMIT");
    expect(names(d1, "trigger", "trg_cloud_sync_%")).toEqual([]);
    expect(dirtyIds(d1)).toEqual([]);
    const cookie = d1.pragma("schema_version", { simple: true });
    await first.close();
    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const db = second.db as DatabaseType;
    expect(db.pragma("schema_version", { simple: true })).toBe(cookie);
    expect(names(db, "trigger", "trg_cloud_sync_%")).toEqual([]);
    expect(dirtyIds(db)).toEqual([]);
    await second.close();
  });

  it("R1: an open of a profile carrying the triggers with no Keepr Cloud user drops them; with a user on, an open keeps them", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const d1 = first.db as DatabaseType;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ensureCloudSyncTriggers } = require("../db/cloudSyncTriggers") as typeof import("../db/cloudSyncTriggers");
    ensureCloudSyncTriggers(d1 as never);
    expect(names(d1, "trigger", "trg_cloud_sync_%")).toHaveLength(CLOUD_SYNC_TRIGGERS.length);
    await first.close();
    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const d2 = second.db as DatabaseType;
    expect(names(d2, "trigger", "trg_cloud_sync_%")).toEqual([]);
    seed(d2);
    turnOn(d2);
    await second.close();
    const third = loadService();
    await expect(third.initialize()).resolves.toBe(true);
    expect(names(third.db as DatabaseType, "trigger", "trg_cloud_sync_%")).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    await third.close();
  });

  it("RELEASE 2.49, Keepr Cloud off: a v78 profile runs v79 and v80 and ends with zero cloud triggers and no marks", async () => {
    const svc = loadService();
    await expect(svc.initialize()).resolves.toBe(true);
    const d = svc.db as DatabaseType;
    seed(d);
    d.pragma("foreign_keys = OFF");
    for (const c of ["pilot_report", "pilot_pending_withdraw", "pilot_sent_versions", "pilot_unsettled_at"]) {
      d.exec(`ALTER TABLE learn_mode_settings DROP COLUMN ${c}`);
    }
    d.exec("DROP TABLE IF EXISTS learn_sender_overrides");
    d.exec("ALTER TABLE learn_bulk_answers DROP COLUMN sender_key");
    d.pragma("foreign_keys = ON");
    d.prepare("UPDATE schema_version SET version = 78 WHERE id = 1").run();
    await expect(svc.runMigrations(d)).resolves.toBeUndefined();
    expect((d.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }).version).toBeGreaterThanOrEqual(80);
    expect(names(d, "trigger", "trg_cloud_sync_%")).toEqual([]);
    expect(dirtyIds(d)).toEqual([]);
    await svc.close();
  });

  it("a migration that ran marks every eligible deal of every enabled user (triggers were absent during it)", async () => {
    const svc = loadService();
    await expect(svc.initialize()).resolves.toBe(true);
    const db = svc.db as DatabaseType;
    seed(db);
    turnOn(db);
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
