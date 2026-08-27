/**
 * @jest-environment node
 *
 * BACKLOG-2796 — a macOS Force Re-import must only replace what chat.db can
 * rebuild. Against the REAL sqlite drivers.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 * The force set was `user_id = <me> AND external_id IS NOT NULL` and nothing
 * else. Walk it through with a user who has the Android companion paired: they
 * press Force Re-import on the Messages settings screen, the swap deletes every
 * row that predicate matches — their Android SMS, their iPhone-synced messages,
 * their `channel = 'email'` rows — and the rebuild puts back only what this
 * Mac's chat.db holds. Everything else is gone, from a button whose promise is
 * "re-import my Mac's messages". It predates stage-and-swap: the old
 * `clearMacOSMessages` deleted the same set.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REAL DRIVERS, AND WHY A UNIQUE INDEX
 * ---------------------------------------------------------------------------
 * Two reasons a mock would pass against broken code here. The store's rows have
 * to be deleted or spared by a REAL predicate evaluating REAL `metadata` JSON —
 * `json_extract` is a driver feature, and a mock has no opinion about it. And
 * the second half of this fix only shows itself against
 * `idx_messages_user_external_id`: iPhone sync writes the SAME Apple GUID space
 * chat.db draws from, so once iPhone rows survive, a rebuild that does not
 * deduplicate against the survivors stages a GUID one of them still holds and
 * the swap's plain INSERT hits that unique index. The 2790 suites build a store
 * without it; this one adds it, because a control that cannot collide cannot
 * prove anything about collisions.
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
// `warn` is its OWN mock, not the shared noop the 2790 suites use: the swap's
// yield count is reported through it, and "how many staged rows stood down" is
// the only thing that separates a rebuild which deduplicated against the
// survivors from one which staged their GUIDs and threw the work away at the
// swap. Both leave the same rows in the table.
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: {
      info: noop,
      warn: jest.fn().mockResolvedValue(undefined),
      error: noop,
      debug: noop,
    },
  };
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
  default: {
    suspendPeriodicSync: jest.fn(() => false),
    resumePeriodicSync: jest.fn(),
    isSyncInFlight: jest.fn(() => false),
  },
}));

// DELIBERATELY NOT MOCKED: ../db/readOnlySqlite, and `sqlite3` is resolved to the
// REAL driver by absolute path. `jest.config.js` maps `^sqlite3$` to a stub whose
// `all` calls back `[]` for every query — against that stub this suite would
// import zero messages and pass just as happily against broken code. Same reason,
// same pattern, as `macOSMessagesImportService.forceCancelRealDriver-2775.test.ts`.
jest.mock("sqlite3", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(
    require("path").join(__dirname, "..", "..", "..", "node_modules", "sqlite3"),
  ),
);

import { app } from "electron";
import macOSMessagesImportService from "../macOSMessagesImportService";
import logService from "../logService";
import { testImportPlan } from "./helpers/importPlanFixture";
import type { MacOSImportResult } from "../macOSMessagesImportService/types";

const USER = "user-force-scope-2796";
const MESSAGE_COUNT = 150; // > BATCH_SIZE (100), so a cancel can land between batches

let homeDir: string;
let scratchDir: string;
let realHome: string | undefined;

/**
 * The subset of the macOS Messages schema the import queries, transcribed from
 * the SQL in `doImport` rather than invented.
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
    -- BACKLOG-2814: display_name is ALWAYS a column of Apple's real chat
    -- table. A fixture without it described a chat.db that cannot exist.
    CREATE TABLE chat (account_login TEXT, display_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (
      guid TEXT, filename TEXT, mime_type TEXT, transfer_name TEXT,
      total_bytes INTEGER, is_outgoing INTEGER
    );
    CREATE TABLE message_attachment_join (attachment_id INTEGER, message_id INTEGER);
  `);

  db.prepare("INSERT INTO handle (id) VALUES (?)").run("+15550100");
  db.prepare("INSERT INTO chat (account_login) VALUES (?)").run("P:+15550199");
  db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(1, 1);

  const insertMessage = db.prepare(`
    INSERT INTO message (
      guid, text, attributedBody, date, is_from_me, handle_id, service,
      cache_has_attachments, associated_message_type, associated_message_guid
    ) VALUES (?, ?, NULL, ?, 0, 1, 'iMessage', 0, NULL, NULL)
  `);
  const joinChat = db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)");
  const seed = db.transaction(() => {
    for (let n = 1; n <= MESSAGE_COUNT; n++) {
      insertMessage.run(`msg-guid-${n}`, `hello ${n}`, 700000000 * 1e9 + n);
      joinChat.run(n);
    }
  });
  seed();
  db.close();
}

function createStoreSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel TEXT, external_id TEXT,
      direction TEXT, body_text TEXT, participants TEXT, participants_flat TEXT,
      thread_id TEXT, sent_at DATETIME, has_attachments INTEGER DEFAULT 0,
      message_type TEXT, metadata TEXT, associated_message_type INTEGER,
      associated_message_guid TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- BACKLOG-2796: production has this and the 2790 suites do not. Without it
    -- a duplicated GUID is just a second row, and every control below that turns
    -- on "the swap would collide" would pass against code that collides.
    CREATE UNIQUE INDEX idx_messages_user_external_id
      ON messages(user_id, external_id) WHERE external_id IS NOT NULL;
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, message_id TEXT, external_message_id TEXT, filename TEXT,
      mime_type TEXT, file_size_bytes INTEGER, storage_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- BACKLOG-2790 control 4: the unrelated writer. Shaped like the real
    -- audit_logs columns this test writes; the point is that it is a DIFFERENT
    -- table on the SAME connection.
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, user_id TEXT, action TEXT, synced_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/** Every stored message id, sorted — the identity set, never a count. */
function storedIds(): string[] {
  return (mockDb.prepare("SELECT id FROM messages").all() as Array<{ id: string }>)
    .map((r) => r.id)
    .sort();
}

