/**
 * @jest-environment node
 *
 * BACKLOG-2748 — cancelling a running import, on the main side.
 *
 * The founder hit this live, 707,842 messages in: there was no way to stop an
 * import short of force-quitting the app. The cancellation machinery existed the
 * whole time (`requestCancellation()`, the abort checks in both loops, the
 * `messages:import-cancel` handler) — nothing called it, so nothing had ever
 * proven it worked either.
 *
 * Three properties, each asserted by IDENTITY (which guids, which attachments)
 * rather than by count, and each with a stated mutation that reds it:
 *
 *   1. Cancel mid-MESSAGES stops the batch loop. Mutation: delete the abort
 *      check at the top of the `for (batchNum...)` loop -> all 500 store.
 *   2. Cancel mid-ATTACHMENTS stops the file copies. This is the one that
 *      matters in practice — the attachment phase is where the disk fills.
 *      Mutation: delete the abort check at the top of
 *      `for (const attachment of attachments)` -> all 12 files copy.
 *   3. A cancelled run does not poison the next one: re-importing after a cancel
 *      finishes normally and yields the FULL corpus, because guid dedup absorbs
 *      the partial rows.
 *
 * Each cancelling test is paired with the same fixture run to completion, so
 * "only 100 stored" cannot pass by way of an import that was broken outright.
 *
 * Drives the REAL `importMessages` against a recording fake for chat.db and a
 * real better-sqlite3 app database — the cancel is requested from inside the
 * progress callback, i.e. at a genuine point mid-run, not by poking internals.
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
/** Number of messages the chat.db fake serves for the current test. */
let messageCount = 0;
/** Number of attachments the chat.db fake serves for the current test. */
let attachmentCount = 0;

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
// query sequence runs unchanged, and HONOURS the cursor pagination parameters
// (`ROWID > ?`, `LIMIT ?`) so the fetch loop behaves as it does against the real
// database rather than being handed the whole corpus in one gulp.
jest.mock("../db/readOnlySqlite", () => ({
  __esModule: true,
  openSqliteReadOnly: jest.fn(async () => ({
    all: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM attachment")) return attachmentRows();
      if (sql.includes("chat_handle_join")) return [];
      if (sql.includes("account_login")) return [];
      if (sql.includes("COUNT(*)")) return [{ count: messageCount }];
      const afterRowId = typeof params?.[0] === "number" ? (params[0] as number) : 0;
      const limit = typeof params?.[1] === "number" ? (params[1] as number) : messageCount;
      return messageRows()
        .filter((row) => row.id > afterRowId)
        .slice(0, limit);
    }),
    get: jest.fn(async () => ({ count: messageCount })),
    close: jest.fn(async () => undefined),
  })),
}));

import { app } from "electron";
import macOSMessagesImportService from "../macOSMessagesImportService";
import { ATTACHMENTS_DIR, BATCH_SIZE } from "../macOSMessagesImportService/types";
import type {
  RawMacMessage,
  RawMacAttachment,
  MacOSImportResult,
} from "../macOSMessagesImportService/types";

const USER = "user-cancel-2748";
let sourceDir: string;
let scratchDir: string;

/** Absolute path of each attachment fixture file, by 1-based index. */
const attachmentSourcePaths = new Map<number, string>();

function messageRows(): RawMacMessage[] {
  return Array.from({ length: messageCount }, (_, i) => {
    const n = i + 1;
    return {
      id: n,
      guid: `msg-guid-${n}`,
      text: `hello ${n}`,
      attributedBody: null,
      date: 700000000 * 1e9 + n,
      is_from_me: 0,
      handle_id: "+15550100",
      service: "iMessage",
      chat_id: 1,
      cache_has_attachments: n <= attachmentCount ? 1 : 0,
      associated_message_type: null,
      associated_message_guid: null,
    };
  });
}

function attachmentRows(): RawMacAttachment[] {
  return Array.from({ length: attachmentCount }, (_, i) => {
    const n = i + 1;
    return {
      attachment_id: n,
      message_id: n,
      message_guid: `msg-guid-${n}`,
      guid: `att-${n}`,
      filename: attachmentSourcePaths.get(n) ?? "",
      mime_type: null,
      transfer_name: `photo-${n}.jpg`,
      total_bytes: 4_000,
      is_outgoing: 0,
    };
  });
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

/** Every message guid the app database actually holds, in corpus order. */
function storedGuids(): string[] {
  const rows = mockDb
    .prepare("SELECT external_id FROM messages")
    .all() as { external_id: string }[];
  return rows
    .map((r) => r.external_id)
    .sort((a, b) => Number(a.replace("msg-guid-", "")) - Number(b.replace("msg-guid-", "")));
}

/** Every attachment the app database links, by the macOS guid it came from. */
function storedAttachmentGuids(): string[] {
  const rows = mockDb
    .prepare("SELECT external_message_id FROM attachments")
    .all() as { external_message_id: string }[];
  return rows
    .map((r) => r.external_message_id)
    .sort((a, b) => Number(a.replace("msg-guid-", "")) - Number(b.replace("msg-guid-", "")));
}

async function filesInAttachmentsDir(): Promise<string[]> {
  try {
    return await fs.readdir(nodePath.join(scratchDir, ATTACHMENTS_DIR));
  } catch {
    return [];
  }
}

function guidRange(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => `msg-guid-${from + i}`);
}

/**
 * Run a real import, requesting cancellation from inside the progress callback
 * the first time `phase` reports `current >= at`.
 */
async function importCancellingAt(
  phase: "importing" | "attachments",
  at: number,
): Promise<MacOSImportResult> {
  let cancelSent = false;
  return macOSMessagesImportService.importMessages(
    USER,
    (progress) => {
      if (!cancelSent && progress.phase === phase && progress.current >= at) {
        cancelSent = true;
        macOSMessagesImportService.requestCancellation();
      }
    },
    false,
    { lookbackMonths: null, maxMessages: null },
  );
}

