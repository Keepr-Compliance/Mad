/**
 * @jest-environment node
 *
 * REAL upgrade-path regression test — BACKLOG-2300 (same class as BACKLOG-2298).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (the gap CI was missing — identical to the v51/2298 gap)
 * ---------------------------------------------------------------------------
 * databaseService.runMigrations() runs in TWO steps, in this order:
 *
 *     currentDb.exec(schemaSql);           // 1. the CURRENT electron/database/schema.sql
 *     await this._runVersionedMigrations() // 2. the versioned migration chain
 *
 * On a FRESH install schema.sql's `CREATE TABLE messages/attachments/
 * external_contacts (...)` builds the tables WITH the `sync_session_id` column
 * (added by migration v32 / TASK-2110), so any standalone
 * `CREATE INDEX ... ON <table>(... sync_session_id)` in schema.sql resolves.
 *
 * But on a REAL upgrade of an existing DB last touched at schema_version <= 31,
 * those tables already exist, so `CREATE TABLE IF NOT EXISTS` is a NO-OP and
 * does NOT add the v32 `sync_session_id` column — it only arrives when step 2's
 * v32 migration runs. If schema.sql (step 1) still contains a standalone
 * `CREATE INDEX ... ON messages(user_id, sync_session_id)` it therefore throws
 * `no such column: sync_session_id` BEFORE step 2 can add the column → the whole
 * migration aborts → auto-restore to the prior version → app stuck on
 * "Starting up your secure database". This is byte-for-byte the BACKLOG-2298
 * failure mode (`no such column: associated_message_guid`), one column earlier.
 *
 * The v32-specific twist: schema.sql itself DECLARES `schema_version = 32`, so a
 * FRESH install SKIPS migration v32. That is why the v32 side effects were
 * "folded" into schema.sql (BACKLOG-1774 / S6). The fix therefore cannot simply
 * delete the indexes from schema.sql (fresh installs would lose them and the
 * schema-parity CI test would fail); it (a) removes the three standalone
 * `sync_session_id` indexes from schema.sql so `exec(schema.sql)` never touches
 * a not-yet-added column, and (b) recreates them idempotently in a migration
 * ABOVE the declared baseline (v54) so BOTH install paths get them — mirroring
 * the deferred-index precedent of idx_contact_phones_normalized (v40),
 * idx_messages_assoc_guid (v52), and idx_messages_user_sent (v53).
 *
 * Every existing migration test only drives step 2 (`_runVersionedMigrations`)
 * against a hand-built fixture, and the schema-parity test seeds BOTH paths from
 * the current schema.sql (so the tables always already have sync_session_id).
 * Neither exercises the real "exec(current schema.sql) over a genuinely pre-v32
 * table" ordering — which is exactly where the crash lives.
 *
 * This test reproduces a real <=v31 on-disk DB (messages / attachments /
 * external_contacts WITHOUT the sync_session_id column, schema_version = 31) and
 * then runs the REAL runMigrations() flow. It FAILS on the unfixed schema.sql
 * (the standalone sync_session index throws) and PASSES once schema.sql no
 * longer declares those indexes (the v54 migration creates them idempotently).
 *
 * Follows the databaseService.runMigrations-upgrade-v51 convention: real
 * better-sqlite3 driver via the node_modules require() bypass, in-memory DB via
 * createMigrationHarness.
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
 * Build a "pre-v32" schema by taking the CURRENT schema.sql and removing every
 * line that references `sync_session_id` — i.e. the three column declarations
 * (messages / attachments / external_contacts) AND the three standalone
 * `idx_*_sync_session` indexes. Exec'ing the result yields a realistic <=v31
 * on-disk DB: full current shape for every other table, but those three tables
 * lack the sync_session_id column (as on any real DB last touched at v31). The
 * line filter is intentionally state-agnostic: it is a no-op on the fixed
 * schema.sql's index lines (already gone) and still strips them if the
 * regression is ever reintroduced.
 */
function buildPreV32SchemaSql(): string {
  const sql = fs.readFileSync(SCHEMA_SQL_PATH, "utf8");
  return sql
    .split("\n")
    .filter((line) => !/sync_session_id/.test(line))
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

function latestMigrationVersion(service: {
  constructor: { MIGRATIONS: Array<{ version: number }> };
}): number {
  const migrations = service.constructor.MIGRATIONS;
  return migrations[migrations.length - 1].version;
}

const SYNC_INDEXES = [
  "idx_messages_sync_session",
  "idx_attachments_sync_session",
  "idx_external_contacts_sync_session",
] as const;

describe("databaseService runMigrations() — real v31 upgrade over current schema.sql (BACKLOG-2300)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    // Simulate the on-disk state of a user who last ran v31: the full pre-v32
    // schema, with messages / attachments / external_contacts tables that lack
    // the sync_session_id column.
    harness.db.exec(buildPreV32SchemaSql());
    harness.db.prepare("UPDATE schema_version SET version = 31 WHERE id = 1").run();
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

  it("precondition: the seeded v31 tables have NO sync_session_id column", () => {
    expect(columns(harness.db, "messages")).not.toContain("sync_session_id");
    expect(columns(harness.db, "attachments")).not.toContain("sync_session_id");
    expect(columns(harness.db, "external_contacts")).not.toContain("sync_session_id");
  });

  it("runMigrations() execs the CURRENT schema.sql then the chain WITHOUT throwing", async () => {
    // This is the assertion that FAILS on the unfixed schema.sql: a standalone
    // `CREATE INDEX idx_messages_sync_session ON messages(user_id, sync_session_id)`
    // in schema.sql throws "no such column: sync_session_id" because the
    // pre-existing v31 messages table has not yet gained the column (the v32
    // migration that adds it has not run at exec(schema.sql) time).
    await expect(harness.service.runMigrations()).resolves.toBeUndefined();
  });

  it("after the upgrade: sync_session_id column AND its index exist on all three tables", async () => {
    await harness.service.runMigrations();

    expect(columns(harness.db, "messages")).toContain("sync_session_id");
    expect(columns(harness.db, "attachments")).toContain("sync_session_id");
    expect(columns(harness.db, "external_contacts")).toContain("sync_session_id");

    for (const idx of SYNC_INDEXES) {
      expect(indexExists(harness.db, idx)).toBe(true);
    }
  });

  it("after the upgrade: schema_version advances to the latest migration", async () => {
    await harness.service.runMigrations();

    const row = harness.db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(row.version).toBe(latestMigrationVersion(harness.service));
  });

  it("after the upgrade: a row carrying a sync_session_id can be inserted and read back", async () => {
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
        `INSERT INTO messages (id, user_id, channel, sync_session_id)
         VALUES ('msg-1', 'user-1', 'imessage', 'session-abc')`,
      )
      .run();

    const row = harness.db
      .prepare("SELECT sync_session_id AS s FROM messages WHERE id = 'msg-1'")
      .get() as { s: string };
    expect(row.s).toBe("session-abc");
  });
});
