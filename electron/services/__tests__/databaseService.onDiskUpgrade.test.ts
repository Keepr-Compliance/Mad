/**
 * @jest-environment node
 *
 * REAL ON-DISK upgrade test — BACKLOG-2364 (tombstone columns, v56) and
 * BACKLOG-2401 (contact_source_links crosswalk, v57).
 *
 * The suite upgrades a real v55 file to whatever HEAD_VERSION is, so every new
 * migration is dragged across the real on-disk path. Assertions that describe a
 * SPECIFIC migration clip the chain to that version via runChainThrough().
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
 *  1. A real v55 -> head run of the real migration chain over the real
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
 * 3. The pre-upgrade (v55) state is built from REAL artefacts only: exec the real
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
 * version < 41 and therefore CANNOT fire on a 55 -> head upgrade; its absence is
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
 *   3. Swap one seeded contact id while HOLDING THE ROW COUNT AT 3 -> 6 fail on
 *      ID-SET assertions. A count assertion would have passed all 15. The 6 are
 *      the two direct set assertions ("precondition: the seeded rows are present
 *      with the exact expected ids" and "the EXACT id sets survive the upgrade"),
 *      the three that re-assert the seeded set downstream (backup CONTENT,
 *      retention-prune survivor, persistence), and BACKLOG-2401's "v57 leaves the
 *      pre-existing contact id set untouched".
 *      Swap the id that `transaction_contacts` does NOT reference (CONTACT_IDS[2],
 *      gamma). Swapping alpha or beta trips the FK during the fixture build and
 *      fails all 15 as a SETUP error, which proves nothing about the assertions.
 *      THIS FIGURE IS COUPLED TO HOW MANY TESTS ASSERT `CONTACT_IDS`. It read 4
 *      before the 13th test was added and went stale unnoticed; re-run the
 *      control and recount when adding a test that asserts that set. Re-run and
 *      recounted at 6 by BACKLOG-2401 (2026-08-02).
 *   4. Neuter the retention prune (`backupFiles.slice(3)` -> `[]`) -> exactly 1
 *      fails: "Expected length: 3, Received length: 5".
 *
 * Independently re-run by SR review on a restored tree: control 2 (all fail at
 * :243), control 1 (exactly 2 fail), plus two stronger variants —
 *   - point the handle at a DIFFERENT real, realpath-able file: all tests fail,
 *     confirming the Windows realpath fix still discriminates IDENTITY rather
 *     than merely normalising path format;
 *   - make the WRONG three backups survive while holding the count at exactly 3
 *     (drop `.reverse()` so the prune keeps oldest-first): the retention test
 *     fails and names the wrong survivors. A count assertion would have passed.
 *
 * SR also settled the "752 was genuinely uncovered" half BY EXECUTION rather
 * than by grep: with the prune still neutered it ran the entire repo (598
 * suites / 10,626 tests) and diffed the failing set against baseline. Exactly
 * ONE new failing suite — this one. That is positive proof of both halves at
 * once: the branch is now covered here, and was covered nowhere before.
 *
 * That method is the lesson of this file's review. The original header claimed
 * this apparatus was untested; that claim came from grepping for a thrown error
 * string, which by construction cannot match a test that SATISFIES the guard
 * instead of tripping it. Engineer, coordinator and reviewer all reached a
 * wrong conclusion the same way on this ticket. An absence of matches is a fact
 * about the query, not about the code — derive by execution.
 *
 * Full results are recorded on BACKLOG-2364 in pm_comments.
 */

import fs from "fs";
import os from "os";
import path from "path";
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
/**
 * The version the chain must land on — i.e. the LAST entry in MIGRATIONS.
 *
 * BACKLOG-2401 raised this from 56 to 57 (contact_source_links); BACKLOG-2407
 * raises it to 58 (external_contacts.source_identity_json). Bumping it rather
 * than pinning the suite to an older number is deliberate: this file is the only
 * place in the repo where a migration meets a REAL FILE, so every new migration
 * should be dragged across the real on-disk upgrade path. That is exactly the
 * coverage BACKLOG-2298/2300 were missing — a migration that passes every
 * in-memory suite and still throws on a genuine old→new upgrade. v58 is a
 * guarded ADD COLUMN on `external_contacts`, which is precisely the shape that
 * incident was about.
 *
 * The v56-SPECIFIC assertions below (tombstone columns, "creates NO index") pin
 * themselves to 56 locally via runChainThrough(), so they keep their original
 * meaning as the head moves on.
 */
const HEAD_VERSION = 62;
/** The version whose isolated effects the BACKLOG-2364 assertions describe. */
const TOMBSTONE_VERSION = 56;
/**
 * BACKLOG-2513's `emails.bulk_mail_headers` ADD COLUMN. Pinned to a literal for
 * the same reason as TOMBSTONE_VERSION: written as `HEAD_VERSION` these
 * assertions would silently change meaning the moment v63 lands.
 */
