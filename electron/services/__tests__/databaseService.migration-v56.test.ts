/**
 * @jest-environment node
 *
 * Integration test for migration v56 (BACKLOG-2364 — tombstone substrate).
 *
 * v56 adds nullable `removed_at` / `removed_reason` columns to BOTH `contacts`
 * and `transaction_contacts`, so a contact (or a contact's role on one deal) can
 * later be removed and restored without a destructive DELETE. Nothing reads or
 * writes them yet — BACKLOG-2365 (remove/restore) and BACKLOG-2366 (filtered
 * reads) do.
 *
 * Two properties this file locks in, both of them incident-driven:
 *
 *  1. v56 creates NO index (case "creates no index"). Every candidate partial
 *     index duplicated the leading column of an existing index, so it would add
 *     write cost with no new access path; the useful shape is not knowable until
 *     BACKLOG-2366 defines the read. The index-name set is snapshotted before and
 *     after the migration and asserted equal, so re-adding one fails loudly here.
 *  2. The columns arrive ONLY from this migration, on both install paths —
 *     schema.sql declares them on neither table (see the DANGER block above
 *     CREATE TABLE contacts: migration v36 copies that table positionally into a
 *     15-column contacts_new, so a 16th column there breaks every fresh install).
 *     The last describe block turns that 15 == 15 equality into an enforced
 *     invariant instead of a comment somebody has to read.
 *
 * Follows the migration-v47..v55 convention: real better-sqlite3 driver via the
 * node_modules require() bypass, in-memory DB via createMigrationHarness, seeded
 * at schema_version=55 so ONLY v56 runs. The real two-step runMigrations() flow
 * (exec(schema.sql) THEN the chain) is covered by its own file,
 * databaseService.runMigrations-upgrade-v55.test.ts.
 */

import fs from "fs";
import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — identical pattern to databaseService.migration-v55.test.ts
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
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

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const USER_ID = "user-v56-test";
const TXN_ID = "txn-v56-test";

/**
 * Post-v55 / pre-v56 shape: contacts + transaction_contacts WITHOUT the
 * tombstone columns (v56 is what adds them). The two pre-existing indexes are
 * deliberate — they make the "creates no index" snapshot a real equality rather
 * than empty-set == empty-set, and would also catch a v56 that DROPPED one.
 */
const PRE_V56_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE transactions (id TEXT PRIMARY KEY, user_id TEXT);

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    company TEXT,
    title TEXT,
    source TEXT DEFAULT 'manual',
    last_inbound_at DATETIME,
    last_outbound_at DATETIME,
    total_messages INTEGER DEFAULT 0,
    tags TEXT,
    is_imported INTEGER DEFAULT 1,
    default_role TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );

  CREATE TABLE transaction_contacts (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    role TEXT,
    role_category TEXT,
    specific_role TEXT,
    is_primary INTEGER DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    UNIQUE(transaction_id, contact_id)
  );

  CREATE INDEX idx_contacts_user_id ON contacts(user_id);
  CREATE INDEX idx_transaction_contacts_transaction ON transaction_contacts(transaction_id);

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

