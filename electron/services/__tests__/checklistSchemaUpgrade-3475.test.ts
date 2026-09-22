/**
 * @jest-environment node
 *
 * BACKLOG-3475 — THE FOUR CHECKLIST TABLES REACH AN EXISTING INSTALL, WITH NO
 * MIGRATION ENTRY.
 *
 * ===========================================================================
 * THE CLAIM UNDER TEST, AND WHY IT NEEDS A TEST AT ALL
 * ===========================================================================
 * This epic adds four tables to `schema.sql` and NO entry to `MIGRATIONS`. That
 * is only safe because `runMigrations()` re-execs the whole of `schema.sql` on
 * every launch that clears the baseline fence, unconditionally — so a
 * `CREATE TABLE IF NOT EXISTS` lands on a database that already exists.
 *
 * If that were ever not true, the failure would be invisible in development and
 * total in the field: fresh installs would work perfectly (they build from the
 * same file) while every existing user's checklist tab would fail against
 * missing tables. No unit test of the SQL can see that, because the SQL is
 * identical in both cases. Only running the real upgrade path can.
 *
 * ===========================================================================
 * WHAT THE TWO LAUNCHES ARE, AND WHAT THEY DO NOT MODEL
 * ===========================================================================
 * Launch 1 is the real `initialize()` against an empty profile — an install at
 * the current version. The four tables are then DROPPED, which puts the
 * database in exactly the state a pre-BACKLOG-3475 install is in: schema
 * version unchanged, and no trace of the tables in `sqlite_master` (dropping a
 * table drops its indexes and its triggers with it). A precondition below
 * asserts that state rather than assuming it, so the test cannot pass by never
 * having removed them.
 *
 * Launch 2 is the real `initialize()` again, on that same file. It is the
 * load-bearing half: everything asserted after it comes from the production
 * code path, on the handle production would hand out.
 *
 * What this does NOT model is a database built by an older BINARY. It cannot:
 * the older binary's `schema.sql` no longer exists in the tree. The property
 * being tested — "an existing database gains the tables" — does not depend on
 * which build wrote it.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

let userDataDir = "/tmp/unset-3475";
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

const NEW_TABLES = [
  "transaction_checklists",
  "transaction_checklist_items",
  "transaction_checklist_links",
  "transaction_checklist_link_members",
];

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

describe("BACKLOG-3475 — an existing install gains the checklist tables on next launch", () => {
  jest.setTimeout(120000);

  let dir = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3475-upgrade-"));
    userDataDir = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the tables appear, the user's data survives, and the schema version does not move", async () => {
    // ---- Launch 1: an install at the current version, with the checklist
    // tables then removed so it stands in for a pre-3475 database.
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const firstDb = first.db as DatabaseType;
    const versionBefore = (
      firstDb.prepare("SELECT version FROM schema_version WHERE id=1").get() as { version: number }
    ).version;

    firstDb.pragma("foreign_keys = OFF");
    for (const table of [...NEW_TABLES].reverse()) {
      firstDb.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    firstDb.pragma("foreign_keys = ON");
    firstDb
      .prepare(
        "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u-3475', 'agent@example.test', 'google', 'oa-3475')",
      )
      .run();
    firstDb
      .prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('t-3475', 'u-3475', '1 Example Way')")
      .run();

    // PRECONDITION: without this, a build that never created the tables and a
    // build that created them would be indistinguishable here, and the
    // assertion after launch 2 would pass for the wrong reason.
    const beforeNames = tableNames(firstDb);
    for (const table of NEW_TABLES) {
      expect(`${table}:${beforeNames.has(table)}`).toBe(`${table}:false`);
    }
    expect(
      firstDb.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_checklist%'").all(),
    ).toEqual([]);

    await first.close();

    // ---- Launch 2: the real upgrade path, on that same profile.
    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const db = second.db as DatabaseType;

    const names = tableNames(db);
    for (const table of NEW_TABLES) {
      expect(`${table}:${names.has(table)}`).toBe(`${table}:true`);
    }
    // The user's own rows are untouched, and no migration ran: this change
    // rides schema.sql's unconditional exec, not the version chain.
    expect(db.prepare("SELECT id FROM transactions WHERE id='t-3475'").get()).toBeTruthy();
    expect(
      (db.prepare("SELECT version FROM schema_version WHERE id=1").get() as { version: number }).version,
    ).toBe(versionBefore);

    // ---- The constraints work on the handle PRODUCTION hands out, not on a
    // test handle configured by this file.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.prepare(
      "INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at) VALUES ('e-1','u-3475','ext-1','outlook','acct','Offer','s@example.com','me@example.com','2026-03-01T10:00:00Z')",
    ).run();
    db.prepare(
      "INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c1','t-3475','tpl-1','Residential')",
    ).run();
    db.prepare(
      "INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required) VALUES ('i1','c1','Signed purchase agreement',1)",
    ).run();
    db.prepare(
      "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('l1','i1','email','Offer thread')",
    ).run();
    db.prepare(
      "INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES ('m1','l1','email','e-1')",
    ).run();

    db.prepare("DELETE FROM transactions WHERE id='t-3475'").run();
    expect(
      NEW_TABLES.map((t) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n),
    ).toEqual([0, 0, 0, 0]);

    await second.close();
  });
});
