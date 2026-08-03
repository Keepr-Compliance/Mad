/**
 * @jest-environment node
 *
 * Integration test for migration v52 (BACKLOG-2280 — reactions/tapbacks).
 *
 * v52 adds messages.associated_message_type + messages.associated_message_guid
 * and a partial index (idx_messages_assoc_guid) so reaction rows can be stored on
 * the messages table and partitioned to their parent at render time.
 *
 * Follows the migration-v51 convention: real better-sqlite3 driver via the
 * node_modules require() bypass, in-memory DB via createMigrationHarness, seeded
 * at schema_version=51 so ONLY v52 runs.
 */

import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

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

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// Pre-v52 messages table (no reaction columns) + schema_version. Seeded at v51.
const PRE_V52_FIXTURE = `
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    channel TEXT,
    body_text TEXT,
    thread_id TEXT,
    sent_at DATETIME,
    message_type TEXT
  );

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

function columnExists(db: DatabaseType, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function indexExists(db: DatabaseType, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
    .get(name);
  return !!row;
}

describe("databaseService migration v52 (BACKLOG-2280 — reactions/tapbacks)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V52_FIXTURE);
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

  async function runV52(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 51)").run();
    await harness.service._runVersionedMigrations();
  }

  it("sanity: real better-sqlite3 driver is wired (not the jest auto-mock)", () => {
    expect(typeof RealDatabase).toBe("function");
  });

  it("adds both reaction columns + the partial index and advances to v52", async () => {
    expect(columnExists(harness.db, "messages", "associated_message_type")).toBe(false);
    expect(columnExists(harness.db, "messages", "associated_message_guid")).toBe(false);

    await runV52();

    expect(columnExists(harness.db, "messages", "associated_message_type")).toBe(true);
    expect(columnExists(harness.db, "messages", "associated_message_guid")).toBe(true);
    expect(indexExists(harness.db, "idx_messages_assoc_guid")).toBe(true);

    const row = harness.db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    // Seeded at v51 → the runner advances to the LATEST migration version.
    // BACKLOG-2364 added v56 (tombstone columns) on top of v55 match_reason and
    // develop's v52–v54, so the chain now terminates at 56 (v53..v56 no-op on
    // this reactions fixture but still advance schema_version). BACKLOG-2401
    // then added v57 (contact_source_links), so the chain terminates at 57.
    expect(row.version).toBe(58);
  });

  it("lets a reaction row be written after the migration", async () => {
    await runV52();
    harness.db
      .prepare(
        `INSERT INTO messages (id, user_id, channel, body_text, thread_id, associated_message_type, associated_message_guid)
         VALUES (?, ?, 'imessage', '', 'macos-chat-1', 2000, 'PARENT-GUID')`,
      )
      .run("react-1", "user-1");
    const row = harness.db
      .prepare("SELECT associated_message_type, associated_message_guid FROM messages WHERE id = ?")
      .get("react-1") as { associated_message_type: number; associated_message_guid: string };
    expect(row.associated_message_type).toBe(2000);
    expect(row.associated_message_guid).toBe("PARENT-GUID");
  });

  it("is idempotent: re-running the migrate() body does not throw and keeps the columns", async () => {
    await runV52();

    const migrations = harness.service.constructor.MIGRATIONS as Array<{
      version: number;
      migrate: (d: DatabaseType) => void;
    }>;
    const v52 = migrations.find((m) => m.version === 52);
    expect(v52).toBeDefined();
    expect(() => v52!.migrate(harness.db)).not.toThrow();

    expect(columnExists(harness.db, "messages", "associated_message_type")).toBe(true);
    expect(columnExists(harness.db, "messages", "associated_message_guid")).toBe(true);
    expect(indexExists(harness.db, "idx_messages_assoc_guid")).toBe(true);
  });

  it("skips cleanly (no throw) when the messages table is absent", async () => {
    await harness.cleanup();
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        migrated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 51)").run();
    await expect(harness.service._runVersionedMigrations()).resolves.toBeUndefined();
  });
});
