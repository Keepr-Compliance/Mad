/**
 * @jest-environment node
 *
 * MIGRATION-CHAIN REHEARSAL — BACKLOG-2700
 *
 * Runs the WHOLE chain that separates the shipped build from the next release
 * (v55 -> v62, seven migrations) in ONE pass, against a COMPLETE and POPULATED
 * database produced by the SHIPPED code, and asserts every record survives BY
 * EXACT IDENTITY.
 *
 * That is what a real upgrade does, and — before this file — nothing did it.
 *
 * ===========================================================================
 * WHAT WAS ALREADY COVERED, AND WHY IT WAS NOT ENOUGH
 * ===========================================================================
 * Every migration here has a strong individual test. They are not the gap.
 * The gap is stated in the tests themselves; `migration-v62.test.ts` property 5:
 *
 *     "IT NO-OPS WITHOUT `emails`, mirroring v48/v52..v58, so a MINIMAL
 *      PARTIAL-SCHEMA FIXTURE does not throw."
 *
 * Each migration is exercised ALONE against a synthetic minimal table. The
 * untested surface is therefore precisely the INTERACTIONS: a guard that passes
 * on a minimal fixture and fails on a real one, an ordering dependency between
 * two of the seven, or a rebuild that drops a column a later migration expects.
 * Note v59 and v61 each DROP and rebuild `contact_source_links`, which v57
 * created and v58/v60 read — exactly that shape.
 *
 * `.github/workflows/migration-check.yml` does not cover it either: it fires
 * only on `supabase/migrations/**` (the cloud Postgres database) and runs a
 * linter. The local SQLite chain had no upgrade job at all.
 *
 * ===========================================================================
 * HOW THIS DIFFERS FROM `databaseService.onDiskUpgrade.test.ts`
 * ===========================================================================
 * That file is the closest existing thing and it is genuinely valuable — a real
 * FILE, the real runner, real backups. It differs in ONE respect that turns out
 * to decide what can be detected: it builds its "v55" fixture by exec'ing
 * **develop's** `schema.sql` (line 437) and then running **develop's** chain
 * clipped to <= 55.
 *
 * develop's `schema.sql` DECLARES v62's `emails.bulk_mail_headers` in the
 * CREATE TABLE body (schema.sql:432). So that fixture's `emails` table ALREADY
 * HAS the column v62 adds — which is why the suite's own v62 test has to
 * `ALTER TABLE emails DROP COLUMN bulk_mail_headers` by hand to manufacture a
 * pre-v62 state. A fixture that must be un-migrated to look old cannot answer
 * the question "what happens to a database that really is old".
 *
 * THIS file starts from a database built by the SHIPPED code, where the column
 * has never existed (`grep -c bulk_mail_headers` over the fixture -> 0). The
 * consequence is measured, not asserted, in the control below.
 *
 * ===========================================================================
 * CONTROLS — RUN, AND WHAT THEY DID
 * ===========================================================================
 * A test that has never failed is not evidence. Both controls were executed,
 * the tree restored, and `git status --porcelain` verified empty afterwards.
 *
 * CONTROL 1 — the BACKLOG-2298/2300 shape.
 *   Append to `electron/database/schema.sql`:
 *       CREATE INDEX IF NOT EXISTS idx_ctrl2700_bmh ON emails(bulk_mail_headers);
 *   This is the exact defect that shipped in BACKLOG-2298: a standalone index in
 *   schema.sql on a column only the chain adds. `runMigrations()` execs
 *   schema.sql BEFORE the chain (databaseService.ts:776 -> 777), so on a fresh
 *   install the column is already in the CREATE TABLE and the index is fine,
 *   while on a REAL upgrade the old table has no such column.
 *   RESULT: this suite goes RED, every upgrading test, with
 *       SqliteError: no such column: bulk_mail_headers
 *   Full results, including what the pre-existing suite does under the same
 *   mutation, are recorded on BACKLOG-2700 in pm_comments.
 *
 * CONTROL 2 — a migration removed from the chain.
 *   Comment v57's entry out of `DatabaseService.MIGRATIONS`.
 *   RESULT: 15 of 17 RED with
 *       Migration sequence error: Missing migration version 57 (found 56 -> 58)
 *   — the runner's own sequence guard, before any probe is reached.
 *
 * CONTROL 2b — v57 PRESENT but neutered (`return;` as the first statement of its
 *   `migrate`), so the sequence guard is satisfied and the chain still lands on
 *   62. This is the sharper one.
 *   RESULT: exactly 4 RED, and they are precisely the v57-dependent probes —
 *   v57, v59, v60, v61 — while 13 pass, including "the app opens" and every
 *   id-set assertion. Under the same mutation `migration-v59`, `migration-v61`
 *   and `migration-v62` all stayed GREEN: the downstream migrations do not
 *   notice that their prerequisite did nothing, because each seeds its own
 *   minimal fixture. That is the interaction blind spot, demonstrated.
 *
 * CONTROL 3 — the `foreign_keys = ON` line after the fixture restore removed.
 *   RESULT: exactly 1 RED — `expect(db.pragma("foreign_keys"))`, Expected 1,
 *   Received 0. Proves that assertion is not vacuous, and that the fixture's
 *   own `PRAGMA foreign_keys=OFF;` really would leave the chain running from
 *   the wrong state without it.
 *
 * ===========================================================================
 * IDENTITY, NEVER COUNTS
 * ===========================================================================
 * Every survival assertion compares an exact SET of ids. Row counts are
 * asserted too, but only ALONGSIDE the sets, never instead of them: the failure
 * this rehearsal exists to catch — a table rebuild copying columns positionally,
 * or dropping rows it could not map — is the kind that holds the count while
 * changing the contents. (`INSERT ... SELECT *` in v33/v36 is exactly that
 * shape, and was fixed on develop for exactly that reason.)
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — same block as databaseService.onDiskUpgrade.test.ts. Sentry.flush is
// included because runMigrations() awaits it on the failure path; without it a
// genuine migration failure surfaces as "Sentry.flush is not a function"
// instead of the real error, which would hide exactly what control 1 proves.
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
import {
  CONTACT_EMAIL_IDS,
  CONTACT_IDS,
  CONTACT_PHONE_IDS,
  TRANSACTION_CONTACT_IDS,
  EMAIL_IDS,
  EXPECTED_ROW_COUNTS,
  EXPECTED_SHIPPED_VERSION,
  EXTERNAL_CONTACT_IDS,
  FROZEN_EXPORT_STAMPS,
  MESSAGE_IDS,
  PARTIES_BY_TRANSACTION,
  TRANSACTION_FROZEN,
  TRANSACTION_IDS,
  TRANSACTION_OPEN,
  USER_ID,
} from "./fixtures/rehearsalCorpus";

// Bypass the Jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock — the whole point of this file is a real file-backed DB.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

/**
 * The shipped-state transcript. Generated from a worktree of the SHIPPED code
 * by `buildV2270Fixture.gen.ts` — see that file for provenance and for how to
 * regenerate when a new version ships.
 */
