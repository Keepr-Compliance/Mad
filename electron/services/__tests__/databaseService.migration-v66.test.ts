/**
 * @jest-environment node
 *
 * Integration test for migration v66 (BACKLOG-2814 — Apple group-chat names).
 *
 * v66 adds `message_thread_names`, the thread-keyed store for the user-visible
 * name of a group conversation ("Closing Team"), plus a lookup index on
 * `thread_id`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * IT DOES NOT BACKFILL, and that is the behaviour most worth pinning, because
 * it looks like an omission. The names do not exist anywhere in our database
 * before this runs — they live in the user's `~/Library/Messages/chat.db`. A
 * migration cannot invent them. The backfill IS the next import: the importer
 * upserts this table from the `chat` table on every run, independent of message
 * dedup, so an existing user's already-imported threads gain their names after
 * one ordinary re-import.
 *
 * So the assertion below is that an upgraded database has the table and it is
 * EMPTY — not that it is populated.
 *
 * The tests assert behaviour (insert, read back, constraint actually rejects)
 * rather than string-matching DDL, and pin that nothing else on the database
 * moves, per the shape established by the v65 suite.
 */

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

const USER_ID = "user-v66-test";
const OTHER_USER = "user-v66-other";
const THREAD = "macos-chat-1";
const GROUP_NAME = "Closing Team";

/** Post-v65 / pre-v66 shape — only what this migration interacts with. */
const PRE_V66_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    thread_id TEXT,
    body_text TEXT,
    sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

/** The column set `messages` carries BEFORE v66, in order. */
const PRE_V66_MESSAGE_COLUMNS = [
  "id",
  "user_id",
  "thread_id",
  "body_text",
  "sent_at",
  "created_at",
];

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

function tableExists(db: DatabaseType, name: string): boolean {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function insertName(
  db: DatabaseType,
  userId: string,
  threadId: string,
  displayName: string | null,
): void {
  db.prepare(
    `INSERT INTO message_thread_names (user_id, thread_id, display_name)
     VALUES (?, ?, ?)`,
  ).run(userId, threadId, displayName);
}

describe("databaseService migration v66 (BACKLOG-2814 — group chat names)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V66_FIXTURE);
    for (const u of [USER_ID, OTHER_USER]) {
      harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(u);
    }
    harness.db
      .prepare("INSERT INTO messages (id, user_id, thread_id, body_text) VALUES (?, ?, ?, ?)")
      .run("m-1", USER_ID, THREAD, "hello");
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

  /** Seed at v65 AND clip the chain at v66 so ONLY v66 runs. */
  async function runV66(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 65)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 66);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  it("advances schema_version to 66", async () => {
    await runV66();
    expect(schemaVersion(harness.db)).toBe(66);
  });

  it("creates message_thread_names and accepts a row", async () => {
    expect(tableExists(harness.db, "message_thread_names")).toBe(false);
    await runV66();
    expect(tableExists(harness.db, "message_thread_names")).toBe(true);

    insertName(harness.db, USER_ID, THREAD, GROUP_NAME);

    const row = harness.db
      .prepare(
        "SELECT user_id, thread_id, display_name FROM message_thread_names WHERE thread_id = ?",
      )
      .get(THREAD);
    expect(row).toEqual({
      user_id: USER_ID,
      thread_id: THREAD,
      display_name: GROUP_NAME,
    });
  });

  it("leaves the table EMPTY — the migration does not, and cannot, backfill", async () => {
    // THE POINT WORTH PINNING. An existing user's upgraded database has the
    // table and no names in it. The names are in their chat.db, not ours; the
    // next ordinary import is what fills this in. A future change that adds a
    // backfill here should have to delete this test on purpose.
    await runV66();

    const count = (
      harness.db.prepare("SELECT COUNT(*) AS n FROM message_thread_names").get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it("REJECTS an empty display_name via NOT NULL — absence is a missing ROW", async () => {
    await runV66();
    expect(() => insertName(harness.db, USER_ID, THREAD, null)).toThrow(/NOT NULL/i);
  });

  it("keys on (user_id, thread_id), so two users can name the SAME thread id", async () => {
    // Thread ids are only unique per machine ("macos-chat-<ROWID>"). If the PK
    // were thread_id alone, the second insert here would collide and one user's
    // name would overwrite the other's.
    await runV66();

    insertName(harness.db, USER_ID, THREAD, GROUP_NAME);
    insertName(harness.db, OTHER_USER, THREAD, "Their Group");

    const rows = harness.db
      .prepare(
        "SELECT user_id, display_name FROM message_thread_names WHERE thread_id = ? ORDER BY user_id",
      )
      .all(THREAD);
    expect(rows).toEqual([
      { user_id: OTHER_USER, display_name: "Their Group" },
      { user_id: USER_ID, display_name: GROUP_NAME },
    ]);
  });

  it("rejects a DUPLICATE (user_id, thread_id)", async () => {
    await runV66();
    insertName(harness.db, USER_ID, THREAD, GROUP_NAME);
    expect(() => insertName(harness.db, USER_ID, THREAD, "Second")).toThrow(/UNIQUE|PRIMARY/i);
  });

  it("creates the thread_id lookup index", async () => {
    await runV66();
    const idx = harness.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_message_thread_names_thread");
    expect(idx).toBeDefined();
  });

  it("is idempotent — running it twice changes nothing and does not throw", async () => {
    await runV66();
    insertName(harness.db, USER_ID, THREAD, GROUP_NAME);

    // Re-run the same migration against the already-migrated database.
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 65)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 66);
    try {
      await expect(harness.service._runVersionedMigrations()).resolves.not.toThrow();
    } finally {
      klass.MIGRATIONS = all;
    }

    // The row placed before the re-run survives it.
    const rows = harness.db
      .prepare("SELECT user_id, thread_id, display_name FROM message_thread_names")
      .all();
    expect(rows).toEqual([
      { user_id: USER_ID, thread_id: THREAD, display_name: GROUP_NAME },
    ]);
  });

  it("does not move anything else on the database", async () => {
    await runV66();

    // `messages` is untouched — the name is NOT a column on it.
    expect(columns(harness.db, "messages")).toEqual(PRE_V66_MESSAGE_COLUMNS);
    expect(columns(harness.db, "messages")).not.toContain("thread_display_name");
    expect(columns(harness.db, "messages")).not.toContain("display_name");

    // And the pre-existing message row is still there, unaltered.
    const msg = harness.db
      .prepare("SELECT id, user_id, thread_id, body_text FROM messages")
      .all();
    expect(msg).toEqual([
      { id: "m-1", user_id: USER_ID, thread_id: THREAD, body_text: "hello" },
    ]);
  });
});