function columns(db: DatabaseType, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function schemaVersion(db: DatabaseType): number {
  return (
    db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
  ).version;
}

/** Every index name in the DB, sorted — including UNIQUE auto-indexes. */
function indexNames(db: DatabaseType): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe("databaseService migration v56 (BACKLOG-2364 — tombstone columns)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V56_FIXTURE);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    harness.db.prepare("INSERT INTO transactions (id, user_id) VALUES (?, ?)").run(TXN_ID, USER_ID);
  });

  afterEach(async () => {
    if (harness) {
      try {
        await harness.cleanup();
      } catch {
        /* already cleaned */
      }
    }
  });

  /**
   * Seed at v55 AND clip the chain at v56, so ONLY v56 runs, then drive the real
   * migration runner.
   *
   * BACKLOG-2401: seeding at 55 alone used to be sufficient — v56 was head, so
   * "everything pending" and "just v56" were the same set. With v57
   * (contact_source_links) in the array they are not, and two assertions in this
   * file — "advancing to v56" and "creates NO index" — were silently describing
   * the whole tail of the chain rather than v56. The runner has no version-limit
   * parameter, so the clip is done by swapping the static array (the same idiom
   * databaseService.onDiskUpgrade.test.ts uses) and restoring it in `finally`.
   * This keeps every assertion below a statement about v56 at v58 and beyond.
   */
  async function runV56(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 55)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 56);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  it("sanity: real better-sqlite3 driver is wired (not the jest auto-mock)", () => {
    expect(typeof RealDatabase).toBe("function");
  });

  it("precondition: neither table has removed_at or removed_reason before v56", () => {
    for (const table of ["contacts", "transaction_contacts"]) {
      const cols = columns(harness.db, table);
      expect(cols).not.toContain("removed_at");
      expect(cols).not.toContain("removed_reason");
    }
  });

  it("adds both columns to BOTH tables, advancing to v56", async () => {
    await runV56();

    for (const table of ["contacts", "transaction_contacts"]) {
      const cols = columns(harness.db, table);
      expect(cols).toContain("removed_at");
      expect(cols).toContain("removed_reason");
    }
    expect(schemaVersion(harness.db)).toBe(56);
  });

  it("appends them LAST, in removed_at then removed_reason order (the only column-order assertion in CI)", async () => {
    // schema-parity keys columns BY NAME (schema-parity.test.ts:386), so nothing
    // else in CI pins order. ALTER TABLE ADD COLUMN appends, and the order here
    // is the order a future schema.sql re-baseline (BACKLOG-2373) must declare
    // them in for fresh and upgraded installs to stay byte-comparable.
    await runV56();

    for (const table of ["contacts", "transaction_contacts"]) {
      const cols = columns(harness.db, table);
      expect(cols.slice(-2)).toEqual(["removed_at", "removed_reason"]);
    }
  });

  it("creates NO index — the index-name set is byte-identical before and after", async () => {
    // Locks in the "no index in v56" ruling. Each candidate partial index
    // duplicated the leading column of an index that already exists, so it would
    // cost a B-tree on every write to two hot tables for no new access path. The
    // index belongs with the query that justifies it (BACKLOG-2366).
    const before = indexNames(harness.db);
    expect(before).toContain("idx_contacts_user_id");
    expect(before).toContain("idx_transaction_contacts_transaction");

    await runV56();

    expect(indexNames(harness.db)).toEqual(before);
  });

  it("leaves pre-existing rows intact with removed_at NULL (asserted by exact id set)", async () => {
    const contactIds = ["c-alpha", "c-beta", "c-gamma"];
    for (const id of contactIds) {
      harness.db
        .prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)")
        .run(id, USER_ID, `Name ${id}`);
    }
    harness.db
      .prepare(
        "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, ?)",
      )
      .run("tc-alpha", TXN_ID, "c-alpha", "buyer");
    harness.db
      .prepare(
        "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, ?)",
      )
      .run("tc-beta", TXN_ID, "c-beta", "seller");

    await runV56();

    const activeContacts = (
      harness.db
        .prepare("SELECT id FROM contacts WHERE removed_at IS NULL ORDER BY id")
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(activeContacts).toEqual(["c-alpha", "c-beta", "c-gamma"]);

    const activeRoles = (
      harness.db
        .prepare("SELECT id FROM transaction_contacts WHERE removed_at IS NULL ORDER BY id")
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(activeRoles).toEqual(["tc-alpha", "tc-beta"]);

    // ...and every removed_reason is NULL, i.e. nothing was tombstoned on upgrade.
    const tombstoned = harness.db
      .prepare("SELECT COUNT(*) AS n FROM contacts WHERE removed_at IS NOT NULL")
      .get() as { n: number };
    expect(tombstoned.n).toBe(0);
  });

  it("is idempotent: a second run over an already-migrated DB does not throw or change the column set", async () => {
    await runV56();
    const after = {
      contacts: columns(harness.db, "contacts"),
      transaction_contacts: columns(harness.db, "transaction_contacts"),
    };

    // Re-seed to 55 so the runner replays v56 over tables that already have the
    // columns — the guard, not luck, is what prevents "duplicate column name".
    await expect(runV56()).resolves.toBeUndefined();

    expect(columns(harness.db, "contacts")).toEqual(after.contacts);
    expect(columns(harness.db, "transaction_contacts")).toEqual(after.transaction_contacts);
  });

  it("round-trips a tombstone write at the SQL level after the upgrade", async () => {
    harness.db
      .prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)")
      .run("c-dupe", USER_ID, "Dupe Contact");

    await runV56();

    harness.db
      .prepare("UPDATE contacts SET removed_at = datetime('now'), removed_reason = ? WHERE id = ?")
      .run("merged_into:c-alpha", "c-dupe");

    const row = harness.db
      .prepare("SELECT removed_at, removed_reason FROM contacts WHERE id = ?")
      .get("c-dupe") as { removed_at: string | null; removed_reason: string | null };
    expect(row.removed_at).not.toBeNull();
    expect(row.removed_reason).toBe("merged_into:c-alpha");

    // The active-set query BACKLOG-2366 will use no longer returns it.
    const active = (
      harness.db
        .prepare("SELECT id FROM contacts WHERE removed_at IS NULL ORDER BY id")
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(active).toEqual([]);
  });
});

