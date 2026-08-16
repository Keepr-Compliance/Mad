/**
 * @jest-environment node
 *
 * LEGACY-COLUMN UPGRADE — BACKLOG-2750
 *
 * Drives a REAL historical database — `electron/database/schema.sql` as it stood
 * at 5cec24486 (2026-01-26), transcribed verbatim, declaring schema_version 23 —
 * through TODAY'S `runMigrations()` on a real file.
 *
 * ===========================================================================
 * THE DEFECT, AND WHO ACTUALLY CAUSED IT
 * ===========================================================================
 * `runMigrations()` does `exec(schemaSql)` and THEN `_runVersionedMigrations()`
 * (databaseService.ts:776 -> 777). `CREATE TABLE IF NOT EXISTS` is a no-op on a
 * table that already exists, so an existing database NEVER gains a column from
 * schema.sql — it can only gain one from the versioned chain. A standalone
 * `CREATE INDEX ... ON <table>(<column>)` in schema.sql therefore throws
 * "no such column" on a real upgrade and aborts the WHOLE migration before the
 * chain gets a chance to add anything (auto-restore -> the app hangs on
 * "Starting up your secure database").
 *
 * BACKLOG-2750 was filed against TASK-1110. That attribution is wrong, and the
 * correction is load-bearing because it says which databases are exposed:
 *
 *   847d6eec4 (2026-01-17, TASK-1110) added `attachments.external_message_id`
 *   TOGETHER WITH a working upgrade path — a legacy
 *   `addMissingColumns('attachments', [...ALTER TABLE...])` plus a `runSafe`
 *   index create. Upgrades were covered.
 *
 *   db3733343 (2026-02-17, "consolidate 28 migrations into schema.sql with
 *   version-based runner", shipped v2.4.1) DELETED that legacy system and left
 *   the standalone CREATE INDEX statements behind. From that release on,
 *   NOTHING adds these columns at any version.
 *
 * `git log -S "addMissingColumns('attachments'"` returns exactly those two
 * commits. `grep -rn "ALTER TABLE attachments" electron/` returns nothing.
 *
 * ===========================================================================
 * ELEVEN INSTANCES, NOT ONE — AND ATTACHMENTS IS NOT THE FIRST TO FIRE
 * ===========================================================================
 * Derived by execution, not by grep. A real pre-TASK-1110 database built from
 * git history, then fed today's schema.sql through the sqlite3 CLI WITHOUT
 * `.bail` (so it enumerates every failure instead of stopping at the first):
 *
 *     git show 847d6eec4^:electron/database/schema.sql | sqlite3 old.db
 *     sqlite3 old.db < electron/database/schema.sql
 *     -> 11 "no such column" errors
 *
 * users_local(license_type, organization_id), attachments(email_id,
 * external_message_id), transactions(last_exported_on, submission_status,
 * submission_id) — seven with no add path anywhere, fixed by migration v63 —
 * plus four on `communications`, which are a DIFFERENT shape (v43 rebuilds that
 * table and recreates those indexes) and are filed separately.
 *
 * The item predicted the crash at schema.sql:1061. It is NOT the first to fire:
 * :984 `license_type` precedes it, and :1060 `email_id` precedes it. No fixture
 * was doctored to force death at :1061 — the errors are reported as they fire.
 *
 * ===========================================================================
 * WHY THIS FIXTURE AND NOT AN OLDER ONE
 * ===========================================================================
 * A genuinely pre-TASK-1110 snapshot CANNOT demonstrate a clean upgrade, for a
 * reason that is itself a finding: migration v43 rebuilds `communications` with
 * `INSERT ... SELECT ... email_id, thread_id FROM communications_old`, and a
 * pre-2026-01-26 `communications` table has neither column (it has
 * `email_thread_id`). Such a database dies inside v43 no matter what this fix
 * does. That is a separate, deeper defect and is filed as its own item.
 *
 * 5cec24486 is the NEWEST snapshot that still reproduces BACKLOG-2750 while
 * remaining upgradeable: `communications` has just gained email_id/thread_id
 * (so v43 survives) while `attachments` has not yet gained `email_id` (that is
 * c90a869f8, five days later). The exposed window is real, not constructed.
 *
 * ===========================================================================
 * CONTROLS — RUN, AND WHAT THEY DID
 * ===========================================================================
 * A test that has never failed is not evidence.
 *
 * CONTROL 1 — revert the schema.sql half (restore the 7 standalone CREATE INDEX
 *   statements) while keeping migration v63.
 *   RESULT: RED, and specifically the upgrade throws before the chain runs:
 *       SqliteError: no such column: email_id
 *   Recorded with full output on BACKLOG-2750 in pm_comments.
 *
 * CONTROL 2 — revert the migration half (delete v63) while keeping the
 *   schema.sql edits.
 *   RESULT: RED on the column/index assertions — exec(schema.sql) no longer
 *   crashes, but nothing ever adds the columns, which is the "silently
 *   index-less forever" end state this migration exists to prevent.
 *
 * CONTROL 3 — fresh-install parity, measured rather than asserted: a database
 *   built from scratch pre-fix and post-fix has an IDENTICAL
 *   `PRAGMA table_info` set and index set for all three tables (see the
 *   fresh-install test below, and the diff recorded on the item).
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — same block as databaseService.migrationChainRehearsal.test.ts.
// Sentry.flush is included because runMigrations() awaits it on the failure
// path; without it a genuine migration failure surfaces as "Sentry.flush is not
// a function" instead of the real error, which would hide exactly what the
// controls above prove.
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
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
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
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

import { setDb, setDbPath, setEncryptionKey } from "../db/core/dbConnection";

// Bypass the Jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock — the whole point of this file is a real file-backed DB.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

/** The historical schema, verbatim. See that file's header for provenance. */
const HISTORICAL_SCHEMA_PATH = path.join(
  __dirname,
  "fixtures",
  "schema-2026-01-26-5cec24486.sql",
);

