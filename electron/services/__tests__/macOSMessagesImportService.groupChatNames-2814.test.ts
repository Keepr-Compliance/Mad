/**
 * @jest-environment node
 *
 * BACKLOG-2814 — Apple group-chat names, against the REAL sqlite drivers.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR
 * ---------------------------------------------------------------------------
 * The importer read `chat_handle_join` for participant lists and `chat` only for
 * `account_login`. `chat.display_name` — the name the user actually typed on the
 * conversation ("Closing Team") — was read by nothing, so a named group thread
 * was identified by its phone numbers.
 *
 * The claim under test is not "a column got written". It is:
 *
 *   AN ORDINARY RE-IMPORT NAMES THREADS THE USER ALREADY HAD.
 *
 * That claim is why the name lives in `message_thread_names`, keyed by thread,
 * rather than on the `messages` row. `storeMessages` inserts with
 * `INSERT OR IGNORE` and pre-loads the GUIDs it already has, so a second import
 * of the same chat.db stores ZERO message rows — and a name carried on the
 * message row would therefore never reach an existing user without a destructive
 * force reimport. The zero-new-messages test below is the one a per-message
 * design cannot pass, and it is the reason for the design.
 *
 * It drives the REAL drivers for the reason the 2790 and 2775 suites do: the
 * jest moduleNameMapper stub for `sqlite3` calls back `[]` for every query, so a
 * mocked version of every test here would import zero messages, read zero chats,
 * and pass just as happily against an importer that never learned to read
 * `display_name` at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FIXTURE ENCODES, AND WHY IT IS NOT INVENTED
 * ---------------------------------------------------------------------------
 * Both of Apple's representations of "unnamed" appear here as separate chats,
 * because a real chat.db uses both and is dominated by the one that is easy to
 * miss. Measured against a real ~/Library/Messages/chat.db (2,886 chats):
 *
 *     named (non-empty) ....... 88
 *     EMPTY STRING ............ 2,564
 *     NULL .................... 234
 *     whitespace-only ......... 0
 *
 * The empty string outnumbers NULL more than ten to one. A `display_name != null`
 * check would therefore have named ~2,564 unnamed chats "" — which is why chat 3
 * (empty string) and chat 4 (NULL) are BOTH here, as distinct fixtures rather
 * than one representative case.
 */

import * as os from "os";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as nodePath from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let mockDb: DatabaseType;

jest.mock("os", () => ({
  ...jest.requireActual("os"),
  platform: () => "darwin",
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { getRawDatabase: () => mockDb },
}));
jest.mock("../permissionService", () => ({
  __esModule: true,
  default: { checkFullDiskAccess: jest.fn(async () => ({ hasPermission: true })) },
}));
jest.mock("../../utils/messageParser", () => ({
  __esModule: true,
  getMessageText: jest.fn(async () => "message text"),
}));
jest.mock("cli-progress", () => ({
  __esModule: true,
  default: {
    SingleBar: jest.fn().mockImplementation(() => ({
      start: jest.fn(), update: jest.fn(), increment: jest.fn(), stop: jest.fn(),
    })),
    Presets: { shades_classic: {} },
  },
}));
jest.mock("../auditService", () => ({
  __esModule: true,
  default: {
    suspendPeriodicSync: jest.fn(() => false),
    resumePeriodicSync: jest.fn(),
    isSyncInFlight: jest.fn(() => false),
  },
}));
jest.mock("../submissionSyncService", () => ({
  __esModule: true,
  default: { pauseRealtime: jest.fn(), resumeRealtime: jest.fn() },
}));

// DELIBERATELY NOT MOCKED: `sqlite3` resolves to the REAL driver by absolute
// path. See the header — against jest.config's stub this suite is vacuous.
jest.mock("sqlite3", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(
    require("path").join(__dirname, "..", "..", "..", "node_modules", "sqlite3"),
  ),
);

import { app } from "electron";
import macOSMessagesImportService from "../macOSMessagesImportService";
import { testImportPlan } from "./helpers/importPlanFixture";
import type { MacOSImportResult } from "../macOSMessagesImportService/types";

