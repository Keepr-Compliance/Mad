/**
 * @jest-environment node
 *
 * MIGRATION-CHAIN REHEARSAL — BACKLOG-2700
 *
 * Runs the WHOLE chain that separates the shipped build from the next release
 * (v55 -> the chain head — twelve migrations as of v67) in ONE pass, against a
 * COMPLETE and POPULATED
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

import { chainHeadVersion } from "./helpers/chainHead";
// The version CURRENT code produces. v67's partial index embeds this as a
// literal (SQLite cannot parameterise an index predicate), so the probe below
// reads the constant rather than re-typing the number.
import { CURRENT_DERIVATION_VERSION } from "../../utils/derivationVersion";
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
// BACKLOG-2791: derived from MIGRATIONS, so adding a migration does not
// silence the only real-file rehearsal in the suite.
const HEAD_VERSION = chainHeadVersion();

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

  /** The stored DDL of an index, or undefined when no such index exists. */
  function indexSql(name: string): string | undefined {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
      .get(name) as { sql: string | null } | undefined;
    return row ? String(row.sql ?? "") : undefined;
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

    // ...v64's re-keyed phone lookup keys are UNWRITTEN...
    //
    // THIS IS WHAT KEEPS THE v64 PROBE HONEST. Every `phone_normalized` and
    // every `phones_normalized_json` in the shipped transcript is NULL, so the
    // values the probe below reads can only have been written by v64. A future
    // fixture regen from a build that already ran v64 would carry the re-keyed
    // values, the probe would pass without v64 doing anything, and these lines
    // fail first instead.
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM contact_phones WHERE phone_normalized IS NOT NULL")
          .get() as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM external_contacts WHERE phones_normalized_json IS NOT NULL",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);

    // ...v65's watermark column and both of its UNIQUE indexes are absent...
    //
    // `pending_review_communications` itself is deliberately NOT asserted here,
    // and that omission is the point: it IS declared in schema.sql (:1456),
    // which runMigrations() execs BEFORE the chain, so the TABLE arrives whether
    // or not v65 runs. Its two UNIQUE indexes are NOT in schema.sql (by design —
    // BACKLOG-2298/2300), and `transactions` already exists here so
    // `CREATE TABLE IF NOT EXISTS` cannot add a column to it. Those three
    // objects are v65's only observable effects on this path, and they are
    // exactly what the v65 probe asserts.
    expect(columnNames("transactions")).not.toContain("last_pending_scan_at");
    expect(indexSql("idx_pending_review_txn_email")).toBeUndefined();
    expect(indexSql("idx_pending_review_txn_thread")).toBeUndefined();

    // ...and v67's column and index are absent.
    //
    // THIS IS WHAT KEEPS THE v67 PROBE HONEST. `schema.sql` NOW DECLARES
    // `derived_version` inside `CREATE TABLE emails` (schema.sql:499), and
    // runMigrations() execs schema.sql BEFORE the chain. That exec cannot add
    // the column here — the statement is `CREATE TABLE IF NOT EXISTS` and this
    // fixture's `emails` already exists — so on THIS path the column can only
    // come from v67. If a future fixture regen produced a table that already had
    // it, the probe below would pass without v67 doing anything, and this line
    // fails first instead. Same reasoning as the bulk_mail_headers line above,
    // and the same shape as `migration-v67.test.ts`'s own pre-state assertion.
    expect(columnNames("emails")).not.toContain("derived_version");
    // The partial index ships in v67 and NOT in schema.sql (a standalone
    // CREATE INDEX on a migrated column throws "no such column" on every real
    // upgrade — BACKLOG-2298/2300/2750), so it too must be absent here.
    expect(indexSql("idx_emails_derived_version_stale")).toBeUndefined();
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
  // STRUCTURAL PROBES — one per migration in the chain this fixture runs
  // (v56..HEAD), so control 2 goes red whichever migration is dropped, WITH TWO
  // NAMED EXEMPTIONS. The header used to say "one per migration" flatly; it was
  // false for four migrations at once (BACKLOG-2860), which is how v63..v66 all
  // reached a state where their bodies could be replaced with `return;` and this
  // suite stayed green. v64 and v65 are probed below. v63 and v66 CANNOT be
  // probed here, for reasons that are measured rather than assumed:
  //
  //   v63 (BACKLOG-2750, seven columns + seven indexes) — ALL FOURTEEN OBJECTS
  //       ARE ALREADY IN THE SHIPPED FIXTURE. v2.27.0's schema.sql declared each
  //       column in its CREATE TABLE and carried each standalone CREATE INDEX,
  //       so the restored transcript has them before anything runs. Measured on
  //       the fixture alone, ahead of any exec: all 7 columns present, all 7
  //       indexes present. v63's body is `if (!cols.includes(column))` plus
  //       `CREATE INDEX IF NOT EXISTS`, so on THIS database it is a total no-op.
  //       Any probe would assert state the fixture already holds — green with
  //       v63 neutered, i.e. exactly the vacuous probe this item exists to
  //       prevent. v63 is aimed at a PRE-2026-02-17 database, which is older
  //       than this fixture; probing it needs a second, older corpus, not a
  //       probe here. `migration-v63.test.ts` covers it on a synthetic one.
  //
  //   v66 (BACKLOG-2814, message_thread_names + its index) — BOTH OBJECTS ARE
  //       CREATED BY schema.sql BEFORE THE CHAIN RUNS. schema.sql declares
  //       `CREATE TABLE IF NOT EXISTS message_thread_names` (:333) and
  //       `CREATE INDEX IF NOT EXISTS idx_message_thread_names_thread` (:343),
  //       and runMigrations() execs schema.sql at :776 before
  //       _runVersionedMigrations(). Measured: after the fixture restore both are
  //       absent; after exec(schema.sql), before the chain, both are PRESENT.
  //       Unlike v65's column and v67's, the table does not yet exist in the
  //       fixture, so `IF NOT EXISTS` does not save it — schema.sql creates it
  //       outright. v66's body is therefore unreachable-in-effect on every
  //       runMigrations() path, which is a finding about the migration and not
  //       about this suite (recorded on BACKLOG-2860; the migration's own comment
  //       claims "an upgrade runs this block and never reads schema.sql", which
  //       is not what runMigrations does). `migration-v66.test.ts` exercises the
  //       body directly, without schema.sql, and is unaffected.
  //
  // Both exemptions are ENFORCED, not merely written down: the coverage test at
  // the bottom of this file re-checks each premise against the fixture and
  // schema.sql, so if a fixture regen or a schema.sql edit ever makes one of
  // these migrations observable, that test goes red and demands the probe.
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

  it("v64 applied: every persisted phone lookup key is re-keyed to the libphonenumber rule", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    // THE EXPECTED KEYS ARE LITERALS, ON PURPOSE.
    //
    // v64's body `require`s the LIVE `toLookupKey` and writes whatever it
    // returns. A probe that computed its expectation through the SAME helper
    // would assert f(x) === f(x): it would still catch a neutered migration
    // (NULL is not a key) but it would say nothing about the RULE, and the rule
    // is the entire subject of BACKLOG-2630. So the values below were computed
    // from the live helper ONCE, at authoring time, and transcribed:
    //
    //     toLookupKey("+14155550102") -> "14155550102"   (DEFAULT_PHONE_REGION = "US")
    //
    // This is the opposite call from v67's, and for the opposite reason: there
    // the constant is INDEPENDENT of what the migration writes, so reading it is
    // what makes the check honest; here the function IS what the migration
    // writes, so reading it is what would make the check circular.
    //
    // CONSEQUENCE, STATED RATHER THAN DISCOVERED LATER: if the normalisation
    // rule ever changes again, this goes red. That is the correct outcome and
    // the migration's own comment says so — v64 FLOATS, and a rule change needs
    // a fresh re-key migration, not a silently-updated expectation here.

    // ------------------------------------------------------------------
    // (1) contact_phones.phone_normalized — recomputed from phone_e164.
    // Asserted as an exact id -> key MAP: a re-key that wrote the right values
    // onto the wrong rows holds every count and every id set.
    // ------------------------------------------------------------------
    const phones = db
      .prepare("SELECT id, phone_normalized FROM contact_phones ORDER BY id")
      .all() as Array<{ id: string; phone_normalized: string | null }>;
    expect(phones.map((r) => r.id)).toEqual([...CONTACT_PHONE_IDS].sort());
    expect(Object.fromEntries(phones.map((r) => [r.id, r.phone_normalized]))).toEqual({
      "cp-2700-ben": "14155550102",
      "cp-2700-dan": "14155550104",
      "cp-2700-eve": "14155550105",
    });

    // ...and none is the OLD ten-digit key. Stated separately because it names
    // the actual regression: the app computes "14155550102" while the database
    // holds "4155550102", and a contact becomes unfindable by his own number.
    for (const r of phones) expect(r.phone_normalized).not.toMatch(/^\d{10}$/);

    // ------------------------------------------------------------------
    // (2) external_contacts.phones_normalized_json — recomputed from phones_json.
    // A SEPARATE it-block assertion would be safer still, but these two share a
    // single upgrade; they are asserted here with their own mutation control
    // (see BACKLOG-2860) precisely because assertion (1) short-circuits.
    // ------------------------------------------------------------------
    const externals = db
      .prepare("SELECT id, phones_normalized_json FROM external_contacts ORDER BY id")
      .all() as Array<{ id: string; phones_normalized_json: string | null }>;
    expect(externals.map((r) => r.id)).toEqual([...EXTERNAL_CONTACT_IDS].sort());
    expect(Object.fromEntries(externals.map((r) => [r.id, r.phones_normalized_json]))).toEqual({
      "x-2700-ext-1": '["14155550106"]',
      "x-2700-ext-2": '["14155550107"]',
    });

    // ------------------------------------------------------------------
    // (3) phone_last_message is NOT asserted, and this is why.
    //
    // v64's third operation re-keys that table. The shipped fixture contains the
    // TABLE and ZERO ROWS (measured on the restored transcript:
    // `SELECT COUNT(*) FROM phone_last_message` -> 0), so the operation runs its
    // guard, finds nothing, and `changed` stays 0. Any assertion about it would
    // pass with the whole block deleted. Recorded here rather than written as a
    // vacuous line: a probe that cannot fail is worse than no probe, because it
    // makes the section header true while changing nothing. Covered instead by
    // `migration-v64.test.ts`, which seeds rows for it.
    // ------------------------------------------------------------------
  });

  it("v65 applied: the pending-review dedup indexes and the delta watermark column exist", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    // WHAT IS DELIBERATELY NOT ASSERTED: `pending_review_communications` itself.
    // schema.sql declares it (:1456) and runMigrations() execs schema.sql before
    // the chain, so the table arrives on this path with or without v65 — an
    // `expect(tableExists(...)).toBe(true)` here would be green under a neutered
    // v65 and would be pure decoration. The three objects below are v65's only
    // observable effects on a real upgrade, and each was confirmed absent in the
    // precondition test above.

    // (1) THE DELTA WATERMARK COLUMN, on a table that already existed — so
    // `CREATE TABLE IF NOT EXISTS transactions` in schema.sql cannot supply it.
    expect(columnNames("transactions")).toContain("last_pending_scan_at");

    // ...and it is NULL on every pre-existing transaction. v65 adds the column
    // and does not backfill a scan time, which is the true statement about rows
    // that have never been scanned; a non-NULL value here would make the delta
    // sync skip mail that predates the upgrade. Exact id -> value map, never a
    // count of NULLs.
    const txns = db
      .prepare("SELECT id, last_pending_scan_at FROM transactions ORDER BY id")
      .all() as Array<{ id: string; last_pending_scan_at: string | null }>;
    expect(txns.map((r) => r.id)).toEqual([...TRANSACTION_IDS].sort());
    expect(Object.fromEntries(txns.map((r) => [r.id, r.last_pending_scan_at]))).toEqual(
      Object.fromEntries([...TRANSACTION_IDS].sort().map((id) => [id, null])),
    );

    // (2) + (3) THE TWO UNIQUE DEDUP INDEXES. These are the DB backstop for the
    // sync's dedup predicate — measured on BACKLOG-2791: drop both and a repeated
    // sync leaves 4 rows where 2 belong. They are NOT in schema.sql, by design
    // (a standalone CREATE INDEX naming a not-yet-created object is the
    // BACKLOG-2298/2300/2750 crash), so on this path only v65 can create them.
    //
    // UNIQUE is asserted; the `WHERE ... IS NOT NULL` partial predicate is NOT.
    // The partial form is a size/readability choice and was mutation-tested on
    // BACKLOG-2791 as NOT load-bearing — SQLite treats every NULL as distinct, so
    // the non-partial form constrains identically. Asserting it would enshrine a
    // documented non-load-bearing choice as a requirement.
    for (const [name, columns] of [
      ["idx_pending_review_txn_email", "email_id"],
      ["idx_pending_review_txn_thread", "thread_id"],
    ] as const) {
      const sql = indexSql(name);
      expect(sql).toBeDefined();
      expect(sql).toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
      expect(sql).toMatch(
        new RegExp(`ON\\s+pending_review_communications\\s*\\(\\s*transaction_id\\s*,\\s*${columns}\\s*\\)`, "i"),
      );
    }
  });

  it("v67 applied: emails.derived_version exists, is 0 on every pre-existing row, and the partial stale index is present", async () => {
    assertRealOnDiskTarget();
    await upgrade();

    // (1) THE COLUMN EXISTS on a database that really is old.
    expect(columnNames("emails")).toContain("derived_version");

    // (2) ITS VALUE ON PRE-EXISTING ROWS IS 0 — read off the migration body, not
    // guessed. v67 runs
    //     ALTER TABLE emails ADD COLUMN derived_version INTEGER NOT NULL DEFAULT 0
    // and deliberately does NOT backfill: 0 is the true statement about these
    // rows (produced by the pre-BACKLOG-2855 derivation), and stamping them
    // CURRENT would declare them already repaired and strand the truncated
    // bodies this column exists to find. `migration-v67.test.ts` guards the same
    // property on a synthetic fixture; this asserts it on a real upgraded one.
    //
    // Asserted as an exact id -> version MAP, never as a count of zeroes: a
    // rebuild that dropped a row or stamped the wrong one holds the count.
    const rows = db
      .prepare("SELECT id, derived_version FROM emails ORDER BY id")
      .all() as Array<{ id: string; derived_version: number }>;
    expect(rows.map((r) => r.id)).toEqual([...EMAIL_IDS].sort());
    expect(Object.fromEntries(rows.map((r) => [r.id, r.derived_version]))).toEqual(
      Object.fromEntries([...EMAIL_IDS].sort().map((id) => [id, 0])),
    );
    // Stated separately because it is the failure that would otherwise be
    // invisible on a corpus where 0 and CURRENT happened to coincide.
    for (const r of rows) expect(r.derived_version).not.toBe(CURRENT_DERIVATION_VERSION);

    // (3) THE PARTIAL INDEX EXISTS, and its embedded literal still agrees with
    // the constant. Drift between the two does not change a single query RESULT
    // — it silently degrades the reprocess pass's `WHERE derived_version < ?`
    // scan to a table scan — so nothing else on the real-upgrade path would
    // notice. A future version bump must ship a migration REPLACING this index;
    // if that migration is forgotten, the chain lands here with the stale
    // literal and this line goes red.
    const sql = indexSql("idx_emails_derived_version_stale");
    expect(sql).toBeDefined();
    expect(sql).toMatch(/WHERE\s+derived_version\s*<\s*\d+/i);
    expect(Number(/WHERE\s+derived_version\s*<\s*(\d+)/i.exec(String(sql))?.[1])).toBe(
      CURRENT_DERIVATION_VERSION,
    );
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

  // =========================================================================
  // COVERAGE — the section header above is CHECKED, not asserted in prose.
  //
  // BACKLOG-2860. "One per migration" was a comment, and comments do not go red:
  // v63, v64, v65 and v66 all shipped with no probe while the header claimed
  // otherwise, and each could have had its body replaced with `return;` without
  // this suite noticing. This test fails when a migration joins the chain and no
  // probe follows it, so the next one cannot arrive silently.
  //
  // It reads THIS FILE's own source. That is the only way to see sibling test
  // names from inside a test, and it is deliberately narrow: the pattern anchors
  // on `it("vNN applied:` so a mention in a comment — including the long
  // exemption block above, which names v63 and v66 repeatedly — cannot satisfy
  // it. Verified by construction: the exemption block would otherwise make this
  // test pass with both probes deleted.
  // =========================================================================

  it("COVERAGE: every migration in the rehearsed chain has a probe, or a still-true exemption", () => {
    // Probed versions, read from this file's own `it` titles.
    const source = fs.readFileSync(__filename, "utf8");
    const probed = new Set<number>();
    for (const m of source.matchAll(/it\(\s*"v(\d+) applied:/g)) probed.add(Number(m[1]));

    // The chain this fixture actually runs: everything ABOVE the shipped
    // version, up to the head. Derived from MIGRATIONS the same way
    // chainHead.ts does, so a new migration shows up here without an edit.
    const versions = (
      service.constructor as { MIGRATIONS: Array<{ version: number }> }
    ).MIGRATIONS.map((m) => m.version);
    const rehearsed = versions.filter((v) => v > EXPECTED_SHIPPED_VERSION).sort((a, b) => a - b);
    expect(rehearsed.length).toBeGreaterThan(0);
    expect(Math.max(...rehearsed)).toBe(HEAD_VERSION);

    // ------------------------------------------------------------------
    // The exemptions, and the PREMISE each one rests on.
    //
    // A permanent exemption is a probe that cannot fail wearing a different hat,
    // so each premise is re-measured here. If a fixture regen or a schema.sql
    // edit makes either migration observable, its premise fails and this test
    // demands the probe that is now writable.
    // ------------------------------------------------------------------
    const exempt = new Set<number>([63, 66]);

    // v63: every object it would add is ALREADY in the shipped transcript, so it
    // is a no-op on this database. Checked against the fixture TEXT rather than
    // the live handle, so it holds even if a future edit reorders beforeEach.
    const fixtureSql = fs.readFileSync(FIXTURE_SQL_PATH, "utf8");
    for (const index of [
      "idx_users_local_license_type",
      "idx_users_local_organization",
      "idx_attachments_email_id",
      "idx_attachments_external_message_id",
      "idx_transactions_last_exported_on",
      "idx_transactions_submission_status",
      "idx_transactions_submission_id",
    ]) {
      // If a regenerated fixture (built by a post-BACKLOG-2750 shipped build,
      // whose schema.sql no longer carries these) lacks one of these, v63 STOPS
      // being a no-op and becomes probeable — and this line goes red.
      expect(fixtureSql).toContain(index);
    }
    // The seven COLUMNS are not checked separately, and that is not an omission:
    // a dump cannot contain `CREATE INDEX ... ON t(c)` for a column the table
    // does not have, so index presence already implies column presence. A second
    // loop over the column names would be a check that cannot fail — the exact
    // thing this test exists to stop.

    // v66: schema.sql creates both of its objects before the chain runs, so the
    // migration body cannot be observed through runMigrations(). If either
    // statement is removed from schema.sql, v66 becomes live on the upgrade path
    // and this goes red.
    const schemaSql = fs.readFileSync(
      path.join(__dirname, "..", "..", "database", "schema.sql"),
      "utf8",
    );
    expect(schemaSql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+message_thread_names/i);
    expect(schemaSql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_message_thread_names_thread/i,
    );

    // ------------------------------------------------------------------
    // No migration is both probed and exempt — an exemption left in place after
    // someone wrote the probe would quietly re-open the hole for the NEXT one.
    // ------------------------------------------------------------------
    expect([...exempt].filter((v) => probed.has(v))).toEqual([]);

    // ...and every rehearsed migration is one or the other.
    const uncovered = rehearsed.filter((v) => !probed.has(v) && !exempt.has(v));
    expect(uncovered).toEqual([]);
  });
});
