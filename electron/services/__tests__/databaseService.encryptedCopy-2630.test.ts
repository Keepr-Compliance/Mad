/**
 * @jest-environment node
 *
 * BACKLOG-2630 — THE PLAINTEXT->ENCRYPTED WHOLE-DATABASE COPY MUST NOT NAME
 * GENERATED COLUMNS.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * `_migrateToEncryptedDatabase()` copied every table with
 *
 *     const rows = oldDb.prepare(`SELECT * FROM "${tableName}"`).all();
 *     const columns = Object.keys(rows[0]);
 *     INSERT INTO "<table>" (<columns>) VALUES (...)
 *
 * `SELECT *` RETURNS stored generated columns. So the derived list named them,
 * and SQLite refused the statement at PREPARE time:
 *
 *     cannot INSERT into generated column "pair_key"
 *
 * Migration v69 (this PR's sibling) introduces `pair_key` on
 * `contact_link_proposals` and `contact_link_verdicts` — the schema's FIRST
 * `GENERATED ALWAYS AS (...) STORED` columns. The throw propagates out of the
 * function's catch (which restores the plaintext backup) and out of
 * `runMigrations()` in `initialize()`, so the app stops at "Database Update
 * Failed".
 *
 * ===========================================================================
 * REACHABILITY — STATED AS THE SR BOUNDED IT, NEITHER INFLATED NOR DISMISSED
 * ===========================================================================
 * NOT reachable in any shipped configuration today. Reaching it needs a
 * PLAINTEXT database already at v69, and there is no route to one:
 * `_openDatabase()` throws without a key, and SQLCipher cannot migrate a
 * plaintext file once a key is applied.
 *
 * It is a blocker anyway, and this file is why: the function is the app's
 * designated whole-database copy primitive, it had ZERO test coverage of any
 * kind, and the fix is one PRAGMA. A primitive nothing executes is a primitive
 * whose next caller inherits the bug.
 *
 * ===========================================================================
 * WHY THIS FILE DRIVES THE REAL FUNCTION AND A REAL DRIVER
 * ===========================================================================
 * `jest.config.js:37` maps `better-sqlite3-multiple-ciphers` to a stub. Under
 * that stub `new Database(...)` writes no file, every `prepare()` returns a
 * mock, and a test of this function would either die with
 * `ENOENT ... mad.db.encrypted` or — far worse — PASS while proving nothing,
 * because the mock cannot refuse an INSERT into a generated column.
 *
 * The `jest.mock` factory below takes precedence over `moduleNameMapper` and
 * hands the REAL native module to `databaseService.ts` itself. That matters
 * specifically here: `_migrateToEncryptedDatabase` constructs its own
 * connections internally (`new Database(unencryptedPath)`,
 * `new Database(encryptedPath)`), so injecting `service.db` from outside — the
 * trick the other on-disk suites use — cannot reach them.
 *
 * ===========================================================================
 * THE FIXTURES ARE TRANSCRIBED, NOT INVENTED
 * ===========================================================================
 * Both source databases are built from real shipped artefacts only: exec the
 * real `electron/database/schema.sql`, then run the REAL migration chain
 * through the REAL runner. The ONLY difference between them is where the chain
 * is clipped:
 *
 *   F0 (control)  chain <= 58  — no generated column exists anywhere in it.
 *   F1 / F3       full chain   — `pair_key` exists on both link tables.
 *
 * Both premises are ASSERTED from `PRAGMA table_xinfo`, not assumed, so neither
 * case can pass for the wrong reason.
 *
 * ---------------------------------------------------------------------------
 * WHY F0 CLIPS AT 58 AND NOT AT 68 — measured, and it surprised the author
 * ---------------------------------------------------------------------------
 * The first draft clipped F0 at 68, reasoning that v69 is what adds `pair_key`.
 * It went RED on its own precondition: a chain clipped to <= 68 ALREADY has
 * `contact_link_proposals.pair_key` and `contact_link_verdicts.pair_key`.
 *
 * Because migration v59 CREATES both tables by exec'ing the shared constants in
 * `electron/services/db/contactIdentitySchemaSql.ts`, and this branch edits
 * those constants. A fresh install therefore gets the head shape at v59; only a
 * database that already existed before v59 takes the v69 rebuild path. A
 * version-clipped chain does NOT reproduce a historical shape for a table whose
 * DDL comes from a shared constant — worth knowing before writing any fixture
 * that way.
 *
 * The consequence for this defect, stated plainly: on this branch the copy
 * would fail for ANY database at v59 or later, not only v69 ones. It is still
 * unreachable for the reason above — there is no route to a plaintext database
 * at any of those versions.
 *
 * So F0 clips at 58, the last version before either table exists. F0 and F1
 * then differ by the presence of the generated column, which is the variable
 * under test.
 *
 * NOTE ON `table_xinfo`: it appears in THIS FILE ONLY, to prove each fixture's
 * premise. The production fix uses `table_info` precisely because it OMITS
 * generated columns. Using `table_xinfo` in the production path would
 * reintroduce the bug.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS
// ---------------------------------------------------------------------------

// THE LOAD-BEARING ONE. Escapes the anchored `moduleNameMapper` entry in
// jest.config.js so `databaseService.ts` gets the real native driver.
jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

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

import { setDb, setDbPath, setEncryptionKey } from "../db/core/dbConnection";
import { chainHeadVersion } from "./helpers/chainHead";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCHEMA_SQL_PATH = path.join(REPO_ROOT, "electron", "database", "schema.sql");

/** The version this PR's migration lands on. A literal: the claim is about 69. */
const V69 = 69;
/**
 * The last version before `contact_link_proposals` / `contact_link_verdicts`
 * exist at all — see the header note on why this is 58 and not 68.
 */