const BULK_MAIL_HEADERS_VERSION = 62;
/**
 * BACKLOG-2473's vocabulary rebuild. Pinned for the same reason
 * TOMBSTONE_VERSION and REVIEW_QUEUE_VERSION are: its test asserts the state
 * BEFORE the rebuild — the narrow five-value `source_type` CHECK — which is only
 * reachable at v60. Written as `HEAD_VERSION` it would silently change meaning
 * the moment a v62 lands.
 */
const ORIGIN_VOCABULARY_VERSION = 61;
/**
 * BACKLOG-2427's value-provenance relabel.
 *
 * PINNED, AND IT HAD TO BE. Its test previously reached its pre-migration state
 * with `HEAD_VERSION - 1`, which meant v59 while head was 60 — and silently came
 * to mean v60 the moment BACKLOG-2473 raised head to 61. Phase 1 then ran v60
 * BEFORE the crosswalk rows it reads were inserted, so the relabel saw no linked
 * source and reclassified rows the test expected it to leave alone. The suite
 * went red for a reason that had nothing to do with the migration under test.
 *
 * This is the third instance of the same trap in this file (see
 * TOMBSTONE_VERSION and REVIEW_QUEUE_VERSION). A version a test asserts the
 * state BEFORE must be written as its own number, never as an offset from head.
 */
const VALUE_PROVENANCE_VERSION = 60;
/**
 * BACKLOG-2410's crosswalk rebuild. Pinned for the same reason TOMBSTONE_VERSION
 * is: its test asserts the state BEFORE the rebuild, which is only reachable at
 * v58. Written as `HEAD_VERSION - 1` it silently changed meaning when v60
 * (BACKLOG-2427) landed and would have run its pre-rebuild CHECK assertion
 * against a table v59 had already rebuilt.
 */
const REVIEW_QUEUE_VERSION = 59;

const USER_ID = "user-ondisk-2364";
const TXN_ID = "txn-ondisk-2364";
/** Fixed ids — the exact SETS asserted before and after the upgrade. */
const CONTACT_IDS = ["c-ondisk-alpha", "c-ondisk-beta", "c-ondisk-gamma"];
const TC_IDS = ["tc-ondisk-alpha", "tc-ondisk-beta"];
/** BACKLOG-2513: pre-existing email rows that must survive the v62 ADD COLUMN. */
const EMAIL_IDS = ["e-ondisk-alpha", "e-ondisk-beta"];

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

