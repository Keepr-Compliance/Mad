/**
 * @jest-environment node
 *
 * Integration test for migration v44 (BACKLOG-1769 — DB hardening S2).
 *
 * Verifies the Message-ID stable-identity migration:
 *   1. schema_version advances to the latest migration.
 *   2. emails.message_id_header is ensured (added when a DB reaches the runner
 *      without it — the minimal harness fixture / drift safety).
 *   3. The message-id dedup index exists as a partial index.
 *   4. The migration is idempotent (safe to re-run on the already-migrated shape).
 *   5. Fresh-install parity: the index built from schema.sql matches the one the
 *      migration produces.
 *
 * NOTE (BACKLOG-1801, migration v46): the harness runs the FULL chain to the
 * latest migration, and v46 RE-SCOPES the message-id identity index from v44's
 * NON-unique (user_id, message_id_header) form to a per-account UNIQUE
 * (account_id, message_id_header) partial index (idx_emails_account_message_id_header),
 * dropping the old idx_emails_message_id_header. These tests therefore assert the
 * post-v46 end state (the account-scoped index), not v44's superseded intermediate
 * form. v44 itself flagged this Phase-2 re-scope in its own comments.
 *
 * Uses the real better-sqlite3-multiple-ciphers driver via the shared migration
 * test harness (see migrationTestHarness.ts).
 */

import fs from "fs";
import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — same shape as databaseService.migration-v43.test.ts
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

const USER_ID = "user-v44-test";

/** The highest migration version = what schema_version should read post-run. */
function latestVersion(harness: MigrationHarness): number {
  const migrations = harness.service.constructor.MIGRATIONS as Array<{ version: number }>;
  return migrations[migrations.length - 1].version;
}

/** Insert an email row carrying an (optionally null) RFC Message-ID header (account_id NULL). */
function insertEmail(harness: MigrationHarness, id: string, messageIdHeader: string | null): void {
  harness.db
    .prepare("INSERT INTO emails (id, user_id, message_id_header) VALUES (?, ?, ?)")
    .run(id, USER_ID, messageIdHeader);
}

/** Insert an email row scoped to a specific account (exercises the per-account UNIQUE index). */
function insertEmailForAccount(
  harness: MigrationHarness,
  id: string,
  accountId: string,
  messageIdHeader: string | null,
): void {
  harness.db
    .prepare("INSERT INTO emails (id, user_id, account_id, message_id_header) VALUES (?, ?, ?, ?)")
    .run(id, USER_ID, accountId, messageIdHeader);
}

/**
 * Read the index_list entry for a named emails index (undefined if absent).
 * Post-v46 the message-id identity index is idx_emails_account_message_id_header;
 * the old idx_emails_message_id_header is dropped.
 */
