/**
 * @jest-environment node
 *
 * REAL ON-DISK upgrade test — BACKLOG-2364 (tombstone columns, migration v56).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE ADDS — AND WHAT IT DOES *NOT* (read this before citing it)
 * ---------------------------------------------------------------------------
 * Every other migration test in this repo runs against `new Database(":memory:")`
 * with `service.dbPath = null` (migrationTestHarness.ts:359, 377). `runMigrations()`
 * gates five branches on a real `dbPath` pointing at an existing file, and
 * `_runVersionedMigrations()` gates a hard failure on it.
 *
 * It is TEMPTING — and WRONG — to conclude those branches were untested. They
 * were already covered, most on BOTH sides of the gate, by
 * `databaseService.migration-restore.test.ts` (TASK-2057), which mocks `fs`
 * wholesale and asserts on `copyFileSync` / `unlinkSync` call arguments. An
 * earlier draft of this header claimed the apparatus "has never executed in a
 * single test". That was false for 5 of the 6 branches. Accurate picture:
 *
 *   Branch                                  Line   Pre-existing coverage
 *   --------------------------------------  -----  ---------------------------
 *   willRunMigration                         644   YES, both sides
 *                                                  migration-restore :281 / :290
 *   pre-migration rolling backup             668   YES, both sides (same tests)
 *   pre-junction snapshot (version < 41)     691   YES, all 3 paths :706/:746/:759
 *                                                  — including the v<41 TRUE path
 *                                                  THIS file cannot reach (55->56)
 *   backup retention prune (keep last 3)     752   NO — genuinely uncovered
 *   30-day snapshot cleanup                  772   YES, both sides :790 / :823
 *   backup-required guard (throws)          2853   YES, both sides. Reject:
 *                                                  migration.test.ts:361.
 *                                                  Satisfied: migration-restore
 *                                                  :790 / :823
 *
 * So the honest claim is "previously uncovered WITHOUT MOCKS", not "uncovered".
 * The one branch nothing in the repo reached was the retention prune at 752 —
 * `"Removed old backup:"` (databaseService.ts:764) appears in no test in the
 * codebase. The 13th test below now executes it on a real filesystem.
 *
 * THE GENUINELY NOVEL COVERAGE, stated plainly, because it is real:
 *
 *  1. A real v55 -> v56 run of the real migration chain over the real
 *     `schema.sql` against a real FILE. This is the BACKLOG-2298 / BACKLOG-2300
 *     failure class: a migration that adds a column plus a standalone
 *     `CREATE INDEX` in schema.sql passes every existing test (per-migration
 *     tests call `_runVersionedMigrations()` directly, schema-parity seeds both
 *     sides from the current schema.sql, E2E seeds at HEAD) and then throws
 *     "no such column" on a real upgrade, because schema.sql is exec'd BEFORE
 *     the chain. No other test starts from a real prior-version on-disk DB.
 *     BACKLOG-2298 shipped exactly this and the founder caught it in live QA.
 *  2. Backup CONTENT assertions, which mocked `fs` cannot express. The existing
 *     tests assert `copyFileSync` was CALLED with a plausible path; they cannot
 *     detect a backup that is empty, corrupt, or taken AFTER the migration.
 *     This file opens the backup as its own database and reads it.
 *  3. Real WAL sidecars, a real `wal_checkpoint(TRUNCATE)`, and durability
 *     across a genuinely fresh connection.
 *
 * Point 1 also cannot be covered manually: the founder's installed app is
 * notarized, a dev build is not, and the SQLite encryption key is tied to the
 * code signature — so a dev build cannot open his real database at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES DIFFERENTLY
 * ---------------------------------------------------------------------------
 * 1. The database is a genuine FILE in an `os.tmpdir()` scratch directory, opened
 *    with the production pragma set (WAL, foreign_keys, busy_timeout,
 *    synchronous) from `_openDatabase()`. Not `:memory:`.
 * 2. `service.dbPath` points at that file during the act phase. If it were null
 *    this file would prove nothing — so `assertRealOnDiskTarget()` runs at the
 *    top of EVERY test as an explicit anchor (see NEGATIVE CONTROL 2 below).
 * 3. The pre-v56 state is built from REAL artefacts only: exec the real
 *    `electron/database/schema.sql` (which seeds schema_version = 32), then run
 *    the REAL migration chain through the REAL runner, filtered to versions <=
 *    55. Nothing about the v55 shape is hand-written here, so this fixture
 *    cannot drift away from what a real v55 install looks like.
 * 4. The act phase calls the PUBLIC `runMigrations()` entry point, not
 *    `_runVersionedMigrations()` directly, so the backup/snapshot branches run.
 *
 * ---------------------------------------------------------------------------
 * IS THE BACKUP BRANCH OBSERVABLE? YES — THREE WAYS (see the backup test)
 * ---------------------------------------------------------------------------
 *   (a) a `mad-backup-<ts>.db` file appears next to `mad.db`;
 *   (b) logService.info is called with "Pre-migration backup created";
 *   (c) that backup file, opened as its own database, is a genuine PRE-migration
 *       snapshot — schema_version 55, no tombstone columns. (c) is what makes
 *       this an assertion about content rather than about an empty file existing.
 * The pre-junction snapshot branch (databaseService.ts:691) is gated on
 * version < 41 and therefore CANNOT fire on a 55 -> 56 upgrade; its absence is
 * asserted explicitly rather than left unmentioned.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS — this file was verified by making it FAIL
 * ---------------------------------------------------------------------------
 * A test that has never failed is not evidence. Every control below was run and
 * produced the required failure; the source tree was restored and verified
 * byte-identical (`git diff` empty) after each.
 *
 *   1. Neuter v56's `ALTER TABLE ... ADD COLUMN` loop -> 2 fail (the column and
 *      persistence assertions).
 *   2. Force `service.dbPath = null` at act time -> ALL tests fail at
 *      `assertRealOnDiskTarget()`. The most important control: a test that
 *      quietly fell back to `:memory:` would recreate the very blind spot it
 *      was written to close, so the on-disk target is asserted per-test rather
 *      than assumed once in beforeEach.
 *   2b. Bind the handle to `":memory:"` while leaving `dbPath` correct -> all
 *      fail. Isolated variant (real file present, so `existsSync` cannot catch
 *      it first) fails on `expect(mainDb?.file).toBeTruthy()`, `Received: ""`.
 *   3. Swap one seeded contact id while HOLDING THE ROW COUNT AT 3 -> 4 fail on
 *      the ID-SET assertions. A count assertion would have passed.
 *   4. Neuter the retention prune (`backupFiles.slice(3)` -> `[]`) -> exactly 1
 *      fails: "Expected length: 3, Received length: 5".
 *
 * Independently re-run by SR review on a restored tree: control 2 (all fail at
 * :243), control 1 (exactly 2 fail), plus a stronger variant of 2b — pointing
 * the handle at a DIFFERENT real, realpath-able file — which also fails all
 * tests, confirming the Windows realpath fix still discriminates identity
 * rather than merely normalising path format.
 *
 * Full results are recorded on BACKLOG-2364 in pm_comments.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — same pattern as databaseService.runMigrations-upgrade-v55.test.ts.
// Sentry.flush is included because runMigrations() awaits it on the failure
// path (databaseService.ts:744); without it a genuine migration failure would
// surface as "Sentry.flush is not a function" instead of the real error.
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

// ---------------------------------------------------------------------------
// IMPORTS
// ---------------------------------------------------------------------------

import logService from "../logService";
import { setDb, setDbPath, setEncryptionKey } from "../db/core/dbConnection";

// Bypass the Jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock — the whole point of this file is a real file-backed DB.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// The exact file runMigrations() reads (databaseService.ts:607).
const SCHEMA_SQL_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

/** The version this fixture is brought to before the upgrade under test. */
const PRE_UPGRADE_VERSION = 55;
/** The version migration v56 must land on. */
const HEAD_VERSION = 56;

