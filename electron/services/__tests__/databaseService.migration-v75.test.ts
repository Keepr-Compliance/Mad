/**
 * @jest-environment node
 *
 * BACKLOG-3764 — migration v75 (`transaction_checklist_links.include_outside_dates`)
 * on the REAL upgrade path: SR plan ruling pm_comments a0241e2d on
 * BACKLOG-3764, control C11.
 *
 * A database at the v74 shape — the link table WITHOUT the column, with a
 * user's link already in it, `schema_version` = 74 — is opened by the real
 * `initialize()`. That runs the whole of `runMigrations()`: schema.sql's
 * unconditional exec FIRST, then the versioned chain. The test asserts the
 * launch succeeds, the column arrives as INTEGER NOT NULL DEFAULT 0, the
 * existing link survives with 0, and the version moves to 75.
 *
 * Mutation that must turn it red: a standalone index (or trigger/view) naming
 * `include_outside_dates` in schema.sql. schema.sql runs before v75, so on a
 * v74 database that statement fails on the missing column and the launch dies.
 *
 * Launch 1 builds an install at the current version and then removes the
 * column (SQLite DROP COLUMN), which is exactly the v74 table: v75 is the
 * only change to it. A precondition asserts that shape rather than assuming it.
 *
 * Run under Electron's node locally (the shared native module is Electron-ABI):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/__tests__/databaseService.migration-v75.test.ts --bail=0
 *
 * EVERY FIXTURE ROW IS SYNTHETIC.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

let userDataDir = "/tmp/unset-3764";
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

function loadService(): AnyService {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../tests/helpers/installTestCapabilities").installTestCapabilities();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../databaseService").default;
}

type Col = { name: string; type: string; notnull: number; dflt_value: string | null };
const linkColumns = (db: DatabaseType): Col[] =>
  db.prepare("PRAGMA table_info(transaction_checklist_links)").all() as Col[];
const version = (db: DatabaseType): number =>
  (db.prepare("SELECT version FROM schema_version WHERE id=1").get() as { version: number }).version;

describe("migration v75 — BACKLOG-3764, a v74 database on the real upgrade path", () => {
  jest.setTimeout(120000);
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3764-v75-"));
    userDataDir = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is in the chain as v75, the last entry", () => {
    const svc = loadService();
    const versions = (svc.constructor as { MIGRATIONS: Array<{ version: number }> }).MIGRATIONS.map(
      (m) => m.version,
    );
    expect(versions[versions.length - 1]).toBe(75);
  });

  it("C11: a v74 database with a link opens, gains the column, and keeps the link with 0", async () => {
    // ---- Launch 1: an install at the current version, then put it back at v74.
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const firstDb = first.db as DatabaseType;
    firstDb.exec("ALTER TABLE transaction_checklist_links DROP COLUMN include_outside_dates");
    firstDb.prepare("UPDATE schema_version SET version = 74 WHERE id = 1").run();
    firstDb.exec(`
      INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u-3764', 'agent@example.test', 'google', 'oa-3764');
      INSERT INTO transactions (id, user_id, property_address) VALUES ('t-3764', 'u-3764', '1 Example Way');
      INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at)
        VALUES ('e-3764', 'u-3764', 'ext-3764', 'gmail', 'acct', 'Offer', 's@example.com', 'me@example.com', '2026-10-03T15:00:00.000Z');
      INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c-3764', 't-3764', 'tpl-1', 'Residential');
      INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required) VALUES ('i-3764', 'c-3764', 'Signed offer', 1);
      INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('l-3764', 'i-3764', 'email', 'Offer');
      INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES ('m-3764', 'l-3764', 'email', 'e-3764');
    `);
    // PRECONDITION: the v74 shape, asserted rather than assumed.
    expect(linkColumns(firstDb).map((c) => c.name)).not.toContain("include_outside_dates");
    expect(version(firstDb)).toBe(74);
    await first.close();

    // ---- Launch 2: the real runMigrations (schema.sql exec, then the chain).
    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const db = second.db as DatabaseType;

    const col = linkColumns(db).find((c) => c.name === "include_outside_dates");
    expect(col).toEqual({
      name: "include_outside_dates",
      type: "INTEGER",
      notnull: 1,
      dflt_value: "0",
      cid: expect.any(Number),
      pk: 0,
    });
    expect(version(db)).toBe(75);
    expect(
      db.prepare("SELECT id, include_outside_dates FROM transaction_checklist_links").all(),
    ).toEqual([{ id: "l-3764", include_outside_dates: 0 }]);
    expect(db.prepare("SELECT id FROM transaction_checklist_link_members").all()).toEqual([
      { id: "m-3764" },
    ]);
    await second.close();
  });

  it("a fresh install has the column once, and a re-run of v75 changes nothing", async () => {
    const svc = loadService();
    await expect(svc.initialize()).resolves.toBe(true);
    const db = svc.db as DatabaseType;
    const before = linkColumns(db);
    expect(before.filter((c) => c.name === "include_outside_dates")).toHaveLength(1);
    const v75 = (svc.constructor as { MIGRATIONS: Array<{ version: number; migrate: (d: DatabaseType) => void }> })
      .MIGRATIONS.find((m) => m.version === 75);
    expect(() => db.transaction(() => v75?.migrate(db))()).not.toThrow();
    expect(linkColumns(db)).toEqual(before);
    await svc.close();
  });
});
