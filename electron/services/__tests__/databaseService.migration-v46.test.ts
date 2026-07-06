/**
 * @jest-environment node
 *
 * Integration test for migration v46 (BACKLOG-1801 — Email Lifecycle foundation,
 * Phase 2 T1). Full design: BACKLOG-1767 §2 (schema), §5 (rollout), §8 (B3/B4).
 *
 * Verifies:
 *   1. schema_version advances to the latest migration.
 *   2. emails gains validated_at (nullable) + ingest_source (NOT NULL DEFAULT
 *      'legacy', CHECK-constrained).
 *   3. The three lifecycle tables (email_tombstones, email_sync_state,
 *      data_clear_events) are created with their CHECK/PK/FK constraints.
 *   4. account_id is backfilled from the connected mailbox oauth_tokens row,
 *      matched by provider; rows with no matching mailbox keep account_id = NULL;
 *      NULL-external_id rows are preserved.
 *   5. Identity re-scope: the user-scoped idx_emails_user_external +
 *      idx_emails_message_id_header are DROPPED and replaced by per-account UNIQUE
 *      partial indexes; the new indexes enforce per-account uniqueness.
 *   6. Ghost pairs (same Message-ID, different provider id, one account) are
 *      de-duplicated NON-destructively before the UNIQUE index is built — the
 *      losing row and its FK-linked communications survive (audit evidence).
 *   7. The migration is idempotent.
 *   8. Fresh-install parity: the tables/indexes/columns schema.sql declares are
 *      structurally identical to what the migration produces (covers the S3
 *      blind spot — schema.sql's CREATE ... IF NOT EXISTS is a no-op in both S3
 *      paths, so only a harness test compares the migration's own DDL).
 *
 * Uses the real better-sqlite3-multiple-ciphers driver via the shared migration
 * test harness (seedV29Schema:false — this migration needs a realistic emails +
 * oauth_tokens shape that the minimal v29 subset does not carry).
 */

import fs from "fs";
import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — same shape as databaseService.migration-v45.test.ts
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/mock/user/data"),
  },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("../logService", () => {
  const mockFns = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return {
    __esModule: true,
    default: mockFns,
    logService: mockFns,
  };
});

