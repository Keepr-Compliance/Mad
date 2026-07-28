/**
 * @jest-environment node
 *
 * REAL upgrade-path regression test — BACKLOG-2298.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (the gap CI was missing)
 * ---------------------------------------------------------------------------
 * databaseService.runMigrations() runs in TWO steps, in this order:
 *
 *     currentDb.exec(schemaSql);          // 1. the CURRENT electron/database/schema.sql
 *     await this._runVersionedMigrations() // 2. the versioned migration chain
 *
 * On a FRESH install schema.sql's `CREATE TABLE messages (...)` builds the table
 * WITH every column, so any standalone `CREATE INDEX ... ON messages(<col>)` in
 * schema.sql resolves. But on a REAL upgrade of an existing DB, the messages
 * table already exists, so `CREATE TABLE IF NOT EXISTS messages` is a NO-OP and
 * does NOT add the new v52 reaction columns — those only arrive when step 2's
 * v52 migration runs. If schema.sql (step 1) contains a standalone
 * `CREATE INDEX ... ON messages(associated_message_guid) ...` it therefore
 * throws `no such column: associated_message_guid` BEFORE step 2 can add the
 * column → the whole migration fails → auto-restore to the prior version.
 *
 * Every existing migration test (including databaseService.migration-v52) only
 * drives step 2 (`_runVersionedMigrations`) against a hand-built fixture, and
 * the schema-parity test seeds BOTH of its paths from the current schema.sql
 * (so the messages table always already has the reaction columns). Neither
 * exercises the real "exec(current schema.sql) over a genuinely pre-2280
 * messages table" ordering — which is exactly where the crash lives.
 *
 * This test reproduces a real v51 on-disk DB (messages table WITHOUT the two
 * reaction columns, schema_version = 51) and then runs the REAL runMigrations()
 * flow. It FAILS on the unfixed schema.sql (the standalone reactions index
 * throws) and PASSES once schema.sql no longer declares that index (the v52
 * migration creates it idempotently instead).
 *
 * Follows the migration-v52 convention: real better-sqlite3 driver via the
 * node_modules require() bypass, in-memory DB via createMigrationHarness.
 */

import fs from "fs";
import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

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

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// The exact file runMigrations() reads on a real upgrade
// (databaseService.ts: path.join(__dirname, "../database/schema.sql")).
const SCHEMA_SQL_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

/**
 * Build a "pre-BACKLOG-2280" schema by taking the CURRENT schema.sql and
 * removing every line that references the v52 reaction identifiers — i.e. the
 * two `associated_message_*` column declarations AND the standalone
 * `idx_messages_assoc_guid` index. Exec'ing the result yields a realistic v51
 * on-disk DB: full current shape for every other table, but a messages table
 * whose reaction columns do not exist yet (as on any real DB last touched at
 * v51). The index-line filter is intentionally state-agnostic: it is a no-op
 * once the fix removes that index from schema.sql, and still strips it if the
 * regression is ever reintroduced.
 */
function buildPre2280SchemaSql(): string {
  const sql = fs.readFileSync(SCHEMA_SQL_PATH, "utf8");
  return sql
    .split("\n")
    .filter((line) => !/associated_message_type|associated_message_guid/.test(line))
    .join("\n");
}

function columns(db: DatabaseType, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function indexExists(db: DatabaseType, name: string): boolean {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
    .get(name);
}

function latestMigrationVersion(service: { constructor: { MIGRATIONS: Array<{ version: number }> } }): number {
  const migrations = service.constructor.MIGRATIONS;
  return migrations[migrations.length - 1].version;
}

describe("databaseService runMigrations() — real v51 upgrade over current schema.sql (BACKLOG-2298)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    // Simulate the on-disk state of a user who last ran v51: the full pre-2280
    // schema, with a messages table that lacks the reaction columns.
    harness.db.exec(buildPre2280SchemaSql());
    harness.db.prepare("UPDATE schema_version SET version = 51 WHERE id = 1").run();
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

  it("sanity: real better-sqlite3 driver is wired (not the jest auto-mock)", () => {
    expect(typeof RealDatabase).toBe("function");
  });

  it("precondition: the seeded v51 messages table has NEITHER reaction column", () => {
    const cols = columns(harness.db, "messages");
    expect(cols).not.toContain("associated_message_type");
    expect(cols).not.toContain("associated_message_guid");
  });

  it("runMigrations() execs the CURRENT schema.sql then the chain WITHOUT throwing", async () => {
    // This is the assertion that FAILS on the unfixed schema.sql: the standalone
    // `CREATE INDEX idx_messages_assoc_guid ON messages(associated_message_guid)`
    // in schema.sql throws "no such column: associated_message_guid" because the
    // pre-existing v51 messages table has not yet gained the column (the v52
    // migration that adds it has not run at exec(schema.sql) time).
    await expect(harness.service.runMigrations()).resolves.toBeUndefined();
  });

  it("after the upgrade: both reaction columns AND the reactions index exist", async () => {
    await harness.service.runMigrations();

    const cols = columns(harness.db, "messages");
    expect(cols).toContain("associated_message_type");
    expect(cols).toContain("associated_message_guid");
    expect(indexExists(harness.db, "idx_messages_assoc_guid")).toBe(true);
  });

  it("after the upgrade: schema_version advances to the latest migration", async () => {
    await harness.service.runMigrations();

    const row = harness.db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(row.version).toBe(latestMigrationVersion(harness.service));
  });

  it("after the upgrade: a reaction row can be inserted and read back", async () => {
    await harness.service.runMigrations();

    // users_local is created by schema.sql; satisfy the messages.user_id FK
    // (users_local has NOT NULL email / oauth_provider / oauth_id).
    harness.db
      .prepare(
        `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
         VALUES ('user-1', 'user-1@example.com', 'google', 'oauth-1')`,
      )
      .run();
    harness.db
      .prepare(
        `INSERT INTO messages (id, user_id, channel, associated_message_type, associated_message_guid)
         VALUES ('react-1', 'user-1', 'imessage', 2000, 'PARENT-GUID')`,
      )
      .run();

    const row = harness.db
      .prepare(
        "SELECT associated_message_type AS t, associated_message_guid AS g FROM messages WHERE id = 'react-1'",
      )
      .get() as { t: number; g: string };
    expect(row.t).toBe(2000);
    expect(row.g).toBe("PARENT-GUID");
  });
});