/** Every stored attachment id, sorted. */
function storedAttachmentIds(): string[] {
  return (mockDb.prepare("SELECT id FROM attachments").all() as Array<{ id: string }>)
    .map((r) => r.id)
    .sort();
}

/** Every stored message by identity — internal row id AND macOS guid. */
function storedRowIdentities(): Array<{ id: string; external_id: string }> {
  return (
    mockDb
      .prepare("SELECT id, external_id FROM messages")
      .all() as Array<{ id: string; external_id: string }>
  ).sort((a, b) => a.external_id.localeCompare(b.external_id));
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

  homeDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-2796-home-"));
  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-2796-app-"));
  await fs.mkdir(nodePath.join(homeDir, "Library", "Messages"), { recursive: true });
  createSourceDb(nodePath.join(homeDir, "Library", "Messages", "chat.db"));

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


/**
 * Rows written by the OTHER two services that insert into `messages`, in the
 * shape their producers actually write them.
 *
 * Transcribed, not invented — `localSyncService.storeMessages` and
 * `iPhoneSyncStorageService` both build a row object and hand it to
 * `syncDbService.batchInsertMessages`, so the field values below are that
 * object's fields: channel, the external_id each derives, the `thread_id`
 * prefix each uses, and the `metadata` JSON each stamps with its own `source`.
 * The email row is the exception and is labelled as one: no producer in the repo
 * writes `channel = 'email'` into `messages` today, but the CHECK constraint
 * admits it, `messageMatchingService` queries for it, and the item names those
 * rows among the casualties — so it is seeded per the schema.
 */
function seedForeignProvenanceRows(): void {
  const insert = mockDb.prepare(`
    INSERT INTO messages (
      id, user_id, channel, external_id, direction, body_text,
      participants, participants_flat, thread_id, sent_at, has_attachments,
      message_type, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // localSyncService.storeMessages: channel "sms", external_id = sha256 of
  // `sender|timestamp|body`, thread_id `android-thread-<id>`, message_type "text".
  insert.run(
    "android-row",
    USER,
    "sms",
    "3f2a9c4e5b6d7180a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
    "inbound",
    "sent from the pixel",
    JSON.stringify({ from: "15550142", to: ["me"] }),
    "15550142",
    "android-thread-12",
    "2026-05-01T10:00:00.000Z",
    0,
    "text",
    JSON.stringify({
      source: "android_wifi_sync",
      deviceId: "pixel-7",
      androidThreadId: 12,
      originalSender: "+1 (555) 555-0142",
    })
  );

  // iPhoneSyncStorageService: external_id = msg.guid — the SAME Apple GUID space
  // chat.db uses — thread_id `ios-chat-<id>`.
  insert.run(
    "iphone-row",
    USER,
    "imessage",
    "iphone-only-guid-A",
    "outbound",
    "sent from the phone",
    JSON.stringify({ from: "me", to: ["+15550100"] }),
    "15550100",
    "ios-chat-4",
    "2026-05-02T10:00:00.000Z",
    0,
    "text",
    JSON.stringify({
      source: "iphone_sync",
      originalId: 9001,
      dateRead: null,
      dateDelivered: null,
      attachmentCount: 0,
    })
  );

  // Schema-permitted, no current producer (labelled).
  insert.run(
    "email-row",
    USER,
    "email",
    "gmail-thread-1:msg-1",
    "inbound",
    "the signed addendum is attached",
    JSON.stringify({ from: "agent@example.com", to: ["me"] }),
    "agent@example.com",
    "gmail-thread-1",
    "2026-05-03T10:00:00.000Z",
    0,
    null,
    null
  );

  // Also schema-permitted with no current producer: `metadata` is nullable, and
  // `json_valid(NULL)` is NULL rather than 0. This row is what makes the
  // COALESCE in SURVIVING_MESSAGES load-bearing rather than decorative.
  insert.run(
    "null-metadata-row",
    USER,
    "imessage",
    "legacy-guid-B",
    "inbound",
    "a row from before metadata was written",
    JSON.stringify({ from: "+15550100", to: ["me"] }),
    "15550100",
    null,
    "2026-05-04T10:00:00.000Z",
    0,
    null,
    null
  );
}

const FOREIGN_IDS = ["android-row", "email-row", "iphone-row", "null-metadata-row"];

/** The swap's "a staged row stood down" reports, as the service emitted them. */
function yieldReports(): string[] {
  return (logService.warn as jest.Mock).mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes("yielded"));
}

beforeEach(() => {
  (logService.warn as jest.Mock).mockClear();
});

describe("BACKLOG-2796 — what a macOS force re-import is allowed to replace", () => {
  it("rebuilds its own rows and leaves every other source's rows exactly where they were", async () => {
    // THE DEFECT, as an exact identity set on the SUCCESS path.
    //
    // MUTATION: delete the provenance clause from FORCE_SET_MESSAGES (leaving
    // the channel scope) and `android-row` + `iphone-row` vanish from the
    // survivors — the founder's Android SMS, deleted by a macOS button. Delete
    // the channel scope as well and `email-row` goes with them.
    seedForeignProvenanceRows();
    const seed = await importToCompletion();
    expect(seed.messagesImported).toBe(MESSAGE_COUNT);

    const macOSIdsBefore = storedRowIdentities()
      .filter((r) => r.external_id.startsWith("msg-guid-"))
      .map((r) => r.id);
    expect(macOSIdsBefore).toHaveLength(MESSAGE_COUNT);

    const result = await importToCompletion(true);
    expect(result.success).toBe(true);
    expect(result.messagesImported).toBe(MESSAGE_COUNT);

    const after = storedRowIdentities();

    // 1. Every foreign row is still there, by id.
    expect(after.filter((r) => FOREIGN_IDS.includes(r.id)).map((r) => r.id).sort()).toEqual(
      FOREIGN_IDS
    );

    // 2. The macOS rows were genuinely REBUILT, not merely left alone: same
    //    GUIDs, all-new row ids. Without this the test would pass for a force
    //    re-import that deleted nothing and imported nothing.
    const macOSAfter = after.filter((r) => r.external_id.startsWith("msg-guid-"));
    expect(macOSAfter).toHaveLength(MESSAGE_COUNT);
    expect(macOSAfter.map((r) => r.external_id)).toEqual(
      macOSIdsBefore.map((_, n) => `msg-guid-${n + 1}`).sort()
    );
    expect(macOSAfter.some((r) => macOSIdsBefore.includes(r.id))).toBe(false);

    // 3. Nothing else appeared or disappeared.
    expect(after).toHaveLength(MESSAGE_COUNT + FOREIGN_IDS.length);
  });

  it("leaves them alone on the cancel path too — the swap that never ran took nothing", async () => {
    // The other exit. BACKLOG-2790 made cancellation leave the store untouched;
    // this asserts the scoped force set does not quietly reintroduce a delete on
    // the way out.
    seedForeignProvenanceRows();
    await importToCompletion();
    const before = storedIds();

    let cancelSent = false;
    const result = await macOSMessagesImportService.importMessages(
      USER,
      (progress) => {
        if (!cancelSent && progress.phase === "importing" && progress.current >= 1) {
          cancelSent = true;
          macOSMessagesImportService.requestCancellation();
        }
      },
      testImportPlan({
        mode: "reprocess",
        storedFilters: { lookbackMonths: null, maxMessages: null },
      })
    );

    expect(cancelSent).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(storedIds()).toEqual(before);
  });

  it("deduplicates against a survivor that holds one of chat.db's own GUIDs, attachment and all", async () => {
    // THE SECOND HALF OF THE FIX. An iPhone-synced row can hold a GUID that is
    // ALSO in this Mac's chat.db — same Apple id space — and once such a row
    // survives a force re-import, a rebuild that deduplicates only against its
    // own staging table stages that GUID again.
    //
    // MUTATIONS, and they are TWO STEPS — measured, because an earlier version
    // of this comment claimed the second one's result for the first:
    //
    //   1. Point the dedup read in `storeMessages` back at the staging table
    //      alone, leaving the rest of this PR in place: RED here, but on the
    //      LAST assertion only — `result.success` stays TRUE. The swap's yield
    //      filter catches the collision, so the store ends up correct and the
    //      only trace is a report claiming the row "arrived from another source
    //      mid-run" about one that had been there all along. That is why this
    //      test asserts the yield count and not just the rows: the two designs
    //      leave an identical table behind.
    //   2. Remove the yield filter from `insertFromStaging` as well — which is
    //      the shape of the code BEFORE this PR — and it goes red on
    //      `result.success` being false: the plain INSERT hits
    //      `idx_messages_user_external_id`, the swap rolls back, and the whole
    //      force re-import fails for exactly the users who have both an iPhone
    //      sync and a Mac.
    //
    // So the outright break belongs to pre-PR code. The union alone is what
    // keeps this from being a rebuild that stages work it will throw away.
    const sharedGuid = "msg-guid-7";
    seedForeignProvenanceRows();
    mockDb
      .prepare(
        `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, metadata)
         VALUES (?, ?, 'imessage', ?, 'inbound', 'the phone got here first', ?)`
      )
      .run("iphone-shared-guid", USER, sharedGuid, JSON.stringify({ source: "iphone_sync" }));
    mockDb
      .prepare(
        `INSERT INTO attachments (id, message_id, external_message_id, filename, storage_path)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("att-iphone-shared", "iphone-shared-guid", sharedGuid, "beach.jpg", "/store/ccc.jpg");

    // The delta import skips the shared GUID, exactly as it would in the field.
    const seed = await importToCompletion();
    expect(seed.messagesImported).toBe(MESSAGE_COUNT - 1);

    const result = await importToCompletion(true);
    expect(result.success).toBe(true);

    const after = storedRowIdentities();
    // The survivor is still the one holding that GUID, and it is the ONLY row
    // holding it. A count would not distinguish "kept" from "replaced".
    expect(after.filter((r) => r.external_id === sharedGuid).map((r) => r.id)).toEqual([
      "iphone-shared-guid",
    ]);
    expect(after).toHaveLength(MESSAGE_COUNT + FOREIGN_IDS.length);
    // Its attachment rode along: the force set's attachment predicates are
    // derived from the message predicate, so scoping one scoped the other.
    expect(storedAttachmentIds()).toContain("att-iphone-shared");

    // AND NOTHING HAD TO STAND DOWN. This is the assertion that separates the
    // two halves of the fix, because the rows in the table look identical
    // either way: the swap's yield is a net for a mid-run arrival, and if the
    // rebuild's dedup read is doing its job it never has to catch anything
    // here. Point that read back at the staging table alone and the GUID gets
    // staged, the message's text is extracted and its attachments copied, and
    // all of it is thrown away at the swap — under a warning that says the row
    // "arrived from another source mid-run", which would be false.
    expect(yieldReports()).toEqual([]);
  });

  it("yields to a foreign row that arrives MID-RUN with a GUID this run already staged", async () => {
    // The residue, and it is reachable: neither `localSyncService` (an inbound
    // HTTP handler) nor `iPhoneSyncStorageService` is behind
    // `forceReimportInProgress`, so a foreign write can land AFTER this run's
    // dedup read and BEFORE its swap. Only iPhone sync can collide — Android's
    // external_ids are sha256 digests, a disjoint space.
    //
    // The swap yields that one row to the arrival rather than failing the whole
    // re-import. MUTATION: drop the yield filter from `insertFromStaging` and
    // this goes red — UNIQUE constraint, `rolledBack`, nothing imported.
    seedForeignProvenanceRows();
    await importToCompletion();

    const collidingGuid = "msg-guid-3";
    // The collision needs a GUID chat.db holds and the STORE does not — a text
    // that arrived since the last delta import. Removing the row is how this
    // fixture reaches that state; the state itself is ordinary. With the row
    // still present the mid-run write is a no-op anyway, because
    // `syncDbService.batchInsertMessages` is an INSERT OR IGNORE against the
    // same unique index — which is worth knowing: the window is narrower than
    // "any concurrent sync", it needs a message neither side has stored yet.
    mockDb.prepare("DELETE FROM messages WHERE external_id = ?").run(collidingGuid);

    let arrived = false;
    const result = await macOSMessagesImportService.importMessages(
      USER,
      (progress) => {
        if (!arrived && progress.phase === "importing" && progress.current >= MESSAGE_COUNT) {
          // A phone sync landing while the rebuild is in flight, writing the row
          // the way `syncDbService.batchInsertMessages` writes it.
          arrived = true;
          mockDb
            .prepare(
              `INSERT OR IGNORE INTO messages (id, user_id, channel, external_id, direction, body_text, metadata)
               VALUES (?, ?, 'imessage', ?, 'inbound', 'arrived mid-run', ?)`
            )
            .run(
              "iphone-mid-run",
              USER,
              collidingGuid,
              JSON.stringify({ source: "iphone_sync", originalId: 4242 })
            );
        }
      },
      testImportPlan({
        mode: "reprocess",
        storedFilters: { lookbackMonths: null, maxMessages: null },
      })
    );

    expect(arrived).toBe(true);
    expect(result.success).toBe(true);
    expect(result.rolledBack).toBeUndefined();

    const after = storedRowIdentities();
    expect(after.filter((r) => r.external_id === collidingGuid).map((r) => r.id)).toEqual([
      "iphone-mid-run",
    ]);
    // One staged row stood down; everything else was rebuilt.
    expect(after.filter((r) => r.external_id.startsWith("msg-guid-"))).toHaveLength(MESSAGE_COUNT);
    expect(after).toHaveLength(MESSAGE_COUNT + FOREIGN_IDS.length);

    // Counted and reported, not dropped quietly — exactly one row, and the
    // report says so.
    expect(yieldReports()).toHaveLength(1);
    expect(yieldReports()[0]).toContain("yielded 1 staged message(s)");
  });
});
