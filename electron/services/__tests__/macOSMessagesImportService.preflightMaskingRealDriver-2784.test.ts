/**
 * @jest-environment node
 *
 * BACKLOG-2784 — the import PRE-FLIGHT reports its real errors, against the
 * REAL sqlite drivers.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS, SEPARATELY FROM THE MOCKED ONES
 * ---------------------------------------------------------------------------
 * `getAvailableMessageCount` is what the Settings panel runs before every
 * import: it is the first place a genuine failure — a locked source database, a
 * disk fault — becomes a sentence the user reads and a Sentry event someone
 * triages. It carried the same double-close shape BACKLOG-2775 fixed on the
 * import path: a raw `const dbClose = db.close`, closed on the success path as
 * soon as the last source query ran, and closed AGAIN by the inner `catch`.
 *
 * `ReadOnlySqliteHandle.close` is `promisify(db.close.bind(db))` from
 * node-sqlite3 and a second close REJECTS, so that rejection REPLACED whatever
 * had actually gone wrong. Every real failure in the tail of this method
 * reported itself as `SQLITE_MISUSE: Database is closed`.
 *
 * No mocked suite can catch it — a `jest.fn()` close is idempotent by
 * construction, so the broken code passes mocked coverage happily. This suite
 * therefore drives a REAL `~/Library/Messages/chat.db` (a temp file with the
 * real schema, reached by pointing HOME at a temp directory — nothing under the
 * founder's real ~/Library is opened, read, or written) through the REAL
 * `openSqliteReadOnly`, and a REAL better-sqlite3 application database.
 *
 * Harness transcribed from `macOSMessagesImportService.forceCancelRealDriver-2775.test.ts`,
 * which established this pattern for the same defect class.
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
jest.mock("cli-progress", () => ({
  __esModule: true,
  default: {
    SingleBar: jest.fn().mockImplementation(() => ({
      start: jest.fn(), update: jest.fn(), increment: jest.fn(), stop: jest.fn(),
    })),
    Presets: { shades_classic: {} },
  },
}));

// DELIBERATELY NOT MOCKED: ../db/readOnlySqlite. It is the producer under test.
//
// `jest.config.js` maps `^sqlite3$` to `tests/__mocks__/sqlite3.js`, whose
// `close` is a bare `jest.fn()` — idempotent, so against that stub this suite
// would pass just as happily against the broken code. Resolving the real driver
// by absolute path is the pattern `readOnlySqlite.test.ts` and the BACKLOG-2775
// suite established for exactly this reason.
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

const MESSAGE_COUNT = 12;

let homeDir: string;
let scratchDir: string;
let realHome: string | undefined;

/**
 * The subset of the macOS Messages schema the pre-flight actually queries.
 * Transcribed from the SQL in `getAvailableMessageCount` rather than invented:
 * every table and column below appears in one of its statements.
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
    CREATE TABLE chat (account_login TEXT);
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

  // One real attachment row, so the attachment-sizing query — the LAST source
  // query, and therefore the one immediately before the close — returns rows
  // rather than trivially short-circuiting.
  db.prepare(
    `INSERT INTO attachment (guid, filename, mime_type, transfer_name, total_bytes, is_outgoing)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run("att-1", "/tmp/photo.jpg", "image/jpeg", "photo.jpg", 1024);
  db.prepare(
    "INSERT INTO message_attachment_join (attachment_id, message_id) VALUES (1, 1)",
  ).run();

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

beforeEach(async () => {
  mockDb = new Database(":memory:");
  createStoreSchema(mockDb);

  homeDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-preflight-home-"));
  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-preflight-app-"));
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

describe("BACKLOG-2784 — the pre-flight surfaces its real error, not SQLITE_MISUSE", () => {
  it("reports a failure from the post-close tail as ITSELF", async () => {
    // WHERE THE FAILURE IS INJECTED, AND WHY HERE.
    //
    // The success path closes the source handle as soon as the attachment
    // sizing query returns, and a good deal of work still follows: the
    // stored-attachment read, the estimate, and the disk verdict — which begins
    // with `app.getPath("userData")`. That call is the injectable seam in the
    // post-close tail, and it stands in for any genuine failure there. Electron
    // throws from `getPath` for real reasons (an unavailable path, a call made
    // before the app is ready); what is under test is not this particular
    // thrower but whether ANYTHING thrown after the first close can still be
    // read by the person who has to act on it.
    (app.getPath as jest.Mock).mockImplementation(() => {
      throw new Error("EIO: i/o error, statfs");
    });

    const result = await macOSMessagesImportService.getAvailableMessageCount(
      testImportPlan({ storedFilters: { lookbackMonths: null, maxMessages: null } }),
    );

    expect(result.success).toBe(false);
    // The whole point: the cause the user and Sentry are given is the real one.
    //
    // The LOAD-BEARING assertion is the positive one. The two negatives below
    // read well but cannot fail in this harness: node-sqlite3 builds its
    // SQLITE_MISUSE rejection in the driver's realm, so `instanceof Error` is
    // false here and the masked result collapses to "Unknown error" — verified
    // by mutation (revert the idempotent close and this test reds on the
    // toBe, reporting "Unknown error"). In the real app that same path is the
    // SQLITE_MISUSE text the founder was shown. Asserting what the result must
    // BE catches both; asserting only what it must not CONTAIN would catch
    // neither.
    expect(result.error).toBe("EIO: i/o error, statfs");
    expect(result.error).not.toMatch(/SQLITE_MISUSE/);
    expect(result.error).not.toMatch(/Database is closed/);
  });

  it("CONTROL: the same pre-flight succeeds against the real drivers when nothing fails", async () => {
    // Distinguishing input. Without this, the test above would be equally green
    // for a pre-flight that could not open the real chat.db at all, never
    // reached its close, and failed for some unrelated reason.
    const result = await macOSMessagesImportService.getAvailableMessageCount(
      testImportPlan({ storedFilters: { lookbackMonths: null, maxMessages: null } }),
    );

    expect(result.success).toBe(true);
    expect(result.count).toBe(MESSAGE_COUNT);
    // Proof the run reached the post-close tail — the region whose errors were
    // being masked — rather than stopping at the first query.
    expect(result.attachmentCount).toBe(1);
    expect(result.attachmentBytes).toBe(1024);
    expect(result.availableDiskBytes).toBe(4096 * 5e7);
    expect(result.fitsOnDisk).toBe(true);
  });

  it("REGRESSION GUARD: a failure at OPEN still fails at open, and never reaches the tail", async () => {
    // The other half of the boundary: the wrapper must not change the path
    // where the handle was never opened in the first place.
    //
    // HONEST LIMIT OF THIS ASSERTION. The error text cannot be pinned here.
    // node-sqlite3 constructs its error in the driver's realm, so
    // `error instanceof Error` is FALSE inside jest's realm and the method's
    // own `instanceof` check collapses it to "Unknown error" — the same realm
    // artifact the BACKLOG-2775 suite documents. That collapse is a property of
    // this harness, not of the app, so this test asserts the realm-safe facts
    // instead of a message: it failed, and it failed EARLY.
    await fs.rm(nodePath.join(homeDir, "Library", "Messages", "chat.db"), { force: true });

    const result = await macOSMessagesImportService.getAvailableMessageCount(
      testImportPlan({ storedFilters: { lookbackMonths: null, maxMessages: null } }),
    );

    expect(result.success).toBe(false);
    // Never reached the post-close tail — every field the tail produces is
    // absent. This is what separates an open failure from a masked tail failure
    // without depending on the message.
    expect(result.count).toBeUndefined();
    expect(result.attachmentBytes).toBeUndefined();
    expect(result.attachmentCount).toBeUndefined();
    expect(result.fitsOnDisk).toBeUndefined();
  });
});
