/**
 * @jest-environment node
 *
 * BACKLOG-2743 — the import must not try to copy more attachments than the disk holds.
 *
 * Before this change the ONLY limit on the attachment copy was a 100 MB PER-FILE
 * cap (`MAX_ATTACHMENT_SIZE`). Nothing anywhere on the import path looked at the
 * TOTAL size or at free disk space, so a large library would copy until the
 * volume filled — and on macOS, filling the volume makes the OS evict local Time
 * Machine snapshots to make room.
 *
 * These tests drive the REAL `storeAttachments` against a REAL better-sqlite3
 * database and REAL files on disk. Only two things are simulated:
 *   - `fs.promises.statfs`, so a refusal can be provoked without filling the
 *     machine's actual disk;
 *   - `app.getPath("userData")`, pointed at a scratch directory.
 * The copy itself, the content-hash dedup, and the eligibility gates all run for
 * real, which is what makes the estimate-vs-reality comparison meaningful.
 *
 * CONTROLS
 *   1. The guard REFUSES when the estimate exceeds free space — and refuses
 *      before the first copyFile, proven by the destination directory not even
 *      existing afterwards.
 *   2. The estimate is compared against the bytes ACTUALLY written by a real
 *      import, and the dedup ratio is recorded.
 *   4. A library that fits comfortably sees no refusal and no added delay.
 */

import * as os from "os";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as nodePath from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

// Injected in-memory DB, referenced lazily inside the databaseService mock.
let mockDb: DatabaseType;

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
jest.mock("../../utils/messageParser", () => ({
  __esModule: true,
  getMessageText: jest.fn(async () => ""),
}));
// cli-progress writes to stdout; silence the bar so test output stays readable.
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

import { app } from "electron";
import macOSMessagesImportService from "../macOSMessagesImportService";
import { summarizeAttachmentEstimate } from "../macOSMessagesImportService/importHelpers";
import { ATTACHMENTS_DIR, MAX_ATTACHMENT_SIZE } from "../macOSMessagesImportService/types";
import type { RawMacAttachment } from "../macOSMessagesImportService/types";
import type { AttachmentsRefusedForSpace } from "../macOSMessagesImportService/types";

const GB = 1024 * 1024 * 1024;
const USER = "user-2743";

interface StoreAttachmentsResult {
  stored: number;
  skipped: number;
  updated: number;
  refusedForSpace?: AttachmentsRefusedForSpace;
}
type StoreAttachmentsFn = (
  userId: string,
  attachments: RawMacAttachment[],
  messageIdMap: Map<string, string>,
) => Promise<StoreAttachmentsResult>;

// storeAttachments is private and uses `this`; bind it to the singleton so the
// production path is exercised faithfully.
const storeAttachments = (
  macOSMessagesImportService as unknown as { storeAttachments: StoreAttachmentsFn }
).storeAttachments.bind(macOSMessagesImportService) as StoreAttachmentsFn;

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      external_id TEXT
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      external_message_id TEXT,
      filename TEXT,
      mime_type TEXT,
      file_size_bytes INTEGER,
      storage_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/** Report a fixed amount of app-available space, without touching a real disk. */
function mockFreeSpace(availableGb: number): void {
  const bsize = 4096;
  jest.spyOn(fsSync.promises, "statfs").mockResolvedValue({
    type: 26,
    bsize,
    blocks: (500 * GB) / bsize,
    bfree: ((availableGb + 1) * GB) / bsize,
    bavail: (availableGb * GB) / bsize,
    files: 1000,
    ffree: 900,
  } as fsSync.StatsFs);
}

let scratchDir: string;
let sourceDir: string;

/**
 * Write a real source file and return the chat.db row that points at it.
 *
 * `total_bytes` is set to the file's real size — that is what chat.db stores and
 * what both the estimate and the copy loop read — EXCEPT where a test overrides
 * it to exercise the per-file cap without writing a 100 MB fixture.
 */
