/**
 * @jest-environment node
 *
 * BACKLOG-2739 — TABLE_FIELDS MUST EQUAL THE DATABASE, BOTH WAYS.
 *
 * ===========================================================================
 * WHAT WENT WRONG
 * ===========================================================================
 * `TABLE_FIELDS` was maintained by hand. Measured on develop @ bc12fec8b, it
 * declared **31 columns that exist in no table** (20 on `communications`,
 * 11 on `transactions`) and **omitted 8 real ones**. The phantom names had been
 * copied into `transactionDbService.ts` and `models.ts`, so four artefacts were
 * internally consistent and all four disagreed with the database.
 *
 * Neither direction is harmless. A phantom in an allow-list admits a field the
 * DB will reject; a MISSING real column silently discards a legitimate write,
 * which is the BACKLOG-2558 / BACKLOG-2737 mechanism.
 *
 * ===========================================================================
 * WHY IT ENUMERATES INSTEAD OF READING schema.sql
 * ===========================================================================
 * Parts of the DDL are built inside migrations, so a text read of `schema.sql`
 * cannot see them. `representation_start_date` is IN `schema.sql`;
 * `text_thread_count`, `removed_at`, `removed_reason`, `email_id` and
 * `thread_id` arrive from the chain. Only running the chain and asking the
 * database gives the real answer, so this test runs the app's own public entry
 * point — `runMigrations()`, i.e. `schema.sql` then the versioned chain — and
 * reads `PRAGMA table_info`.
 *
 * ===========================================================================
 * THE ANCHOR THAT MAKES THE ANSWER TRUSTWORTHY
 * ===========================================================================
 * A chain that stopped early would produce a SMALLER column set, and this test
 * would then happily "prove" that real columns are phantoms — a green run
 * asserting a fiction. `schema_version` is therefore asserted to equal the LAST
 * entry in `MIGRATIONS` (read from the runner, never hardcoded) BEFORE any
 * column set is compared.
 *
 * ===========================================================================
 * SETS, NOT COUNTS
 * ===========================================================================
 * Every assertion below is an exact sorted SET. A count cannot tell "58 real
 * columns" apart from "57 real columns and one phantom".
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — same block as databaseService.migrationChainRehearsal.test.ts.
// Sentry.flush is included because runMigrations() awaits it on the failure
// path; without it a genuine migration failure surfaces as "Sentry.flush is not
// a function" instead of the real error.
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
import { TABLE_FIELDS, type ValidatableTable } from "../sqlFieldWhitelist";

// Bypass the Jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock — the whole point of this file is a real file-backed DB.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const TABLES = Object.keys(TABLE_FIELDS) as ValidatableTable[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

describe("sqlFieldWhitelist — TABLE_FIELDS vs the real database (BACKLOG-2739)", () => {
  jest.setTimeout(120000);

  let service: AnyService;
  let db: DatabaseType;
  let tmpDir: string;
  let dbFile: string;

  /**
   * A fresh install: an empty file taken through the app's own migration entry
   * point. This is the state a new user's database is in, and the one the
   * whitelist has to describe.
   */
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2739-parity-"));
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
    db = service.db as DatabaseType;
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

  function realColumns(table: string): string[] {
    return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
  }

  function declaredColumns(table: ValidatableTable): string[] {
    return [...(TABLE_FIELDS[table] as readonly string[])].sort();
  }

  // -------------------------------------------------------------------------
  // ANCHOR — everything below is meaningless if the chain did not reach head.
  // -------------------------------------------------------------------------

  it("migrated a real on-disk database all the way to the head migration", () => {
    // BACKLOG-2993: the install head is schema.sql's own seed (the chain is
    // gone); chainHeadVersion() derives it from the artefacts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chainHeadVersion } = require("../../services/__tests__/helpers/chainHead") as typeof import("../../services/__tests__/helpers/chainHead");
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
  // PARITY — both directions, exact sets, one test per table so a failure names
  // the table instead of dumping all six.
  // -------------------------------------------------------------------------

  describe.each(TABLES)("%s", (table) => {
    it("declares every real column and no others", () => {
      expect(realColumns(table).length).toBeGreaterThan(0); // table exists
      expect(declaredColumns(table)).toEqual(realColumns(table));
    });

    it("declares NO phantom column (a name the database does not have)", () => {
      const real = new Set(realColumns(table));
      expect(declaredColumns(table).filter((c) => !real.has(c))).toEqual([]);
    });

    it("OMITS no real column (the mechanism that silently discards a write)", () => {
      const declared = new Set(declaredColumns(table));
      expect(realColumns(table).filter((c) => !declared.has(c))).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // The shape the TYPES depend on. `new Set([...])` here erased the string
  // literals and was the reason an invented column name compiled — see the
  // header of sqlFieldWhitelist.ts. If someone reintroduces a Set as the
  // DEFINITION, this goes red before the type erosion reaches a call site.
  // -------------------------------------------------------------------------

  it("keeps each table's definition an array, so the literal types survive", () => {
    for (const table of TABLES) {
      expect(Array.isArray(TABLE_FIELDS[table])).toBe(true);
    }
  });

  /**
   * ...and the OTHER half of that trade, which is easy to lose.
   *
   * An array is the right TYPE source and the wrong LOOKUP: `.includes()` on
   * `transactions` is a linear scan over 58 strings on every field of every
   * update. The module keeps a `Set` per table (`FIELD_SETS`) for the lookup.
   *
   * Scanned from source rather than measured, on purpose — a timing assertion
   * over 58 strings is too small to separate O(1) from O(n) reliably and would
   * be flaky in CI, whereas the regression this guards against is textual: the
   * next person "simplifies" the Set away. Same approach as
   * databaseService.positionalCopy-2371.guard.test.ts.
   */
  it("keeps the runtime membership check O(1) — a Set per table, not a scan", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "sqlFieldWhitelist.ts"),
      "utf8",
    );

    for (const table of TABLES) {
      expect(source).toContain(`new Set<string>(TABLE_FIELDS.${table})`);
    }

    // The two lookups must read the Sets, not the arrays.
    const lookupBodies = source.slice(source.indexOf("export function validateFields"));
    expect(lookupBodies).toContain("FIELD_SETS[table]");
    expect(lookupBodies).not.toContain("TABLE_FIELDS[table].includes");
    expect(lookupBodies).not.toContain(".indexOf(");
  });
});
