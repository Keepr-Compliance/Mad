/**
 * @jest-environment node
 *
 * BACKLOG-2775 — force re-import, cancelled, against the REAL sqlite drivers.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS, SEPARATELY FROM THE MOCKED ONE
 * ---------------------------------------------------------------------------
 * The founder ran a force re-import on a dev build and pressed Cancel ~1.2s in.
 * The atomicity held — the store rolled back and the background writers resumed
 * — but the run surfaced as a RED "Import failed: SQLITE_MISUSE: Database is
 * closed" card instead of the calm "nothing changed" result, because the cancel
 * exit path itself threw.
 *
 * `macOSMessagesImportService.cancel-2748.test.ts` covers this exact sequence
 * and stayed green through it, because it mocks `openSqliteReadOnly` and its
 * fake `close` is a `jest.fn()` — idempotent by construction. The real handle is
 * `promisify(db.close.bind(db))` from node-sqlite3, and closing it twice REJECTS.
 * A mock cannot produce the failure, so no amount of mocked coverage could have
 * caught it. This suite therefore drives:
 *
 *   - a REAL `~/Library/Messages/chat.db` (a temp file with the real schema,
 *     reached by pointing HOME at a temp directory — nothing under the founder's
 *     real ~/Library is opened, read, or written), through the REAL
 *     `openSqliteReadOnly`; and
 *   - a REAL better-sqlite3 application database.
 *
 * The only mocks are the ones that would otherwise reach the network, the
 * filesystem outside the temp tree, or the founder's machine.
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
  default: {
    suspendPeriodicSync: jest.fn(() => false),
    resumePeriodicSync: jest.fn(),
    isSyncInFlight: jest.fn(() => false),
  },
}));

// DELIBERATELY NOT MOCKED: ../db/readOnlySqlite. It is the producer under test.
//
// But `jest.config.js` maps `^sqlite3$` to `tests/__mocks__/sqlite3.js`, whose
// `all` calls back `[]` for every query and whose `close` is a bare `jest.fn()`.
// Against that stub this suite would import zero messages and could never
// double-close anything — it would pass just as happily against the broken code.
// Resolving the real driver by absolute path is the pattern `readOnlySqlite.test.ts`
// and `contactsService.addressBooks.test.ts` established for exactly this reason.
//
// Found the hard way: the first version of this suite omitted this and "passed"
// its way to a seed import of 0 messages.
jest.mock("sqlite3", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(
    require("path").join(__dirname, "..", "..", "..", "node_modules", "sqlite3"),
  ),
);

import { app } from "electron";
import macOSMessagesImportService from "../macOSMessagesImportService";
// BACKLOG-2772: plans are built by the REAL resolver, never hand-written.
import { testImportPlan } from "./helpers/importPlanFixture";
import type { MacOSImportResult } from "../macOSMessagesImportService/types";

const USER = "user-real-driver-2775";
const MESSAGE_COUNT = 150; // > BATCH_SIZE (100), so the cancel lands between batches

let homeDir: string;
let scratchDir: string;
let realHome: string | undefined;

/**
 * The subset of the macOS Messages schema the import actually queries.
 * Transcribed from the SQL in `macOSMessagesImportService.doImport` rather than
 * invented: every table and column below appears in one of its statements.
 * `ROWID` is left implicit, as it is in the real chat.db.
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
    -- BACKLOG-2814: display_name is ALWAYS a column of Apple's real `chat`
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
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, message_id TEXT, external_message_id TEXT, filename TEXT,
      mime_type TEXT, file_size_bytes INTEGER, storage_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
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
    // BACKLOG-2772: `force` is now the plan's MODE. Both modes cover the same
    // window (D2'), which is why the same filters serve both here.
    testImportPlan({
      mode: force ? "reprocess" : "delta",
      storedFilters: { lookbackMonths: null, maxMessages: null },
    }),
  );
}

beforeEach(async () => {
  mockDb = new Database(":memory:");
  createStoreSchema(mockDb);

  homeDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-real-home-"));
  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-real-app-"));
  await fs.mkdir(nodePath.join(homeDir, "Library", "Messages"), { recursive: true });
  createSourceDb(nodePath.join(homeDir, "Library", "Messages", "chat.db"));

  // The service builds the source path from HOME. Pointing it at the temp tree
  // is what keeps this suite away from the founder's real ~/Library.
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

describe("BACKLOG-2775 — a cancelled force re-import against the real drivers", () => {
  it("returns the rolled-back result rather than throwing SQLITE_MISUSE", async () => {
    // The founder's sequence, end to end.
    const seed = await importToCompletion();
    expect(seed.messagesImported).toBe(MESSAGE_COUNT);
    const before = storedRowIdentities();
    expect(before).toHaveLength(MESSAGE_COUNT);

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
      }),
    );

    // What the founder saw instead: the cancel exit's own `close()` rejected
    // with "SQLITE_MISUSE: Database is closed", that rejection replaced the
    // cancellation result, and the orchestrator turned it into a red
    // "Import failed" card because no `cancelled` flag accompanies a thrown
    // error.
    //
    // The load-bearing assertions are the POSITIVE ones below. A regex on the
    // message is not enough on its own: jest's realm boundary makes the rethrown
    // driver error fail `instanceof Error` inside this suite, so the broken code
    // reports the generic "Unknown error" here while the real app reports the
    // SQLITE_MISUSE text the founder saw. Asserting what the result must BE
    // catches both.
    expect(result.error).toBe("Import cancelled");
    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(result.messagesImported).toBe(0);

    // The atomicity itself held throughout the incident and must still hold.
    expect(storedRowIdentities()).toEqual(before);
  });

  it("CONTROL: the same force re-import uncancelled commits against the real drivers", async () => {
    // Distinguishing input: without this, the test above would be equally green
    // for a force path that could not read the real chat.db at all.
    await importToCompletion();
    const before = storedRowIdentities();

    const result = await importToCompletion(true);

    expect(result.success).toBe(true);
    expect(result.cancelled).toBeUndefined();
    expect(result.rolledBack).toBeUndefined();
    expect(result.messagesImported).toBe(MESSAGE_COUNT);

    const after = storedRowIdentities();
    expect(after.map((r) => r.external_id)).toEqual(before.map((r) => r.external_id));
    // Genuinely re-created: not one internal id survives.
    expect(after.filter((r) => before.some((b) => b.id === r.id))).toEqual([]);
  });

  it("surfaces a real failure as itself, not as SQLITE_MISUSE", async () => {
    // The same double-close masked errors long before this feature existed, and
    // still would: the source handle is closed as soon as the last source query
    // runs, so ANYTHING thrown afterwards reaches the inner `catch`, which closes
    // again — and that rejection replaces the real error. A disk failure in
    // `storeMessages` reported itself as "Database is closed".
    //
    // Pre-existing rather than introduced by BACKLOG-2775, and closed by the
    // same idempotent close. Only visible against the real driver.
    const storeSpy = jest
      .spyOn(
        macOSMessagesImportService as unknown as {
          storeMessages: () => Promise<unknown>;
        },
        "storeMessages",
      )
      .mockRejectedValue(new Error("disk I/O error"));

    const result = await importToCompletion(true);

    expect(result.success).toBe(false);
    expect(result.error).toBe("disk I/O error");
    expect(result.error).not.toMatch(/SQLITE_MISUSE/);
    // The force run still rolled back, and says so.
    expect(result.rolledBack).toBe(true);

    storeSpy.mockRestore();
  });

  it("a cancelled DELTA import against the real drivers keeps its partial progress", async () => {
    // The scope line, re-asserted where the close ordering is real: only the
    // force path is atomic.
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
        mode: "delta",
        storedFilters: { lookbackMonths: null, maxMessages: null },
      }),
    );

    // No error at all: a delta cancel is a clean partial finish, and the close
    // that used to reject on this path is now idempotent.
    expect(result.error ?? "").not.toMatch(/SQLITE_MISUSE/);
    expect(result.error).toBeUndefined();
    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBeUndefined();
    expect(result.messagesImported).toBeGreaterThan(0);
    expect(storedRowIdentities()).toHaveLength(result.messagesImported);
  });
});
