/**
 * @jest-environment node
 *
 * BACKLOG-4040 S2 (absorbs BACKLOG-3135) — Mac Messages Force Re-import deletes
 * the attachment FILES it replaced, after the swap commits, and only files no
 * remaining row uses.
 *
 * Drives the real `importMessages` against the REAL drivers (better-sqlite3 for
 * the store, sqlite3 for chat.db), the real at-rest writer and real files in a
 * temp userData, on the harness of macOSMessagesImportService.stageAndSwap-2790.
 *
 *   F1  "Import message text only" ON: each Mac-only file is gone; a file shared
 *       with an iPhone row (relative path, upper-case extension: the SR C-7 /
 *       P1r shape), a Google Messages row and another user's Mac row stays.
 *       RED before S2 (3135: rows deleted, files kept).
 *   F2  attachments ON: every file the re-imported rows point at stays, rows are
 *       replaced; the file of a text that LEFT the window goes.
 *   F3  the swap throws / the run is cancelled: no file is touched.
 *   F4  the cleanup itself fails after the commit: the import still succeeds,
 *       the rows are the new ones, the files are still there (orphans), never a
 *       row whose file was deleted.
 *
 * Foreign rows are transcribed from their writers: iPhone `metadata.source =
 * "iphone_sync"` (iPhoneSyncStorageService.ts, buildMessage metadata), Google
 * Messages `"google_messages_web"` (rcsClear-3657 fixture), Mac
 * `"macos_messages"` (MACOS_IMPORT_METADATA_SOURCE). Their GUIDs are NOT Mac
 * GUIDs, so the force set's by-external-id DELETE cannot reach them.
 */

import * as os from "os";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as nodePath from "path";
import * as crypto from "crypto";
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
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
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
jest.mock("../attachmentTextExtractionService", () => ({
  extractTextForAttachment: jest.fn().mockResolvedValue(undefined),
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
  default: { suspendPeriodicSync: jest.fn(() => false), resumePeriodicSync: jest.fn(), isSyncInFlight: jest.fn(() => false) },
}));
jest.mock("../submissionSyncService", () => ({
  __esModule: true,
  default: { suspendPeriodicSync: jest.fn(() => false), resumePeriodicSync: jest.fn(), isSyncInFlight: jest.fn(() => false) },
}));
// The REAL sqlite3 driver for chat.db (jest.config maps `sqlite3` to a stub).
jest.mock("sqlite3", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(require("path").join(__dirname, "..", "..", "..", "node_modules", "sqlite3")),
);

import { app } from "electron";
import macOSMessagesImportService from "../macOSMessagesImportService";
import { testImportPlan, FIXED_NOW } from "./helpers/importPlanFixture";
import { forceSwapSteps } from "../macOSMessagesImportService/forceStaging";
import * as attachmentFileRefs from "../attachmentFileRefs";
import { getDataKeyService } from "../atRest/dataKeyService";
import { resetAtRestWriteRefusalForTests } from "../atRest/attachmentWriter";
import type { MacOSImportResult } from "../macOSMessagesImportService/types";

const USER = "user-4040s2";
const OTHER = "user-4040s2-other";
const MAC_EPOCH_MS = Date.UTC(2001, 0, 1);
/** chat.db `message.date`: nanoseconds since 2001-01-01. */
const macNanos = (d: Date) => (d.getTime() - MAC_EPOCH_MS) * 1e6;
const RECENT = new Date(FIXED_NOW.getTime() - 20 * 24 * 3600 * 1000);
const OLD = new Date("2023-03-01T12:00:00Z");
const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * The Mac texts with attachments. `n` = chat.db message ROWID, guid msg-guid-n.
 *   A  Mac-only
 *   B  Mac-only, upper-case transfer name
 *   C  shared with an iPhone row (relative + upper-case extension)
 *   D  shared with a Google Messages row
 *   E  shared with ANOTHER user's Mac row
 */