/** BACKLOG-2513: column names on `emails`, for the v62 ADD COLUMN assertions. */
function emailColumns(d: DatabaseType): string[] {
  return (d.prepare("PRAGMA table_info(emails)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
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

/**
 * Run `body` with the static MIGRATIONS array clipped to `maxVersion`.
 *
 * The runner has no version-limit parameter, so the only way to isolate one
 * migration's effects is to swap the static (the same idiom the beforeEach uses
 * to BUILD the pre-upgrade fixture). Restored in `finally`, and the restoration
 * is re-asserted in afterEach — a leak here would make the head-version tests
 * silently test nothing.
 *
 * Added by BACKLOG-2401: before v57 existed, seeding at 55 and running the chain
 * happened to run ONLY v56, so the v56-specific assertions below were correct by
 * accident. They are now correct by construction, and stay correct at v59+.
 */
async function runChainThrough(service: AnyService, maxVersion: number): Promise<void> {
  const klass = service.constructor as { MIGRATIONS: Array<{ version: number }> };
  const all = klass.MIGRATIONS;
  klass.MIGRATIONS = all.filter((m) => m.version <= maxVersion);
  try {
    await service.runMigrations();
  } finally {
    klass.MIGRATIONS = all;
  }
}

/** Mock-call inspection without dragging jest.Mock generics through the file. */
function infoLogMessages(): string[] {
  const calls = (logService.info as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.map((c) => String(c[0]));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

// ---------------------------------------------------------------------------

describe("databaseService — REAL on-disk v55 -> head upgrade (BACKLOG-2364 + BACKLOG-2401)", () => {
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

  it("runMigrations() over the real file resolves and lands schema_version at head", async () => {
    assertRealOnDiskTarget();

    // Head is the last MIGRATIONS entry — i.e. the beforeEach MIGRATIONS swap
    // was restored, so a migration really is pending and the on-disk branches
    // really will run.
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

  it("v56 creates NO index — the index-name set is identical before and after", async () => {
    assertRealOnDiskTarget();

    // Same invariant as databaseService.migration-v56.test.ts, re-asserted here
    // over the REAL schema.sql: runMigrations() re-execs that file before the
    // chain, so a standalone tombstone CREATE INDEX added there would show up
    // in this diff (and would also throw "no such column" on a real upgrade —
    // the BACKLOG-2298/2300 failure class).
    //
    // BACKLOG-2401: clipped to v56. v57 legitimately DOES create an index
    // (idx_contact_source_links_contact), so running the whole chain here would
    // make this assertion fail for a reason that has nothing to do with the
    // tombstone ruling it exists to protect. Clipping keeps it a statement about
    // v56 — which is what its name claims — instead of a statement about
    // whatever happens to be at head.
    const before = indexNames(db);
    expect(before.length).toBeGreaterThan(0);

    await runChainThrough(service, TOMBSTONE_VERSION);

    expect(schemaVersionOf(db)).toBe(TOMBSTONE_VERSION);
    expect(indexNames(db)).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // BACKLOG-2513 — emails.bulk_mail_headers, over the SAME real file
  //
  // This is the assertion the item body asked for by name: "start from an actual
  // prior-version database file, run the migration, assert the column exists and
  // existing rows survive intact." Every other migration test in the repo runs
  // against :memory:, so this suite is the only place that claim can be made.
  // -------------------------------------------------------------------------

  it("v62 adds emails.bulk_mail_headers on the real file, NULL for every pre-existing row", async () => {
    assertRealOnDiskTarget();

    // The fixture builds its "v55" file by exec'ing the CURRENT schema.sql and
    // then forcing schema_version back to 55 — so a column that schema.sql
    // declares is already present, and the file does not represent a database
    // that predates it. Drop it to get a genuinely pre-v62 shape.
    //
    // This is safe and faithful to what a real upgrade sees: runMigrations()
    // re-execs schema.sql, but `CREATE TABLE IF NOT EXISTS emails` is a no-op on
    // an existing table, so on a real user's database the column can ONLY come
    // from the v62 ALTER. Dropping here makes the fixture express that.
    //
    // Without this drop the test would pass whether or not the migration did
    // anything — a green that carries no information, and precisely the
    // BACKLOG-2298/2300 confusion this suite exists to separate.
    db.exec("ALTER TABLE emails DROP COLUMN bulk_mail_headers");

    const colsBefore = emailColumns(db);
    expect(colsBefore).not.toContain("bulk_mail_headers");

    // Seed pre-existing email rows with fixed ids. The fixture's beforeEach
    // seeds contacts/transactions but no emails, so this test owns its own
    // population — the rows whose survival is the point.
    for (const id of EMAIL_IDS) {
      db.prepare(
        `INSERT INTO emails (id, user_id, external_id, source, subject)
         VALUES (?, ?, ?, 'gmail', ?)`,
      ).run(id, USER_ID, `ext-${id}`, `Subject ${id}`);
    }
    expect(idsIn(db, "emails")).toEqual([...EMAIL_IDS].sort());

    await service.runMigrations();

    expect(schemaVersionOf(db)).toBe(HEAD_VERSION);

    // 1. The column is live on a REAL upgraded file.
    expect(emailColumns(db)).toContain("bulk_mail_headers");

    // 2. The exact id set survives — identity, not counts. A count assertion
    //    cannot tell a dropped row from a row swapped for a different one.
    expect(idsIn(db, "emails")).toEqual([...EMAIL_IDS].sort());

    // 3. Every pre-existing row reads NULL: additive, no backfill, nothing a
    //    user would see change on upgrade.
    const rows = db
      .prepare("SELECT id, bulk_mail_headers FROM emails ORDER BY id")
      .all() as Array<{ id: string; bulk_mail_headers: string | null }>;
    expect(rows.map((r) => r.bulk_mail_headers)).toEqual(EMAIL_IDS.map(() => null));

    // 4. The rest of the row is untouched, not merely present.
    expect(
      (
        db.prepare("SELECT subject FROM emails WHERE id = ?").get(EMAIL_IDS[0]) as {
          subject: string;
        }
      ).subject,
    ).toBe(`Subject ${EMAIL_IDS[0]}`);
  });

  it("v62 creates NO index — the index-name set is identical before and after", async () => {
    assertRealOnDiskTarget();

    // Clipped to 61 first so the comparison isolates v62. Running the whole
    // chain in one go would fold in v57's idx_contact_source_links_contact and
    // make this a statement about the chain rather than about v62.
    await runChainThrough(service, HEAD_VERSION - 1);
    const before = indexNames(db);
    expect(before.length).toBeGreaterThan(0);

    await runChainThrough(service, BULK_MAIL_HEADERS_VERSION);

    expect(schemaVersionOf(db)).toBe(BULK_MAIL_HEADERS_VERSION);
    // A standalone CREATE INDEX on bulk_mail_headers added to schema.sql would
    // surface here — and would also throw "no such column" on a real upgrade,
    // because runMigrations() re-execs schema.sql BEFORE the chain. That is the
    // BACKLOG-2298/2300 failure class, shipped in July and caught only by
    // founder live QA.
    expect(indexNames(db)).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // BACKLOG-2401 — the crosswalk, over the SAME real file
  // -------------------------------------------------------------------------

  it("v57 creates contact_source_links on the real file, with its index and constraints live", async () => {
    assertRealOnDiskTarget();

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact_source_links'")
        .get(),
    ).toBeUndefined();

    await service.runMigrations();

    expect(schemaVersionOf(db)).toBe(HEAD_VERSION);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact_source_links'")
        .get(),
    ).toBeDefined();
    expect(indexNames(db)).toContain("idx_contact_source_links_contact");

    // The constraints are REAL on a real file, not just declared text: a second
    // claim on the same (user, source, source_record_id) must be rejected, and
    // the vocabulary CHECKs must bite. Asserted by round-tripping the exact id.
    const insert = db.prepare(
      `INSERT INTO contact_source_links
         (id, user_id, contact_id, source_type, source_record_id, match_method)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run("csl-ondisk-1", USER_ID, CONTACT_IDS[0], "macos", "UUID-A:ABPerson", "source_id");

    expect(() =>
      insert.run("csl-ondisk-2", USER_ID, CONTACT_IDS[1], "macos", "UUID-A:ABPerson", "source_id"),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      insert.run("csl-ondisk-3", USER_ID, CONTACT_IDS[1], "myspace", "UUID-B:ABPerson", "source_id"),
    ).toThrow(/CHECK/i);
    expect(() =>
      insert.run("csl-ondisk-4", USER_ID, CONTACT_IDS[1], "macos", "UUID-B:ABPerson", "vibes"),
    ).toThrow(/CHECK/i);

    const linked = (
      db
        .prepare("SELECT id, contact_id FROM contact_source_links ORDER BY id")
        .all() as Array<{ id: string; contact_id: string }>
    ).map((r) => `${r.id}:${r.contact_id}`);
    expect(linked).toEqual([`csl-ondisk-1:${CONTACT_IDS[0]}`]);
  });

  /**
   * BACKLOG-2473 — THE v61 VOCABULARY REBUILD, ON A REAL OLD DATABASE.
   *
   * WHY THIS TEST HAD TO EXIST, IN THE WORDS OF THE INCIDENT IT ANSWERS.
   * BACKLOG-2298: a migration added a column plus a standalone `CREATE INDEX` on
   * it in schema.sql, passed EVERY CI suite, and still broke real upgrades with
   * "no such column" — because no test starts from a real prior-version on-disk
   * database. The in-memory migration tests call `_runVersionedMigrations`
   * directly; the parity tests seed schema.sql on an empty DB; E2E seeds at HEAD.
   * None of them upgrade a real old database. This one does.
   *
   * THE FOUR POPULATIONS SEEDED BEFORE THE UPGRADE, and what each is here to
   * prove survives:
   *
   *   a manual contact            — the population v61 exists to serve. Before
   *                                 the migration it CANNOT have a crosswalk row
   *                                 at all; after it, `manual` is admitted.
   *   a message-derived contact   — same, via `sms`.
   *   a macOS-linked contact      — has a REAL record-backed crosswalk row that
   *                                 the rebuild has to carry across intact.
   *   a contact with no links     — the pre-v57 shape. It must come out of the
   *                                 upgrade EXACTLY as it went in, because v61
   *                                 deliberately ships no backfill.
   *
   * Two-phase for the same reason the v59 test above is: the crosswalk row has
   * to exist on disk BEFORE the rebuild runs, so the chain is clipped at v60,
   * rows are inserted through the real file, then the chain is restored and run
   * to head. Both halves go through the PUBLIC `runMigrations()` — WAL, backup
   * branch, schema.sql re-exec and all.
   */
  it("v61 widens the crosswalk vocabulary on a REAL old database without disturbing a row", async () => {
    assertRealOnDiskTarget();

    const klass = service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const allMigrations = klass.MIGRATIONS;

    // --- phase 1: reach v60, the real pre-migration state.
    klass.MIGRATIONS = allMigrations.filter(
      (m) => m.version <= ORIGIN_VOCABULARY_VERSION - 1,
    );
    try {
      await service.runMigrations();
    } finally {
      klass.MIGRATIONS = allMigrations;
    }
    expect(schemaVersionOf(db)).toBe(ORIGIN_VOCABULARY_VERSION - 1);

    // ---------------------------------------------------------------------
    // RESTORE THE GENUINE v60 SHAPE — this is what a real user's file holds.
    // ---------------------------------------------------------------------
    // A REPLAYED chain does not reproduce it, and the reason is worth stating
    // because it looks like a bug and is not.
    //
    // v59 and v61 both rebuild this table through the SAME shared DDL constant
    // (`contactSourceLinksRebuildTableSql`), which always describes the CURRENT
    // shape. So replaying the chain with today's code gives v59's rebuild the
    // v61-wide CHECK, and v61 then correctly no-ops. Every route converges on
    // one final shape, which is the property the parity tests enforce — but it
    // means the replayed fixture is NOT the database a shipped v2.x install has.
    //
    // A REAL v60 install ran v59 against the code as it was THEN, so its
    // crosswalk carries the narrow five-value `source_type` CHECK and no
    // `origin` match method. That is the database v61 has to upgrade in the
    // field, and BACKLOG-2298 is precisely the incident where the difference
    // between "the fixture the chain produces" and "the file the user has"
    // hid a migration defect through every CI suite. So it is reconstructed
    // here, on the real file, from the historical DDL verbatim.
    db.exec(`
      DROP TABLE contact_source_links;
      CREATE TABLE contact_source_links (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (
          source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
        ),
        source_record_id TEXT NOT NULL,
        external_uuid TEXT,
        match_method TEXT NOT NULL CHECK (
          match_method IN ('source_id', 'email', 'phone', 'unique_name', 'manual', 'scored')
        ),
        confidence REAL,
        matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        evidence_ref TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
        UNIQUE (user_id, source_type, source_record_id)
      );
      CREATE INDEX IF NOT EXISTS idx_contact_source_links_contact
        ON contact_source_links(contact_id);
    `);

    // The four populations. `contacts.source` is what an origin row would be
    // derived from, so it is set deliberately per contact rather than defaulted.
    const setSource = db.prepare("UPDATE contacts SET source = ? WHERE id = ?");
    setSource.run("manual", CONTACT_IDS[0]); // typed in by hand
    setSource.run("sms", CONTACT_IDS[1]); // inferred from a text thread
    setSource.run("contacts_app", CONTACT_IDS[2]); // imported from the Mac

    // PRE-MIGRATION PROOF: the narrow CHECK is live, so the two populations
    // this work is about genuinely cannot be recorded yet. Without this the
    // "admits it after" assertions below prove nothing.
    expect(() =>
      db
        .prepare(
          `INSERT INTO contact_source_links
             (id, user_id, contact_id, source_type, source_record_id, match_method)
           VALUES ('csl-pre-manual', ?, ?, 'manual', 'origin:pre', 'manual')`,
        )
        .run(USER_ID, CONTACT_IDS[0]),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO contact_source_links
             (id, user_id, contact_id, source_type, source_record_id, match_method)
           VALUES ('csl-pre-origin', ?, ?, 'macos', 'origin:pre2', 'origin')`,
        )
        .run(USER_ID, CONTACT_IDS[0]),
    ).toThrow(/CHECK/i);

    // The record-backed row that must cross the rebuild untouched. Every
    // nullable field is populated distinctly so a positional copy cannot land
    // correctly by coincidence.
    db.prepare(
      `INSERT INTO contact_source_links
         (id, user_id, contact_id, source_type, source_record_id, external_uuid,
          match_method, confidence, matched_at, evidence_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "csl-v61-book", USER_ID, CONTACT_IDS[2], "macos", "UUID-BOOK:ABPerson", "ext-uuid-book",
      "source_id", null, "2026-06-01 00:00:00", "ev-book",
      "2026-06-01 00:00:00", "2026-06-02 00:00:00",
    );

    const contactsBefore = idsIn(db, "contacts");

    // --- phase 2: the real chain to head, over the real file, with rows present.
    await service.runMigrations();

    expect(schemaVersionOf(db)).toBe(HEAD_VERSION);

    // (1) THE RECORD-BACKED ROW SURVIVED, FIELD FOR FIELD. Not a count — a count
    //     passes while every row holds its neighbour's value, which is the whole
    //     failure mode of a table rebuild.
    expect(
      db
        .prepare(
          `SELECT id, user_id, contact_id, source_type, source_record_id, external_uuid,
                  match_method, confidence, matched_at, evidence_ref, created_at, updated_at
             FROM contact_source_links ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: "csl-v61-book",
        user_id: USER_ID,
        contact_id: CONTACT_IDS[2],
        source_type: "macos",
        source_record_id: "UUID-BOOK:ABPerson",
        external_uuid: "ext-uuid-book",
        match_method: "source_id",
        confidence: null,
        matched_at: "2026-06-01 00:00:00",
        evidence_ref: "ev-book",
        created_at: "2026-06-01 00:00:00",
        updated_at: "2026-06-02 00:00:00",
      },
    ]);

    // (2) THE CONTACTS ARE UNTOUCHED — exact id SET, and the source column each
    //     went in with. v61 is schema-only; it must not have rewritten a row.
    expect(idsIn(db, "contacts")).toEqual(contactsBefore);
    expect(
      db
        .prepare("SELECT id, source FROM contacts ORDER BY id")
        .all() as Array<{ id: string; source: string }>,
    ).toEqual([
      { id: CONTACT_IDS[0], source: "manual" },
      { id: CONTACT_IDS[1], source: "sms" },
      { id: CONTACT_IDS[2], source: "contacts_app" },
    ]);

    // (3) NO BACKFILL RAN. The two link-less contacts are still link-less —
    //     founder decision 2026-08-04, pinned so a later "helpful" backfill
    //     cannot be added without this going red.
    expect(
      (db
        .prepare("SELECT DISTINCT contact_id FROM contact_source_links ORDER BY contact_id")
        .all() as Array<{ contact_id: string }>).map((r) => r.contact_id),
    ).toEqual([CONTACT_IDS[2]]);

    // (4) THE WIDENED VOCABULARY IS LIVE ON THE REAL FILE — the whole point.
    //     Both populations can now be recorded, having been refused above.
    const insertOrigin = db.prepare(
      `INSERT INTO contact_source_links
         (id, user_id, contact_id, source_type, source_record_id, match_method)
       VALUES (?, ?, ?, ?, ?, 'origin')`,
    );
    expect(() =>
      insertOrigin.run("csl-v61-manual", USER_ID, CONTACT_IDS[0], "manual", `origin:${CONTACT_IDS[0]}`),
    ).not.toThrow();
    expect(() =>
      insertOrigin.run("csl-v61-sms", USER_ID, CONTACT_IDS[1], "sms", `origin:${CONTACT_IDS[1]}`),
    ).not.toThrow();

    // (5) STILL A CONSTRAINT, NOT A FREE-FOR-ALL. A widened CHECK that admits
    //     anything would satisfy (4) while being useless.
    expect(() =>
      insertOrigin.run("csl-v61-bad", USER_ID, CONTACT_IDS[0], "whatsapp", "origin:bad"),
    ).toThrow(/CHECK/i);

    // (6) THE UNIQUE, THE FK CASCADE AND THE INDEX ALL SURVIVED THE DROP/RENAME.
    expect(indexNames(db)).toContain("idx_contact_source_links_contact");
    expect(() =>
      insertOrigin.run("csl-v61-dup", USER_ID, CONTACT_IDS[1], "manual", `origin:${CONTACT_IDS[0]}`),
    ).toThrow(/UNIQUE/i);

    db.prepare("DELETE FROM contacts WHERE id = ?").run(CONTACT_IDS[0]);
    expect(
      (db
        .prepare("SELECT id FROM contact_source_links ORDER BY id")
        .all() as Array<{ id: string }>).map((r) => r.id),
    ).toEqual(["csl-v61-book", "csl-v61-sms"]);
  });

  /**
   * BACKLOG-2410 — THE v59 REBUILD, CARRYING REAL ROWS, ON A REAL FILE.
   *
   * WHY THIS TEST HAD TO EXIST. v59 rebuilds `contact_source_links` to widen a
   * CHECK, and a rebuild is the highest-risk shape of migration there is. Until
   * this test, row-copy fidelity was asserted ONLY in memory
   * (`databaseService.migration-v59.test.ts`, via `createMigrationHarness` —
   * `:memory:`, `dbPath = null`, calling `_runVersionedMigrations()` directly).
   * That is exactly the synthetic pattern BACKLOG-2298 warns about.
   *
   * On the ordinary path through this file the rebuild runs but copies ZERO
   * rows: the fixture starts at v55, v57 creates the crosswalk empty, and v57
   * deliberately ships no backfill. So the migration that could scramble every
   * row was never once observed moving a row across a real file.
   *
   * THE TWO-PHASE RUN IS THE POINT. Clip the chain at 58, run the PUBLIC
   * `runMigrations()` so the crosswalk exists on disk, insert rows through the
   * real file, restore the chain, and run again so v59 rebuilds a POPULATED
   * table. Both halves go through the same public entry point a user's app
   * calls — WAL, backup branch, schema.sql re-exec and all.
   */
  it("v59 rebuilds a POPULATED crosswalk on the real file without scrambling a row", async () => {
    assertRealOnDiskTarget();

    const klass = service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const allMigrations = klass.MIGRATIONS;

    // --- phase 1: reach v58, so the crosswalk exists at its PRE-rebuild shape.
    klass.MIGRATIONS = allMigrations.filter((m) => m.version <= REVIEW_QUEUE_VERSION - 1);
    try {
      await service.runMigrations();
    } finally {
      klass.MIGRATIONS = allMigrations;
    }
    expect(schemaVersionOf(db)).toBe(REVIEW_QUEUE_VERSION - 1);
    // Pre-rebuild: the v57 CHECK is still in force, so `unique_name` is refused.
    expect(() =>
      db
        .prepare(
          `INSERT INTO contact_source_links
             (id, user_id, contact_id, source_type, source_record_id, match_method)
           VALUES ('csl-pre', ?, ?, 'macos', 'PRE:ABPerson', 'unique_name')`,
        )
        .run(USER_ID, CONTACT_IDS[0]),
    ).toThrow(/CHECK/i);

    // Two rows with every nullable field populated differently, so a positional
    // copy cannot land correctly by coincidence.
    const insert = db.prepare(
      `INSERT INTO contact_source_links
         (id, user_id, contact_id, source_type, source_record_id, external_uuid,
          match_method, confidence, matched_at, evidence_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "csl-rebuild-1", USER_ID, CONTACT_IDS[0], "macos", "UUID-R1:ABPerson", "ext-uuid-r1",
      "source_id", null, "2026-04-01 00:00:00", null, "2026-04-01 00:00:00", "2026-04-02 00:00:00",
    );
    insert.run(
      "csl-rebuild-2", USER_ID, CONTACT_IDS[1], "outlook", "GRAPH-R2", null,
      "email", null, "2026-05-01 00:00:00", "ev-r2", "2026-05-01 00:00:00", "2026-05-02 00:00:00",
    );

    // --- phase 2: the real chain, over the real file, with rows present.
    await service.runMigrations();

    expect(schemaVersionOf(db)).toBe(HEAD_VERSION);

    // Field for field, both rows. Not a count — a count passes while every row
    // holds its neighbour's value, which is the whole failure mode.
    expect(
      db
        .prepare(
          `SELECT id, user_id, contact_id, source_type, source_record_id, external_uuid,
                  match_method, confidence, matched_at, evidence_ref, created_at, updated_at
             FROM contact_source_links ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: "csl-rebuild-1",
        user_id: USER_ID,
        contact_id: CONTACT_IDS[0],
        source_type: "macos",
        source_record_id: "UUID-R1:ABPerson",
        external_uuid: "ext-uuid-r1",
        match_method: "source_id",
        confidence: null,
        matched_at: "2026-04-01 00:00:00",
        evidence_ref: null,
        created_at: "2026-04-01 00:00:00",
        updated_at: "2026-04-02 00:00:00",
      },
      {
        id: "csl-rebuild-2",
        user_id: USER_ID,
        contact_id: CONTACT_IDS[1],
        source_type: "outlook",
        source_record_id: "GRAPH-R2",
        external_uuid: null,
        match_method: "email",
        confidence: null,
        matched_at: "2026-05-01 00:00:00",
        evidence_ref: "ev-r2",
        created_at: "2026-05-01 00:00:00",
        updated_at: "2026-05-02 00:00:00",
      },
    ]);

    // The widened CHECK is live on the rebuilt table, the dropped index is back,
    // and the UNIQUE survived the DROP/RENAME.
    expect(() =>
      db
        .prepare(
          `INSERT INTO contact_source_links
             (id, user_id, contact_id, source_type, source_record_id, match_method)
           VALUES ('csl-rebuild-3', ?, ?, 'iphone', 'IPH-R3', 'unique_name')`,
        )
        .run(USER_ID, CONTACT_IDS[2]),
    ).not.toThrow();
    expect(indexNames(db)).toContain("idx_contact_source_links_contact");
    expect(() =>
      db
        .prepare(
          `INSERT INTO contact_source_links
             (id, user_id, contact_id, source_type, source_record_id, match_method)
           VALUES ('csl-rebuild-4', ?, ?, 'outlook', 'GRAPH-R2', 'email')`,
        )
        .run(USER_ID, CONTACT_IDS[2]),
    ).toThrow(/UNIQUE/i);

    // And the review-queue tables landed on the real file too, usable.
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('contact_link_proposals','contact_link_verdicts') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "contact_link_proposals" }, { name: "contact_link_verdicts" }]);
  });

  /**
   * v60 (BACKLOG-2427) — RECLASSIFYING USER DATA, ON THE REAL DRIVER.
   *
   * The rule itself is unit-tested against `node:sqlite` in
   * `db/__tests__/contactValueProvenanceBackfill.test.ts`, because the
   * better-sqlite3 binary in this repo is an Electron build (ABI 139) and
   * cannot be loaded by plain node — so that suite is the only one that can be
   * EXECUTED on a developer machine.
   *
   * SR review of PR #2186 required this second, real-driver run before a
   * user-data reclassification ships, and was right to: `node:sqlite` and
   * better-sqlite3 are different engines, and "the SQL is portable" is an
   * argument, not evidence. Without seeded rows this file would prove only that
   * v60 did not throw.
   *
   * TWO-PHASE, for the same reason the v59 test above is: `contact_source_links`
   * does not exist until v57, so the crosswalk rows v60 reads have to be
   * inserted after the chain reaches v59 and before v60 runs. Both halves go
   * through the PUBLIC `runMigrations()` on the real file.
   *
   * The three branches, on one contact so a per-row rule cannot pass by
   * accident of grouping:
   *   carried by a linked source  -> stays 'import'  (still removable)
   *   carried by nothing          -> becomes 'manual' (never removable)
   *   already 'manual'            -> untouched
   */
  it("v60 reclassifies ONLY the values no linked source carries, on the real file", async () => {
    assertRealOnDiskTarget();

    const klass = service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const allMigrations = klass.MIGRATIONS;

    // --- phase 1: reach v59, so the crosswalk exists at its post-rebuild shape.
    //     Pinned to VALUE_PROVENANCE_VERSION - 1, NOT HEAD_VERSION - 1: as an
    //     offset from head this silently came to mean "run v60 first" when v61
    //     landed, which is the opposite of what this phase is for.
    klass.MIGRATIONS = allMigrations.filter(
      (m) => m.version <= VALUE_PROVENANCE_VERSION - 1,
    );
    try {
      await service.runMigrations();
    } finally {
      klass.MIGRATIONS = allMigrations;
    }
    expect(schemaVersionOf(db)).toBe(VALUE_PROVENANCE_VERSION - 1);

    // A source record that genuinely carries one email and one phone. Its phone
    // is spelled differently from the stored E.164 form, so the normalized-key
    // match is exercised rather than string equality.
    db.prepare(
      `INSERT INTO external_contacts
         (id, user_id, name, phones_json, phones_normalized_json, emails_json,
          external_record_id, source, synced_at)
       VALUES ('ec-v60', ?, 'Carried By Source', '["(408) 555-0101"]', '["4085550101"]',
               '["carried@bysource.com"]', 'MAC-V60', 'macos', '2026-08-03 00:00:00')`,
    ).run(USER_ID);
    db.prepare(
      `INSERT INTO contact_source_links
         (id, user_id, contact_id, source_type, source_record_id, match_method)
       VALUES ('csl-v60', ?, ?, 'macos', 'MAC-V60', 'source_id')`,
    ).run(USER_ID, CONTACT_IDS[0]);

    // Every value below says 'import' — which is exactly the problem v60 exists
    // to clean up: before BACKLOG-2427 threaded real provenance, a typed value
    // and an imported one were indistinguishable.
    const insEmail = db.prepare(
      "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, ?, ?)",
    );
    insEmail.run("ce-v60-carried", CONTACT_IDS[0], "carried@bysource.com", 1, "import");
    insEmail.run("ce-v60-typed", CONTACT_IDS[0], "typed@byhand.com", 0, "import");
    insEmail.run("ce-v60-manual", CONTACT_IDS[0], "already@manual.com", 0, "manual");

    const insPhone = db.prepare(
      `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insPhone.run("cp-v60-carried", CONTACT_IDS[0], "+14085550101", "4085550101", 1, "import");
    insPhone.run("cp-v60-typed", CONTACT_IDS[0], "+14155550109", "4155550109", 0, "import");

    // A SECOND contact's value that only the FIRST contact's source carries.
    // The NOT EXISTS is correlated on contact_id; dropping that correlation
    // would spare this row, and the unlink would then be free to delete it.
    insEmail.run("ce-v60-other", CONTACT_IDS[1], "carried@bysource.com", 1, "import");

    // --- phase 2: the real chain runs v60 over the seeded rows.
    await service.runMigrations();

    expect(schemaVersionOf(db)).toBe(HEAD_VERSION);

    // Exact value -> source pairs. A count would pass while the WRONG row was
    // reclassified, which is the entire failure mode of a data migration.
    expect(
      db
        .prepare(
          `SELECT id, email, source FROM contact_emails
            WHERE contact_id IN (?, ?) ORDER BY id`,
        )
        .all(CONTACT_IDS[0], CONTACT_IDS[1]),
    ).toEqual([
      { id: "ce-v60-carried", email: "carried@bysource.com", source: "import" },
      { id: "ce-v60-manual", email: "already@manual.com", source: "manual" },
      { id: "ce-v60-other", email: "carried@bysource.com", source: "manual" },
      { id: "ce-v60-typed", email: "typed@byhand.com", source: "manual" },
    ]);

    expect(
      db
        .prepare("SELECT id, phone_e164, source FROM contact_phones WHERE contact_id = ? ORDER BY id")
        .all(CONTACT_IDS[0]),
    ).toEqual([
      { id: "cp-v60-carried", phone_e164: "+14085550101", source: "import" },
      { id: "cp-v60-typed", phone_e164: "+14155550109", source: "manual" },
    ]);

    // v60 CLASSIFIES; it must never delete. Same row ids, same count.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM contact_emails").get() as { n: number }).n,
    ).toBe(4);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM contact_phones").get() as { n: number }).n,
    ).toBe(2);
  });

  it("v57 leaves the pre-existing contact id set untouched (no row is rewritten by the crosswalk)", async () => {
    assertRealOnDiskTarget();

    const before = idsIn(db, "contacts");
    expect(before).toEqual([...CONTACT_IDS].sort());

    await service.runMigrations();

    expect(idsIn(db, "contacts")).toEqual(before);
    // Nothing is auto-linked on upgrade — BACKLOG-2401 deliberately ships NO
    // backfill; links are created opportunistically during normal sync.
    expect(
      (db.prepare("SELECT id FROM contact_source_links").all() as Array<{ id: string }>).length,
    ).toBe(0);
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

  it("PERSISTS the upgrade: a fresh connection to the same file sees head", async () => {
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