const NO_GENERATED_COLUMN_VERSION = 58;

/**
 * A 256-bit raw key, hex. `_openDatabase()` and the migration both interpolate
 * it into `PRAGMA key = "x'<hex>'"`, which requires exactly 64 hex characters.
 * Fixed rather than random so a failure is reproducible.
 */
const KEY = "a".repeat(64);

// Synthetic ids. No real person, address, phone or mailbox appears in this file.
const USER_ID = "user-2630-encrypted-copy";
const CONTACT_LOW = "contact-aaa-2630";
const CONTACT_HIGH = "contact-zzz-2630";
const VERDICT_ID = "verdict-2630-1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

describe("_migrateToEncryptedDatabase — the whole-database copy (BACKLOG-2630)", () => {
  let service: AnyService;
  let tmpDir: string;
  let dbFile: string;
  const createdTmpDirs: string[] = [];

  /**
   * Builds a REAL plaintext database at `dbFile`, at `maxVersion`, from real
   * artefacts, and leaves the service pointed at it with a key set.
   *
   * Mirrors databaseService.onDiskUpgrade.test.ts: `dbPath` is held at null
   * while the chain runs, because `_runVersionedMigrations()` refuses to
   * migrate an on-disk DB with no pre-existing backup file — faking one would
   * pre-satisfy a check this file has no business touching.
   */
  async function buildPlaintextFixture(maxVersion: number): Promise<void> {
    const db = new RealDatabase(dbFile);
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(SCHEMA_SQL_PATH, "utf8"));

    service.db = db;
    setDb(db);
    service.dbPath = null;

    const klass = service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const allMigrations = klass.MIGRATIONS;
    klass.MIGRATIONS = allMigrations.filter((m) => m.version <= maxVersion);
    try {
      await service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = allMigrations;
    }

    // The population every fixture carries. `contacts` has no generated column
    // in either shape, so it is the row F0 proves the copy on and the row F1
    // proves is NOT collateral damage.
    db.prepare(
      `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
       VALUES (?, 'copy-2630@example.invalid', 'google', 'oauth-2630')`,
    ).run(USER_ID);
    for (const id of [CONTACT_LOW, CONTACT_HIGH]) {
      db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)").run(
        id,
        USER_ID,
        `Display ${id}`,
      );
    }

    // Close so the file is complete and unlocked before the function under
    // test opens it for itself.
    db.close();
    service.db = null;
    setDb(null as unknown as DatabaseType);

    service.dbPath = dbFile;
    service.encryptionKey = KEY;
    setDbPath(dbFile);
    setEncryptionKey(KEY);
  }

  /** Opens `dbFile` again through the REAL production opener. */
  function openMigrated(): DatabaseType {
    return service._openDatabase() as DatabaseType;
  }

  /** Every STORED generated column in a database, as "table.column". */
  function generatedColumns(db: DatabaseType): string[] {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const out: string[] = [];
    for (const { name } of tables) {
      // hidden: 2 = STORED generated, 3 = VIRTUAL generated.
      const cols = db.pragma(`table_xinfo("${name}")`) as { name: string; hidden: number }[];
      for (const c of cols) {
        if (c.hidden === 2 || c.hidden === 3) out.push(`${name}.${c.name}`);
      }
    }
    return out.sort();
  }

  /** Seeds one `contact_contact` verdict whose endpoints are OUT of sort order. */
  function seedReversedContactContactVerdict(): void {
    const db = new RealDatabase(dbFile);
    try {
      db.prepare(
        `INSERT INTO contact_link_verdicts
           (id, user_id, contact_id, source_type, source_record_id, identity_verdict,
            relationship_verdict, reason, matched_on, evidence_json, decided_at,
            decided_by, pair_kind, target_contact_id, target_source_type,
            target_source_record_id, subject_side)
         VALUES (?, ?, ?, NULL, NULL, 'different_people',
                 'no_known_connection', 'answered', 'email', '{"summary":"copied"}',
                 '2026-08-01 09:30:00',
                 'user', 'contact_contact', ?, NULL,
                 NULL, 'b')`,
        // contact_id is the HIGHER-sorting id and target_contact_id the LOWER
        // one, so min()/max() must actually reorder them. A generated column
        // that were merely copied verbatim would still equal the source value;
        // a WRONGLY recomputed one would come back as the unsorted join.
      ).run(VERDICT_ID, USER_ID, CONTACT_HIGH, CONTACT_LOW);
    } finally {
      db.close();
    }
  }

  /** The key the generated expression must produce for that row. */
  const EXPECTED_PAIR_KEY = `c:${CONTACT_LOW}|c:${CONTACT_HIGH}`;

  beforeEach(() => {
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-encrypted-copy-2630-"));
    createdTmpDirs.push(tmpDir);
    dbFile = path.join(tmpDir, "mad.db");
    // Deferred require so the jest.mock factories above are applied first.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../databaseService").default;
  });

  afterEach(() => {
    if (service) {
      try {
        service.db?.close();
      } catch {
        /* already closed */
      }
      service.db = null;
      service.dbPath = null;
      service.encryptionKey = null;
    }
    setDb(null as unknown as DatabaseType);
    setDbPath(null as unknown as string);
    setEncryptionKey(null as unknown as string);
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    for (const dir of createdTmpDirs) {
      expect(fs.existsSync(dir)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // PRECONDITIONS — without these the three cases below can pass vacuously.
  // -------------------------------------------------------------------------

  it("PRECONDITION: the real driver is wired, not the jest stub", () => {
    const probe = new RealDatabase(dbFile);
    try {
      probe.exec("CREATE TABLE probe (a INTEGER); INSERT INTO probe VALUES (7);");
      // The stub's `all()` returns [] for everything and writes no file.
      expect(probe.prepare("SELECT a FROM probe").all()).toEqual([{ a: 7 }]);
    } finally {
      probe.close();
    }
    expect(fs.existsSync(dbFile)).toBe(true);
    expect(fs.statSync(dbFile).size).toBeGreaterThan(0);
  });

  it("PRECONDITION: the chain head is v69 or later, so the F1 fixture can contain pair_key", () => {
    expect(chainHeadVersion()).toBeGreaterThanOrEqual(V69);
  });

  // -------------------------------------------------------------------------
  // F0 — CONTROL. Merge-base structure. No generated column exists.
  // -------------------------------------------------------------------------

  it("F0 (control): a database with NO generated column (<= v58) copies, and its rows land encrypted", async () => {
    await buildPlaintextFixture(NO_GENERATED_COLUMN_VERSION);

    // The control's premise, asserted rather than assumed: there is NOTHING
    // here for the defect to trip over. This is the line that caught the first
    // draft's wrong clip point — see the header.
    const before = new RealDatabase(dbFile);
    try {
      expect(generatedColumns(before)).toEqual([]);
    } finally {
      before.close();
    }

    await expect(service._migrateToEncryptedDatabase()).resolves.toBeUndefined();

    const after = openMigrated();
    try {
      expect(
        after.prepare("SELECT id, user_id, display_name FROM contacts ORDER BY id").all(),
      ).toEqual([
        { id: CONTACT_LOW, user_id: USER_ID, display_name: `Display ${CONTACT_LOW}` },
        { id: CONTACT_HIGH, user_id: USER_ID, display_name: `Display ${CONTACT_HIGH}` },
      ]);
    } finally {
      after.close();
    }

    // The plaintext original is gone and no scratch file survives.
    expect(fs.existsSync(`${dbFile}.encrypted`)).toBe(false);
    expect(fs.existsSync(`${dbFile}.backup`)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // F1 — the defect itself. RED before the fix, GREEN after.
  // -------------------------------------------------------------------------

  it("F1: a v69 database — which HAS a stored generated column — copies without error", async () => {
    await buildPlaintextFixture(chainHeadVersion());
    seedReversedContactContactVerdict();

    // The fixture's premise: `pair_key` really is a STORED generated column on
    // both tables. Before the fix this is what made the copy throw
    // `cannot INSERT into generated column`; if v69 ever stopped producing it,
    // this test would pass for the wrong reason and this line prevents that.
    const before = new RealDatabase(dbFile);
    try {
      expect(generatedColumns(before)).toEqual([
        "contact_link_proposals.pair_key",
        "contact_link_verdicts.pair_key",
      ]);
    } finally {
      before.close();
    }

    await expect(service._migrateToEncryptedDatabase()).resolves.toBeUndefined();

    // Not just "it did not throw": the ordinary rows are intact too, so a copy
    // that silently skipped tables cannot satisfy this.
    const after = openMigrated();
    try {
      expect(
        (after.prepare("SELECT id FROM contacts ORDER BY id").all() as { id: string }[]).map(
          (r) => r.id,
        ),
      ).toEqual([CONTACT_LOW, CONTACT_HIGH]);
    } finally {
      after.close();
    }
  });

  // -------------------------------------------------------------------------
  // F3 — the row lands AND the destination recomputes pair_key correctly.
  // -------------------------------------------------------------------------

  it("F3: the verdict lands field for field and the destination RECOMPUTES pair_key", async () => {
    await buildPlaintextFixture(chainHeadVersion());
    seedReversedContactContactVerdict();

    // What the source computed, read back rather than asserted from memory.
    const before = new RealDatabase(dbFile);
    let sourceRow: Record<string, unknown>;
    try {
      sourceRow = before
        .prepare("SELECT * FROM contact_link_verdicts WHERE id = ?")
        .get(VERDICT_ID) as Record<string, unknown>;
      expect(sourceRow.pair_key).toBe(EXPECTED_PAIR_KEY);
    } finally {
      before.close();
    }

    await service._migrateToEncryptedDatabase();

    const after = openMigrated();
    try {
      const copied = after
        .prepare("SELECT * FROM contact_link_verdicts WHERE id = ?")
        .get(VERDICT_ID) as Record<string, unknown>;

      // Field for field, INCLUDING pair_key — which the destination computed
      // for itself, because nothing wrote it.
      expect(copied).toEqual(sourceRow);

      // Stated as a literal too. `toEqual(sourceRow)` alone would be satisfied
      // by two databases that are wrong in the same way.
      expect(copied.pair_key).toBe(EXPECTED_PAIR_KEY);

      // And the reorder really happened: the endpoints were stored in the
      // OPPOSITE order, so an expression that just concatenated them would
      // produce this instead.
      expect(copied.pair_key).not.toBe(`c:${CONTACT_HIGH}|c:${CONTACT_LOW}`);
      expect(copied.contact_id).toBe(CONTACT_HIGH);
      expect(copied.target_contact_id).toBe(CONTACT_LOW);

      // pair_key is still GENERATED on the destination — the copy reproduced the
      // constraint, not just the value. A plain TEXT column holding the right
      // string would satisfy every assertion above and none of this one.
      expect(generatedColumns(after)).toEqual([
        "contact_link_proposals.pair_key",
        "contact_link_verdicts.pair_key",
      ]);
    } finally {
      after.close();
    }
  });
});
