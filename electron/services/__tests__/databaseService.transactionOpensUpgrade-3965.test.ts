/**
 * @jest-environment node
 *
 * BACKLOG-3965 PR-2 — `transaction_opens` reaches EXISTING installs with no
 * migration version, because the real `initialize()` re-executes schema.sql on
 * every open (SR plan review 3965 §2: the 3343 precedent). Harness transcribed
 * from databaseService.openSessionsUpgrade-3343.test.ts.
 *
 * Case 1 — an older database (table dropped, version set back): gains the table.
 *   MUTATION: remove the CREATE TABLE block from schema.sql -> red.
 * Case 2 — a database that already has the table and a row: opens again and the
 *   row is still there. Case 1 cannot see a missing IF NOT EXISTS (it drops the
 *   table first); this case can.
 *   MUTATION: drop IF NOT EXISTS from the table or the index -> red.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

let userDataDir = "/tmp/unset-3965";
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
  captureMessage: jest.fn(),
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

function loadService(): AnyService {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../tests/helpers/installTestCapabilities").installTestCapabilities();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../databaseService").default;
}

const hasTable = (db: DatabaseType): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transaction_opens'").get() !== undefined;
const version = (db: DatabaseType): number =>
  (db.prepare("SELECT version FROM schema_version WHERE id=1").get() as { version: number }).version;

function seedDeal(db: DatabaseType): void {
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u-3965', 'u@example.test', 'google', 'o')").run();
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('t-3965', 'u-3965', '1 Test Road')").run();
}

function openStore() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../db/transactionOpenDbService");
}

describe("BACKLOG-3965 transaction_opens on the upgrade path", () => {
  jest.setTimeout(120000);
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3965-up-"));
    userDataDir = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an older database (no table) gets the table on its next open, with no version bump", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const firstDb = first.db as DatabaseType;
    const current = version(firstDb);
    firstDb.exec("DROP TABLE transaction_opens");
    firstDb.prepare("UPDATE schema_version SET version = 77 WHERE id = 1").run();
    expect(hasTable(firstDb)).toBe(false);
    await first.close();

    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const db = second.db as DatabaseType;
    expect(hasTable(db)).toBe(true);
    expect(version(db)).toBe(current);
    seedDeal(db);
    expect(openStore().recordTransactionOpen("t-3965", "2026-10-31T10:00:00.000Z")).toBe(true);
    expect(openStore().getRecentlyOpenedTransactions("u-3965", 5).map((r: { transactionId: string }) => r.transactionId)).toEqual(["t-3965"]);
    await second.close();
  });

  it("a database that already has the table opens again and keeps its rows", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    seedDeal(first.db as DatabaseType);
    expect(openStore().recordTransactionOpen("t-3965", "2026-10-31T10:00:00.000Z")).toBe(true);
    await first.close();

    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const db = second.db as DatabaseType;
    expect(db.prepare("SELECT transaction_id, opened_at FROM transaction_opens").all()).toEqual([
      { transaction_id: "t-3965", opened_at: "2026-10-31T10:00:00.000Z" },
    ]);
    await second.close();
  });
});