const ATT = [
  { n: 1, key: "A", name: "photo-1.jpg" },
  { n: 2, key: "B", name: "SHOT.PNG" },
  { n: 3, key: "C", name: "photo-3.jpg" },
  { n: 4, key: "D", name: "photo-4.jpg" },
  { n: 5, key: "E", name: "photo-5.jpg" },
] as const;
type Key = (typeof ATT)[number]["key"];
const TEXT_ONLY_MESSAGES = 3; // 6..8: texts with no attachment

let homeDir: string;
let scratchDir: string;
let realHome: string | undefined;
const bytes: Record<string, Buffer> = {};
/** When set, message 1's date (A) is OLD instead of RECENT. */
let oldMessageOne = false;

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
    INSERT INTO message (guid, text, attributedBody, date, is_from_me, handle_id, service,
      cache_has_attachments, associated_message_type, associated_message_guid)
    VALUES (?, ?, NULL, ?, 0, 1, 'iMessage', ?, NULL, NULL)
  `);
  const joinChat = db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)");
  const insertAtt = db.prepare(
    "INSERT INTO attachment (guid, filename, mime_type, transfer_name, total_bytes, is_outgoing) VALUES (?, ?, NULL, ?, ?, 0)",
  );
  const joinAtt = db.prepare("INSERT INTO message_attachment_join (attachment_id, message_id) VALUES (?, ?)");
  db.transaction(() => {
    for (const a of ATT) {
      const date = a.n === 1 && oldMessageOne ? OLD : RECENT;
      insertMessage.run(`msg-guid-${a.n}`, `hello ${a.n}`, macNanos(date) + a.n, 1);
      joinChat.run(a.n);
      insertAtt.run(`att-guid-${a.n}`, `~/Library/Messages/Attachments/0${a.n}/${a.name}`, a.name, bytes[a.key].length);
      joinAtt.run(a.n, a.n);
    }
    for (let i = 0; i < TEXT_ONLY_MESSAGES; i++) {
      const n = ATT.length + 1 + i;
      insertMessage.run(`msg-guid-${n}`, `hello ${n}`, macNanos(RECENT) + n, 0);
      joinChat.run(n);
    }
  })();
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

const msgDir = () => nodePath.join(scratchDir, "message-attachments");
/** Exact names on disk (readdir, so a case-insensitive volume cannot answer for a variant). */
async function filesOnDisk(): Promise<string[]> {
  return (await fs.readdir(msgDir()).catch(() => [] as string[])).sort();
}
/** The stored file of key k, by hash (any extension case). */
async function hasFileFor(k: Key): Promise<boolean> {
  const h = sha256(bytes[k]);
  return (await filesOnDisk()).some((f) => f.toLowerCase().startsWith(h));
}
function macRows(): Array<{ id: string; external_message_id: string; storage_path: string }> {
  return mockDb
    .prepare(
      `SELECT a.id, a.external_message_id, a.storage_path FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.user_id = ? AND json_extract(m.metadata, '$.source') = 'macos_messages'
       ORDER BY a.external_message_id`,
    )
    .all(USER) as Array<{ id: string; external_message_id: string; storage_path: string }>;
}
function foreignRows(): Array<{ id: string; storage_path: string }> {
  return mockDb
    .prepare("SELECT id, storage_path FROM attachments WHERE id LIKE 'foreign-%' ORDER BY id")
    .all() as Array<{ id: string; storage_path: string }>;
}

/** The Mac file name the first import stored for key k (its own spelling). */
function storedName(k: Key): string {
  const n = ATT.find((a) => a.key === k)!.n;
  const row = macRows().find((r) => r.external_message_id === `msg-guid-${n}`)!;
  return nodePath.basename(row.storage_path);
}

/** Rows another writer left for the same bytes, AFTER the first Mac import stored the files. */
function seedForeignRows(): void {
  const insMsg = mockDb.prepare(
    "INSERT INTO messages (id, user_id, channel, external_id, body_text, metadata) VALUES (?, ?, ?, ?, 'x', ?)",
  );
  const insAtt = mockDb.prepare(
    "INSERT INTO attachments (id, message_id, external_message_id, filename, storage_path) VALUES (?, ?, ?, ?, ?)",
  );
  const c = storedName("C");
  // iPhone: relative path, upper-case extension (SR C-7 / P1r).
  insMsg.run("foreign-msg-iphone", USER, "sms", "iphone-guid-1", JSON.stringify({ source: "iphone_sync" }));
  insAtt.run(
    "foreign-iphone",
    "foreign-msg-iphone",
    "iphone-guid-1",
    "IMG.JPG",
    `message-attachments/${c.slice(0, c.lastIndexOf("."))}${nodePath.extname(c).toUpperCase()}`,
  );
  // Google Messages for Web: absolute path, same user.
  insMsg.run("foreign-msg-gmweb", USER, "sms", "gmweb:conv4040s2:1", JSON.stringify({ source: "google_messages_web" }));
  insAtt.run("foreign-gmweb", "foreign-msg-gmweb", "gmweb:conv4040s2:1", "photo.jpg", nodePath.join(msgDir(), storedName("D")));
  // Another user's Mac import on this Mac: outside this user's force set.
  insMsg.run("foreign-msg-other", OTHER, "imessage", "msg-guid-other-5", JSON.stringify({ source: "macos_messages" }));
  insAtt.run("foreign-other", "foreign-msg-other", "msg-guid-other-5", "photo-5.jpg", nodePath.join(msgDir(), storedName("E")));
}

function runImport(opts: { force: boolean; textOnly?: boolean; lookbackMonths?: number | null }): Promise<MacOSImportResult> {
  return macOSMessagesImportService.importMessages(
    USER,
    undefined,
    testImportPlan({
      mode: opts.force ? "reprocess" : "delta",
      storedFilters: {
        lookbackMonths: opts.lookbackMonths ?? null,
        maxMessages: null,
        ...(opts.textOnly ? { skipAttachments: true } : {}),
      },
    }),
  );
}

/** First import (attachments ON), then the foreign rows. Returns the files on disk. */
async function setUpLibrary(): Promise<string[]> {
  const first = await runImport({ force: false });
  expect(first.success).toBe(true);
  expect(macRows()).toHaveLength(ATT.length);
  for (const a of ATT) expect(await hasFileFor(a.key)).toBe(true);
  seedForeignRows();
  return filesOnDisk();
}

beforeEach(async () => {
  oldMessageOne = false;
  for (const a of ATT) bytes[a.key] = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2048)]);
  mockDb = new Database(":memory:");
  createStoreSchema(mockDb);
  homeDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-4040s2-home-"));
  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-4040s2-app-"));
  await fs.mkdir(nodePath.join(homeDir, "Library", "Messages"), { recursive: true });
  for (const a of ATT) {
    const dir = nodePath.join(homeDir, "Library", "Messages", "Attachments", `0${a.n}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(nodePath.join(dir, a.name), bytes[a.key]);
  }
  realHome = process.env.HOME;
  process.env.HOME = homeDir;
  (app.getPath as jest.Mock).mockImplementation((name: string) =>
    name === "userData" ? scratchDir : nodePath.join(scratchDir, `path-${name}`),
  );
  getDataKeyService().clearCache();
  resetAtRestWriteRefusalForTests();
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