async function makeAttachment(
  name: string,
  contents: string,
  opts: { totalBytesOverride?: number; guid?: string } = {},
): Promise<{ row: RawMacAttachment; realBytes: number }> {
  const filePath = nodePath.join(sourceDir, name);
  await fs.writeFile(filePath, contents);
  const realBytes = (await fs.stat(filePath)).size;
  const guid = opts.guid ?? `msg-${name}`;
  return {
    row: {
      attachment_id: Math.floor(Math.random() * 1e9),
      message_id: 1,
      message_guid: guid,
      guid: `att-${name}`,
      filename: filePath,
      mime_type: null,
      transfer_name: name,
      total_bytes: opts.totalBytesOverride ?? realBytes,
      is_outgoing: 0,
    },
    realBytes,
  };
}

/** Total bytes actually written into the app's attachment store. */
async function bytesOnDisk(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { bytes: 0, files: 0 };
  }
  for (const entry of entries) {
    const stat = await fs.stat(nodePath.join(dir, entry));
    if (stat.isFile()) {
      bytes += stat.size;
      files++;
    }
  }
  return { bytes, files };
}

beforeEach(async () => {
  mockDb = new Database(":memory:");
  createSchema(mockDb);

  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-2743-app-"));
  sourceDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-2743-src-"));
  (app.getPath as jest.Mock).mockImplementation((name: string) =>
    name === "userData" ? scratchDir : `/tmp/test-${name}`,
  );
});

