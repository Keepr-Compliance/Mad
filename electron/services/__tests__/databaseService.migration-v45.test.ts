/**
 * @jest-environment node
 *
 * Integration test for migration v45 (BACKLOG-1771 — DB hardening S4).
 *
 * Verifies the emails(user_id, sent_at) composite index:
 *   1. schema_version advances to the latest migration.
 *   2. idx_emails_user_sent exists, is NON-unique, and covers exactly
 *      (user_id, sent_at) in that order.
 *   3. The migration is idempotent (safe to re-run).
 *   4. Fresh-install parity: the index built from schema.sql matches the one the
 *      migration produces (both structurally identical, both non-unique).
 *
 * Uses the real better-sqlite3-multiple-ciphers driver via the shared migration
 * test harness (see migrationTestHarness.ts).
 */

import fs from "fs";
import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — same shape as databaseService.migration-v44.test.ts
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

const USER_ID = "user-v45-test";

/** The highest migration version = what schema_version should read post-run. */
function latestVersion(harness: MigrationHarness): number {
  const migrations = harness.service.constructor.MIGRATIONS as Array<{ version: number }>;
  return migrations[migrations.length - 1].version;
}

/** Read the index_list entry for idx_emails_user_sent (undefined if absent). */
function userSentIndexEntry(
  harness: MigrationHarness,
): { name: string; unique: number } | undefined {
  const list = harness.db.prepare("PRAGMA index_list(emails)").all() as Array<{
    name: string;
    unique: number;
  }>;
  return list.find((i) => i.name === "idx_emails_user_sent");
}

/** Column names (ordered) covered by an index. */
function indexColumns(db: DatabaseType, indexName: string): string[] {
  return (
    db.prepare(`PRAGMA index_info("${indexName}")`).all() as Array<{ name: string | null }>
  ).map((r) => r.name ?? "<expr>");
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe("databaseService migration v45 (BACKLOG-1771)", () => {
  let harness: MigrationHarness;

  beforeEach(async () => {
    harness = createMigrationHarness({ seedV29Schema: true });
    harness.seedSchemaVersion(44);
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

  it("creates a NON-unique composite index on (user_id, sent_at)", () => {
    const entry = userSentIndexEntry(harness);
    expect(entry).toBeDefined();
    expect(entry?.unique).toBe(0); // 0 = non-unique
    expect(indexColumns(harness.db, "idx_emails_user_sent")).toEqual(["user_id", "sent_at"]);
  });

  it("is a full (non-partial) index — no WHERE predicate", () => {
    const idx = harness.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_emails_user_sent'")
      .get() as { sql: string };
    expect(idx.sql.toUpperCase()).not.toContain("WHERE");
    expect(idx.sql.toUpperCase()).not.toContain("UNIQUE");
  });

  it("is idempotent — re-running v45 keeps the composite index intact", async () => {
    harness.db.prepare("UPDATE schema_version SET version = 44 WHERE id = 1").run();
    await expect(harness.service._runVersionedMigrations()).resolves.not.toThrow();

    expect(indexColumns(harness.db, "idx_emails_user_sent")).toEqual(["user_id", "sent_at"]);
    expect(userSentIndexEntry(harness)?.unique).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fresh-install parity: the index built from schema.sql must match the shape the
// migration produces (BACKLOG-1771 / S3 pre-flight).
// ---------------------------------------------------------------------------

describe("migration v45 — fresh-install schema.sql parity (BACKLOG-1771)", () => {
  /** Collapse whitespace + strip SQL line comments for structural comparison. */
  function normalizeSql(sql: string | null): string {
    if (!sql) return "";
    return sql
      .replace(/\r\n?/g, "\n") // CRLF / lone CR -> LF (Windows checkout safety)
      .replace(/--[^\n]*/g, "") // strip SQL line comments
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

    // (b) Migrated DB via the runner (pre-v45 fixture -> v45).
    migratedHarness = createMigrationHarness({ seedV29Schema: true });
    migratedHarness.seedSchemaVersion(44);
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

  it("schema.sql defines the composite index", () => {
    expect(objectSql(freshDb, "idx_emails_user_sent")).toBeTruthy();
  });

  it("composite index shape matches between schema.sql and the migration", () => {
    expect(normalizeSql(objectSql(freshDb, "idx_emails_user_sent"))).toBe(
      normalizeSql(objectSql(migratedHarness.db, "idx_emails_user_sent")),
    );
  });

  it("composite index covers (user_id, sent_at) in both schema.sql and the migration", () => {
    const cols = (db: DatabaseType) =>
      (
        db.prepare('PRAGMA index_info("idx_emails_user_sent")').all() as Array<{
          name: string | null;
        }>
      ).map((r) => r.name);
    expect(cols(freshDb)).toEqual(["user_id", "sent_at"]);
    expect(cols(migratedHarness.db)).toEqual(["user_id", "sent_at"]);
  });
});
