/**
 * @jest-environment node
 *
 * BACKLOG-2559 — TransactionSchema MUST EQUAL THE `transactions` TABLE.
 *
 * ===========================================================================
 * THE MECHANISM THIS GUARDS
 * ===========================================================================
 * `validateResponse` (electron/schemas/validate.ts:28-63) calls `safeParse`.
 * On FAILURE it logs and returns `data as T` — the row survives intact, but
 * validation is silently disabled for it. On SUCCESS it returns `result.data`,
 * and Zod v4's plain `z.object` STRIPS unknown keys — so the caller gets an
 * amputated row.
 *
 * Both halves are invisible, and they fail in opposite directions:
 *
 *   - a column the schema FORGETS is silently deleted from every cleanly
 *     validating row. This is the BACKLOG-2532 mechanism that blanked
 *     `removed_reason` until PR #2211 declared it.
 *   - a declaration that is TOO STRICT (`z.string()` where the column is
 *     nullable) makes `safeParse` fail, which routes the row down the
 *     graceful-degradation branch. Nothing breaks, nothing is stripped, and
 *     the trust boundary quietly stops existing.
 *
 * `TransactionSchema` is wired to no boundary today (`getTransactionByIdSync`
 * returns raw `SELECT t.*` + a computed `email_count`). This test exists so
 * that whoever DOES wire it does not blank `last_exported_on` — the column the
 * export handlers actually write (BACKLOG-2109) — or `last_pending_scan_at`,
 * the Needs-Review delta watermark (BACKLOG-2791).
 *
 * ===========================================================================
 * WHY IT ENUMERATES INSTEAD OF READING schema.sql
 * ===========================================================================
 * Parts of the DDL are built inside migrations, so a text read of `schema.sql`
 * cannot see them. Only running the chain and asking the database gives the
 * real answer, so this test runs the app's own public entry point —
 * `runMigrations()`, i.e. `schema.sql` then the versioned chain — against a
 * REAL file-backed database and reads `PRAGMA table_info`. Same harness as
 * `electron/utils/__tests__/sqlFieldWhitelist.schemaParity.test.ts`
 * (BACKLOG-2739), deliberately copied rather than invented.
 *
 * ===========================================================================
 * THE ANCHOR THAT MAKES THE ANSWER TRUSTWORTHY
 * ===========================================================================
 * A chain that stopped early would produce a SMALLER column set, and this test
 * would then happily "prove" that real columns are phantoms — a green run
 * asserting a fiction. `schema_version` is therefore asserted to equal the head
 * of `MIGRATIONS` (derived via `chainHeadVersion()`, never hardcoded) BEFORE
 * any column set is compared.
 *
 * ===========================================================================
 * SETS, NOT COUNTS
 * ===========================================================================
 * Every assertion below is an exact sorted SET. A count cannot tell "59 real
 * columns" apart from "58 real columns and one phantom".
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — same block as sqlFieldWhitelist.schemaParity.test.ts. Sentry.flush is
// included because runMigrations() awaits it on the failure path; without it a
// genuine migration failure surfaces as "Sentry.flush is not a function"
// instead of the real error.
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../services/databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../../services/contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { setDb, setDbPath, setEncryptionKey } from "../../services/db/core/dbConnection";
import { chainHeadVersion } from "../../services/__tests__/helpers/chainHead";
import { validateResponse } from "../validate";
import { TransactionSchema } from "../transaction";

// Bypass the Jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock — the whole point of this file is a real file-backed DB.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

/**
 * The ONLY key `TransactionSchema` may declare that is not a column.
 *
 * `email_count` is computed by the read path itself — a
 * `COUNT(DISTINCT c.email_id)` subquery aliased `email_count` in
 * `getTransactionByIdSync` (transactionDbService.ts:725-733) and in the list
 * SELECT. It MUST stay declared: dropping it would strip the count the detail
 * view renders.
 *
 * Allow-listed BY NAME, never by a "computed fields are exempt" rule — the next
 * undeclared-but-plausible key has to be argued for here, in writing, before it
 * can pass. `text_count` had no column AND no producer on any read path, which
 * is why it was removed rather than added to this list.
 */