afterEach(async () => {
  jest.restoreAllMocks();
  mockDb?.close();
  await fs.rm(scratchDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

describe("BACKLOG-2743 — pre-flight free-space guard", () => {
  it("CONTROL 1: refuses the copy when the estimate exceeds free space, writing NOTHING", async () => {
    // A modest attachment set against a nearly-full volume. Before this change
    // the copy would simply start and run until the disk filled.
    const a = await makeAttachment("photo1.jpg", "x".repeat(200_000));
    const b = await makeAttachment("photo2.png", "y".repeat(150_000), { guid: "msg-b" });
    mockFreeSpace(0.5); // 0.5 GB available — below the estimate + headroom

    const map = new Map([
      [a.row.message_guid, "internal-a"],
      [b.row.message_guid, "internal-b"],
    ]);
    const result = await storeAttachments(USER, [a.row, b.row], map);

    expect(result.stored).toBe(0);
    expect(result.refusedForSpace).toBeDefined();
    expect(result.refusedForSpace!.availableBytes).toBe(0.5 * GB);
    expect(result.refusedForSpace!.estimatedBytes).toBe(a.realBytes + b.realBytes);

    // "Before the first copyFile" is the contract, not "before it filled up":
    // the destination directory is never even created.
    const attachmentsDir = nodePath.join(scratchDir, ATTACHMENTS_DIR);
    expect(fsSync.existsSync(attachmentsDir)).toBe(false);

    // And no attachment rows were written either.
    const rows = mockDb.prepare("SELECT COUNT(*) as c FROM attachments").get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it("CONTROL 2: estimate vs reality — bytes written match the estimate less content dedup", async () => {
    // photo2 holds byte-identical content to photo1: two chat.db rows, ONE file
    // on disk after the content-hash dedup. That gap is the dedup ratio, and it
    // is the reason the estimate is an upper bound rather than a prediction.
    const identical = "a".repeat(120_000);
    const p1 = await makeAttachment("photo1.jpg", identical, { guid: "m1" });
    const p2 = await makeAttachment("photo2.jpg", identical, { guid: "m2" });
    const p3 = await makeAttachment("photo3.png", "b".repeat(60_000), { guid: "m3" });
    const doc = await makeAttachment("contract.pdf", "c".repeat(30_000), { guid: "m4" });
    // Claims to be larger than the per-file cap — skipped by BOTH the estimate
    // and the copy loop, without writing a 100 MB fixture.
    const huge = await makeAttachment("movie.mov", "d".repeat(1_000), {
      totalBytesOverride: MAX_ATTACHMENT_SIZE + 1,
      guid: "m5",
    });
    // Unsupported extension — skipped by both.
    const junk = await makeAttachment("notes.xyz", "e".repeat(5_000), { guid: "m6" });

    const rows = [p1.row, p2.row, p3.row, doc.row, huge.row, junk.row];
    const estimate = summarizeAttachmentEstimate(rows);

    // The estimate counts every ELIGIBLE row, including both copies of the
    // identical pair.
    expect(estimate.eligibleCount).toBe(4);
    expect(estimate.eligibleBytes).toBe(
      p1.realBytes + p2.realBytes + p3.realBytes + doc.realBytes,
    );
    expect(estimate.skippedOversizeCount).toBe(1);
    expect(estimate.skippedUnsupportedCount).toBe(1);

    mockFreeSpace(100); // comfortable — the copy proceeds for real
    const map = new Map(rows.map((r, i) => [r.message_guid, `internal-${i}`]));
    const result = await storeAttachments(USER, rows, map);

    expect(result.refusedForSpace).toBeUndefined();

    const attachmentsDir = nodePath.join(scratchDir, ATTACHMENTS_DIR);
    const written = await bytesOnDisk(attachmentsDir);

    // Reality: three distinct files, the identical pair collapsed into one.
    expect(written.files).toBe(3);
    expect(written.bytes).toBe(p1.realBytes + p3.realBytes + doc.realBytes);

    // The estimate is an UPPER BOUND — never below what was written. A guard
    // that under-estimates is the dangerous direction; this pins the sign.
    expect(estimate.eligibleBytes).toBeGreaterThanOrEqual(written.bytes);

    // Dedup ratio for the record: written / estimated.
    const dedupRatio = written.bytes / estimate.eligibleBytes;
    expect(dedupRatio).toBeCloseTo(210_000 / 330_000, 5);

    // All four eligible rows are recorded, including the deduped one (it links
    // to the existing file rather than copying again).
    expect(result.stored).toBe(4);
  });

  it("CONTROL 4: a library that fits comfortably is not refused and adds no delay", async () => {
    const small = await makeAttachment("snap.jpg", "z".repeat(40_000), { guid: "s1" });
    mockFreeSpace(200);

    const started = Date.now();
    const result = await storeAttachments(
      USER,
      [small.row],
      new Map([[small.row.message_guid, "internal-s1"]]),
    );
    const elapsed = Date.now() - started;

    expect(result.refusedForSpace).toBeUndefined();
    expect(result.stored).toBe(1);
    // The guard is one statfs call; it must not add anything a user could feel.
    expect(elapsed).toBeLessThan(1000);
  });

  it("proceeds when free space is UNKNOWN rather than blocking every import", async () => {
    // statfs unavailable => fail open. copyFile's ENOSPC remains the backstop.
    jest.spyOn(fsSync.promises, "statfs").mockRejectedValue(new Error("ENOTSUP"));
    const a = await makeAttachment("photo.jpg", "q".repeat(10_000), { guid: "u1" });

    const result = await storeAttachments(
      USER,
      [a.row],
      new Map([[a.row.message_guid, "internal-u1"]]),
    );

    expect(result.refusedForSpace).toBeUndefined();
    expect(result.stored).toBe(1);
  });

  it("refuses on the TOTAL size even though every single file passes the per-file cap", async () => {
    // This is the exact shape of the reported failure: the 100 MB per-file cap
    // is satisfied by every attachment, and the set still does not fit.
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const a = await makeAttachment(`clip${i}.mov`, "m".repeat(1_000), {
        totalBytesOverride: 50 * 1024 * 1024, // 50 MB each: under the per-file cap
        guid: `t${i}`,
      });
      rows.push(a.row);
    }
    // Every file passes MAX_ATTACHMENT_SIZE individually...
    expect(rows.every((r) => r.total_bytes <= MAX_ATTACHMENT_SIZE)).toBe(true);

    mockFreeSpace(0.1);
    const result = await storeAttachments(
      USER,
      rows,
      new Map(rows.map((r, i) => [r.message_guid, `internal-t${i}`])),
    );

    // ...and the set is still refused, which the per-file cap alone could never do.
    expect(result.stored).toBe(0);
    expect(result.refusedForSpace!.estimatedBytes).toBe(5 * 50 * 1024 * 1024);
    expect(fsSync.existsSync(nodePath.join(scratchDir, ATTACHMENTS_DIR))).toBe(false);
  });
});