describe("F1 — text only ON: the Mac-only files go, shared files stay (3135)", () => {
  beforeEach(() => createSourceDb(nodePath.join(homeDir, "Library", "Messages", "chat.db")));

  it("deletes each Mac-only file and keeps every file another row uses", async () => {
    await setUpLibrary();
    const foreignBefore = foreignRows();

    const result = await runImport({ force: true, textOnly: true });

    expect(result.success).toBe(true);
    expect(macRows()).toEqual([]);
    expect(foreignRows()).toEqual(foreignBefore);
    expect({
      A: await hasFileFor("A"),
      B: await hasFileFor("B"),
      C: await hasFileFor("C"),
      D: await hasFileFor("D"),
      E: await hasFileFor("E"),
    }).toEqual({ A: false, B: false, C: true, D: true, E: true });
  });
});

describe("F2 — attachments ON: re-linked files stay, rows are replaced", () => {
  it("keeps every re-imported file and replaces the rows", async () => {
    createSourceDb(nodePath.join(homeDir, "Library", "Messages", "chat.db"));
    const before = await setUpLibrary();
    const idsBefore = macRows().map((r) => r.id);

    const result = await runImport({ force: true });

    expect(result.success).toBe(true);
    const after = macRows();
    expect(after).toHaveLength(ATT.length);
    expect(after.map((r) => r.id).filter((id) => idsBefore.includes(id))).toEqual([]);
    for (const r of after) expect(fsSync.existsSync(r.storage_path)).toBe(true);
    expect(await filesOnDisk()).toEqual(before);
  });

  it("deletes the file of a text that left the window, and only that one", async () => {
    oldMessageOne = true;
    createSourceDb(nodePath.join(homeDir, "Library", "Messages", "chat.db"));
    await setUpLibrary();

    const result = await runImport({ force: true, lookbackMonths: 3 });

    expect(result.success).toBe(true);
    expect(macRows().map((r) => r.external_message_id)).toEqual(["msg-guid-2", "msg-guid-3", "msg-guid-4", "msg-guid-5"]);
    expect({
      A: await hasFileFor("A"),
      B: await hasFileFor("B"),
      C: await hasFileFor("C"),
      D: await hasFileFor("D"),
      E: await hasFileFor("E"),
    }).toEqual({ A: false, B: true, C: true, D: true, E: true });
  });
});