/** `schema_version` the 2026-01-26 snapshot declares. */
const HISTORICAL_VERSION = 23;

/** Live schema.sql — the one `runMigrations()` actually execs. */
const LIVE_SCHEMA_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

/**
 * The seven (table, column, index) triples BACKLOG-2750 repairs. Kept as data so
 * every assertion below iterates the SAME list — a column added without its
 * index, or an index without its column, cannot slip through.
 */
const REPAIRED: ReadonlyArray<{ table: string; column: string; index: string }> = [
  { table: "users_local", column: "license_type", index: "idx_users_local_license_type" },
  { table: "users_local", column: "organization_id", index: "idx_users_local_organization" },
  { table: "attachments", column: "email_id", index: "idx_attachments_email_id" },
  {
    table: "attachments",
    column: "external_message_id",
    index: "idx_attachments_external_message_id",
  },
  {
    table: "transactions",
    column: "last_exported_on",
    index: "idx_transactions_last_exported_on",
  },
  {
    table: "transactions",
    column: "submission_status",
    index: "idx_transactions_submission_status",
  },
  { table: "transactions", column: "submission_id", index: "idx_transactions_submission_id" },
];

const USER_ID = "u-2750-legacy";
const TRANSACTION_ID = "t-2750-legacy";
const MESSAGE_ID = "m-2750-legacy";
const ATTACHMENT_ID = "a-2750-legacy";
/** The GUID the attachment is linked by — the whole point of TASK-1110. */
const ATTACHMENT_GUID = "guid-2750-stable";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