const USER = "user-group-names-2814";

/** Synthetic names. Nothing here is transcribed from a real conversation. */
const NAMED_GROUP = "Closing Team";
const RENAMED_GROUP = "Closing Team (Final)";

/**
 * Chat layout, fixed across the suite so every assertion names the same thing:
 *
 *   chat 1 — GROUP (3 handles), display_name = "Closing Team"   -> named
 *   chat 2 — GROUP (2 handles), display_name = ''               -> unnamed, EMPTY STRING
 *   chat 3 — GROUP (2 handles), display_name = NULL             -> unnamed, NULL
 *   chat 4 — 1:1  (1 handle),   display_name = 'Mum'            -> NAMED 1:1
 *
 * Chat 4 is the discriminating fixture. Apple lets a 1:1 carry a display_name
 * (10 such chats in the founder's own chat.db), so a rule of "show the name when
 * there is one" and a rule of "show the name on GROUPS" are only distinguishable
 * against a named 1:1. An unnamed 1:1 would let a wrong rule pass.
 */
const CHAT_1_NAMED_GROUP = 1;
const CHAT_2_EMPTY_NAME_GROUP = 2;
const CHAT_3_NULL_NAME_GROUP = 3;
const CHAT_4_NAMED_ONE_TO_ONE = 4;

let homeDir: string;
let scratchDir: string;
let realHome: string | undefined;
let sourceDbPath: string;

/**
 * The subset of the macOS Messages schema the import queries, transcribed from
 * the SQL in `doImport` rather than invented. `display_name` is a real column of
 * Apple's `chat` table — a fixture without it describes a chat.db that cannot
 * exist.
 */
function createSourceDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE message (
      guid TEXT, text TEXT, attributedBody BLOB, date INTEGER,
      is_from_me INTEGER, handle_id INTEGER, service TEXT,
      cache_has_attachments INTEGER, associated_message_type INTEGER,
      associated_message_guid TEXT
    );
    CREATE TABLE handle (id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, account_login TEXT, display_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (
      guid TEXT, filename TEXT, mime_type TEXT, transfer_name TEXT,
      total_bytes INTEGER, is_outgoing INTEGER
    );
    CREATE TABLE message_attachment_join (attachment_id INTEGER, message_id INTEGER);
  `);

  const insertHandle = db.prepare("INSERT INTO handle (id) VALUES (?)");
  for (const h of ["+15550100", "+15550101", "+15550102", "+15550103"]) {
    insertHandle.run(h);
  }

  const insertChat = db.prepare(
    "INSERT INTO chat (ROWID, account_login, display_name) VALUES (?, ?, ?)",
  );
  insertChat.run(CHAT_1_NAMED_GROUP, "P:+15550199", NAMED_GROUP);
  insertChat.run(CHAT_2_EMPTY_NAME_GROUP, "P:+15550199", ""); // Apple's common "unnamed"
  insertChat.run(CHAT_3_NULL_NAME_GROUP, "P:+15550199", null); // Apple's other "unnamed"
  insertChat.run(CHAT_4_NAMED_ONE_TO_ONE, "P:+15550199", "Mum"); // a NAMED 1:1

  const joinHandle = db.prepare(
    "INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)",
  );
  // Group membership: >1 handle is what makes the importer emit chat_members.
  joinHandle.run(CHAT_1_NAMED_GROUP, 1);
  joinHandle.run(CHAT_1_NAMED_GROUP, 2);
  joinHandle.run(CHAT_1_NAMED_GROUP, 3);
  joinHandle.run(CHAT_2_EMPTY_NAME_GROUP, 1);
  joinHandle.run(CHAT_2_EMPTY_NAME_GROUP, 2);
  joinHandle.run(CHAT_3_NULL_NAME_GROUP, 1);
  joinHandle.run(CHAT_3_NULL_NAME_GROUP, 2);
  joinHandle.run(CHAT_4_NAMED_ONE_TO_ONE, 4); // one handle => 1:1

  const insertMessage = db.prepare(`
    INSERT INTO message (
      guid, text, attributedBody, date, is_from_me, handle_id, service,
      cache_has_attachments, associated_message_type, associated_message_guid
    ) VALUES (?, ?, NULL, ?, 0, ?, 'iMessage', 0, NULL, NULL)
  `);
  const joinChat = db.prepare(
    "INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)",
  );

  // Two messages per chat, so a thread is a thread and not a single row.
  let rowId = 0;
  const seed = db.transaction(() => {
    for (const chatId of [
      CHAT_1_NAMED_GROUP,
      CHAT_2_EMPTY_NAME_GROUP,
      CHAT_3_NULL_NAME_GROUP,
      CHAT_4_NAMED_ONE_TO_ONE,
    ]) {
      for (let n = 1; n <= 2; n++) {
        rowId += 1;
        insertMessage.run(
          `msg-guid-c${chatId}-${n}`,
          `hello ${rowId}`,
          700000000 * 1e9 + rowId,
          chatId === CHAT_4_NAMED_ONE_TO_ONE ? 4 : 1,
        );
        joinChat.run(chatId, rowId);
      }
    }
  });
  seed();
  db.close();
}

/**
 * The app-side store. Hand-written rather than taken from schema.sql, matching
 * the convention of the other real-driver import suites — `message_thread_names`
 * is transcribed from the v66 migration's DDL.
 */
function createStoreSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel TEXT, external_id TEXT,
      direction TEXT, body_text TEXT, participants TEXT, participants_flat TEXT,
      thread_id TEXT, sent_at DATETIME, has_attachments INTEGER DEFAULT 0,
      message_type TEXT, metadata TEXT, associated_message_type INTEGER,
      associated_message_guid TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, message_id TEXT, external_message_id TEXT, filename TEXT,
      mime_type TEXT, file_size_bytes INTEGER, storage_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE message_thread_names (
      user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, thread_id)
    );
  `);
}