function importToCompletion(): Promise<MacOSImportResult> {
  return macOSMessagesImportService.importMessages(USER, undefined, false, {
    lookbackMonths: null,
    maxMessages: null,
  });
}

beforeEach(async () => {
  messageCount = 0;
  attachmentCount = 0;
  attachmentSourcePaths.clear();

  mockDb = new Database(":memory:");
  createSchema(mockDb);

  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-cancel-app-"));
  sourceDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-cancel-src-"));

  (app.getPath as jest.Mock).mockImplementation((name: string) =>
    name === "userData" ? scratchDir : `/tmp/test-${name}`,
  );
  // Plenty of room — this suite is about cancellation, not the space guard.
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

/** Write N attachment fixture files with DISTINCT contents (distinct hashes). */
async function writeAttachmentFixtures(n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    const p = nodePath.join(sourceDir, `photo-${i}.jpg`);
    // Distinct bytes per file: identical contents would hit the content-hash
    // dedup path, which writes a row but copies no file — and "no file appeared"
    // would then be true for reasons having nothing to do with cancellation.
    await fs.writeFile(p, `attachment-${i}-`.repeat(200));
    attachmentSourcePaths.set(i, p);
  }
}

describe("BACKLOG-2748 — cancelling a running import (message phase)", () => {
  beforeEach(() => {
    messageCount = 500; // 5 batches of BATCH_SIZE (100)
    attachmentCount = 0;
  });

  it("stops the batch loop: exactly the first batch is stored, and the reported count is what the DB holds", async () => {
    // The first `importing` progress event fires after batch 0 commits, so the
    // cancel lands before batch 1 — the boundary the service promises to honour.
    const result = await importCancellingAt("importing", 1);

    expect(result.cancelled).toBe(true);

    // WHICH messages, not how many: the first batch, in corpus order.
    expect(storedGuids()).toEqual(guidRange(1, BATCH_SIZE));

    // The count the UI will show is read back from the database, not taken from
    // the target — a cancelled run must not report the number it was aiming at.
    expect(result.messagesImported).toBe(BATCH_SIZE);
    expect(result.messagesImported).toBe(storedGuids().length);
  });

  it("CONTROL: the same fixture uncancelled stores all 500 and is not marked cancelled", async () => {
    // Without this, "only 100 stored" would be equally green for an import that
    // simply could not read past its first batch.
    const result = await importToCompletion();

    expect(result.cancelled).toBeUndefined();
    expect(result.messagesImported).toBe(500);
    expect(storedGuids()).toEqual(guidRange(1, 500));
  });

  it("a cancelled run does not poison the next: re-importing yields the FULL corpus", async () => {
    const cancelled = await importCancellingAt("importing", 1);
    expect(cancelled.cancelled).toBe(true);
    expect(storedGuids()).toEqual(guidRange(1, BATCH_SIZE));

    // Same corpus again, no cancel. Guid dedup absorbs the partial rows: the
    // second run stores the 400 that were missing and duplicates none.
    const rerun = await importToCompletion();

    expect(rerun.cancelled).toBeUndefined();
    expect(rerun.messagesImported).toBe(500 - BATCH_SIZE);
    expect(storedGuids()).toEqual(guidRange(1, 500));
  });
});

describe("BACKLOG-2748 — cancelling during the attachment phase", () => {
  beforeEach(async () => {
    messageCount = 12;
    attachmentCount = 12;
    await writeAttachmentFixtures(12);
  });

  it("stops copying files: exactly the attachments processed before the cancel exist on disk", async () => {
    // The attachment progress event fires at the END of each iteration, so
    // cancelling on `current === 3` means iteration 4 hits the abort check at
    // the top of the loop and breaks — three files copied, no fourth.
    const result = await importCancellingAt("attachments", 3);

    expect(result.cancelled).toBe(true);

    // The messages themselves were never cancelled — all 12 are kept.
    expect(storedGuids()).toEqual(guidRange(1, 12));

    // The property that makes Cancel worth pressing: the copies STOPPED.
    const files = await filesInAttachmentsDir();
    expect(files).toHaveLength(3);
    expect(storedAttachmentGuids()).toEqual(guidRange(1, 3));
    expect(result.attachmentsImported).toBe(3);

    // The import has fully returned by now; nothing is still writing. A second
    // read a tick later must show the same directory — frozen, not draining.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await filesInAttachmentsDir()).toEqual(files);
  });

  it("CONTROL: the same fixture uncancelled copies all 12 files", async () => {
    // The distinguishing input. If the attachment loop's abort check is deleted,
    // the test above sees 12 files too and reds.
    const result = await importToCompletion();

    expect(result.cancelled).toBeUndefined();
    expect(result.attachmentsImported).toBe(12);
    expect(await filesInAttachmentsDir()).toHaveLength(12);
    expect(storedAttachmentGuids()).toEqual(guidRange(1, 12));
  });

  it("re-importing after an attachment-phase cancel copies the attachments that were skipped", async () => {
    const cancelled = await importCancellingAt("attachments", 3);
    expect(cancelled.cancelled).toBe(true);
    expect(await filesInAttachmentsDir()).toHaveLength(3);

    const rerun = await importToCompletion();

    expect(rerun.cancelled).toBeUndefined();
    // The messages were already all stored, so the second run adds none...
    expect(rerun.messagesImported).toBe(0);
    // ...but the nine attachments the cancel skipped are picked up.
    expect(await filesInAttachmentsDir()).toHaveLength(12);
    expect(storedAttachmentGuids()).toEqual(guidRange(1, 12));
  });
});
