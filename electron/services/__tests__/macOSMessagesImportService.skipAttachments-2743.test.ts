/**
 * @jest-environment node
 *
 * BACKLOG-2743 — "import without attachments", on the main side.
 *
 * This is the only exit from a space refusal that actually imports anything, and
 * until now nothing asserted it below the renderer: the checkbox and the
 * persisted preference were covered, and the handler passes the flag through,
 * but the service branch that acts on it
 * (`filters?.skipAttachments ? [] : await dbAll(...)`) was verified nowhere.
 *
 * The property that matters is BOTH halves at once: zero attachment files
 * copied, AND the messages still imported. A flag that quietly skipped the
 * messages too would satisfy "no attachments were copied" and be useless.
 *
 * Drives the REAL importMessages against a recording fake for chat.db and a real
 * better-sqlite3 app database, so the assertion is about the SQL the service
 * actually issues, not about a reimplementation of its logic.
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
/** Every SQL string the service issued against chat.db, in order. */
let issuedSql: string[] = [];

// The import early-returns off darwin, and CI runs a Windows leg. `os.platform`
// is a non-configurable property so it cannot be spied — mock the module.
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
      start: jest.fn(),
      update: jest.fn(),
      increment: jest.fn(),
      stop: jest.fn(),
    })),
    Presets: { shades_classic: {} },
  },
}));

// Recording fake for chat.db. Dispatches on the SQL text so the service's real
// query sequence runs unchanged.
jest.mock("../db/readOnlySqlite", () => ({
  __esModule: true,
  openSqliteReadOnly: jest.fn(async () => ({
    all: jest.fn(async (sql: string) => {
      issuedSql.push(sql);
      if (sql.includes("FROM attachment")) return attachmentRows();
      if (sql.includes("chat_handle_join")) return [];
      if (sql.includes("account_login")) return [];
      if (sql.includes("COUNT(*)")) return [{ count: 2 }];
      return messageRows();
    }),
    get: jest.fn(async () => ({ count: 2 })),
    close: jest.fn(async () => undefined),
  })),
}));

import { app } from "electron";
import macOSMessagesImportService from "../macOSMessagesImportService";
// BACKLOG-2772: plans are built by the REAL resolver, never hand-written.
import { testImportPlan } from "./helpers/importPlanFixture";
import { ATTACHMENTS_DIR } from "../macOSMessagesImportService/types";
import type { RawMacMessage, RawMacAttachment } from "../macOSMessagesImportService/types";

const USER = "user-skip-2743";
let sourceDir: string;
let scratchDir: string;
/** Set once the fixture file exists; read lazily by the chat.db fake. */
let attachmentSourcePath = "";

function messageRows(): RawMacMessage[] {
  return [1, 2].map((i) => ({
    id: i,
    guid: `msg-guid-${i}`,
    text: `hello ${i}`,
    attributedBody: null,
    date: 700000000 * 1e9 + i,
    is_from_me: 0,
    handle_id: "+15550100",
    service: "iMessage",
    chat_id: 1,
    cache_has_attachments: i === 1 ? 1 : 0,
    associated_message_type: null,
    associated_message_guid: null,
  }));
}

function attachmentRows(): RawMacAttachment[] {
  return [
    {
      attachment_id: 1,
      message_id: 1,
      message_guid: "msg-guid-1",
      guid: "att-1",
      filename: attachmentSourcePath,
      mime_type: null,
      transfer_name: "photo.jpg",
      total_bytes: 40_000,
      is_outgoing: 0,
    },
  ];
}

function createSchema(db: DatabaseType): void {
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

async function filesInAttachmentsDir(): Promise<string[]> {
  try {
    return await fs.readdir(nodePath.join(scratchDir, ATTACHMENTS_DIR));
  } catch {
    return [];
  }
}

beforeEach(async () => {
  issuedSql = [];
  mockDb = new Database(":memory:");
  createSchema(mockDb);

  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-skip-app-"));
  sourceDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-skip-src-"));
  attachmentSourcePath = nodePath.join(sourceDir, "photo.jpg");
  await fs.writeFile(attachmentSourcePath, "x".repeat(40_000));

  (app.getPath as jest.Mock).mockImplementation((name: string) =>
    name === "userData" ? scratchDir : `/tmp/test-${name}`,
  );
  // Plenty of room — this suite is about the flag, not the space guard.
  jest.spyOn(fsSync.promises, "statfs").mockResolvedValue({
    type: 26, bsize: 4096, blocks: 1e9, bfree: 5e7, bavail: 5e7, files: 10, ffree: 10,
  } as fsSync.StatsFs);
});

afterEach(async () => {
  jest.restoreAllMocks();
  mockDb?.close();
  await fs.rm(scratchDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

describe("BACKLOG-2743 — import without attachments (service branch)", () => {
  it("copies no attachment files AND still imports the messages", async () => {
    const result = await macOSMessagesImportService.importMessages(
      USER,
      undefined,
      testImportPlan({
        mode: "delta",
        storedFilters: { lookbackMonths: null, maxMessages: null, skipAttachments: true },
      }),
    );

    expect(result.success).toBe(true);

    // Both halves of the property. The messages import...
    expect(result.messagesImported).toBe(2);
    const storedMessages = mockDb
      .prepare("SELECT external_id FROM messages ORDER BY external_id")
      .all() as { external_id: string }[];
    expect(storedMessages.map((m) => m.external_id)).toEqual(["msg-guid-1", "msg-guid-2"]);

    // ...and not one attachment file or row is written.
    expect(result.attachmentsImported).toBe(0);
    expect(result.attachmentsSkippedByChoice).toBe(true);
    expect(await filesInAttachmentsDir()).toEqual([]);
    const attachmentCount = mockDb
      .prepare("SELECT COUNT(*) as c FROM attachments")
      .get() as { c: number };
    expect(attachmentCount.c).toBe(0);

    // The attachment query is never even issued — skipped at the source, not
    // fetched and then discarded.
    expect(issuedSql.some((sql) => sql.includes("FROM attachment"))).toBe(false);
  });

  it("DOES query and copy attachments when the flag is not set", async () => {
    // Control for the assertions above: without this, "no attachment SQL" and
    // "no files written" would both be green for an import that was broken
    // outright rather than one honoring the flag.
    const result = await macOSMessagesImportService.importMessages(
      USER,
      undefined,
      testImportPlan({
        mode: "delta",
        storedFilters: { lookbackMonths: null, maxMessages: null, skipAttachments: false },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.messagesImported).toBe(2);
    expect(issuedSql.some((sql) => sql.includes("FROM attachment"))).toBe(true);
    expect(result.attachmentsImported).toBe(1);
    expect(await filesInAttachmentsDir()).toHaveLength(1);
    expect(result.attachmentsSkippedByChoice).toBeUndefined();
  });

  it("treats an absent skipAttachments preference as 'import attachments'", async () => {
    // Prior behavior must be preserved for every existing user, whose stored
    // preferences carry no such key.
    const result = await macOSMessagesImportService.importMessages(
      USER,
      undefined,
      testImportPlan({
        mode: "delta",
        storedFilters: { lookbackMonths: null, maxMessages: null },
      }),
    );

    expect(issuedSql.some((sql) => sql.includes("FROM attachment"))).toBe(true);
    expect(result.attachmentsImported).toBe(1);
  });
});
