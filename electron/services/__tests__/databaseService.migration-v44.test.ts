/**
 * @jest-environment node
 *
 * Integration test for migration v44 (BACKLOG-1769 — DB hardening S2).
 *
 * Verifies the Message-ID stable-identity migration:
 *   1. schema_version advances to the latest migration.
 *   2. emails.message_id_header is ensured (added when a DB reaches the runner
 *      without it — the minimal harness fixture / drift safety).
 *   3. idx_emails_message_id_header is a NON-unique partial index (was UNIQUE at
 *      schema inception): tolerates duplicate non-null Message-IDs (the ghost
 *      pairs) instead of rejecting them.
 *   4. The migration is idempotent (safe to re-run on the already-migrated shape).
 *   5. Fresh-install parity: the index built from schema.sql matches the one the
 *      migration produces, and both are non-unique.
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

/** Insert an email row carrying an (optionally null) RFC Message-ID header. */
function insertEmail(harness: MigrationHarness, id: string, messageIdHeader: string | null): void {
  harness.db
    .prepare("INSERT INTO emails (id, user_id, message_id_header) VALUES (?, ?, ?)")
    .run(id, USER_ID, messageIdHeader);
}

/** Read the index_list entry for idx_emails_message_id_header (undefined if absent). */
function messageIdIndexEntry(
  harness: MigrationHarness,
): { name: string; unique: number } | undefined {
  const list = harness.db.prepare("PRAGMA index_list(emails)").all() as Array<{
    name: string;
    unique: number;
  }>;
  return list.find((i) => i.name === "idx_emails_message_id_header");
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

  it("creates a NON-unique partial index on (user_id, message_id_header)", () => {
    const entry = messageIdIndexEntry(harness);
    expect(entry).toBeDefined();
    expect(entry?.unique).toBe(0); // 0 = non-unique

    const idx = harness.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_emails_message_id_header'")
      .get() as { sql: string };
    expect(idx.sql.toUpperCase()).not.toContain("UNIQUE");
    expect(idx.sql).toContain("message_id_header IS NOT NULL"); // partial predicate preserved
  });

  it("tolerates duplicate non-null Message-IDs (the ghost pairs) — no UNIQUE constraint", () => {
    insertEmail(harness, "e1", "<ghost@example.com>");
    // A second row with the SAME user + Message-ID must NOT throw (was UNIQUE).
    expect(() => insertEmail(harness, "e2", "<ghost@example.com>")).not.toThrow();

    const n = (
      harness.db
        .prepare("SELECT COUNT(*) AS n FROM emails WHERE message_id_header = ?")
        .get("<ghost@example.com>") as { n: number }
    ).n;
    expect(n).toBe(2);
  });

  it("still allows multiple NULL message_id_header rows (partial index excludes NULLs)", () => {
    expect(() => {
      insertEmail(harness, "n1", null);
      insertEmail(harness, "n2", null);
    }).not.toThrow();
  });

  it("is idempotent — re-running v44 keeps the index non-unique and does not error", async () => {
    harness.db.prepare("UPDATE schema_version SET version = 43 WHERE id = 1").run();
    await expect(harness.service._runVersionedMigrations()).resolves.not.toThrow();

    const entry = messageIdIndexEntry(harness);
    expect(entry?.unique).toBe(0);
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

  it("schema.sql defines the message-id index", () => {
    expect(objectSql(freshDb, "idx_emails_message_id_header")).toBeTruthy();
  });

  it("message-id index shape matches between schema.sql and the migration", () => {
    expect(normalizeSql(objectSql(freshDb, "idx_emails_message_id_header"))).toBe(
      normalizeSql(objectSql(migratedHarness.db, "idx_emails_message_id_header")),
    );
  });

  it("message-id index is NON-unique in both schema.sql and the migration", () => {
    expect(normalizeSql(objectSql(freshDb, "idx_emails_message_id_header"))).not.toContain(
      "UNIQUE",
    );
    expect(normalizeSql(objectSql(migratedHarness.db, "idx_emails_message_id_header"))).not.toContain(
      "UNIQUE",
    );
    // And the partial predicate genuinely survives.
    expect(normalizeSql(objectSql(freshDb, "idx_emails_message_id_header"))).toContain(
      "MESSAGE_ID_HEADER IS NOT NULL",
    );
  });
});