/** Every stored thread name by identity, not by count. */
function storedNames(): Array<{ thread_id: string; display_name: string }> {
  return (
    mockDb
      .prepare("SELECT thread_id, display_name FROM message_thread_names ORDER BY thread_id")
      .all() as Array<{ thread_id: string; display_name: string }>
  );
}

function storedThreadIds(): string[] {
  return (
    mockDb
      .prepare("SELECT DISTINCT thread_id FROM messages ORDER BY thread_id")
      .all() as Array<{ thread_id: string }>
  ).map((r) => r.thread_id);
}

function messageCount(): number {
  return (mockDb.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
}

function setDisplayName(chatId: number, value: string | null): void {
  const db = new Database(sourceDbPath);
  db.prepare("UPDATE chat SET display_name = ? WHERE ROWID = ?").run(value, chatId);
  db.close();
}

function importToCompletion(force = false): Promise<MacOSImportResult> {
  return macOSMessagesImportService.importMessages(
    USER,
    undefined,
    testImportPlan({
      mode: force ? "reprocess" : "delta",
      storedFilters: { lookbackMonths: null, maxMessages: null },
    }),
  );
}

beforeEach(async () => {
  mockDb = new Database(":memory:");
  createStoreSchema(mockDb);

  homeDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-2814-home-"));
  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-2814-app-"));
  await fs.mkdir(nodePath.join(homeDir, "Library", "Messages"), { recursive: true });
  sourceDbPath = nodePath.join(homeDir, "Library", "Messages", "chat.db");
  createSourceDb(sourceDbPath);

  // The service builds the source path from HOME. Pointing it at the temp tree is
  // what keeps this suite away from the founder's real ~/Library.
  realHome = process.env.HOME;
  process.env.HOME = homeDir;

  (app.getPath as jest.Mock).mockImplementation((name: string) =>
    name === "userData" ? scratchDir : `/tmp/test-${name}`,
  );
  jest.spyOn(fsSync.promises, "statfs").mockResolvedValue({
    type: 26, bsize: 4096, blocks: 1e9, bfree: 5e7, bavail: 5e7, files: 10, ffree: 10,
  } as fsSync.StatsFs);
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  mockDb?.close();
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(scratchDir, { recursive: true, force: true });
});

describe("BACKLOG-2814 — the import reads chat.display_name", () => {
  it("stores the name for a NAMED group, and stores nothing for either flavour of unnamed", async () => {
    const result = await importToCompletion();
    expect(result.success).toBe(true);
    expect(result.messagesImported).toBe(8);

    // IDENTITY, not a count: exactly one row, for exactly the named group.
    expect(storedNames()).toEqual([
      { thread_id: `macos-chat-${CHAT_1_NAMED_GROUP}`, display_name: NAMED_GROUP },
      // chat 4 is a NAMED 1:1 — the importer STORES its name (storage is
      // source-faithful); it is the CARD that refuses to display it. See
      // MessageThreadCard.groupName-2814.test.tsx.
      { thread_id: `macos-chat-${CHAT_4_NAMED_ONE_TO_ONE}`, display_name: "Mum" },
    ]);

    // The two unnamed groups are absent ENTIRELY — not present with "".
    const named = storedNames().map((r) => r.thread_id);
    expect(named).not.toContain(`macos-chat-${CHAT_2_EMPTY_NAME_GROUP}`);
    expect(named).not.toContain(`macos-chat-${CHAT_3_NULL_NAME_GROUP}`);
  });

  it("treats the EMPTY STRING as unnamed, which is the case a null-check alone would miss", async () => {
    // Isolated from the NULL case on purpose. Apple's empty string outnumbers
    // its NULL more than ten to one in a real chat.db, so this is the common
    // path, not the edge.
    await importToCompletion();

    const row = mockDb
      .prepare("SELECT display_name FROM message_thread_names WHERE thread_id = ?")
      .get(`macos-chat-${CHAT_2_EMPTY_NAME_GROUP}`);
    expect(row).toBeUndefined();
  });

  it("treats a whitespace-only name as unnamed", async () => {
    setDisplayName(CHAT_2_EMPTY_NAME_GROUP, "   ");
    await importToCompletion();

    const row = mockDb
      .prepare("SELECT display_name FROM message_thread_names WHERE thread_id = ?")
      .get(`macos-chat-${CHAT_2_EMPTY_NAME_GROUP}`);
    expect(row).toBeUndefined();
  });

  it("trims a name that has surrounding whitespace rather than storing it raw", async () => {
    setDisplayName(CHAT_1_NAMED_GROUP, `  ${NAMED_GROUP}  `);
    await importToCompletion();

    const row = mockDb
      .prepare("SELECT display_name FROM message_thread_names WHERE thread_id = ?")
      .get(`macos-chat-${CHAT_1_NAMED_GROUP}`) as { display_name: string };
    expect(row.display_name).toBe(NAMED_GROUP);
  });
});

describe("BACKLOG-2814 — an ordinary re-import names threads the user already had", () => {
  it("populates names on a re-import that stores ZERO new messages", async () => {
    // THE TEST THIS DESIGN EXISTS FOR.
    //
    // Simulating the existing user: their messages are already in the store, and
    // no name is (because the build that imported them could not read one). The
    // question the founder will ask is whether they must force-reimport to get
    // names. They must not.

    // Pass 1 — the "old" import: messages land, then the names are wiped to
    // recreate the pre-feature state exactly.
    await importToCompletion();
    mockDb.prepare("DELETE FROM message_thread_names").run();
    expect(storedNames()).toEqual([]);
    const messagesBefore = messageCount();
    const threadsBefore = storedThreadIds();
    expect(messagesBefore).toBe(8);

    // Pass 2 — an ORDINARY re-import (delta, not force).
    const second = await importToCompletion();
    expect(second.success).toBe(true);

    // Zero new messages: every GUID deduped. This is precisely why a name
    // carried on the message row could never arrive — INSERT OR IGNORE skips
    // all eight rows.
    expect(second.messagesImported).toBe(0);
    expect(messageCount()).toBe(messagesBefore);

    // And yet the name is now there.
    expect(storedNames()).toEqual([
      { thread_id: `macos-chat-${CHAT_1_NAMED_GROUP}`, display_name: NAMED_GROUP },
      { thread_id: `macos-chat-${CHAT_4_NAMED_ONE_TO_ONE}`, display_name: "Mum" },
    ]);

    // No thread was duplicated or invented by the second pass.
    expect(storedThreadIds()).toEqual(threadsBefore);
  });

  it("does not duplicate a name row when the same import runs three times", async () => {
    await importToCompletion();
    await importToCompletion();
    await importToCompletion();

    expect(storedNames()).toEqual([
      { thread_id: `macos-chat-${CHAT_1_NAMED_GROUP}`, display_name: NAMED_GROUP },
      { thread_id: `macos-chat-${CHAT_4_NAMED_ONE_TO_ONE}`, display_name: "Mum" },
    ]);
    expect(messageCount()).toBe(8);
  });

  it("follows a RENAME in Messages", async () => {
    await importToCompletion();
    setDisplayName(CHAT_1_NAMED_GROUP, RENAMED_GROUP);
    await importToCompletion();

    const row = mockDb
      .prepare("SELECT display_name FROM message_thread_names WHERE thread_id = ?")
      .get(`macos-chat-${CHAT_1_NAMED_GROUP}`) as { display_name: string };
    expect(row.display_name).toBe(RENAMED_GROUP);
  });

  it("CLEARS a name the user removed in Messages, rather than keeping a stale one", async () => {
    await importToCompletion();
    expect(storedNames().map((r) => r.thread_id)).toContain(
      `macos-chat-${CHAT_1_NAMED_GROUP}`,
    );

    // Apple writes the empty string when a name is cleared far more often than
    // it writes NULL, so that is what this clears with.
    setDisplayName(CHAT_1_NAMED_GROUP, "");
    await importToCompletion();

    expect(storedNames().map((r) => r.thread_id)).not.toContain(
      `macos-chat-${CHAT_1_NAMED_GROUP}`,
    );
    // The messages themselves are untouched by a name clear.
    expect(messageCount()).toBe(8);
  });

  it("leaves a thread name from ANOTHER source alone when it clears", async () => {
    // The clear is scoped by the `macos-chat-` prefix. An Android or iPhone
    // thread name must survive a macOS import that names nothing.
    mockDb
      .prepare(
        "INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?, ?, ?)",
      )
      .run(USER, "android-thread-77", "Neighbours");
    setDisplayName(CHAT_1_NAMED_GROUP, "");
    setDisplayName(CHAT_4_NAMED_ONE_TO_ONE, "");

    await importToCompletion();

    expect(storedNames()).toEqual([
      { thread_id: "android-thread-77", display_name: "Neighbours" },
    ]);
  });

  it("does not reach another user's rows", async () => {
    mockDb
      .prepare(
        "INSERT INTO message_thread_names (user_id, thread_id, display_name) VALUES (?, ?, ?)",
      )
      .run("someone-else", `macos-chat-${CHAT_1_NAMED_GROUP}`, "Their Group");

    setDisplayName(CHAT_1_NAMED_GROUP, "");
    await importToCompletion();

    const theirs = mockDb
      .prepare(
        "SELECT display_name FROM message_thread_names WHERE user_id = ? AND thread_id = ?",
      )
      .get("someone-else", `macos-chat-${CHAT_1_NAMED_GROUP}`) as { display_name: string };
    expect(theirs.display_name).toBe("Their Group");
  });
});

describe("BACKLOG-2814 — a name failure never fails the message import", () => {
  it("still reports success when the names table is missing entirely", async () => {
    // An upgrade that has not run v66 yet, or a partial-schema fixture. The
    // messages are the product; the name is a display convenience.
    mockDb.exec("DROP TABLE message_thread_names");

    const result = await importToCompletion();

    expect(result.success).toBe(true);
    expect(result.messagesImported).toBe(8);
    expect(messageCount()).toBe(8);
  });
});