const FIXTURE_SQL_PATH = path.join(__dirname, "fixtures", "v2.27.0-populated.sql");

/** The version the chain must land on — the LAST entry in MIGRATIONS. */
const HEAD_VERSION = 63;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

describe("databaseService — v2.27.0 -> develop migration-chain rehearsal (BACKLOG-2700)", () => {
  let service: AnyService;
  let tmpDir: string;
  let dbFile: string;
  let db: DatabaseType;
  const createdTmpDirs: string[] = [];

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function ids(sql: string): string[] {
    return (db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id).sort();
  }

  function columnNames(table: string): string[] {
    return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
  }

  function tableExists(name: string): boolean {
    return !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name);
  }

  function tableSql(name: string): string {
    return String(
      (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(name) as
          | { sql: string }
          | undefined
      )?.sql ?? "",
    );
  }

  function schemaVersion(): number {
    return (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
    ).version;
  }

  function rowCount(table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  }

  function partySet(transactionId: string): string[] {
    return (
      db
        .prepare("SELECT contact_id AS id FROM transaction_contacts WHERE transaction_id = ?")
        .all(transactionId) as Array<{ id: string }>
    )
      .map((r) => r.id)
      .sort();
  }

  /**
   * ANCHOR — called at the top of EVERY test.
   *
   * If `dbPath` were ever null or `:memory:`, this suite would silently stop
   * testing the upgrade path and start testing nothing, which is the exact
   * blind spot it exists to close. Asserted per-test rather than once in
   * beforeEach so a test that reassigns dbPath mid-run is still caught.
   */
  function assertRealOnDiskTarget(): void {
    expect(service.dbPath).not.toBeNull();
    expect(service.dbPath).not.toBe(":memory:");
    expect(service.dbPath).toBe(dbFile);
    expect(path.isAbsolute(String(service.dbPath))).toBe(true);
    expect(fs.existsSync(dbFile)).toBe(true);
    expect(fs.statSync(dbFile).size).toBeGreaterThan(0);
    // ...and the handle really is bound to THAT file. An in-memory connection
    // reports an EMPTY file here, so this catches a silent ":memory:" fallback
    // that left dbPath looking correct. realpath both sides: macOS reports
    // /private/var for a /var symlink and Windows temp dirs can be 8.3 short
    // names, neither of which SQLite normalises for us.
    const list = db.pragma("database_list") as Array<{ name: string; file: string }>;
    const mainDb = list.find((r) => r.name === "main");
    expect(mainDb?.file).toBeTruthy();
    expect(fs.realpathSync(String(mainDb?.file))).toBe(fs.realpathSync(dbFile));
  }

  /**
   * The ACT phase: the PUBLIC entry point, so schema.sql is exec'd and the
   * backup / snapshot branches run exactly as they do on a real launch.
   */
  async function upgrade(): Promise<void> {
    await service.runMigrations();
    db = service.db as DatabaseType;
  }

  // -------------------------------------------------------------------------

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-rehearsal-2700-"));
    createdTmpDirs.push(tmpDir);
    dbFile = path.join(tmpDir, "mad.db");

    db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");

    // ARRANGE — restore the shipped-state transcript onto a real file. Nothing
    // about this shape is written here; it is replayed from the generator's
    // output, which came from the shipped code's own init path.
    db.exec(fs.readFileSync(FIXTURE_SQL_PATH, "utf8"));

    // RE-ENABLE foreign_keys AFTER the restore, and not only before it.
    //
    // The dump opens with `PRAGMA foreign_keys=OFF;` so it can create tables in
    // any order, and never turns it back on. Without this line the connection
    // therefore enters the act phase with FK enforcement OFF — which is NOT the
    // handle a real launch migrates on: `_openDatabase()` sets
    // `foreign_keys = ON` (databaseService.ts:360).
    //
    // That difference is load-bearing, not cosmetic. `_runVersionedMigrations()`
    // reads the CURRENT pragma into `fkWasOn` (databaseService.ts:3576), turns
    // FKs off for the duration of the chain, and restores them to ON afterwards
    // ONLY IF they were on to begin with (:3607). Left off, this suite would run
    // the chain from the wrong starting state and finish with enforcement
    // disabled, so the restore branch would never execute here.
    db.pragma("foreign_keys = ON");

    // Deferred require so the jest.mock factories above are applied first.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../databaseService").default;
    service.db = db;
    service.dbPath = dbFile;
    service.encryptionKey = "test-encryption-key-hex";
    setDb(db);
    setDbPath(dbFile);
    setEncryptionKey("test-encryption-key-hex");
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
  // PRECONDITIONS — the fixture really is the old shape, and really is populated
  // =========================================================================

  it("PRECONDITION: the fixture is a populated database at the SHIPPED schema version", () => {
    assertRealOnDiskTarget();

    expect(schemaVersion()).toBe(EXPECTED_SHIPPED_VERSION);
    expect(EXPECTED_SHIPPED_VERSION).toBeLessThan(HEAD_VERSION);

    // Exact identities, so a rotted or truncated fixture fails HERE rather than
    // silently weakening every assertion downstream.
    expect(ids("SELECT id FROM contacts")).toEqual([...CONTACT_IDS].sort());
    expect(ids("SELECT id FROM transactions")).toEqual([...TRANSACTION_IDS].sort());
    expect(ids("SELECT id FROM emails")).toEqual([...EMAIL_IDS].sort());
    expect(ids("SELECT id FROM messages")).toEqual([...MESSAGE_IDS].sort());
    expect(ids("SELECT id FROM external_contacts")).toEqual([...EXTERNAL_CONTACT_IDS].sort());
    expect(ids("SELECT id FROM contact_emails")).toEqual([...CONTACT_EMAIL_IDS].sort());
    expect(ids("SELECT id FROM contact_phones")).toEqual([...CONTACT_PHONE_IDS].sort());
    expect(ids("SELECT id FROM transaction_contacts")).toEqual([...TRANSACTION_CONTACT_IDS].sort());
    expect(partySet(TRANSACTION_OPEN)).toEqual([...PARTIES_BY_TRANSACTION[TRANSACTION_OPEN]].sort());
    expect(partySet(TRANSACTION_FROZEN)).toEqual(
      [...PARTIES_BY_TRANSACTION[TRANSACTION_FROZEN]].sort(),
    );

    // The corpus spans more than one source — a single-source corpus would let a
    // migration that collapses provenance pass unnoticed.
    const sources = (
      db.prepare("SELECT DISTINCT source AS s FROM contacts ORDER BY s").all() as Array<{
        s: string;
      }>
    ).map((r) => r.s);
    expect(sources.length).toBeGreaterThanOrEqual(2);

    // And it contains a genuinely FROZEN transaction.
    const frozen = db
      .prepare("SELECT first_exported_at, export_status FROM transactions WHERE id = ?")
      .get(TRANSACTION_FROZEN) as { first_exported_at: string; export_status: string };
    expect(frozen.first_exported_at).toBe(FROZEN_EXPORT_STAMPS.first_exported_at);
    expect(frozen.export_status).toBe("exported");
  });

  it("PRECONDITION: the fixture predates every migration under test", () => {
    assertRealOnDiskTarget();

    // v56 columns absent...
    expect(columnNames("contacts")).not.toContain("removed_at");
    expect(columnNames("transaction_contacts")).not.toContain("removed_at");
    // ...v57 crosswalk absent...
    expect(tableExists("contact_source_links")).toBe(false);
    // ...v58 column absent...
    expect(columnNames("external_contacts")).not.toContain("source_identity_json");
    // ...v59 review queue absent...
    expect(tableExists("contact_link_proposals")).toBe(false);
    expect(tableExists("contact_link_verdicts")).toBe(false);
    // ...and v62's column absent.
    //
    // THIS IS THE ASSERTION THAT MAKES CONTROL 1 MEANINGFUL. A fixture built
    // from develop's schema.sql would FAIL here, because develop's CREATE TABLE
    // declares the column (schema.sql:432) — and a fixture that already has the
    // column cannot detect a standalone index placed on it.
    expect(columnNames("emails")).not.toContain("bulk_mail_headers");
  });

  // =========================================================================
  // THE REHEARSAL
  // =========================================================================

  it("the app opens: the whole chain runs to completion and lands on the head version", async () => {
    assertRealOnDiskTarget();
    await upgrade();
    assertRealOnDiskTarget();

    expect(schemaVersion()).toBe(HEAD_VERSION);
  });

  it("the upgraded database is internally consistent — integrity_check and foreign_key_check both clean", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    expect(integrity[0]?.integrity_check).toBe("ok");

    // Foreign-key enforcement is back ON after the chain. The runner disables it
    // for the duration (the documented safe table-rebuild procedure) and
    // restores it only if it was on when it started — so this asserts both that
    // the fixture entered the act phase in the production state AND that the
    // restore branch (databaseService.ts:3607) actually ran. A database left
    // with enforcement off would accept orphan writes on the next launch.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    // Empty = no orphans. A rebuild that recreated a table without re-pointing
    // its children shows up here and almost nowhere else.
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("survives a genuinely fresh connection — the upgrade is durable, not just in-cache", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();

    const reopened = new RealDatabase(dbFile) as DatabaseType;
    try {
      expect(
        (
          reopened.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
            version: number;
          }
        ).version,
      ).toBe(HEAD_VERSION);
      expect(
        (reopened.prepare("SELECT id FROM contacts").all() as Array<{ id: string }>)
          .map((r) => r.id)
          .sort(),
      ).toEqual([...CONTACT_IDS].sort());
    } finally {
      reopened.close();
      db = reopened;
    }
  });

  // =========================================================================
  // IDENTITY SURVIVAL — exact sets, never counts alone
  // =========================================================================

  it("every seeded record survives the chain BY EXACT ID SET", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    expect(ids("SELECT id FROM contacts")).toEqual([...CONTACT_IDS].sort());
    expect(ids("SELECT id FROM transactions")).toEqual([...TRANSACTION_IDS].sort());
    expect(ids("SELECT id FROM emails")).toEqual([...EMAIL_IDS].sort());
    expect(ids("SELECT id FROM messages")).toEqual([...MESSAGE_IDS].sort());
    expect(ids("SELECT id FROM external_contacts")).toEqual([...EXTERNAL_CONTACT_IDS].sort());
    expect(ids("SELECT id FROM users_local")).toEqual([USER_ID]);

    // Child rows carry their OWN identity, and it must survive too. `id` on
    // these three tables is `TEXT PRIMARY KEY` — which SQLite lets you leave
    // NULL — so a rebuild that regenerated or dropped these ids would keep every
    // row count and every parent id intact and be invisible without this.
    expect(ids("SELECT id FROM contact_emails")).toEqual([...CONTACT_EMAIL_IDS].sort());
    expect(ids("SELECT id FROM contact_phones")).toEqual([...CONTACT_PHONE_IDS].sort());
    expect(ids("SELECT id FROM transaction_contacts")).toEqual([...TRANSACTION_CONTACT_IDS].sort());

    // ...and none of them is NULL, which an id-set comparison alone would not
    // say (a table of all-NULL ids compares equal to [null]).
    for (const t of ["contact_emails", "contact_phones", "transaction_contacts"]) {
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE id IS NULL`).get() as { n: number }).n,
      ).toBe(0);
    }
  });

  it("the party set of EACH transaction is preserved — and not cross-contaminated", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    // Per-transaction, not pooled. A rebuild that cross-joined parties onto the
    // wrong transaction would keep the pooled set and the total count intact,
    // and would fail only here.
    expect(partySet(TRANSACTION_OPEN)).toEqual([...PARTIES_BY_TRANSACTION[TRANSACTION_OPEN]].sort());
    expect(partySet(TRANSACTION_FROZEN)).toEqual(
      [...PARTIES_BY_TRANSACTION[TRANSACTION_FROZEN]].sort(),
    );

    // The two sets are disjoint by construction; assert that too, so a future
    // corpus edit cannot quietly weaken the test above.
    const open = new Set(partySet(TRANSACTION_OPEN));
    expect(partySet(TRANSACTION_FROZEN).filter((c) => open.has(c))).toEqual([]);
  });

  it("the FROZEN transaction keeps its export stamps byte-for-byte", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    const frozen = db
      .prepare(
        "SELECT first_exported_at, last_exported_at, export_status, export_format, export_count FROM transactions WHERE id = ?",
      )
      .get(TRANSACTION_FROZEN) as Record<string, unknown>;

    // first_exported_at is the write-once freeze boundary (BACKLOG-2013). A
    // rebuild that shifted it onto the wrong row or cleared it would silently
    // re-open a frozen audit record.
    expect(frozen.first_exported_at).toBe(FROZEN_EXPORT_STAMPS.first_exported_at);
    expect(frozen.last_exported_at).toBe(FROZEN_EXPORT_STAMPS.last_exported_at);
    expect(frozen.export_status).toBe(FROZEN_EXPORT_STAMPS.export_status);
    expect(frozen.export_format).toBe(FROZEN_EXPORT_STAMPS.export_format);
    expect(frozen.export_count).toBe(FROZEN_EXPORT_STAMPS.export_count);

    // ...and the transaction that was never exported is still unfrozen. Asserted
    // explicitly: a migration that stamped EVERY row would satisfy the check
    // above and be caught only here.
    const open = db
      .prepare("SELECT first_exported_at, export_status FROM transactions WHERE id = ?")
      .get(TRANSACTION_OPEN) as { first_exported_at: string | null; export_status: string };
    expect(open.first_exported_at).toBeNull();
    expect(open.export_status).toBe("not_exported");
  });

  it("per-table row counts are unchanged (asserted ALONGSIDE the id sets, never instead of them)", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    const actual: Record<string, number> = {};
    for (const t of Object.keys(EXPECTED_ROW_COUNTS)) actual[t] = rowCount(t);
    expect(actual).toEqual(EXPECTED_ROW_COUNTS);
  });

  // =========================================================================
  // STRUCTURAL PROBES — one per migration, so control 2 goes red whichever
  // migration is dropped from the chain.
  // =========================================================================

  it("v56 applied: tombstone columns exist on contacts AND transaction_contacts", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    expect(columnNames("contacts")).toEqual(expect.arrayContaining(["removed_at", "removed_reason"]));
    expect(columnNames("transaction_contacts")).toEqual(
      expect.arrayContaining(["removed_at", "removed_reason"]),
    );
    // Pre-existing rows are NOT tombstoned by the migration.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE removed_at IS NOT NULL").get() as {
        n: number;
      }).n,
    ).toBe(0);
  });

  it("v57 applied: the contact_source_links crosswalk exists, and external_contacts gained external_uuid", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    expect(tableExists("contact_source_links")).toBe(true);
    expect(columnNames("external_contacts")).toContain("external_uuid");
  });

  it("v58 applied: external_contacts.source_identity_json exists and is NULL for pre-existing rows", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    expect(columnNames("external_contacts")).toContain("source_identity_json");
    const rows = db
      .prepare("SELECT id, source_identity_json FROM external_contacts ORDER BY id")
      .all() as Array<{ id: string; source_identity_json: string | null }>;
    expect(rows.map((r) => r.id)).toEqual([...EXTERNAL_CONTACT_IDS].sort());
    for (const r of rows) expect(r.source_identity_json).toBeNull();
  });

  it("v59 applied: the contact link review queue and its durable verdicts exist", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    expect(tableExists("contact_link_proposals")).toBe(true);
    expect(tableExists("contact_link_verdicts")).toBe(true);
    // v59 also admits the `unique_name` match method on the crosswalk. Read from
    // the live CHECK rather than from a constant, so a rebuild that narrowed the
    // vocabulary is caught.
    expect(tableSql("contact_source_links")).toContain("unique_name");
  });

  it("v61 applied: the crosswalk vocabulary is the WIDE one — manual and message-derived contacts can be linked", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    const sql = tableSql("contact_source_links");
    // BACKLOG-2473 widened source_type past the five import sources. v59 and v61
    // each DROP and rebuild this table, so this also proves the two rebuilds ran
    // in the right order — a v61-then-v59 ordering would leave the NARROW check.
    for (const v of ["manual", "email", "sms", "inferred"]) expect(sql).toContain(`'${v}'`);
  });

  it("v62 applied: emails.bulk_mail_headers exists and is NULL for every pre-existing row", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    expect(columnNames("emails")).toContain("bulk_mail_headers");
    const rows = db
      .prepare("SELECT id, bulk_mail_headers FROM emails ORDER BY id")
      .all() as Array<{ id: string; bulk_mail_headers: string | null }>;
    expect(rows.map((r) => r.id)).toEqual([...EMAIL_IDS].sort());
    for (const r of rows) expect(r.bulk_mail_headers).toBeNull();
  });

  // =========================================================================
  // v60 — the value-provenance relabel, observed on a REAL corpus.
  //
  // This is the migration a minimal fixture cannot exercise: it decides, per
  // contact value, whether any crosswalk-linked source record vouches for that
  // value, and relabels the ones nothing vouches for as hand-typed. With no
  // contacts, no crosswalk and no external records it has nothing to read.
  // =========================================================================

  it("v60 applied: values no source vouches for are relabelled 'manual', and each contact keeps ITS OWN values", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    const emails = db
      .prepare("SELECT contact_id, email, source FROM contact_emails ORDER BY contact_id, email")
      .all() as Array<{ contact_id: string; email: string; source: string }>;

    // IDENTITY, not counts: every value is still attached to the contact it was
    // seeded on. This is the assertion that would catch BACKLOG-2669's shape —
    // a backfill pulling values from unrelated records onto a migrated contact.
    expect(emails.map((r) => `${r.contact_id}|${r.email}`)).toEqual([
      "c-2700-google-cara|cara@example.test",
      "c-2700-manual-dan|dan.alt@example.test",
      "c-2700-manual-dan|dan@example.test",
      "c-2700-outlook-ann|ann@example.test",
    ]);

    // No 'import' value survives when nothing vouches for it: this corpus has no
    // crosswalk rows joining these contacts to an external record, so v60's
    // documented safe direction is to protect every one of them as hand-typed.
    expect(emails.filter((r) => r.source === "import")).toEqual([]);

    const phones = db
      .prepare("SELECT contact_id, phone_e164, source FROM contact_phones ORDER BY contact_id")
      .all() as Array<{ contact_id: string; phone_e164: string; source: string }>;
    expect(phones.map((r) => `${r.contact_id}|${r.phone_e164}`)).toEqual([
      // SQL ORDER BY contact_id: "inferred" sorts before "iphone".
      "c-2700-inferred-eve|+14155550105",
      "c-2700-iphone-ben|+14155550102",
      "c-2700-manual-dan|+14155550104",
    ]);
    expect(phones.filter((r) => r.source === "import")).toEqual([]);
  });

  // =========================================================================
  // The pre-migration backup — a real upgrade takes one, and it must be a
  // PRE-migration snapshot, not an empty file.
  // =========================================================================

  it("takes a pre-migration backup whose CONTENT is the old database", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    const backups = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("mad-backup-") && f.endsWith(".db"));
    expect(backups.length).toBeGreaterThanOrEqual(1);

    // Open it as its own database. Asserting the file merely EXISTS cannot tell
    // a genuine snapshot from a zero-byte placeholder or a post-migration copy.
    const backup = new RealDatabase(path.join(tmpDir, backups[0]), { readonly: true });
    try {
      expect(
        (
          backup.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
            version: number;
          }
        ).version,
      ).toBe(EXPECTED_SHIPPED_VERSION);
      // ...and it predates the chain: v62's column is absent from the snapshot.
      const cols = (
        backup.prepare("PRAGMA table_info(emails)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).not.toContain("bulk_mail_headers");
    } finally {
      backup.close();
    }
  });
});