const USER_ID = "user-ondisk-2364";
const TXN_ID = "txn-ondisk-2364";
/** Fixed ids — the exact SETS asserted before and after the upgrade. */
const CONTACT_IDS = ["c-ondisk-alpha", "c-ondisk-beta", "c-ondisk-gamma"];
const TC_IDS = ["tc-ondisk-alpha", "tc-ondisk-beta"];

const TOMBSTONE_COLUMNS = ["removed_at", "removed_reason"];
const TOMBSTONE_TABLES = ["contacts", "transaction_contacts"];

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function columns(d: DatabaseType, table: string): string[] {
  return (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function schemaVersionOf(d: DatabaseType): number {
  return (d.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number })
    .version;
}

/** Every index name in the DB, sorted — including UNIQUE auto-indexes. */
function indexNames(d: DatabaseType): string[] {
  return (
    d
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function idsIn(d: DatabaseType, table: string): string[] {
  return (d.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

/**
 * Open a REAL file-backed database with the production pragma set from
 * databaseService._openDatabase() (databaseService.ts:313-340), minus the
 * SQLCipher key + cipher_compatibility pair — this fixture is unencrypted, and
 * encryption is orthogonal to migration ordering (the key service is mocked).
 *
 * journal_mode = WAL matters here specifically: it is what makes `-wal` / `-shm`
 * sidecar files real, exercises the `wal_checkpoint(TRUNCATE)` inside the backup
 * branch (databaseService.ts:673), and makes the "reopen in a fresh connection"
 * assertion a genuine durability check rather than a read of the same page cache.
 */
function openRealDb(file: string): DatabaseType {
  const d = new RealDatabase(file) as DatabaseType;
  d.pragma("foreign_keys = ON");
  d.pragma("busy_timeout = 5000");
  d.pragma("journal_mode = WAL");
  d.pragma("synchronous = NORMAL");
  return d;
}

/** Mock-call inspection without dragging jest.Mock generics through the file. */
function infoLogMessages(): string[] {
  const calls = (logService.info as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.map((c) => String(c[0]));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

// ---------------------------------------------------------------------------

describe("databaseService — REAL on-disk v55 -> v56 upgrade (BACKLOG-2364)", () => {
  let service: AnyService;
  let tmpDir: string;
  let dbFile: string;
  let db: DatabaseType;
  /** Every temp dir this suite creates, so afterAll can prove none survived. */
  const createdTmpDirs: string[] = [];

  /**
   * NEGATIVE-CONTROL ANCHOR (control 2).
   *
   * Called at the top of EVERY test. If `dbPath` is ever null or `:memory:`,
   * every test in this file fails loudly instead of silently passing against an
   * in-memory DB — which is exactly the blind spot this file exists to close.
   * Do not move this into beforeEach: a test that reassigns dbPath mid-run must
   * still be caught.
   */
  function assertRealOnDiskTarget(): void {
    expect(service.dbPath).not.toBeNull();
    expect(service.dbPath).not.toBe(":memory:");
    expect(service.dbPath).toBe(dbFile);
    expect(path.isAbsolute(String(service.dbPath))).toBe(true);
    expect(fs.existsSync(dbFile)).toBe(true);
    // A real SQLite file with a full schema, not a zero-byte placeholder.
    expect(fs.statSync(dbFile).size).toBeGreaterThan(0);
    // ...and the handle really is bound to that file, not to memory. An
    // in-memory connection reports an EMPTY file here, so this is the assertion
    // that catches a silent ":memory:" fallback which left dbPath looking right.
    //
    // realpath BOTH sides rather than comparing raw strings: macOS reports
    // /private/var for a /var symlink, and Windows temp dirs can be 8.3 short
    // names (C:\Users\RUNNER~1\...) which SQLite's GetFullPathName does NOT
    // expand to the long form. Normalising both through the same call keeps this
    // true on macOS and Windows CI alike.
    const dbList = db.pragma("database_list") as Array<{ name: string; file: string }>;
    const mainDb = dbList.find((r) => r.name === "main");
    expect(mainDb?.file).toBeTruthy();
    expect(fs.realpathSync(String(mainDb?.file))).toBe(fs.realpathSync(dbFile));
  }

  /** Files currently sitting in the scratch dir, sorted. */
  function scratchFiles(): string[] {
    return fs.readdirSync(tmpDir).sort();
  }

  function backupFiles(): string[] {
    return scratchFiles().filter((f) => f.startsWith("mad-backup-") && f.endsWith(".db"));
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-ondisk-v56-"));
    createdTmpDirs.push(tmpDir);
    dbFile = path.join(tmpDir, "mad.db");

    db = openRealDb(dbFile);

    // (1) REAL schema.sql — the fresh-install artefact. Seeds schema_version=32.
    db.exec(fs.readFileSync(SCHEMA_SQL_PATH, "utf8"));

    // Deferred require so the jest.mock factories above are applied first.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../databaseService").default;
    service.db = db;
    setDb(db);

    // (2) REAL migration chain, filtered to <= 55, through the REAL runner.
    //
    // dbPath is held at null for THIS step only, deliberately:
    // _runVersionedMigrations() refuses to migrate an on-disk DB that has no
    // pre-existing `mad-backup-*.db` (databaseService.ts:2853). Faking one here
    // just to build the fixture would pre-satisfy the very check the act phase
    // is meant to prove. So the fixture build runs with the on-disk branches
    // off, and dbPath is set to the real file immediately afterwards — before
    // anything under test runs.
    service.dbPath = null;

    // The runner reads the static MIGRATIONS array and has no version-limit
    // parameter, so the filter is applied by temporarily swapping the static.
    // Restored in `finally`, and re-asserted in afterEach — if this ever leaked,
    // runMigrations() would compute latestMigrationVersion = 55, decide no
    // migration is pending, skip the backup, and the act phase would silently
    // test nothing.
    const klass = service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const allMigrations = klass.MIGRATIONS;
    klass.MIGRATIONS = allMigrations.filter((m) => m.version <= PRE_UPGRADE_VERSION);
    try {
      await service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = allMigrations;
    }

    // (3) NOW point the service at the real file. This is the state under test.
    service.dbPath = dbFile;
    setDbPath(dbFile);

    // (4) Seed pre-existing rows with fixed ids — the population that must
    //     survive the upgrade untouched and fully active.
    db.prepare(
      `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
       VALUES (?, 'ondisk-2364@example.com', 'google', 'oauth-ondisk-2364')`,
    ).run(USER_ID);
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address)
       VALUES (?, ?, '123 On Disk Way')`,
    ).run(TXN_ID, USER_ID);
    for (const id of CONTACT_IDS) {
      db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)").run(
        id,
        USER_ID,
        `Name ${id}`,
      );
    }
    db.prepare(
      "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, ?)",
    ).run(TC_IDS[0], TXN_ID, CONTACT_IDS[0], "buyer");
    db.prepare(
      "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, ?)",
    ).run(TC_IDS[1], TXN_ID, CONTACT_IDS[1], "seller");

    // Drop log calls made while BUILDING the fixture so the backup assertion
    // can only be satisfied by the act phase. clearAllMocks clears call history
    // but preserves the mockResolvedValue implementations.
    jest.clearAllMocks();
  });

  afterEach(() => {
    // MIGRATIONS must be back to the full array — see the swap comment above.
    const klass = service?.constructor as { MIGRATIONS: Array<{ version: number }> } | undefined;
    const migrations = klass?.MIGRATIONS ?? [];
    expect(migrations[migrations.length - 1]?.version).toBe(HEAD_VERSION);

    try {
      db.close();
    } catch {
      // a test may have closed it already (the persistence test does)
    }
    setDb(null as unknown as DatabaseType);
    setDbPath(null as unknown as string);
    setEncryptionKey(null as unknown as string);
    if (service) {
      service.db = null;
      service.dbPath = null;
    }

    // Removes mad.db, mad.db-wal, mad.db-shm and every backup/snapshot the
    // migration produced.
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    // Leaves nothing behind — asserted over every scratch dir the suite made.
    for (const dir of createdTmpDirs) {
      expect(fs.existsSync(dir)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Preconditions
  // -------------------------------------------------------------------------

  it("sanity: real better-sqlite3 driver is wired (not the jest auto-mock)", () => {
    assertRealOnDiskTarget();
    expect(typeof RealDatabase).toBe("function");
  });

  it("GUARD: the DB under test is a real FILE and the service points at it (not :memory:, not null)", () => {
    assertRealOnDiskTarget();

    // The file is a real SQLite database on disk, byte-inspectable.
    const header = Buffer.alloc(16);
    const fd = fs.openSync(dbFile, "r");
    try {
      fs.readSync(fd, header, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    expect(header.toString("utf8", 0, 15)).toBe("SQLite format 3");

    // WAL is on, so the sidecar exists — proof this is not an in-memory handle.
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(fs.existsSync(`${dbFile}-wal`)).toBe(true);
  });

  it("precondition: the on-disk fixture is at v55 with NEITHER tombstone column on EITHER table", () => {
    assertRealOnDiskTarget();

    expect(schemaVersionOf(db)).toBe(PRE_UPGRADE_VERSION);
    for (const table of TOMBSTONE_TABLES) {
      const cols = columns(db, table);
      for (const col of TOMBSTONE_COLUMNS) {
        expect(cols).not.toContain(col);
      }
    }
    // No backup exists yet — so the backup asserted later can only come from
    // the act phase.
    expect(backupFiles()).toEqual([]);
  });

  it("precondition: the seeded rows are present with the exact expected ids", () => {
    assertRealOnDiskTarget();

    expect(idsIn(db, "contacts")).toEqual([...CONTACT_IDS].sort());
    expect(idsIn(db, "transaction_contacts")).toEqual([...TC_IDS].sort());
  });

  // -------------------------------------------------------------------------
  // The upgrade
  // -------------------------------------------------------------------------

  it("runMigrations() over the real file resolves and lands schema_version at 56", async () => {
    assertRealOnDiskTarget();

    // Head is 56 — i.e. the beforeEach MIGRATIONS swap was restored, so a
    // migration really is pending and the on-disk branches really will run.
    const klass = service.constructor as { MIGRATIONS: Array<{ version: number }> };
    expect(klass.MIGRATIONS[klass.MIGRATIONS.length - 1].version).toBe(HEAD_VERSION);

    await expect(service.runMigrations()).resolves.toBeUndefined();

    expect(schemaVersionOf(db)).toBe(HEAD_VERSION);
  });

  it("adds both tombstone columns to BOTH tables, NULL for every pre-existing row", async () => {
    assertRealOnDiskTarget();

    await service.runMigrations();

    for (const table of TOMBSTONE_TABLES) {
      const cols = columns(db, table);
      for (const col of TOMBSTONE_COLUMNS) {
        expect(cols).toContain(col);
      }
      // Appended last, in declaration order.
      expect(cols.slice(-2)).toEqual(TOMBSTONE_COLUMNS);

      // NULL for pre-existing rows, asserted by ID SET (not by count): the ids
      // whose removed_at IS NULL are exactly the ids in the table.
      const allIds = idsIn(db, table);
      const nullIds = (
        db
          .prepare(`SELECT id FROM ${table} WHERE removed_at IS NULL ORDER BY id`)
          .all() as Array<{ id: string }>
      ).map((r) => r.id);
      expect(nullIds).toEqual(allIds);

      const reasonNullIds = (
        db
          .prepare(`SELECT id FROM ${table} WHERE removed_reason IS NULL ORDER BY id`)
          .all() as Array<{ id: string }>
      ).map((r) => r.id);
      expect(reasonNullIds).toEqual(allIds);
    }
  });

  it("the EXACT id sets survive the upgrade on both tables (identity, not counts)", async () => {
    assertRealOnDiskTarget();

    const before = {
      contacts: idsIn(db, "contacts"),
      transaction_contacts: idsIn(db, "transaction_contacts"),
    };
    // The fixture is what we think it is before we trust the comparison.
    expect(before.contacts).toEqual([...CONTACT_IDS].sort());
    expect(before.transaction_contacts).toEqual([...TC_IDS].sort());

    await service.runMigrations();

    // Set equality both ways: catches a dropped row, an added row, AND a row
    // swapped for a different one — none of which a count assertion catches.
    expect(idsIn(db, "contacts")).toEqual(before.contacts);
    expect(idsIn(db, "transaction_contacts")).toEqual(before.transaction_contacts);
  });

  it("creates NO index — the index-name set is identical before and after", async () => {
    assertRealOnDiskTarget();

    // Same invariant as databaseService.migration-v56.test.ts, re-asserted here
    // over the REAL schema.sql: runMigrations() re-execs that file before the
    // chain, so a standalone tombstone CREATE INDEX added there would show up
    // in this diff (and would also throw "no such column" on a real upgrade —
    // the BACKLOG-2298/2300 failure class).
    const before = indexNames(db);
    expect(before.length).toBeGreaterThan(0);

    await service.runMigrations();

    expect(indexNames(db)).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // The on-disk-only branches — never executed by any other test in this repo
  // -------------------------------------------------------------------------

  it("EXERCISES THE BACKUP BRANCH: a genuine pre-migration snapshot file is written", async () => {
    assertRealOnDiskTarget();
    expect(backupFiles()).toEqual([]);

    await service.runMigrations();

    // (a) the file appears next to the DB (databaseService.ts:668-683)
    const backups = backupFiles();
    expect(backups).toHaveLength(1);

    // (b) the branch logged it
    expect(infoLogMessages().some((m) => m.includes("Pre-migration backup created"))).toBe(true);

    // (c) it is a REAL pre-migration snapshot, not an empty touch-file: opened
    //     on its own it is still at v55 with no tombstone columns, while the
    //     live DB has moved to v56. This is the assertion that would survive a
    //     "backup" that copied the post-migration file.
    const backupPath = path.join(tmpDir, backups[0]);
    expect(fs.statSync(backupPath).size).toBeGreaterThan(0);

    const backupDb = new RealDatabase(backupPath) as DatabaseType;
    try {
      expect(schemaVersionOf(backupDb)).toBe(PRE_UPGRADE_VERSION);
      for (const table of TOMBSTONE_TABLES) {
        const cols = columns(backupDb, table);
        for (const col of TOMBSTONE_COLUMNS) {
          expect(cols).not.toContain(col);
        }
      }
      // The user's rows are in the backup — it is a restore point, not a shell.
      expect(idsIn(backupDb, "contacts")).toEqual([...CONTACT_IDS].sort());
    } finally {
      backupDb.close();
    }

    // ...and the live DB did move on.
    expect(schemaVersionOf(db)).toBe(HEAD_VERSION);
  });

  it("takes NO pre-junction snapshot at v55 (that branch is gated on version < 41)", async () => {
    assertRealOnDiskTarget();

    await service.runMigrations();

    // databaseService.ts:691-729 only fires below v41. Asserted rather than
    // left unstated, so a future change that starts snapshotting on every
    // upgrade (a full DB copy on every launch that migrates) is caught here.
    expect(fs.existsSync(path.join(tmpDir, "mad-pre-junction-backfill.db"))).toBe(false);
    expect(scratchFiles().filter((f) => f.includes("pre-junction"))).toEqual([]);
  });

  it("EXERCISES THE RETENTION PRUNE: keeps the newest 3 backups and unlinks the rest", async () => {
    assertRealOnDiskTarget();

    // databaseService.ts:752-769 — the ONE branch in this apparatus that nothing
    // in the repo reached. migration-restore.test.ts covers the others against a
    // mocked fs, but `"Removed old backup:"` (databaseService.ts:764) appears in
    // no test in the codebase, and every other test in THIS file produces exactly
    // one backup, so `.slice(3)` is empty and the unlink loop never runs.
    //
    // Backup names are minted at databaseService.ts:670-671 as
    //   new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)  ->  YYYY-MM-DDTHHMM
    // and the prune sorts by NAME then reverses, so these lexical dates ARE the
    // recency order. The backup runMigrations() is about to take is dated now,
    // so it sorts newest and must survive.
    const seeded = [
      "mad-backup-2020-01-01T0000.db",
      "mad-backup-2021-01-01T0000.db",
      "mad-backup-2022-01-01T0000.db",
      "mad-backup-2023-01-01T0000.db",
    ];
    for (const name of seeded) {
      fs.writeFileSync(path.join(tmpDir, name), `stand-in backup: ${name}`);
    }
    expect(backupFiles()).toEqual([...seeded].sort());

    await service.runMigrations();

    const remaining = backupFiles();
    expect(remaining).toHaveLength(3);

    // Identity, not count: the two OLDEST are gone, the two newest seeded
    // survive, and the newly minted backup is the third.
    expect(remaining).toContain("mad-backup-2023-01-01T0000.db");
    expect(remaining).toContain("mad-backup-2022-01-01T0000.db");
    expect(remaining).not.toContain("mad-backup-2021-01-01T0000.db");
    expect(remaining).not.toContain("mad-backup-2020-01-01T0000.db");

    const created = remaining.filter((f) => !seeded.includes(f));
    expect(created).toHaveLength(1);
    expect(remaining).toEqual(
      [created[0], "mad-backup-2022-01-01T0000.db", "mad-backup-2023-01-01T0000.db"].sort(),
    );

    // Really unlinked from the filesystem, not merely absent from one listing.
    for (const gone of ["mad-backup-2020-01-01T0000.db", "mad-backup-2021-01-01T0000.db"]) {
      expect(fs.existsSync(path.join(tmpDir, gone))).toBe(false);
    }

    // The branch logged each removal (databaseService.ts:764) — exactly twice.
    expect(infoLogMessages().filter((m) => m.includes("Removed old backup"))).toHaveLength(2);

    // ...and pruning did not clobber the backup that actually matters: the
    // survivor is still a usable v55 restore point.
    const backupDb = new RealDatabase(path.join(tmpDir, created[0])) as DatabaseType;
    try {
      expect(schemaVersionOf(backupDb)).toBe(PRE_UPGRADE_VERSION);
      expect(idsIn(backupDb, "contacts")).toEqual([...CONTACT_IDS].sort());
    } finally {
      backupDb.close();
    }
  });

  it("PERSISTS the upgrade: a fresh connection to the same file sees v56", async () => {
    assertRealOnDiskTarget();

    await service.runMigrations();

    // Close the migrating handle so WAL is checkpointed into the main file.
    db.close();

    const reopened = openRealDb(dbFile);
    try {
      expect(schemaVersionOf(reopened)).toBe(HEAD_VERSION);
      for (const table of TOMBSTONE_TABLES) {
        const cols = columns(reopened, table);
        for (const col of TOMBSTONE_COLUMNS) {
          expect(cols).toContain(col);
        }
      }
      // The rows are there too — the durability claim covers data, not just DDL.
      expect(idsIn(reopened, "contacts")).toEqual([...CONTACT_IDS].sort());
      expect(idsIn(reopened, "transaction_contacts")).toEqual([...TC_IDS].sort());

      // A tombstone write round-trips through a connection that never saw the
      // migration run.
      reopened
        .prepare("UPDATE contacts SET removed_at = datetime('now'), removed_reason = ? WHERE id = ?")
        .run("merged_into:c-ondisk-alpha", CONTACT_IDS[1]);
      const stillActive = (
        reopened
          .prepare("SELECT id FROM contacts WHERE removed_at IS NULL ORDER BY id")
          .all() as Array<{ id: string }>
      ).map((r) => r.id);
      expect(stillActive).toEqual([CONTACT_IDS[0], CONTACT_IDS[2]].sort());
    } finally {
      reopened.close();
    }
  });

  it("leaves nothing behind: every artefact the upgrade wrote is removable", async () => {
    assertRealOnDiskTarget();

    await service.runMigrations();

    // Enumerate what a real upgrade actually produced, so the cleanup claim is
    // made against observed files rather than assumed ones.
    const produced = scratchFiles();
    expect(produced).toContain("mad.db");
    expect(produced.filter((f) => f.startsWith("mad-backup-"))).toHaveLength(1);

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    expect(fs.existsSync(tmpDir)).toBe(false);
    // Nothing was written outside the scratch dir (WAL/SHM sidecars included).
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(fs.existsSync(`${dbFile}${suffix}`)).toBe(false);
    }
  });
});