function emailsIndexEntry(
  harness: MigrationHarness,
  indexName: string,
): { name: string; unique: number } | undefined {
  const list = harness.db.prepare("PRAGMA index_list(emails)").all() as Array<{
    name: string;
    unique: number;
  }>;
  return list.find((i) => i.name === indexName);
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe("databaseService migration v44 (BACKLOG-1769)", () => {
  let harness: MigrationHarness;

  beforeEach(async () => {
    harness = createMigrationHarness({ seedV29Schema: true });
    harness.seedSchemaVersion(43);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
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

  it("ensures the emails.message_id_header column exists", () => {
    const cols = (
      harness.db.prepare("PRAGMA table_info(emails)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("message_id_header");
  });

  it("re-scopes the message-id index to a per-account UNIQUE partial index (v46)", () => {
    // v44 created a NON-unique (user_id, message_id_header) index; v46
    // (BACKLOG-1801) replaces it with a UNIQUE (account_id, message_id_header)
    // partial index. After the full chain the old index is gone.
    expect(emailsIndexEntry(harness, "idx_emails_message_id_header")).toBeUndefined();

    const entry = emailsIndexEntry(harness, "idx_emails_account_message_id_header");
    expect(entry).toBeDefined();
    expect(entry?.unique).toBe(1); // 1 = UNIQUE (per-account scope)

    const idx = harness.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_emails_account_message_id_header'")
      .get() as { sql: string };
    expect(idx.sql.toUpperCase()).toContain("UNIQUE");
    expect(idx.sql).toContain("message_id_header IS NOT NULL"); // partial predicate preserved
  });

  it("rejects duplicate Message-IDs WITHIN one account, tolerates them across NULL accounts (v46)", () => {
    // Within a resolved account the per-account UNIQUE index now rejects the
    // ghost pair (a re-delivered message under a new provider id but same
    // Message-ID). The writer (emailCacheService, T3) remaps instead of inserting.
    insertEmailForAccount(harness, "a1", "acct-1", "<ghost@example.com>");
    expect(() =>
      insertEmailForAccount(harness, "a2", "acct-1", "<ghost@example.com>"),
    ).toThrow(/UNIQUE/i);

    // Rows whose account_id is NULL (no connected mailbox) are still tolerated —
    // SQLite treats NULL as distinct in the partial UNIQUE index.
    expect(() => {
      insertEmail(harness, "e1", "<ghost@example.com>");
      insertEmail(harness, "e2", "<ghost@example.com>");
    }).not.toThrow();
  });

  it("still allows multiple NULL message_id_header rows (partial index excludes NULLs)", () => {
    expect(() => {
      insertEmail(harness, "n1", null);
      insertEmail(harness, "n2", null);
    }).not.toThrow();
  });

  it("is idempotent — re-running the chain keeps the account-scoped index UNIQUE and does not error", async () => {
    harness.db.prepare("UPDATE schema_version SET version = 43 WHERE id = 1").run();
    await expect(harness.service._runVersionedMigrations()).resolves.not.toThrow();

    expect(emailsIndexEntry(harness, "idx_emails_message_id_header")).toBeUndefined();
    expect(emailsIndexEntry(harness, "idx_emails_account_message_id_header")?.unique).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fresh-install parity: the index built from schema.sql must match the shape the
// migration produces (BACKLOG-1769 / S3 pre-flight).
// ---------------------------------------------------------------------------

describe("migration v44 — fresh-install schema.sql parity (BACKLOG-1769)", () => {
  /** Collapse whitespace + strip SQL line comments for structural comparison. */
  function normalizeSql(sql: string | null): string {
    if (!sql) return "";
    return sql
      .replace(/\r\n?/g, "\n") // CRLF / lone CR -> LF (Windows checkout safety)
      .replace(/--[^\n]*/g, "") // strip SQL line comments (robust regardless of line endings)
      .replace(/\s+/g, " ")
      .replace(/\s*\(\s*/g, "(")
      .replace(/\s*\)\s*/g, ")")
      .replace(/\s*,\s*/g, ",")
      .trim()
      .toUpperCase();
  }

  function objectSql(db: DatabaseType, name: string): string | null {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(name) as { sql: string | null } | undefined;
    return row?.sql ?? null;
  }

  let freshDb: DatabaseType;
  let migratedHarness: MigrationHarness;

  beforeEach(async () => {
    // (a) Fresh DB built directly from schema.sql.
    const schemaPath = path.join(__dirname, "..", "..", "database", "schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    freshDb = new RealDatabase(":memory:") as DatabaseType;
    freshDb.pragma("foreign_keys = ON");
    freshDb.exec(schemaSql);

    // (b) Migrated DB via the runner (pre-v44 fixture -> v44).
    migratedHarness = createMigrationHarness({ seedV29Schema: true });
    migratedHarness.seedSchemaVersion(43);
    migratedHarness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
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

  it("schema.sql defines the account-scoped message-id index (v46 re-scope)", () => {
    // v46 (BACKLOG-1801) replaced idx_emails_message_id_header with the
    // per-account idx_emails_account_message_id_header — both schema.sql and the
    // full migration chain now carry ONLY the account-scoped form.
    expect(objectSql(freshDb, "idx_emails_account_message_id_header")).toBeTruthy();
    expect(objectSql(freshDb, "idx_emails_message_id_header")).toBeNull();
    expect(objectSql(migratedHarness.db, "idx_emails_message_id_header")).toBeNull();
  });

  it("message-id index shape matches between schema.sql and the migration", () => {
    expect(normalizeSql(objectSql(freshDb, "idx_emails_account_message_id_header"))).toBe(
      normalizeSql(objectSql(migratedHarness.db, "idx_emails_account_message_id_header")),
    );
  });

  it("message-id index is UNIQUE + partial in both schema.sql and the migration (v46)", () => {
    expect(normalizeSql(objectSql(freshDb, "idx_emails_account_message_id_header"))).toContain(
      "UNIQUE",
    );
    expect(
      normalizeSql(objectSql(migratedHarness.db, "idx_emails_account_message_id_header")),
    ).toContain("UNIQUE");
    // And the partial predicate genuinely survives.
    expect(normalizeSql(objectSql(freshDb, "idx_emails_account_message_id_header"))).toContain(
      "MESSAGE_ID_HEADER IS NOT NULL",
    );
  });
});