describe("F3 — no commit, no file deleted", () => {
  beforeEach(() => createSourceDb(nodePath.join(homeDir, "Library", "Messages", "chat.db")));

  it("the swap throws: every row and every file is still there", async () => {
    const before = await setUpLibrary();
    const rowsBefore = macRows();
    jest.spyOn(forceSwapSteps, "insertFromStaging").mockImplementation(() => {
      throw new Error("injected: swap failed after the delete");
    });

    const result = await runImport({ force: true, textOnly: true }).catch((e: unknown) => ({ success: false, error: String(e) }) as MacOSImportResult);

    expect(result.success).toBe(false);
    expect(macRows()).toEqual(rowsBefore);
    expect(await filesOnDisk()).toEqual(before);
  });

  it("the run is cancelled: every row and every file is still there", async () => {
    const before = await setUpLibrary();
    const rowsBefore = macRows();

    let cancelSent = false;
    const result = await macOSMessagesImportService.importMessages(
      USER,
      (progress) => {
        if (!cancelSent && progress.phase === "importing") {
          cancelSent = true;
          macOSMessagesImportService.requestCancellation();
        }
      },
      testImportPlan({ mode: "reprocess", storedFilters: { lookbackMonths: null, maxMessages: null, skipAttachments: true } }),
    );

    expect(cancelSent).toBe(true);
    expect(result.success).toBe(false);
    expect(macRows()).toEqual(rowsBefore);
    expect(await filesOnDisk()).toEqual(before);
  });
});

describe("F4 — the cleanup fails after the commit", () => {
  beforeEach(() => createSourceDb(nodePath.join(homeDir, "Library", "Messages", "chat.db")));

  it("the import succeeds, the rows are the new ones, the files are left (never a row without its file)", async () => {
    const before = await setUpLibrary();
    const spy = jest
      .spyOn(attachmentFileRefs, "removeUnreferencedAttachmentFiles")
      .mockRejectedValue(new Error("injected: crash before unlink"));

    const result = await runImport({ force: true, textOnly: true });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(macRows()).toEqual([]);
    expect(await filesOnDisk()).toEqual(before);
    for (const r of foreignRows()) {
      const abs = nodePath.isAbsolute(r.storage_path) ? r.storage_path : nodePath.join(scratchDir, r.storage_path);
      expect(fsSync.existsSync(abs)).toBe(true);
    }
  });
});
