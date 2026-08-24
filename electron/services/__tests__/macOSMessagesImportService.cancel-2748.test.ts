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

  it("does no work at all when the cancel arrives first", async () => {
    // Scope 3 of the item, and the cheapest half of the fix: the founder's
    // cancel was already in when the 35-second delete began, and the flag was
    // next read after it had finished. A cancel held from before the run
    // (BACKLOG-2776) is checked before anything happens.
    //
    // BACKLOG-2790: it is now the check before STAGING rather than before
    // deleting, and the assertion below is correspondingly weaker on its own —
    // no force run reports a `deleting` phase any more, so its absence no longer
    // distinguishes this exit from any other. What distinguishes it is that no
    // staging table is created: this run allocates nothing, not even scratch.
    const before = storedRowIdentities();
    const phases: string[] = [];

    macOSMessagesImportService.requestCancellation();
    const result = await forceImportToCompletion((progress) => {
      phases.push(progress.phase);
    });

    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(storedRowIdentities()).toEqual(before);
    expect(phases).toEqual([]);
    expect(
      mockDb
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'staging_msgimport_%'`
        )
        .get() as { count: number }
    ).toEqual({ count: 0 });
  });

  it("BACKLOG-2790: the store never shrinks at ANY point during the run", async () => {
    // The test this replaces cancelled on the first `deleting` progress event
    // and asserted that not one delete batch ran afterwards — the 35 seconds the
    // founder waited out. It was the right assertion for a design that deleted
    // first and restored on failure. There is no `deleting` phase to cancel on
    // any more, and the property it was protecting is now available directly, as
    // an invariant over the WHOLE run rather than a fact about one exit:
    //
    //   at no instant is the live message store emptier than it was before the
    //   run started.
    //
    // That is stronger than what the old design could offer. Under BACKLOG-2775
    // the store WAS empty for most of the run — the guarantee was only that an
    // interruption would restore it, which is a promise about the exit path.
    // Here it is a fact about every instant, so a crash (which runs no exit
    // path at all) is covered by the same assertion.
    const before = storedRowIdentities();
    const observedCounts: number[] = [];
    const phasesSeen = new Set<string>();

    let cancelSent = false;
    const result = await macOSMessagesImportService.importMessages(
      USER,
      (progress) => {
        phasesSeen.add(progress.phase);
        observedCounts.push(storedRowIdentities().length);
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

    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(storedRowIdentities()).toEqual(before);

    // The invariant. Sampling only proves it where it was sampled, which is why
    // the sampling is at every progress event of every phase, and why the
    // architecture — not this test — is what makes it true everywhere else.
    expect(observedCounts.length).toBeGreaterThan(0);
    expect(Math.min(...observedCounts)).toBe(before.length);

    // The declared, founder-visible consequence, asserted rather than assumed:
    // there is no "Clearing existing messages…" step any more, because nothing
    // is cleared until the rebuild has finished. Emitting a `deleting` phase
    // late would also drive the orchestrator's weighted progress bar backwards
    // (it maps phases positionally), so its absence is load-bearing for the UI
    // as well as descriptive of the architecture.
    expect(phasesSeen.has("deleting")).toBe(false);
  });

  it("leaves the attachment ROWS alone too, not just the messages", async () => {
    // BACKLOG-2790: this used to read "restores the attachment rows the clear
    // deleted". The clear deleted attachment rows in one statement before the
    // message loop, so they vanished from the transaction's view the instant it
    // started and had to come back with everything else. Now they are never
    // deleted: the rebuild's attachment rows go to a staging table, and the live
    // ones are replaced only by the swap. Same assertion, one fewer thing that
    // has to go right.
    //
    // Attachment FILES on disk are a separate matter and still deliberately not
    // reverted: the force path never deletes files, and the copies a cancelled
    // rebuild made are left behind as orphans for the retention sweep
    // (BACKLOG-2768) to reclaim. Nothing irreversible happens on disk before the
    // swap, which is what makes that acceptable.
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

describe("BACKLOG-2790 — a force re-import cannot swallow background writes, and no longer has to pause them", () => {
  // WHAT CHANGED, AND WHY THESE TESTS DID.
  //
  // Every write in the main process goes through the SAME better-sqlite3 handle
  // (`databaseService` shares it with `db/core/dbConnection` via `setDb`). Under
  // BACKLOG-2775 the force path held one BEGIN IMMEDIATE transaction open for
  // the whole run, so any write landing in that window silently JOINED it and
  // was destroyed by the rollback that a cancelled force re-import performs as
  // its NORMAL path. The fix was to pause the two 60-second timers that write
  // there — auditService's cloud sync and submissionSyncService's poll — and to
  // wait out any tick already in the air.
  //
  // That mechanism is gone, and the tests that pinned it went with it: five
  // tests asserting that the suspends happened, in the right order, restarted
  // only what they stopped, and waited for in-flight syncs. They were correct
  // about a mechanism that no longer exists, and none of them asserted the thing
  // the user cares about.
  //
  // What remains is that thing, asserted directly. The rebuild writes to a
  // staging table with ordinary short transactions and swaps it in with one that
  // contains no `await`, so there is no window for anything to fall into. The
  // quiesce is not merely unnecessary — the exposure it bounded, and the two
  // residuals it could NOT bound (event-driven `insertAuditLog`, and
  // submissionSyncService's realtime subscription, which writes by the same path
  // as its poll but is not stopped by suspending the timer), are all structurally
  // impossible now.

  /** Rows the audit sync has uploaded to the cloud. */
  let cloudRows: string[] = [];

  /**
   * One tick of auditService's periodic sync, modelled: upload the unsynced
   * rows, then mark them synced locally — on the shared connection.
   *
   * Honours `auditSyncRunning` because that is what the real thing does: a
   * cleared interval does not fire. Nothing clears it any more, which is the
   * point of the first test below.
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

  it("keeps a background sync's write when the force re-import is cancelled", async () => {
    // The failure this prevents, in full: the tick uploads the row to the cloud
    // and marks it synced locally, the user cancels, and the rollback erases
    // only the LOCAL mark — leaving a row that exists in the cloud and looks
    // unsynced here, so it uploads again. The two stores disagree and nothing
    // reports it.
    //
    // The old fix was to make sure the tick could not fire. This one lets it
    // fire and keeps its work: the tick's write is its own short transaction and
    // commits immediately, so the cancelled re-import has nothing to roll it
    // back with.
    //
    // The distinguishing assertion is AGREEMENT between the two stores, not the
    // local value on its own — under the old design the correct state was
    // "neither", here it is "both", and only checking the cloud side tells a
    // correct state apart from a corrupt one.
    let cancelSent = false;
    const result = await macOSMessagesImportService.importMessages(
      USER,
      (progress) => {
        if (!cancelSent && progress.phase === "importing" && progress.current >= 1) {
          cancelSent = true;
          // The timer fires mid-rebuild. Nothing has stopped it, and nothing
          // needs to.
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
    expect(cloudRows).toEqual(["audit-1"]);
    expect(syncedAtOf("audit-1")).toBe("2026-08-21T00:00:00.000Z");
  });

  it("suspends nothing, on any force path", async () => {
    // The mechanism's absence, asserted where its presence used to be. If a
    // future change reintroduces a long transaction on this path it will almost
    // certainly reintroduce the quiesce with it, and this is what notices.
    await forceImportToCompletion();
    expect(writerEvents).toEqual([]);
    expect(auditSyncRunning).toBe(true);
    expect(submissionSyncRunning).toBe(true);

    // ...including the exit that stops before doing any work at all.
    writerEvents.length = 0;
    macOSMessagesImportService.requestCancellation();
    const cancelled = await forceImportToCompletion();
    expect(cancelled.rolledBack).toBe(true);
    expect(writerEvents).toEqual([]);
  });

  it("leaves the background writers alone for a DELTA import", async () => {
    // Unchanged, and it never had anything to do with the transaction: the delta
    // path has never taken one.
    mockDb.prepare("DELETE FROM messages").run();

    await importToCompletion();

    expect(writerEvents).toEqual([]);
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