describe("databaseService — 2026-01-26 legacy-column upgrade (BACKLOG-2750)", () => {
  let service: AnyService;
  let tmpDir: string;
  let dbFile: string;
  let db: DatabaseType;
  const createdTmpDirs: string[] = [];

  function columnNames(table: string): string[] {
    return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
  }

  function indexNames(table: string): string[] {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?")
        .all(table) as Array<{ name: string }>
    )
      .map((r) => r.name)
      .sort();
  }

  function schemaVersion(): number {
    return (db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
      version: number;
    }).version;
  }

  /**
   * ANCHOR — called at the top of every upgrade test. If `dbPath` were null or
   * ":memory:", this suite would silently stop testing the upgrade path and
   * start testing nothing, which is the exact blind spot it exists to close.
   */
  function assertRealOnDiskTarget(): void {
    expect(service.dbPath).not.toBeNull();
    expect(service.dbPath).not.toBe(":memory:");
    expect(service.dbPath).toBe(dbFile);
    expect(fs.existsSync(dbFile)).toBe(true);
    const list = db.pragma("database_list") as Array<{ name: string; file: string }>;
    const mainDb = list.find((r) => r.name === "main");
    expect(fs.realpathSync(String(mainDb?.file))).toBe(fs.realpathSync(dbFile));
  }

  /** The ACT phase: the PUBLIC entry point, so schema.sql is exec'd for real. */
  async function upgrade(): Promise<void> {
    await service.runMigrations();
    db = service.db as DatabaseType;
  }

  function attachService(): void {
    // Deferred require so the jest.mock factories above are applied first.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../databaseService").default;
    service.db = db;
    service.dbPath = dbFile;
    service.encryptionKey = "test-encryption-key-hex";
    setDb(db);
    setDbPath(dbFile);
    setEncryptionKey("test-encryption-key-hex");
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-legacy-2750-"));
    createdTmpDirs.push(tmpDir);
    dbFile = path.join(tmpDir, "mad.db");

    db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // ARRANGE — the historical schema, replayed verbatim onto a real file.
    db.exec(fs.readFileSync(HISTORICAL_SCHEMA_PATH, "utf8"));

    // Populate. Rows are seeded with literal ids so survival is asserted by
    // IDENTITY, not by count: a count cannot tell "the row survived" apart from
    // "the row was dropped and another appeared".
    db.exec(`
      INSERT INTO users_local (id, email, oauth_provider, oauth_id)
        VALUES ('${USER_ID}', 'legacy-2750@example.test', 'google', 'oauth-2750');
      INSERT INTO transactions (id, user_id, property_address)
        VALUES ('${TRANSACTION_ID}', '${USER_ID}', '742 Evergreen Terrace');
      INSERT INTO messages (id, user_id)
        VALUES ('${MESSAGE_ID}', '${USER_ID}');
      INSERT INTO attachments (id, message_id, external_message_id, filename)
        VALUES ('${ATTACHMENT_ID}', '${MESSAGE_ID}', '${ATTACHMENT_GUID}', 'disclosure.pdf');
    `);

    // Re-enable FK enforcement AFTER the restore. `_runVersionedMigrations`
    // reads the CURRENT pragma into `fkWasOn` and only restores enforcement if
    // it was on to begin with — left off, this suite would run the chain from
    // the wrong starting state.
    db.pragma("foreign_keys = ON");

    attachService();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    service.db = null;
    service.dbPath = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    for (const d of createdTmpDirs) expect(fs.existsSync(d)).toBe(false);
  });

  // =========================================================================
  // PRECONDITIONS — the fixture really is the old shape
  // =========================================================================

  it("PRECONDITION: the fixture is a populated 2026-01-26 database missing exactly the columns at issue", () => {
    assertRealOnDiskTarget();
    expect(schemaVersion()).toBe(HISTORICAL_VERSION);

    // The defect requires the TABLES to exist (so CREATE TABLE IF NOT EXISTS is
    // a no-op) while the COLUMNS do not.
    for (const table of ["users_local", "attachments", "transactions"]) {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table),
      ).toBeTruthy();
    }
    // This snapshot lacks EXACTLY ONE of the seven repaired columns —
    // `attachments.email_id`, which arrives five days later (c90a869f8,
    // 2026-01-31). That is not a weakness of the fixture, it is why this commit
    // was chosen: it is the NEWEST point on the timeline that still reproduces
    // BACKLOG-2750, and the crash it produces is on the attachments table the
    // item was filed about. Measured against today's schema.sql with the sqlite3
    // CLI: exactly 1 error pre-fix, 0 post-fix.
    expect(columnNames("attachments")).not.toContain("email_id");

    // The other six columns are ALREADY present here (license_type /
    // organization_id / submission_* landed 2026-01-22; last_exported_on
    // 2025-11-17; external_message_id 2026-01-17). Asserted positively so this
    // precondition states the fixture's real shape rather than implying it is
    // missing everything. Databases old enough to lack THOSE columns exist, but
    // they die inside migration v43 for an unrelated reason (see the header) and
    // so cannot be driven through a clean upgrade by any fix in this PR.
    expect(columnNames("users_local")).toContain("license_type");
    expect(columnNames("users_local")).toContain("organization_id");
    expect(columnNames("transactions")).toContain("submission_id");
    expect(columnNames("attachments")).toContain("external_message_id");

    // ...and it is genuinely populated, so the migration runs against rows.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n,
    ).toBe(1);
  });

  it("PRECONDITION: today's schema.sql no longer carries a standalone index for any repaired column", () => {
    // The half of the fix that lives in schema.sql. If a future edit re-adds one
    // of these statements, the upgrade path breaks again silently on databases
    // this suite cannot enumerate — so assert their ABSENCE directly, at the
    // source, rather than inferring it from a green upgrade.
    const liveSchema = fs.readFileSync(LIVE_SCHEMA_PATH, "utf8");
    const uncommented = liveSchema
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    for (const { index } of REPAIRED) {
      expect(uncommented).not.toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
    }

    // ...while the COLUMNS must still be declared in CREATE TABLE, which is what
    // keeps the fresh-install path byte-identical.
    for (const { column } of REPAIRED) {
      expect(uncommented).toContain(column);
    }
  });

  // =========================================================================
  // THE UPGRADE
  // =========================================================================

  it("upgrades a 2026-01-26 database without throwing (pre-fix: no such column: email_id)", async () => {
    assertRealOnDiskTarget();
    // Pre-fix this rejects inside exec(schema.sql), BEFORE the versioned chain.
    await expect(upgrade()).resolves.not.toThrow();
  });

  it("adds every repaired column AND its index", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    for (const { table, column, index } of REPAIRED) {
      expect(columnNames(table)).toContain(column);
      expect(indexNames(table)).toContain(index);
    }
  });

  it("DOCUMENTS A SEPARATE PRE-EXISTING DEFECT: one upgrade lands on BASELINE, not head", async () => {
    // NOT a BACKLOG-2750 behaviour, and deliberately NOT fixed here — recorded
    // because it changes what "upgraded" means for every below-baseline install.
    //
    // `_runVersionedMigrations` captures `currentVersion` BEFORE the loop, runs
    // the whole chain (each migration writing its own version), and then, at
    // databaseService.ts:3756, unconditionally does
    //     if (currentVersion < BASELINE_VERSION)
    //         UPDATE schema_version SET version = 29
    // — overwriting the head version the loop just wrote. So a below-baseline
    // database finishes its FIRST launch marked 29 despite having run every
    // migration, and replays the ENTIRE chain on its next launch.
    //
    // Consequence that matters for THIS PR: migration v63 runs TWICE on exactly
    // the databases it was written for. Its `if (!cols.includes(column))` guard
    // is therefore load-bearing, not defensive decoration — without it the
    // second pass throws "duplicate column name". The idempotency test below is
    // what proves that, and it is only meaningful because of this clamp.
    await upgrade();
    expect(schemaVersion()).toBe(29);
  });

  it("lands on the head schema version once the baseline clamp has been consumed", async () => {
    // Second launch: `currentVersion` is now 29, the clamp's condition
    // (29 < 29) is false, and the chain's own version write survives.
    await upgrade();
    await upgrade();
    const head = (
      require("../databaseService").default.constructor as {
        MIGRATIONS: Array<{ version: number }>;
      }
    ).MIGRATIONS;
    expect(schemaVersion()).toBe(head[head.length - 1].version);
  });

  it("preserves the seeded rows BY IDENTITY across the upgrade", async () => {
    await upgrade();

    expect(
      (db.prepare("SELECT id FROM attachments").all() as Array<{ id: string }>).map((r) => r.id),
    ).toEqual([ATTACHMENT_ID]);
    expect(
      (db.prepare("SELECT id FROM transactions").all() as Array<{ id: string }>).map((r) => r.id),
    ).toEqual([TRANSACTION_ID]);
    expect(
      (db.prepare("SELECT id FROM users_local").all() as Array<{ id: string }>).map((r) => r.id),
    ).toEqual([USER_ID]);

    // The TASK-1110 GUID — the value the whole column exists to carry — must
    // survive intact, not merely be present as a column.
    expect(
      (
        db
          .prepare("SELECT external_message_id AS g FROM attachments WHERE id = ?")
          .get(ATTACHMENT_ID) as { g: string }
      ).g,
    ).toBe(ATTACHMENT_GUID);
  });

  it("backfills the new columns with the SAME defaults a fresh install would give them", async () => {
    await upgrade();

    // `license_type` and `submission_status` carry DEFAULT literals in
    // schema.sql. SQLite applies an ADD COLUMN default to pre-existing rows, so
    // an upgraded row must read the same as a freshly-inserted one — otherwise
    // upgraded users would sit on NULL where fresh users sit on a real value.
    expect(
      (
        db.prepare("SELECT license_type AS v FROM users_local WHERE id = ?").get(USER_ID) as {
          v: string | null;
        }
      ).v,
    ).toBe("individual");
    expect(
      (
        db
          .prepare("SELECT submission_status AS v FROM transactions WHERE id = ?")
          .get(TRANSACTION_ID) as { v: string | null }
      ).v,
    ).toBe("not_submitted");

    // ...and the columns with no default are NULL, not absent.
    expect(
      (
        db.prepare("SELECT email_id AS v FROM attachments WHERE id = ?").get(ATTACHMENT_ID) as {
          v: string | null;
        }
      ).v,
    ).toBeNull();
  });

  it("leaves the database structurally intact", async () => {
    await upgrade();
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("survives the REPLAY the baseline clamp forces — no duplicate-column throw", async () => {
    // The clamp above guarantees a below-baseline database runs v63 twice. This
    // is that exact sequence, so the guard is exercised the way production will
    // exercise it — not as a hypothetical re-run.
    await upgrade();
    await expect(upgrade()).resolves.not.toThrow();
    // A third pass for good measure: by now the version has settled on head, so
    // the chain no longer replays and v63 must simply not be reached or not care.
    await expect(upgrade()).resolves.not.toThrow();
    for (const { table, column, index } of REPAIRED) {
      expect(columnNames(table)).toContain(column);
      expect(indexNames(table)).toContain(index);
    }
    // The replay must not have duplicated the column either.
    expect(columnNames("attachments").filter((c) => c === "email_id")).toHaveLength(1);
  });

  // =========================================================================
  // FRESH INSTALL — the path that was already correct, and must stay so
  // =========================================================================

  it("FRESH INSTALL: still gets every repaired column and index", async () => {
    // Rebuild the harness against an EMPTY file: schema.sql creates the tables
    // with the columns in the CREATE TABLE body, and migration v63 supplies the
    // indexes that used to come from the standalone statements. If v63 ever
    // stopped running on this path, fresh installs would quietly lose seven
    // indexes — a slow query, not a crash, and therefore invisible without this.
    db.close();
    fs.rmSync(dbFile, { force: true });
    db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    attachService();

    await upgrade();

    for (const { table, column, index } of REPAIRED) {
      expect(columnNames(table)).toContain(column);
      expect(indexNames(table)).toContain(index);
    }
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  });
});
