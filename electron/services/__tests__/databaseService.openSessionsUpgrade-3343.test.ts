/**
 * @jest-environment node
 *
 * BACKLOG-3343 — the new `iphone_sync_open_sessions` table reaches EXISTING installs
 * with no migration version, because the real `initialize()` re-executes schema.sql
 * on every open (SR plan review pm_comments 90d03930: no migration; v78 unclaimed).
 *
 * Launch 1: the real `initialize()` builds an install at the current version; the
 * table is then dropped and schema_version set to 77, which is the shape of a
 * v2.44/2.45 database before this change (the table is the only difference).
 * Launch 2: the real `initialize()` opens it. The table must exist and accept writes.
 *
 * MUTATION: remove the CREATE TABLE block from schema.sql -> red.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

let userDataDir = "/tmp/unset-3343";
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
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'iphone_sync_open_sessions'").get() !==
  undefined;
const version = (db: DatabaseType): number =>
  (db.prepare("SELECT version FROM schema_version WHERE id=1").get() as { version: number }).version;

describe("BACKLOG-3343 iphone_sync_open_sessions on the upgrade path", () => {
  jest.setTimeout(120000);
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3343-up-"));
    userDataDir = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a pre-3343 database (v77, no table) gets the table on its next open, with no version bump", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const firstDb = first.db as DatabaseType;
    const current = version(firstDb);
    firstDb.exec("DROP TABLE iphone_sync_open_sessions");
    firstDb.prepare("UPDATE schema_version SET version = 77 WHERE id = 1").run();
    expect(hasTable(firstDb)).toBe(false);
    await first.close();

    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const db = second.db as DatabaseType;

    expect(hasTable(db)).toBe(true);
    // No migration is needed for the table: the runner brings the version back to
    // where it was, and the table is present at it.
    expect(version(db)).toBe(current);
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u-3343', 'u@example.test', 'google', 'o')").run();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const openSessions = require("../db/iphoneSyncOpenSessionDbService");
    openSessions.markStarted("u-3343", "s-3343");
    expect(openSessions.listOpen()).toEqual([{ sessionId: "s-3343", userId: "u-3343" }]);
    await second.close();
  });
});
