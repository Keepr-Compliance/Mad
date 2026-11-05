/**
 * @jest-environment node
 *
 * BACKLOG-4120 C11 — THE THREE LEARN TABLES REACH AN EXISTING INSTALL THROUGH
 * schema.sql.
 *
 * Harness copied from checklistSchemaUpgrade-3475.test.ts (SR 426498b4 change
 * 5): launch 1 is the real initialize() at the CURRENT version, the learn
 * tables are then dropped (a pre-4120 database: version unchanged, no trace in
 * sqlite_master), launch 2 is the real initialize() again. The version is
 * never set back: a set-back version makes willRunMigration true, and a build
 * that ran schema.sql only when a migration is due would then pass.
 *
 * Case 2 (3965 shape): a database that already has the tables and rows opens
 * again and keeps them (a missing IF NOT EXISTS would fail the open).
 *
 * Merge-blocking: schema.sql is one BEGIN..COMMIT, so a DDL error in the learn
 * block stops the database opening for every user.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

let userDataDir = "/tmp/unset-4120";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

const NEW_TABLES = ["learn_mode_settings", "learn_deal_answers", "learn_bulk_answers"];

function tableNames(db: DatabaseType): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
}

/**
 * A launch is a fresh module registry: `databaseService` is a singleton holding
 * an open handle, so re-requiring it is what makes the second `initialize()` a
 * second LAUNCH rather than a second call.
 *
 * `resetModules` also discards the host capabilities `tests/setup.js` installed
 * at startup — they live in module state — so they are re-installed here.
 * Without this, `initialize()` fails on `isPackaged` with
 * `AppLifecycleUnavailableError` before it ever reaches the schema.
 */
function loadService(): AnyService {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../tests/helpers/installTestCapabilities").installTestCapabilities();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../databaseService").default;
}


const UUID_A = "learn-row-4120";

describe("BACKLOG-4120 — an existing install gains the learn tables on next launch", () => {
  jest.setTimeout(120000);

  let dir = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-4120-upgrade-"));
    userDataDir = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the tables and their partial unique indexes appear, user data survives, the version does not move", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const firstDb = first.db as DatabaseType;
    const versionBefore = (
      firstDb.prepare("SELECT version FROM schema_version WHERE id=1").get() as { version: number }
    ).version;

    for (const table of NEW_TABLES) firstDb.exec(`DROP TABLE IF EXISTS ${table}`);
    firstDb
      .prepare(
        "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u-4120', 'agent@example.test', 'google', 'oa-4120')",
      )
      .run();
    firstDb
      .prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('t-4120', 'u-4120', '1 Example Way')")
      .run();

    // PRECONDITION: the tables are really gone, or the assertion after launch 2 is vacuous.
    const beforeNames = tableNames(firstDb);
    for (const table of NEW_TABLES) {
      expect(`${table}:${beforeNames.has(table)}`).toBe(`${table}:false`);
    }
    await first.close();

    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const db = second.db as DatabaseType;

    const names = tableNames(db);
    for (const table of NEW_TABLES) {
      expect(`${table}:${names.has(table)}`).toBe(`${table}:true`);
    }
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_learn_%' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toEqual([
      "idx_learn_bulk_answers_user_msg_live",
      "idx_learn_deal_answers_user_key_live",
      "idx_learn_mode_settings_user_live",
    ]);
    expect(db.prepare("SELECT id FROM transactions WHERE id='t-4120'").get()).toBeTruthy();
    expect(
      (db.prepare("SELECT version FROM schema_version WHERE id=1").get() as { version: number }).version,
    ).toBe(versionBefore);

    // Constraints on the handle production hands out.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.prepare(
      `INSERT INTO learn_mode_settings (id, user_id, enabled, created_at, updated_at) VALUES ('${UUID_A}', 'u-4120', 1, 'x', 'x')`,
    ).run();
    db.prepare("DELETE FROM users_local WHERE id='u-4120'").run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM learn_mode_settings").get() as { n: number }).n).toBe(0);

    await second.close();
  });

  it("a database that already has the tables opens again and keeps its rows", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const firstDb = first.db as DatabaseType;
    firstDb
      .prepare(
        "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u-4120', 'agent@example.test', 'google', 'oa-4120')",
      )
      .run();
    firstDb
      .prepare(
        `INSERT INTO learn_deal_answers (id, user_id, run_id, address_key, property_address, answer, answered_at, rule_version, created_at, updated_at)
         VALUES ('${UUID_A}', 'u-4120', 'run-0', '1 example|', '1 Example Way', 'yes', 'x', 1, 'x', 'x')`,
      )
      .run();
    await first.close();

    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const db = second.db as DatabaseType;
    expect(db.prepare("SELECT id, answer FROM learn_deal_answers").all()).toEqual([{ id: UUID_A, answer: "yes" }]);
    await second.close();
  });
});
