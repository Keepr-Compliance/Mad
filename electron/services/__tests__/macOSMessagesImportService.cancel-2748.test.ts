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

/**
 * BACKLOG-2775: the two main-process timers that write on the SHARED database
 * connection. They are recorded, not just stubbed, because the property under
 * test is an ORDERING — stopped before the transaction opens, restarted after it
 * resolves — and only a trail can show that.
 */
const writerEvents: string[] = [];
/** Whether each timer is running, as the real services would report. */
let auditSyncRunning = true;
let submissionSyncRunning = true;
/** Flips to false when the fake in-flight audit sync finishes. */
let auditSyncInFlight = false;
/** The same, for the submission poll — it has its own in-flight guard now. */
let submissionSyncInFlight = false;

jest.mock("../auditService", () => ({
  __esModule: true,
  default: {
    suspendPeriodicSync: jest.fn(() => {
      writerEvents.push("audit:suspend");
      const wasRunning = auditSyncRunning;
      auditSyncRunning = false;
      return wasRunning;
    }),
    resumePeriodicSync: jest.fn(() => {
      writerEvents.push("audit:resume");
      auditSyncRunning = true;
    }),
    isSyncInFlight: jest.fn(() => auditSyncInFlight),
  },
}));

jest.mock("../submissionSyncService", () => ({
  __esModule: true,
  default: {
    suspendPeriodicSync: jest.fn(() => {
      writerEvents.push("submissions:suspend");
      const wasRunning = submissionSyncRunning;
      submissionSyncRunning = false;
      return wasRunning;
    }),
    resumePeriodicSync: jest.fn(() => {
      writerEvents.push("submissions:resume");
      submissionSyncRunning = true;
    }),
    isSyncInFlight: jest.fn(() => submissionSyncInFlight),
  },
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
// BACKLOG-2772: plans are built by the REAL resolver, never hand-written.
import { testImportPlan } from "./helpers/importPlanFixture";
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
    -- BACKLOG-2775: the table auditService's 60-second timer writes to, on this
    -- same connection. Only the columns the sync mark touches.
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, action TEXT, timestamp DATETIME, synced_at DATETIME
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

/**
 * BACKLOG-2775: every stored message by IDENTITY — the internal row id AND the
 * macOS guid it came from.
 *
 * The guid alone cannot tell a rolled back force re-import from a completed
 * one: both end with msg-guid-1..N present. The internal id is a fresh
 * `crypto.randomUUID()` per INSERT, so it changes if and only if the row was
 * actually re-created. Comparing the pairs is therefore the difference between
 * "the store is untouched" and "the store was rebuilt and happens to look the
 * same".
 */
function storedRowIdentities(): Array<{ id: string; external_id: string }> {
  return (
    mockDb
      .prepare("SELECT id, external_id FROM messages")
      .all() as Array<{ id: string; external_id: string }>
  ).sort((a, b) => a.external_id.localeCompare(b.external_id));
}

/** Every attachment row by identity, for the same reason. */
function storedAttachmentIdentities(): Array<{ id: string; external_message_id: string }> {
  return (
    mockDb
      .prepare("SELECT id, external_message_id FROM attachments")
      .all() as Array<{ id: string; external_message_id: string }>
  ).sort((a, b) => a.external_message_id.localeCompare(b.external_message_id));
}

/**
 * Run a real FORCE re-import (clear + re-import), requesting cancellation from
 * inside the progress callback the first time `phase` reports `current >= at`.
 */
async function forceImportCancellingAt(
  phase: "deleting" | "importing" | "attachments",
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
    testImportPlan({
        mode: "reprocess",
        storedFilters: { lookbackMonths: null, maxMessages: null },
      }),
    );
}

function forceImportToCompletion(
  onProgress?: (progress: { phase: string; current: number }) => void,
): Promise<MacOSImportResult> {
  return macOSMessagesImportService.importMessages(USER, onProgress, testImportPlan({
      mode: "reprocess",
      storedFilters: { lookbackMonths: null, maxMessages: null },
    }));
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
    testImportPlan({
        mode: "delta",
        storedFilters: { lookbackMonths: null, maxMessages: null },
      }),
    );
}

function importToCompletion(): Promise<MacOSImportResult> {
  return macOSMessagesImportService.importMessages(USER, undefined, testImportPlan({
      mode: "delta",
      storedFilters: { lookbackMonths: null, maxMessages: null },
    }));
}

beforeEach(async () => {
  messageCount = 0;
  attachmentCount = 0;
  attachmentSourcePaths.clear();
  writerEvents.length = 0;
  auditSyncRunning = true;
  submissionSyncRunning = true;
  auditSyncInFlight = false;
  submissionSyncInFlight = false;

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

describe("BACKLOG-2776 — a cancel sent before the import starts is HELD, not dropped", () => {
  beforeEach(() => {
    messageCount = 500;
    attachmentCount = 0;
  });

  // This describe asserted the OPPOSITE under BACKLOG-2748: `requestCancellation()`
  // was guarded by `if (this.isImporting)` and each run built a fresh
  // AbortController, so a cancel arriving before the run was in flight reached
  // nothing. That was documented as a fact the UI had to respect — the Cancel
  // button was withheld during 'pending' and left clickable so a user could
  // re-send a dropped one.
  //
  // It was still a gap the founder fell into: he pressed Cancel, the UI said
  // "Cancelling...", and the import carried on, so he pressed again. A cancel is
  // now held and consumed by the run that starts next.

  it("carries over: a cancel with nothing running aborts the run that starts next", async () => {
    macOSMessagesImportService.requestCancellation();

    const result = await importToCompletion();

    expect(result.cancelled).toBe(true);
    // Aborted before the first fetch, so nothing was read and nothing stored.
    expect(result.messagesImported).toBe(0);
    expect(storedGuids()).toEqual([]);
  });

  it("CONTROL: without the preceding cancel the same fixture imports all 500", async () => {
    // The distinguishing input. If the held cancel were instead a service that
    // had simply stopped importing, the test above would be equally green.
    const result = await importToCompletion();

    expect(result.cancelled).toBeUndefined();
    expect(result.messagesImported).toBe(500);
    expect(storedGuids()).toEqual(guidRange(1, 500));
  });

  it("is consumed once: the run after the held cancel is unaffected", async () => {
    macOSMessagesImportService.requestCancellation();
    const cancelled = await importToCompletion();
    expect(cancelled.cancelled).toBe(true);
    expect(storedGuids()).toEqual([]);

    // A held cancel that stayed armed would make the import button dead for the
    // rest of the session.
    const rerun = await importToCompletion();

    expect(rerun.cancelled).toBeUndefined();
    expect(rerun.messagesImported).toBe(500);
    expect(storedGuids()).toEqual(guidRange(1, 500));
  });

  it("expires: a cancel older than the hold window does not reach a later import", async () => {
    // The bound that keeps "held" from becoming "armed forever". The window it
    // covers is the sub-second gap between the UI offering Cancel and the
    // service setting `isImporting`; an import the user starts long afterwards
    // is a different intention and must run.
    const realNow = Date.now;
    const armedAt = realNow.call(Date);
    jest.spyOn(Date, "now").mockReturnValue(armedAt);

    macOSMessagesImportService.requestCancellation();

    // ...a minute passes, then the user asks for an import.
    jest.spyOn(Date, "now").mockReturnValue(armedAt + 60_000);

    const result = await importToCompletion();

    expect(result.cancelled).toBeUndefined();
    expect(result.messagesImported).toBe(500);
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

describe("BACKLOG-2775 — a cancelled FORCE re-import changes nothing", () => {
  // The incident, in full: the founder pressed Force Re-import, changed his mind
  // about a second later and pressed Cancel. The service was inside its up-front
  // clear phase, which held no transaction and checked no cancellation flag, so
  // it deleted all 162,961 of his messages over ~35 seconds and committed that.
  // The first cancellation check after the clear then fired — "Import cancelled
  // during query phase at 0/12777" — and the run ended having imported nothing.
  // His entire local message store was gone, recoverable only by a manual full
  // re-import.
  //
  // The clear and the re-import now share one transaction, so the pre-run rows
  // are what survives any interruption. Every test here asserts that by IDENTITY
  // (`storedRowIdentities`), which is the only way to tell a store that was left
  // alone from one that was emptied and rebuilt.

  beforeEach(async () => {
    messageCount = 500;
    attachmentCount = 0;
    // Seed the store the way the founder's was seeded: a completed import.
    const seed = await importToCompletion();
    expect(seed.messagesImported).toBe(500);
  });

  it("rolls back a cancel mid re-import: the exact pre-run rows are still there", async () => {
    const before = storedRowIdentities();
    expect(before).toHaveLength(500);

    // Cancel after the first batch of the re-import has been stored — i.e. well
    // past the clear, with the store mid-rebuild. This is the shape of run that
    // used to leave 100 messages where 500 had been.
    const result = await forceImportCancellingAt("importing", 1);

    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBe(true);
    // Nothing was written, so nothing was imported. Reporting the partial count
    // here would be the report that told the founder his run had "imported 0".
    expect(result.messagesImported).toBe(0);

    // The property: same rows, same internal ids, same guids.
    expect(storedRowIdentities()).toEqual(before);
  });

  it("CONTROL: the same force fixture uncancelled REPLACES every row and commits", async () => {
    // The distinguishing input. A force re-import that silently did nothing —
    // no clear, no re-import — would leave the test above green on identical
    // rows. This proves the force path really does delete and re-create: same
    // guids, and NOT ONE surviving internal id.
    const before = storedRowIdentities();

    const result = await forceImportToCompletion();

    expect(result.cancelled).toBeUndefined();
    expect(result.rolledBack).toBeUndefined();
    expect(result.messagesImported).toBe(500);

    const after = storedRowIdentities();
    expect(after.map((row) => row.external_id)).toEqual(
      before.map((row) => row.external_id),
    );
    const survivingIds = after
      .map((row) => row.id)
      .filter((id) => before.some((row) => row.id === id));
    expect(survivingIds).toEqual([]);
  });

  it("never starts the clear at all when the cancel arrives first", async () => {
    // Scope 3 of the item, and the cheapest half of the fix: the founder's
    // cancel was already in when the 35-second delete began, and the flag was
    // next read after it had finished. A cancel held from before the run
    // (BACKLOG-2776) is now checked BEFORE the destructive step.
    const before = storedRowIdentities();
    const phases: string[] = [];

    macOSMessagesImportService.requestCancellation();
    const result = await forceImportToCompletion((progress) => {
      phases.push(progress.phase);
    });

    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(storedRowIdentities()).toEqual(before);
    // Not merely "the rows came back" — the delete never ran. No progress was
    // ever reported for the deleting phase.
    expect(phases).not.toContain("deleting");
  });

  it("STOPS the clear when the cancel lands during it, and rolls back", async () => {
    // The founder's own timing: the cancel lands while the clear is underway.
    // The first `deleting` progress event is emitted before any message row is
    // deleted, so cancelling on it exercises the abort check inside the delete
    // loop. (With 500 seeded messages the whole clear is one batch of
    // DELETE_BATCH_SIZE=5000, so this proves the loop stops before its first
    // delete rather than between two of them — the founder's 162,961 would take
    // 33 batches, each now interruptible.)
    //
    // The identity assertion alone would NOT prove the in-loop check: with the
    // transaction in place, a clear that ran to completion and was cancelled at
    // the query phase afterwards also rolls back to the same rows. The
    // distinguishing assertion is the progress trail — deleting must never
    // report having deleted anything, because the delete never happened.
    const before = storedRowIdentities();
    const deletingProgress: number[] = [];

    let cancelSent = false;
    const result = await macOSMessagesImportService.importMessages(
      USER,
      (progress) => {
        if (progress.phase === "deleting") deletingProgress.push(progress.current);
        if (!cancelSent && progress.phase === "deleting") {
          cancelSent = true;
          macOSMessagesImportService.requestCancellation();
        }
      },
      testImportPlan({
        mode: "reprocess",
        storedFilters: { lookbackMonths: null, maxMessages: null },
      }),
    );

    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(storedRowIdentities()).toEqual(before);

    // The 35 seconds the founder waited out: not one delete batch ran after his
    // cancel was in.
    expect(deletingProgress).toEqual([0]);
  });

  it("restores the attachment rows the clear deleted, too", async () => {
    // The clear deletes attachment ROWS as well as messages, and those are
    // deleted in one statement before the message loop — so they are gone from
    // the transaction's view the instant the clear starts. They must come back
    // with everything else.
    //
    // Attachment FILES on disk are a separate matter and deliberately NOT
    // restored: the clear never deletes files (it is DB-rows-only), and the
    // re-import's copies are left behind on rollback as orphans for the
    // retention sweep (BACKLOG-2768) to reclaim. Nothing irreversible happens
    // on disk before the commit, which is what makes that acceptable.
    messageCount = 12;
    attachmentCount = 12;
    await writeAttachmentFixtures(12);
    const reseed = await macOSMessagesImportService.importMessages(USER, undefined, testImportPlan({
      mode: "reprocess",
      storedFilters: { lookbackMonths: null, maxMessages: null },
    }));
    expect(reseed.attachmentsImported).toBe(12);

    const beforeMessages = storedRowIdentities();
    const beforeAttachments = storedAttachmentIdentities();
    expect(beforeAttachments).toHaveLength(12);

    const result = await forceImportCancellingAt("attachments", 3);

    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(result.attachmentsImported).toBe(0);
    expect(storedRowIdentities()).toEqual(beforeMessages);
    expect(storedAttachmentIdentities()).toEqual(beforeAttachments);
  });

  it("leaves a cancelled DELTA import's partial progress alone", async () => {
    // The scope line. Atomicity belongs to the force path only: a delta import
    // commits per batch, so cancelling one keeps what it had imported — which is
    // what makes cancelling a long delta import worth doing at all. If the
    // transaction wrap ever leaked onto this path, this test reds and the
    // "N messages were imported before cancellation" copy becomes a lie.
    mockDb.prepare("DELETE FROM messages").run();

    const result = await importCancellingAt("importing", 1);

    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBeUndefined();
    expect(result.messagesImported).toBe(BATCH_SIZE);
    expect(storedGuids()).toEqual(guidRange(1, BATCH_SIZE));
  });
});

describe("BACKLOG-2775 — the force transaction cannot swallow background writes", () => {
  // Every write in the main process goes through the SAME better-sqlite3 handle
  // (`databaseService` shares it with `db/core/dbConnection` via `setDb`), so a
  // write from anywhere while the force transaction is open JOINS it and is
  // rolled back with it. Two 60-second timers write on that handle:
  // auditService's cloud sync (markAuditLogsSynced) and submissionSyncService's
  // poll. Rollback is the NORMAL path for a cancelled force re-import, so
  // without quiescing them the fix for BACKLOG-2775 would have introduced a
  // quieter bug of its own.

  /** Rows the audit sync has uploaded to the cloud. */
  let cloudRows: string[] = [];

  /**
   * One tick of auditService's periodic sync, modelled: upload the unsynced
   * rows, then mark them synced locally — on the shared connection.
   *
   * Honours `auditSyncRunning` because that is what the real thing does: a
   * cleared interval does not fire.
   */
  function auditTimerTick(): void {
    if (!auditSyncRunning) return;
    const unsynced = mockDb
      .prepare("SELECT id FROM audit_logs WHERE synced_at IS NULL")
      .all() as Array<{ id: string }>;
    for (const row of unsynced) {
      cloudRows.push(row.id);
      mockDb
        .prepare("UPDATE audit_logs SET synced_at = ? WHERE id = ?")
        .run("2026-08-21T00:00:00.000Z", row.id);
    }
  }

  const syncedAtOf = (id: string): string | null =>
    (mockDb.prepare("SELECT synced_at FROM audit_logs WHERE id = ?").get(id) as {
      synced_at: string | null;
    }).synced_at;

  beforeEach(async () => {
    cloudRows = [];
    messageCount = 500;
    attachmentCount = 0;
    await importToCompletion();
    mockDb
      .prepare("INSERT INTO audit_logs (id, action, timestamp, synced_at) VALUES (?, ?, ?, NULL)")
      .run("audit-1", "user.login", "2026-08-21T00:00:00.000Z");
  });

  it("stops the audit sync before opening the transaction, so its mark cannot be rolled back", async () => {
    // The failure this prevents: the tick uploads the row to the cloud and marks
    // it synced locally, the user cancels, and the rollback erases only the
    // LOCAL mark — leaving a row that is in the cloud and looks unsynced here,
    // so it uploads again. The local store and the cloud disagree, and nothing
    // reports it.
    let cancelSent = false;
    const result = await macOSMessagesImportService.importMessages(
      USER,
      (progress) => {
        if (!cancelSent && progress.phase === "importing" && progress.current >= 1) {
          cancelSent = true;
          // The timer fires mid-transaction — or would, if it were still running.
          auditTimerTick();
          macOSMessagesImportService.requestCancellation();
        }
      },
      testImportPlan({
        mode: "reprocess",
        storedFilters: { lookbackMonths: null, maxMessages: null },
      }),
    );

    expect(result.rolledBack).toBe(true);

    // The distinguishing assertion is AGREEMENT between the two stores, not the
    // local value alone: rolled back to NULL is the correct state here and the
    // corrupt state in the mutation, and only the cloud side tells them apart.
    expect(syncedAtOf("audit-1")).toBeNull();
    expect(cloudRows).toEqual([]);
  });

  it("suspends both writers BEFORE the clear starts and resumes them after the rollback", async () => {
    // Note: a cancel that arrives BEFORE the run starts returns at the pre-clear
    // check, without opening a transaction and therefore without quiescing
    // anything — correct, and the reason this test cancels mid-import instead.
    const trail: string[] = [];
    const seen = new Set<string>();

    let cancelSent = false;
    await macOSMessagesImportService.importMessages(
      USER,
      (progress) => {
        if (!seen.has(progress.phase)) {
          seen.add(progress.phase);
          writerEvents.push(`phase:${progress.phase}`);
        }
        // Cancel mid-import, so this run genuinely ends in a ROLLBACK — a
        // pre-run cancel would return before the transaction was ever opened
        // and would prove nothing about the ordering around it.
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
    trail.push(...writerEvents);

    // Both stopped, both restarted, and the stops come first — a suspend issued
    // after BEGIN would leave a window the timer could fire in.
    expect(trail.slice(0, 2)).toEqual(["audit:suspend", "submissions:suspend"]);
    expect(trail.slice(-2)).toEqual(["audit:resume", "submissions:resume"]);
  });

  it("restarts only what it stopped", async () => {
    // The audit timer was already stopped by the app (e.g. never initialized).
    // Starting it here would be this feature switching cloud sync ON behind the
    // user's back.
    auditSyncRunning = false;

    await forceImportToCompletion();

    expect(writerEvents).toContain("submissions:resume");
    expect(writerEvents).not.toContain("audit:resume");
  });

  it("a force run cancelled BEFORE the clear neither suspends nor resumes anything", async () => {
    // The last uncovered force exit, and the SR found it the only way it can be
    // found: they hoisted the quiesce above the pre-clear cancel check and all
    // 24 tests in this file stayed green. Every other test steers around this
    // path deliberately, so nothing was watching it.
    //
    // The property is that the quiesce belongs INSIDE the branch that opens a
    // transaction. A run that stops before the clear has nothing to protect, so
    // suspending the app's cloud sync for it would be a cost with no purchase —
    // and the regression is silent, because the `finally` still resumes.
    writerEvents.length = 0;

    macOSMessagesImportService.requestCancellation();
    const result = await forceImportToCompletion();

    expect(result.rolledBack).toBe(true);
    expect(writerEvents).toEqual([]);
    expect(auditSyncRunning).toBe(true);
    expect(submissionSyncRunning).toBe(true);
  });

  it("leaves the background writers alone for a DELTA import", async () => {
    // Only the force path takes the long transaction, so only it has any reason
    // to stop the app's cloud sync.
    mockDb.prepare("DELETE FROM messages").run();

    await importToCompletion();

    expect(writerEvents).toEqual([]);
  });

  it("waits for a SUBMISSION sync that is already in flight", async () => {
    // submissionSyncService awaits its cloud-status fetch before writing via
    // updateTransactionSubmissionStatus, exactly as the audit sync does. Until
    // BACKLOG-2775's re-review it had no in-flight guard at all, so stopping its
    // interval was the only thing the quiesce could do for it — and a poll
    // already in the air would still write inside the transaction. The audit
    // shape is now mirrored, and the wait covers both.
    submissionSyncInFlight = true;
    let checks = 0;
    (
      jest.requireMock("../submissionSyncService") as {
        default: { isSyncInFlight: jest.Mock };
      }
    ).default.isSyncInFlight.mockImplementation(() => {
      checks += 1;
      if (checks >= 3) submissionSyncInFlight = false;
      return submissionSyncInFlight;
    });

    await forceImportToCompletion();

    expect(checks).toBeGreaterThanOrEqual(3);
    expect(submissionSyncInFlight).toBe(false);
  });

  it("waits for an audit sync that is already in flight", async () => {
    // Stopping an interval prevents new ticks; it cannot cancel one already
    // awaiting its network round trip before it reaches markAuditLogsSynced.
    auditSyncInFlight = true;
    let checks = 0;
    (
      jest.requireMock("../auditService") as {
        default: { isSyncInFlight: jest.Mock };
      }
    ).default.isSyncInFlight.mockImplementation(() => {
      // Settles after a few polls, as a finishing round trip would.
      checks += 1;
      if (checks >= 3) auditSyncInFlight = false;
      return auditSyncInFlight;
    });

    await forceImportToCompletion();

    expect(checks).toBeGreaterThanOrEqual(3);
    expect(auditSyncInFlight).toBe(false);
  });
});

describe("BACKLOG-2775 — the structural guard on the force transaction", () => {
  // The COMMIT sits at the end of a ~600-line try block with several exits. A
  // future `return { success: true, ... }` added anywhere inside it would be
  // rolled back by the `finally` while reporting success to the user — an
  // emptied message store with tsc, lint and every other test still green.
  //
  // Every exit that means to leave the transaction open declares it. This test
  // simulates the undeclared one, which is the only way to know the guard is
  // wired to anything.

  beforeEach(async () => {
    messageCount = 500;
    attachmentCount = 0;
    await importToCompletion();
  });

  it("throws rather than return a result describing data it rolled back", async () => {
    const before = storedRowIdentities();

    // The simulated regression, reproduced by its END STATE: the try returns a
    // success-shaped result while the transaction is still open and nothing has
    // declared a rollback. Swallowing the COMMIT produces exactly that — the
    // import runs to its success `return`, and the `finally` finds the
    // transaction it was supposed to have committed still open.
    //
    // This also pins the reason the `finally` asks the CONNECTION whether a
    // transaction is open rather than trusting `forceTxnOpen`, which is cleared
    // on the line after the COMMIT: written the other way, this exact state
    // skips the rollback entirely and leaks the write lock for the life of the
    // process. That is how this test was found — it failed, and the code was
    // wrong, not the test.
    //
    // (Throwing from inside the try does NOT stand in for this: the outer catch
    // catches anything, Error or not, and DOES declare a rollback — so the guard
    // correctly stays silent, as the CONTROL below shows.)
    const realExec = mockDb.exec.bind(mockDb);
    const execSpy = jest
      .spyOn(mockDb, "exec")
      .mockImplementation((sql: string) => {
        if (sql.trim().toUpperCase() === "COMMIT") return mockDb; // never lands
        return realExec(sql);
      });

    await expect(forceImportToCompletion()).rejects.toThrow(
      /open transaction and no declared rollback/i,
    );

    execSpy.mockRestore();

    // The guard's whole purpose: the data is safe FIRST, and the misleading
    // result is discarded second.
    expect(storedRowIdentities()).toEqual(before);
    // ...and the background writers were restarted despite the throw.
    expect(writerEvents.slice(-2)).toEqual(["audit:resume", "submissions:resume"]);
  });

  it("CONTROL: a declared rollback exit does NOT trip the guard", async () => {
    // The distinguishing input. If the guard fired on every rollback, an
    // ordinary cancel — the feature's normal path — would blow up in the user's
    // face instead of reporting "nothing changed".
    const result = await forceImportCancellingAt("importing", 1);

    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toBe("Import cancelled");
  });

  it("CONTROL: a thrown error is a declared exit and surfaces as itself", async () => {
    // A genuine failure inside the try must still arrive as that failure, not
    // be replaced by the guard's message.
    const storeSpy = jest
      .spyOn(
        macOSMessagesImportService as unknown as {
          storeMessages: () => Promise<unknown>;
        },
        "storeMessages",
      )
      .mockRejectedValue(new Error("disk I/O error"));

    const result = await forceImportToCompletion();

    expect(result.success).toBe(false);
    expect(result.error).toBe("disk I/O error");
    expect(result.rolledBack).toBe(true);

    storeSpy.mockRestore();
  });
});

describe("BACKLOG-2775 — a transaction this run did not open is never rolled back", () => {
  // The BEGIN site refuses to start a force re-import when a transaction is
  // already open, on the stated grounds that it "belongs to someone else and the
  // ROLLBACK would discard their work". That refusal is a throw — which lands in
  // the outer catch, and then in the `finally` that owns the rollback. Rolling
  // back on `inTransaction` alone would discard exactly the work the guard just
  // refused to touch, on the one path where its own assertion had failed.
  //
  // Unreachable in the app today: nothing else in electron/ opens a raw
  // transaction, and better-sqlite3's `db.transaction()` is synchronous so it
  // cannot span an await. It is reachable HERE, which is the point — the guard's
  // own comment says to assert rather than assume, "because the failure would be
  // silent".

  beforeEach(async () => {
    messageCount = 500;
    attachmentCount = 0;
    await importToCompletion();
  });

  it("refuses to start, and leaves the foreign transaction intact", async () => {
    const before = storedRowIdentities();

    // Someone else's uncommitted work, on the shared connection.
    mockDb.exec("BEGIN IMMEDIATE");
    mockDb
      .prepare("INSERT INTO audit_logs (id, action, timestamp, synced_at) VALUES (?, ?, ?, NULL)")
      .run("foreign-1", "someone.else", "2026-08-21T00:00:00.000Z");

    const result = await forceImportToCompletion();

    // Refused rather than attempted.
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/transaction is already open/i);

    // The foreign transaction is STILL OPEN and STILL HOLDS its work — the
    // refusal did not quietly discard what it declined to touch.
    expect(mockDb.inTransaction).toBe(true);
    expect(
      mockDb.prepare("SELECT id FROM audit_logs WHERE id = ?").all("foreign-1"),
    ).toHaveLength(1);

    // ...and the messages were never touched either.
    expect(storedRowIdentities()).toEqual(before);

    // Nothing was suspended: the refusal happens before the quiesce.
    expect(writerEvents).toEqual([]);

    mockDb.exec("COMMIT");
  });
});