const COMPUTED_KEYS = ["email_count"] as const;

/**
 * Values for the columns a generic type-derived value cannot satisfy: CHECK
 * constraints, the primary key, and the FK. Everything else is derived from
 * `PRAGMA table_info`'s declared type, so a column added tomorrow is populated
 * automatically instead of being silently skipped.
 *
 * Each value is a legal member of that column's CHECK list, read off the
 * `transactions` DDL in electron/database/schema.sql.
 */
const COLUMN_VALUE_OVERRIDES: Record<string, unknown> = {
  id: "txn-2559-parity",
  user_id: "user-2559-parity",
  transaction_type: "purchase", // CHECK (purchase, sale, other)
  status: "active", // CHECK (pending, active, closed, rejected)
  stage: "escrow", // no CHECK; a documented-intent value from the DDL comment
  stage_source: "user", // CHECK (pattern, llm, user, import)
  export_status: "exported", // CHECK (not_exported, exported, re_export_needed)
  export_format: "pdf", // CHECK (pdf, csv, json, txt_eml, excel, folder)
  detection_source: "auto", // CHECK (manual, auto, hybrid)
  detection_status: "confirmed", // CHECK (pending, confirmed, rejected)
  submission_status: "submitted", // CHECK (not_submitted .. rejected)
};

const TIMESTAMP_VALUE = "2026-08-23T04:05:06.000Z";

/**
 * A value no CHECK list contains and no enum declares. Used to ask the DATABASE
 * and the SCHEMA the same question — "is this domain closed?" — so the two
 * answers can be compared instead of assumed.
 */
const DOMAIN_SENTINEL = "__not_a_legal_value__";