jest.mock("../databaseEncryptionService", () => ({
  databaseEncryptionService: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  },
  default: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock("../contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));

jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

// ---------------------------------------------------------------------------
// IMPORTS
// ---------------------------------------------------------------------------

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";

// Real driver, bypassing the Jest auto-mock (same technique as the harness).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

const USER_ID = "user-v46-test";

function latestVersion(harness: MigrationHarness): number {
  const migrations = harness.service.constructor.MIGRATIONS as Array<{ version: number }>;
  return migrations[migrations.length - 1].version;
}

/**
 * A realistic pre-v46 shape: emails carrying the identity columns, oauth_tokens
 * (with the production UNIQUE(user_id, provider, purpose)), a communications
 * link table (to prove dedup is non-destructive), and the pre-v46 user-scoped
 * identity indexes (which v46 must DROP). schema_version starts at 45 so ONLY
 * v46 runs.
 */
const PRE_V46_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE oauth_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    purpose TEXT NOT NULL,
    UNIQUE(user_id, provider, purpose),
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );

  CREATE TABLE emails (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    external_id TEXT,
    account_id TEXT,
    source TEXT,
    message_id_header TEXT,
    content_hash TEXT,
    sent_at DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_emails_external_id ON emails(external_id);
  CREATE UNIQUE INDEX idx_emails_user_external ON emails(user_id, external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX idx_emails_message_id_header ON emails(user_id, message_id_header) WHERE message_id_header IS NOT NULL;

  CREATE TABLE communications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
  );

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

/** Seed the realistic fixture into a harness DB (seedV29Schema:false). */
function seedFixture(harness: MigrationHarness, startVersion = 45): void {
  harness.db.exec(PRE_V46_FIXTURE);
  harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
  harness.db
    .prepare("INSERT INTO oauth_tokens (id, user_id, provider, purpose) VALUES (?, ?, ?, ?)")
    .run("tok-goog", USER_ID, "google", "mailbox");
  harness.db
    .prepare("INSERT INTO oauth_tokens (id, user_id, provider, purpose) VALUES (?, ?, ?, ?)")
    .run("tok-ms", USER_ID, "microsoft", "mailbox");
  // An authentication-purpose token must NOT be matched by the backfill.
  harness.db
    .prepare("INSERT INTO oauth_tokens (id, user_id, provider, purpose) VALUES (?, ?, ?, ?)")
    .run("tok-auth", USER_ID, "google", "authentication");
  harness.db.prepare("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(startVersion);
}

function insertEmail(
  harness: MigrationHarness,
  row: { id: string; external_id?: string | null; source?: string | null; msgid?: string | null; content_hash?: string | null },
): void {
  harness.db
    .prepare(
      "INSERT INTO emails (id, user_id, external_id, source, message_id_header, content_hash) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.id,
      USER_ID,
      row.external_id ?? null,
      row.source ?? null,
      row.msgid ?? null,
      row.content_hash ?? null,
    );
}

function accountOf(harness: MigrationHarness, id: string): string | null {
  return (
    harness.db.prepare("SELECT account_id FROM emails WHERE id = ?").get(id) as {
      account_id: string | null;
    }
  ).account_id;
}

function rowOf(
  harness: MigrationHarness,
  id: string,
): { external_id: string | null; message_id_header: string | null; account_id: string | null } | undefined {
  return harness.db
    .prepare("SELECT external_id, message_id_header, account_id FROM emails WHERE id = ?")
    .get(id) as
    | { external_id: string | null; message_id_header: string | null; account_id: string | null }
    | undefined;
}

function indexEntry(
  harness: MigrationHarness,
  indexName: string,
): { name: string; unique: number } | undefined {
  const list = harness.db.prepare("PRAGMA index_list(emails)").all() as Array<{
    name: string;
    unique: number;
  }>;
  return list.find((i) => i.name === indexName);
}

function tableExists(harness: MigrationHarness, name: string): boolean {
  return !!harness.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
}

// ---------------------------------------------------------------------------
// TESTS — realistic backfill / re-scope / dedup
// ---------------------------------------------------------------------------

describe("databaseService migration v46 (BACKLOG-1801)", () => {
  let harness: MigrationHarness;

  beforeEach(async () => {
    harness = createMigrationHarness({ seedV29Schema: false });
    seedFixture(harness);

    // Realistic pre-migration data. external_ids are unique per user (the old
    // UNIQUE index guaranteed this in production); message_id_header is NON-unique
    // (v44), so ghost pairs — same Message-ID, different provider id — CAN exist.
    insertEmail(harness, { id: "e-g1", external_id: "G1", source: "gmail", msgid: "<mg1>" });
    insertEmail(harness, { id: "e-g2", external_id: "G2", source: "gmail", msgid: "<mg2>" });
    insertEmail(harness, { id: "e-o1", external_id: "O1", source: "outlook", msgid: "<mo1>" });
    insertEmail(harness, { id: "e-nx", external_id: null, source: "gmail", msgid: "<mnx>", content_hash: "h-nx" });
    insertEmail(harness, { id: "e-nt", external_id: "Y1", source: "yahoo", msgid: "<my1>" }); // no mailbox token
    insertEmail(harness, { id: "e-gh1", external_id: "GH1", source: "gmail", msgid: "<ghost>" });
    insertEmail(harness, { id: "e-gh2", external_id: "GH2", source: "gmail", msgid: "<ghost>" }); // ghost pair loser
    // A communication linked to the ghost loser — must survive the dedup.
    harness.db
      .prepare("INSERT INTO communications (id, user_id, email_id) VALUES (?, ?, ?)")
      .run("c-gh2", USER_ID, "e-gh2");

    await harness.service._runVersionedMigrations();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("advances schema_version to the latest migration", () => {
    const row = harness.db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(row.version).toBe(latestVersion(harness));
  });

  it("adds emails.validated_at (nullable) and ingest_source (NOT NULL DEFAULT 'legacy')", () => {
    const cols = harness.db.prepare("PRAGMA table_info(emails)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const validated = cols.find((c) => c.name === "validated_at");
    const ingest = cols.find((c) => c.name === "ingest_source");
    expect(validated).toBeDefined();
    expect(validated?.notnull).toBe(0);
    expect(ingest).toBeDefined();
    expect(ingest?.notnull).toBe(1);
    // Existing rows were backfilled to the 'legacy' default.
    const n = (
      harness.db.prepare("SELECT COUNT(*) AS n FROM emails WHERE ingest_source = 'legacy'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(7);
  });

  it("enforces the ingest_source CHECK constraint", () => {
    expect(() =>
      harness.db
        .prepare("INSERT INTO emails (id, user_id, ingest_source) VALUES (?, ?, ?)")
        .run("bad-ingest", USER_ID, "bogus"),
    ).toThrow(/CHECK/i);
    // Valid values are accepted.
    expect(() =>
      harness.db
        .prepare("INSERT INTO emails (id, user_id, ingest_source) VALUES (?, ?, ?)")
        .run("ok-ingest", USER_ID, "search_validated"),
    ).not.toThrow();
  });

  it("backfills account_id from the connected mailbox, matched by provider", () => {
    expect(accountOf(harness, "e-g1")).toBe("tok-goog");
    expect(accountOf(harness, "e-g2")).toBe("tok-goog");
    expect(accountOf(harness, "e-gh1")).toBe("tok-goog");
    expect(accountOf(harness, "e-nx")).toBe("tok-goog");
    expect(accountOf(harness, "e-o1")).toBe("tok-ms");
  });

  it("leaves account_id NULL (and keys untouched) for rows with no matching mailbox", () => {
    // 'yahoo' has no oauth_tokens mailbox row → unresolved → account_id stays NULL,
    // and the dedup MUST NOT touch its external_id / message_id_header.
    const r = rowOf(harness, "e-nt");
    expect(r?.account_id).toBeNull();
    expect(r?.external_id).toBe("Y1");
    expect(r?.message_id_header).toBe("<my1>");
  });

  it("preserves NULL-external_id rows (content_hash-keyed per design §5.1)", () => {
    const r = rowOf(harness, "e-nx");
    expect(r?.external_id).toBeNull();
    expect(r?.account_id).toBe("tok-goog");
    expect(
      (harness.db.prepare("SELECT content_hash FROM emails WHERE id = 'e-nx'").get() as {
        content_hash: string | null;
      }).content_hash,
    ).toBe("h-nx");
  });

  it("drops the user-scoped identity indexes and creates per-account UNIQUE partial indexes", () => {
    expect(indexEntry(harness, "idx_emails_user_external")).toBeUndefined();
    expect(indexEntry(harness, "idx_emails_message_id_header")).toBeUndefined();

    const ext = indexEntry(harness, "idx_emails_account_external");
    const msg = indexEntry(harness, "idx_emails_account_message_id_header");
    expect(ext?.unique).toBe(1);
    expect(msg?.unique).toBe(1);

    const extSql = (
      harness.db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_emails_account_external'")
        .get() as { sql: string }
    ).sql;
    expect(extSql).toContain("account_id");
    expect(extSql).toContain("external_id IS NOT NULL");
  });

  it("the new UNIQUE indexes reject duplicates within one account", () => {
    // Same account + same external_id → rejected.
    expect(() =>
      harness.db
        .prepare("INSERT INTO emails (id, user_id, account_id, external_id) VALUES (?, ?, ?, ?)")
        .run("dup-ext", USER_ID, "tok-goog", "G1"),
    ).toThrow(/UNIQUE/i);
    // Same account + same Message-ID → rejected.
    expect(() =>
      harness.db
        .prepare("INSERT INTO emails (id, user_id, account_id, message_id_header) VALUES (?, ?, ?, ?)")
        .run("dup-msg", USER_ID, "tok-goog", "<mg1>"),
    ).toThrow(/UNIQUE/i);
  });

  it("de-duplicates ghost pairs NON-destructively before building the UNIQUE index", () => {
    // The winner (lower rowid) keeps its Message-ID; the loser's is nulled.
    expect(rowOf(harness, "e-gh1")?.message_id_header).toBe("<ghost>");
    expect(rowOf(harness, "e-gh2")?.message_id_header).toBeNull();
    // BOTH rows survive (no cascade delete)...
    expect(rowOf(harness, "e-gh1")).toBeDefined();
    expect(rowOf(harness, "e-gh2")).toBeDefined();
    // ...and the loser's linked communication (audit evidence) survives too.
    const link = harness.db
      .prepare("SELECT email_id FROM communications WHERE id = 'c-gh2'")
      .get() as { email_id: string } | undefined;
    expect(link?.email_id).toBe("e-gh2");
  });

  it("creates the three lifecycle tables with their constraints", () => {
    expect(tableExists(harness, "email_tombstones")).toBe(true);
    expect(tableExists(harness, "email_sync_state")).toBe(true);
    expect(tableExists(harness, "data_clear_events")).toBe(true);

    // email_tombstones: reason CHECK + account_id/external_id NOT NULL + PK dedup.
    expect(() =>
      harness.db
        .prepare(
          "INSERT INTO email_tombstones (user_id, account_id, external_id, reason) VALUES (?, ?, ?, ?)",
        )
        .run(USER_ID, "acct", "x", "not_a_reason"),
    ).toThrow(/CHECK/i);
    expect(() =>
      harness.db
        .prepare(
          "INSERT INTO email_tombstones (user_id, account_id, external_id, reason) VALUES (?, ?, ?, ?)",
        )
        .run(USER_ID, null, "x", "reconcile"),
    ).toThrow(/NOT NULL/i);
    harness.db
      .prepare("INSERT INTO email_tombstones (user_id, account_id, external_id, reason) VALUES (?, ?, ?, ?)")
      .run(USER_ID, "acct", "x", "reconcile");
    expect(() =>
      harness.db
        .prepare("INSERT INTO email_tombstones (user_id, account_id, external_id, reason) VALUES (?, ?, ?, ?)")
        .run(USER_ID, "acct", "x", "server_gone"),
    ).toThrow(/UNIQUE|PRIMARY/i);

    // email_sync_state: phase + provider CHECK, account_id NOT NULL.
    expect(() =>
      harness.db
        .prepare("INSERT INTO email_sync_state (user_id, account_id, provider, phase) VALUES (?, ?, ?, ?)")
        .run(USER_ID, "acct", "google", "not_a_phase"),
    ).toThrow(/CHECK/i);
    harness.db
      .prepare("INSERT INTO email_sync_state (user_id, account_id, provider) VALUES (?, ?, ?)")
      .run(USER_ID, "acct", "google");
    const syncRow = harness.db
      .prepare("SELECT phase, failure_count FROM email_sync_state WHERE account_id = 'acct'")
      .get() as { phase: string; failure_count: number };
    expect(syncRow.phase).toBe("active"); // default
    expect(syncRow.failure_count).toBe(0); // default

    // data_clear_events: scope CHECK, cloud_synced_at nullable (pending).
    expect(() =>
      harness.db
        .prepare("INSERT INTO data_clear_events (id, user_id, scope) VALUES (?, ?, ?)")
        .run("dce-bad", USER_ID, "not_a_scope"),
    ).toThrow(/CHECK/i);
    harness.db
      .prepare("INSERT INTO data_clear_events (id, user_id, scope) VALUES (?, ?, ?)")
      .run("dce-ok", USER_ID, "all");
    expect(
      (harness.db.prepare("SELECT cloud_synced_at FROM data_clear_events WHERE id = 'dce-ok'").get() as {
        cloud_synced_at: string | null;
      }).cloud_synced_at,
    ).toBeNull();
  });

  it("email_sync_state.account_id has NO foreign key (disposition B3)", () => {
    const fks = harness.db.prepare("PRAGMA foreign_key_list(email_sync_state)").all() as Array<{
      from: string;
    }>;
    expect(fks.some((f) => f.from === "account_id")).toBe(false);
    // user_id FK remains (user-level cascade).
    expect(fks.some((f) => f.from === "user_id")).toBe(true);
  });

  it("is idempotent — re-running v46 does not error and keeps the indexes intact", async () => {
    harness.db.prepare("UPDATE schema_version SET version = 45 WHERE id = 1").run();
    await expect(harness.service._runVersionedMigrations()).resolves.not.toThrow();

    expect(indexEntry(harness, "idx_emails_account_external")?.unique).toBe(1);
    expect(indexEntry(harness, "idx_emails_account_message_id_header")?.unique).toBe(1);
    expect(indexEntry(harness, "idx_emails_user_external")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Defensive dedup: external_id collision within one account. Production's
// user-scoped UNIQUE index prevents this, but a corrupted DB could carry it —
// the migration must resolve it (non-destructively) before building the new
// UNIQUE index rather than throwing.
// ---------------------------------------------------------------------------

describe("migration v46 — external_id dedup fallback (defensive)", () => {
  let harness: MigrationHarness;

  afterEach(async () => {
    await harness.cleanup();
  });

  it("nulls the losing duplicate external_id and builds the UNIQUE index", async () => {
    harness = createMigrationHarness({ seedV29Schema: false });
    // Fixture WITHOUT the user-scoped UNIQUE index, so dup external_ids can be seeded.
    harness.db.exec(`
      CREATE TABLE users_local (id TEXT PRIMARY KEY);
      CREATE TABLE oauth_tokens (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, purpose TEXT NOT NULL,
        UNIQUE(user_id, provider, purpose),
        FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
      );
      CREATE TABLE emails (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, external_id TEXT, account_id TEXT,
        source TEXT, message_id_header TEXT, content_hash TEXT, updated_at DATETIME
      );
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, migrated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    harness.db
      .prepare("INSERT INTO oauth_tokens (id, user_id, provider, purpose) VALUES (?, ?, ?, ?)")
      .run("tok-goog", USER_ID, "google", "mailbox");
    harness.db.prepare("INSERT INTO schema_version (id, version) VALUES (1, 45)").run();
    // Two rows share external_id 'DUP' within the (soon-to-be) same account.
    insertEmail(harness, { id: "d1", external_id: "DUP", source: "gmail", msgid: "<md1>" });
    insertEmail(harness, { id: "d2", external_id: "DUP", source: "gmail", msgid: "<md2>" });

    await expect(harness.service._runVersionedMigrations()).resolves.not.toThrow();

    // Winner keeps external_id, loser nulled — both rows survive.
    expect(rowOf(harness, "d1")?.external_id).toBe("DUP");
    expect(rowOf(harness, "d2")?.external_id).toBeNull();
    expect(rowOf(harness, "d1")?.account_id).toBe("tok-goog");
    expect(rowOf(harness, "d2")?.account_id).toBe("tok-goog");
    expect(indexEntry(harness, "idx_emails_account_external")?.unique).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fresh-install parity: the lifecycle tables / re-scoped indexes / new columns
// schema.sql declares must be structurally identical to what the migration
// produces. This covers the S3 blind spot (schema.sql's CREATE ... IF NOT EXISTS
// is a no-op in BOTH S3 paths, so S3 never compares the migration's own DDL).
// ---------------------------------------------------------------------------

describe("migration v46 — fresh-install schema.sql parity (BACKLOG-1801)", () => {
  let freshDb: DatabaseType;
  let migratedHarness: MigrationHarness;

  interface ColInfo {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }
  interface IdxInfo {
    unique: number;
    partial: number;
    columns: string[];
  }

  function tableCols(db: DatabaseType, table: string): ColInfo[] {
    return (db.prepare(`PRAGMA table_info("${table}")`).all() as ColInfo[])
      .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  function fkList(db: DatabaseType, table: string): string {
    return (
      db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
        from: string;
        table: string;
        to: string | null;
        on_delete: string;
      }>
    )
      .map((f) => `${f.from}->${f.table}.${f.to}:${f.on_delete}`)
      .sort()
      .join("|");
  }
  function idxInfo(db: DatabaseType, indexName: string): IdxInfo | undefined {
    // index_list is keyed per table; find the table owning the index first.
    const owner = db
      .prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name = ?")
      .get(indexName) as { tbl_name: string } | undefined;
    if (!owner) return undefined;
    const entry = (
      db.prepare(`PRAGMA index_list("${owner.tbl_name}")`).all() as Array<{
        name: string;
        unique: number;
        partial: number;
      }>
    ).find((i) => i.name === indexName);
    if (!entry) return undefined;
    const columns = (
      db.prepare(`PRAGMA index_info("${indexName}")`).all() as Array<{ name: string | null }>
    ).map((r) => r.name ?? "<expr>");
    return { unique: entry.unique, partial: entry.partial, columns };
  }

  beforeEach(async () => {
    const schemaPath = path.join(__dirname, "..", "..", "database", "schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    freshDb = new RealDatabase(":memory:") as DatabaseType;
    freshDb.pragma("foreign_keys = ON");
    freshDb.exec(schemaSql);

    migratedHarness = createMigrationHarness({ seedV29Schema: false });
    seedFixture(migratedHarness);
    await migratedHarness.service._runVersionedMigrations();
  });

  afterEach(async () => {
    try {
      freshDb.close();
    } catch {
      /* already closed */
    }
    await migratedHarness.cleanup();
  });

  it.each(["email_tombstones", "email_sync_state", "data_clear_events"])(
    "table %s: columns + foreign keys match schema.sql and the migration",
    (table) => {
      expect(tableCols(migratedHarness.db, table)).toEqual(tableCols(freshDb, table));
      expect(fkList(migratedHarness.db, table)).toEqual(fkList(freshDb, table));
    },
  );

  it.each([
    "idx_emails_account_external",
    "idx_emails_account_message_id_header",
    "idx_email_tombstones_msgid",
    "idx_data_clear_events_pending",
  ])("index %s: shape matches schema.sql and the migration", (indexName) => {
    const fresh = idxInfo(freshDb, indexName);
    const migrated = idxInfo(migratedHarness.db, indexName);
    expect(fresh).toBeDefined();
    expect(migrated).toEqual(fresh);
  });

  it("emails.validated_at + ingest_source columns match schema.sql and the migration", () => {
    const pick = (cols: ColInfo[], name: string) => cols.find((c) => c.name === name);
    const freshCols = tableCols(freshDb, "emails");
    const migratedCols = tableCols(migratedHarness.db, "emails");
    for (const name of ["validated_at", "ingest_source"]) {
      expect(pick(migratedCols, name)).toEqual(pick(freshCols, name));
      expect(pick(migratedCols, name)).toBeDefined();
    }
  });
});