describe("databaseService migration v56 — partial-schema DB (table guard)", () => {
  let partial: MigrationHarness;

  afterEach(async () => {
    if (partial) {
      try {
        await partial.cleanup();
      } catch {
        /* already cleaned */
      }
    }
  });

  it("skips transaction_contacts when it is absent, and still adds the columns to contacts", async () => {
    partial = createMigrationHarness({ seedV29Schema: false });
    partial.db.exec(`
      CREATE TABLE users_local (id TEXT PRIMARY KEY);
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL
      );
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        migrated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    partial.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 55)").run();

    await expect(partial.service._runVersionedMigrations()).resolves.toBeUndefined();

    const cols = columns(partial.db, "contacts");
    expect(cols).toContain("removed_at");
    expect(cols).toContain("removed_reason");
    expect(
      partial.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transaction_contacts'")
        .get(),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The v36 positional-copy invariant (BACKLOG-2364 §4c)
// ---------------------------------------------------------------------------

const SCHEMA_SQL_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");
const DB_SERVICE_PATH = path.join(__dirname, "..", "databaseService.ts");

/**
 * Returns the text between the outermost parentheses of the first statement in
 * `src` matching `header`. Depth-counted, so CHECK (x IN (...)) does not end it
 * early. schema.sql and the v36 DDL contain no parentheses inside string
 * literals, so a plain depth scan is sufficient here.
 */
function extractParenBody(src: string, header: RegExp): string {
  const m = header.exec(src);
  if (!m) throw new Error(`extractParenBody: header not found: ${header}`);
  const open = src.indexOf("(", m.index + m[0].length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`extractParenBody: unbalanced parentheses for ${header}`);
}

/** Count column definitions in a CREATE TABLE body, ignoring table constraints. */
function countColumns(body: string): number {
  return body
    .split("\n")
    .map((l) => l.replace(/--.*$/, "").trim())
    .filter(Boolean)
    .filter((l) => !/^(FOREIGN\s+KEY|UNIQUE|PRIMARY\s+KEY|CHECK|CONSTRAINT)\b/i.test(l))
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*\s+/.test(l)).length;
}

describe("schema.sql contacts vs migration v36 contacts_new — positional-copy invariant (BACKLOG-2364)", () => {
  it("declares EXACTLY as many columns as v36's contacts_new, which copies positionally", () => {
    // WHY THIS TEST EXISTS. Migration v36 runs on every FRESH install (schema.sql
    // seeds schema_version = 32) and does:
    //     INSERT OR IGNORE INTO contacts_new SELECT * FROM contacts;
    // If schema.sql's contacts ever declares more columns than v36's contacts_new,
    // that SELECT * supplies too many values to a fixed-width table. It is a
    // PREPARE-time error, so OR IGNORE does not suppress it and an empty table
    // does not avoid it: runMigrations() throws on EVERY new install and the user
    // is stuck on "Starting up your secure database" (the BACKLOG-2298/2300
    // symptom). This is precisely why BACKLOG-2364 added removed_at/removed_reason
    // via migration v56 ONLY, and declared them in schema.sql on NEITHER table.
    //
    // If this test fails, do NOT "fix" it by bumping schema.sql's seeded
    // schema_version past 36 — that turns CI green while silently stripping
    // v33..vN from every fresh install. Add the column as a guarded ALTER in a
    // new migration instead. (Hardening v36's copy to an explicit column list is
    // tracked as its own follow-up, BACKLOG-2371.)
    const schemaSql = fs.readFileSync(SCHEMA_SQL_PATH, "utf8");
    const dbService = fs.readFileSync(DB_SERVICE_PATH, "utf8");

    const schemaContacts = countColumns(
      extractParenBody(schemaSql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+contacts\s*\(/i),
    );

    // Scope to the v36 entry — v48 declares a second, different contacts_new.
    const v36Index = dbService.indexOf("version: 36,");
    expect(v36Index).toBeGreaterThan(-1);
    const v36Contacts = countColumns(
      extractParenBody(
        dbService.slice(v36Index),
        /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+contacts_new\s*\(/i,
      ),
    );

    // Pinned literally as well as relatively: if a future change moves both in
    // lockstep, that is still a change worth an explicit review.
    expect(schemaContacts).toBe(15);
    expect(v36Contacts).toBe(15);
    expect(schemaContacts).toBe(v36Contacts);
  });

  it("does NOT declare the tombstone columns on contacts (they come from v56 on both paths)", () => {
    const body = extractParenBody(
      fs.readFileSync(SCHEMA_SQL_PATH, "utf8"),
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+contacts\s*\(/i,
    );
    expect(body).not.toMatch(/removed_at/);
    expect(body).not.toMatch(/removed_reason/);
  });
});