type ColumnInfo = { name: string; type: string; notnull: number; pk: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

describe("TransactionSchema — declared keys vs the real transactions table (BACKLOG-2559)", () => {
  jest.setTimeout(120000);

  let service: AnyService;
  let db: DatabaseType;
  let tmpDir: string;
  let dbFile: string;
  let columnInfo: ColumnInfo[];

  /**
   * A fresh install: an empty file taken through the app's own migration entry
   * point. This is the state a new user's database is in, and the one the
   * schema has to describe.
   */
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2559-schema-parity-"));
    dbFile = path.join(tmpDir, "mad.db");

    db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // Deferred require so the jest.mock factories above are applied first.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../../services/databaseService").default;
    service.db = db;
    service.dbPath = dbFile;
    service.encryptionKey = "test-encryption-key-hex";
    setDb(db);
    setDbPath(dbFile);
    setEncryptionKey("test-encryption-key-hex");

    await service.runMigrations();

    // runMigrations may hand back a different handle (restore paths reopen the
    // file). Re-point BOTH this suite and the db helpers at whatever it ended
    // up with, or the round-trip test below would read a stale connection.
    db = service.db as DatabaseType;
    setDb(db);

    columnInfo = db.prepare(`PRAGMA table_info("transactions")`).all() as ColumnInfo[];

    // The FK target for the fixture row. transactions.user_id REFERENCES
    // users_local(id) and foreign_keys is ON, so the INSERT below would throw
    // without this.
    db.prepare(
      `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
       VALUES (?, ?, ?, ?)`,
    ).run("user-2559-parity", "parity-2559@example.test", "google", "oauth-2559");
  });

  afterAll(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    service.db = null;
    setDb(null as never);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function realColumns(): string[] {
    return columnInfo.map((c) => c.name).sort();
  }

  function declaredKeys(): string[] {
    return Object.keys(TransactionSchema.shape).sort();
  }

  /** Declared keys minus the sanctioned computed ones — i.e. the column claim. */
  function declaredColumnKeys(): string[] {
    const computed = new Set<string>(COMPUTED_KEYS);
    return declaredKeys().filter((k) => !computed.has(k));
  }

  /**
   * A fully-populated row built from `PRAGMA table_info` itself: every real
   * column gets a value, chosen by the column's DECLARED TYPE, with the CHECK /
   * key columns overridden above. Deriving the column list from the database
   * rather than typing 59 names means a column added tomorrow enters the
   * fixture automatically — the failure this whole file is about is a column
   * nobody remembered.
   */
  function buildFullRow(): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const col of columnInfo) {
      if (col.name in COLUMN_VALUE_OVERRIDES) {
        row[col.name] = COLUMN_VALUE_OVERRIDES[col.name];
        continue;
      }
      const declaredType = col.type.toUpperCase();
      if (declaredType === "INTEGER") {
        row[col.name] = 1;
      } else if (declaredType === "REAL") {
        row[col.name] = 0.75;
      } else if (declaredType === "DATETIME" || declaredType === "DATE") {
        row[col.name] = TIMESTAMP_VALUE;
      } else {
        row[col.name] = `value-${col.name}`;
      }
    }
    return row;
  }

  function insertFullRow(): Record<string, unknown> {
    const row = buildFullRow();
    const names = Object.keys(row);

    // The fixture must cover EVERY real column, or the strip demo below would
    // be measuring a row the database never produces.
    expect(names.slice().sort()).toEqual(realColumns());

    db.prepare(`DELETE FROM transactions WHERE id = ?`).run(COLUMN_VALUE_OVERRIDES.id);
    db.prepare(
      `INSERT INTO transactions (${names.map((n) => `"${n}"`).join(", ")})
       VALUES (${names.map(() => "?").join(", ")})`,
    ).run(...names.map((n) => row[n]));
    return row;
  }

  // -------------------------------------------------------------------------
  // VALUE-DOMAIN HELPERS (BACKLOG-2559, SR review of PR #2364)
  //
  // The NULL sweep below probes exactly one value: null. COLUMN_VALUE_OVERRIDES
  // samples exactly one legal value per CHECK column. Between them, a
  // declaration that is too strict INSIDE an enum's domain is invisible: drop
  // 'rejected' from TransactionStatusSchema and the database still accepts the
  // row, safeParse still fails, validation is still silently disabled — and
  // every assertion above still passes. These helpers close that hole.
  // -------------------------------------------------------------------------

  /**
   * The CHECK domains, parsed off the MIGRATED database's own stored DDL rather
   * than off schema.sql — a column whose CHECK arrives in a migration is only
   * visible here.
   *
   * A regex over SQL is exactly the kind of derivation that quietly matches
   * nothing, so the parse is never trusted on its own: `verifies the parsed
   * CHECK domains against the database` below re-derives every list by asking
   * the database to accept and reject values.
   */
  function parseCheckDomains(): Map<string, string[]> {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'`)
      .get() as { sql: string } | undefined;
    if (!row?.sql) {
      throw new Error("transactions has no stored DDL in sqlite_master");
    }

    const domains = new Map<string, string[]>();
    const re = /CHECK\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s+IN\s*\(([^)]*)\)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(row.sql)) !== null) {
      const values = m[2]
        .split(",")
        .map((v) => v.trim().replace(/^'(.*)'$/, "$1"))
        .filter((v) => v.length > 0)
        .sort();
      domains.set(m[1], values);
    }
    return domains;
  }

  /**
   * Does the DATABASE accept this value in this column? Asked inside a
   * SAVEPOINT that is always rolled back, so the probe leaves no row behind.
   */
  function dbAccepts(column: string, value: unknown): boolean {
    const row = buildFullRow();
    row.id = `txn-2559-probe-${column}`;
    row[column] = value;
    const names = Object.keys(row);

    db.exec("SAVEPOINT domain_probe");
    let accepted: boolean;
    try {
      db.prepare(
        `INSERT INTO transactions (${names.map((n) => `"${n}"`).join(", ")})
         VALUES (${names.map(() => "?").join(", ")})`,
      ).run(...names.map((n) => row[n]));
      accepted = true;
    } catch {
      accepted = false;
    }
    db.exec("ROLLBACK TO domain_probe");
    db.exec("RELEASE domain_probe");
    return accepted;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function schemaShape(): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return TransactionSchema.shape as Record<string, any>;
  }

  /**
   * Columns whose DECLARATION refuses an arbitrary string — i.e. the schema
   * claims a closed value domain for them. Determined by probing, not by
   * inspecting zod internals, so it stays true across zod versions.
   *
   * Restricted to TEXT-affinity columns on purpose. A numeric declaration also
   * rejects the string sentinel, but that is type-correctness, not a narrowed
   * domain — counting it would flag every `z.number()` in the table and bury
   * the one finding that matters.
   */
  function closedDomainColumns(): string[] {
    const shape = schemaShape();
    const textColumns = new Set(
      columnInfo.filter((c) => c.type.toUpperCase() === "TEXT").map((c) => c.name),
    );
    return realColumns()
      .filter((c) => textColumns.has(c) && c in shape)
      .filter((c) => !shape[c].safeParse(DOMAIN_SENTINEL).success)
      .sort();
  }

  /** The declared enum members, unwrapping .nullable()/.optional(). */
  function enumOptions(column: string): string[] | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = schemaShape()[column];
    for (let i = 0; i < 10 && cur && typeof cur.unwrap === "function"; i++) {
      cur = cur.unwrap();
    }
    const opts = cur?.options;
    // `.options` is not unique to z.enum — a z.union exposes its MEMBER SCHEMAS
    // under the same name, and String()-ing those yields garbage that looks
    // like an enum. Require string members, which is what a CHECK list is.
    if (!Array.isArray(opts) || opts.length === 0) return null;
    if (!opts.every((o: unknown) => typeof o === "string")) return null;
    return [...(opts as string[])].sort();
  }

  // -------------------------------------------------------------------------
  // ANCHOR — everything below is meaningless if the chain did not reach head.
  // -------------------------------------------------------------------------

  it("migrated a real on-disk database all the way to the head migration", () => {
    const head = chainHeadVersion();

    const version = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
    ).version;

    expect(version).toBe(head);

    // ...and the handle really is bound to THAT file. An in-memory connection
    // would report an EMPTY file here, which would silently turn this whole
    // suite into a test of nothing.
    const list = db.pragma("database_list") as Array<{ name: string; file: string }>;
    const mainDb = list.find((r) => r.name === "main");
    expect(mainDb?.file).toBeTruthy();
    expect(fs.realpathSync(String(mainDb?.file))).toBe(fs.realpathSync(dbFile));
  });

  // -------------------------------------------------------------------------
  // PARITY — both directions, exact sets.
  // -------------------------------------------------------------------------

  describe("parity", () => {
    it("declares every real column and no others (beyond the computed allow-list)", () => {
      expect(realColumns().length).toBeGreaterThan(0); // table exists
      expect(declaredColumnKeys()).toEqual(realColumns());
    });

    it("OMITS no real column (the key that gets stripped off every valid row)", () => {
      const declared = new Set(declaredKeys());
      expect(realColumns().filter((c) => !declared.has(c))).toEqual([]);
    });

    it("declares NO phantom key (a name that is neither a column nor computed)", () => {
      const real = new Set(realColumns());
      const computed = new Set<string>(COMPUTED_KEYS);
      expect(declaredKeys().filter((k) => !real.has(k) && !computed.has(k))).toEqual([]);
    });

    it("still declares the computed read-path fields, which have no column", () => {
      // The inverse hazard: "make the parity test pass" by deleting
      // email_count would strip the count the detail view renders.
      const declared = new Set(declaredKeys());
      for (const key of COMPUTED_KEYS) {
        expect(declared.has(key)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // THE STRIP, DEMONSTRATED — the only assertion that shows the actual harm.
  // -------------------------------------------------------------------------

  describe("validateResponse round-trip", () => {
    it("returns a row with EXACTLY the keys the database gave it (nothing stripped)", () => {
      insertFullRow();
      const dbRow = db
        .prepare(`SELECT * FROM transactions WHERE id = ?`)
        .get(COLUMN_VALUE_OVERRIDES.id) as Record<string, unknown>;

      // GUARD: if safeParse FAILED, validateResponse returns the input
      // unchanged and the key-set assertion below would pass while proving
      // nothing. Assert the success branch was the one taken.
      const parsed = TransactionSchema.safeParse(dbRow);
      expect(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`))
        .toEqual([]);

      const validated = validateResponse(
        TransactionSchema,
        dbRow,
        "transactionSchemaParity.test",
      ) as Record<string, unknown>;

      expect(Object.keys(validated).sort()).toEqual(Object.keys(dbRow).sort());
    });

    it("preserves the VALUES of the columns a strip would blank", () => {
      insertFullRow();
      const dbRow = db
        .prepare(`SELECT * FROM transactions WHERE id = ?`)
        .get(COLUMN_VALUE_OVERRIDES.id) as Record<string, unknown>;

      const validated = validateResponse(
        TransactionSchema,
        dbRow,
        "transactionSchemaParity.test",
      ) as Record<string, unknown>;

      // Values, not presence: a null where a timestamp belongs is the
      // user-visible defect. last_exported_on is the export timestamp
      // (BACKLOG-2109); last_pending_scan_at is the Needs-Review delta
      // watermark (BACKLOG-2791); suggested_contacts drives the review queue
      // (BACKLOG-2737 / PR #2326).
      expect(validated.last_exported_on).toBe(TIMESTAMP_VALUE);
      expect(validated.last_pending_scan_at).toBe(TIMESTAMP_VALUE);
      expect(validated.suggested_contacts).toBe("value-suggested_contacts");
    });

    it("survives the REAL read path — getTransactionByIdSync + validateResponse", () => {
      insertFullRow();

      // Deferred require: the module reads the db helpers at call time, and the
      // mocks above have to be in place first.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getTransactionByIdSync } = require("../../services/db/transactionDbService");
      const row = getTransactionByIdSync(COLUMN_VALUE_OVERRIDES.id) as Record<string, unknown>;
      expect(row).toBeTruthy();

      // The read path adds the computed email_count. If the schema stopped
      // declaring it, this is where it would disappear.
      expect(row).toHaveProperty("email_count");

      const validated = validateResponse(
        TransactionSchema,
        row,
        "getTransactionByIdSync",
      ) as Record<string, unknown>;

      expect(Object.keys(validated).sort()).toEqual(Object.keys(row).sort());
      expect(validated.last_exported_on).toBe(TIMESTAMP_VALUE);
      expect(validated.last_pending_scan_at).toBe(TIMESTAMP_VALUE);
      expect(validated.email_count).toBe(row.email_count);
    });
  });

  // -------------------------------------------------------------------------
  // NULLABILITY — the OTHER direction, and the one with no visible symptom.
  //
  // A declaration stricter than the column makes safeParse fail, which sends
  // the row down validateResponse's `return data as T` branch: the row is
  // intact, so nothing looks wrong, but validation is disabled for it and only
  // a log line says so. Swept across ALL nullable columns, not just the ones
  // this item added — the pre-existing declarations are where the offenders
  // actually were.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // VALUE DOMAINS — strictness INSIDE an enum, the gap the NULL sweep cannot see.
  //
  // Same consequence as a too-strict nullability declaration and the same
  // absence of symptoms: safeParse fails, validateResponse returns the row
  // unvalidated, and only a log line records that the trust boundary stopped
  // existing for that row.
  // -------------------------------------------------------------------------

  describe("value domains", () => {
    it("verifies the parsed CHECK domains against the database", () => {
      const domains = parseCheckDomains();

      // A regex that matched nothing would make every assertion below vacuous.
      expect(domains.size).toBeGreaterThan(0);

      for (const [column, values] of domains) {
        expect(values.length).toBeGreaterThan(0);

        // Every value the parse claims is legal must actually be legal...
        const rejectedByDb = values.filter((v) => !dbAccepts(column, v));
        expect({ column, rejectedByDb }).toEqual({ column, rejectedByDb: [] });

        // ...and the domain must actually be closed, or "CHECK list" is a
        // fiction the parser invented.
        expect({ column, acceptsSentinel: dbAccepts(column, DOMAIN_SENTINEL) })
          .toEqual({ column, acceptsSentinel: false });
      }
    });

    it("accepts every value the column's CHECK admits", () => {
      const domains = parseCheckDomains();
      const shape = schemaShape();

      let probed = 0;
      const rejected: string[] = [];
      for (const [column, values] of domains) {
        // A column missing from the shape is the parity test's failure.
        if (!(column in shape)) continue;
        for (const value of values) {
          probed += 1;
          if (!shape[column].safeParse(value).success) {
            rejected.push(`${column}=${value}`);
          }
        }
      }

      expect(probed).toBeGreaterThan(0); // guards an empty sweep
      expect(rejected.sort()).toEqual([]);
    });

    it("claims a closed value domain ONLY where the column has a CHECK", () => {
      // The other direction, and the one with no CHECK to compare against: an
      // enum declared over a plain TEXT column is stricter than the column by
      // construction, so any value outside the enum disables validation for the
      // whole row. There is no exemption list here on purpose — a hatch is
      // where the next genuine violation gets parked.
      const domains = parseCheckDomains();
      const closedWithoutCheck = closedDomainColumns().filter((c) => !domains.has(c));
      expect(closedWithoutCheck).toEqual([]);
    });

    it("declares enum members that equal the column's CHECK list, as SETS", () => {
      const domains = parseCheckDomains();
      const closed = closedDomainColumns();
      const withOptions = realColumns()
        .filter((c) => enumOptions(c) !== null)
        .sort();

      // Every enum declaration in this schema sits on a TEXT column, so the two
      // derivations cover the same ground and can be compared directly.

      // ANTI-VACUITY: the reflection must agree with the behavioural probe. If
      // an unwrap breaks and enumOptions() starts returning null everywhere,
      // this diverges instead of silently comparing nothing.
      expect(withOptions).toEqual(closed);
      expect(withOptions.length).toBeGreaterThan(0);

      for (const column of withOptions) {
        expect({ column, options: enumOptions(column) })
          .toEqual({ column, options: domains.get(column) ?? null });
      }
    });

    it("accepts a fractional value for every REAL column", () => {
      // The numeric analogue of the enum gap: `.int()` on a REAL column would
      // fail safeParse on a legal value and disable validation for the row.
      const shape = schemaShape();
      const realTyped = columnInfo.filter(
        (c) => c.type.toUpperCase() === "REAL" && c.name in shape,
      );

      expect(realTyped.length).toBeGreaterThan(0); // guards an empty sweep
      const tooStrict = realTyped
        .filter((c) => !shape[c.name].safeParse(0.5).success)
        .map((c) => c.name)
        .sort();
      expect(tooStrict).toEqual([]);
    });
  });

  describe("nullability", () => {
    /**
     * Columns the DATABASE allows to be NULL. `pk` is excluded on purpose:
     * SQLite reports `id TEXT PRIMARY KEY` as notnull=0 on a rowid table, and
     * demanding a nullable `id` would be over-loosening in the name of a quirk.
     */
    function nullableColumns(): ColumnInfo[] {
      return columnInfo.filter((c) => c.notnull === 0 && c.pk === 0);
    }

    it("has at least one nullable column to sweep (guards an empty sweep)", () => {
      expect(nullableColumns().length).toBeGreaterThan(0);
    });

    it("accepts NULL for every column the database lets be NULL", () => {
      const shape = TransactionSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
      const tooStrict = nullableColumns()
        // A column missing from the shape is the parity test's failure, not
        // this one's — reporting it twice would obscure which check is red.
        .filter((c) => c.name in shape)
        .filter((c) => !shape[c.name].safeParse(null).success)
        .map((c) => c.name)
        .sort();

      expect(tooStrict).toEqual([]);
    });

    it("accepts a fully-NULL row for every nullable column at once", () => {
      // The columns the DB requires still have to be present, so this row is
      // "everything nullable set to NULL" rather than an empty object.
      const row: Record<string, unknown> = {};
      for (const col of columnInfo) {
        if (col.notnull === 1 || col.pk === 1) {
          row[col.name] = COLUMN_VALUE_OVERRIDES[col.name] ?? `value-${col.name}`;
        } else {
          row[col.name] = null;
        }
      }

      const result = TransactionSchema.safeParse(row);
      expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`))
        .toEqual([]);
    });
  });
});
