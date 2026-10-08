/**
 * @jest-environment node
 */
/**
 * BACKLOG-3763 — the conversation view gets attachment METADATA in one reply,
 * and each image's bytes on demand, by attachment id.
 *
 * Before: `messages:get-attachments-batch` read every attachment file of the
 * opened conversation with readFileSync on the main thread and returned all of
 * them as base64 in one reply (no cap). 50 x 2 MB photos ~ 133 MB of IPC.
 *
 * Under test:
 *  1. the batch reply carries no file bytes, and no file is read to build it;
 *  2. `messages:get-attachment-data` serves bytes for an attachment of a text
 *     owned by the signed-in user, and refuses an unknown id, a path, another
 *     user's attachment, a file outside the app data directory, a file over
 *     the cap, and any request without a session.
 *
 * Fixture provenance: `users_local`, `messages`, `attachments` come from the
 * REAL `electron/database/schema.sql`; attachment rows use the macOS import's
 * insert shape (id, message_id, external_message_id, filename, mime_type,
 * file_size_bytes, storage_path — macOSMessagesImportService storeAttachments).
 * The batch handler's lookup (`getAttachmentsByMessageIds`) is mocked to the
 * row shape it returns (id, message_id, filename, mime_type, file_size_bytes,
 * storage_path); `getAttachmentAsBase64` is mocked to the production body
 * (readFileSync -> base64) so a regression that reads files is visible as a
 * call AND as bytes in the reply.
 *
 * Measurement (not run by default — writes 100 MB): MEASURE_3763=1 runs the
 * 50 x 2 MB conversation and prints the reply size.
 */

import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import type { IpcMainInvokeEvent } from "electron";
import { openTestDb, type TestDb } from "../../services/__tests__/helpers/syncSqliteDriver";

let db: TestDb;
let userData: string;
let outside: string;

const mockIpcHandle = jest.fn();
jest.mock("electron", () => ({
  ipcMain: { handle: (...args: unknown[]) => mockIpcHandle(...args), on: jest.fn() },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: () => userData },
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: () => db,
  },
}));

const mockLoadSession = jest.fn();
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: (...a: unknown[]) => mockLoadSession(...a) },
}));

const mockGetAttachmentsByMessageIds = jest.fn();
const mockGetAttachmentAsBase64 = jest.fn((p: string) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("fs") as typeof import("fs")).readFileSync(p).toString("base64");
});
jest.mock("../../services/macOSMessagesImportService", () => ({
  __esModule: true,
  default: {
    getAttachmentsByMessageIds: (...a: unknown[]) => mockGetAttachmentsByMessageIds(...a),
    getAttachmentAsBase64: (p: string) => mockGetAttachmentAsBase64(p),
  },
}));

jest.mock("../../services/db/externalContactDbService", () => ({}));
jest.mock("../../services/autoLinkService", () => ({
  autoLinkNewMessagesForUser: jest.fn().mockResolvedValue(undefined),
  expandAttachedThreadsForUser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/importPlanInputs", () => ({
  resolveImportPlanForUser: jest.fn(),
  loadStoredImportFilters: jest.fn().mockResolvedValue({}),
}));

import { registerMessageImportHandlers } from "../messageImportHandlers";
import { MAX_INLINE_ATTACHMENT_BYTES } from "../../services/textAttachmentDataService";

const USER_A = "3763a000-0000-4000-8000-00000000000a"; // pii-allow-uuid: invented, not from any live row
const USER_B = "3763b000-0000-4000-8000-00000000000b"; // pii-allow-uuid: invented, not from any live row

const SCHEMA_PATH = path.join(__dirname, "../../database/schema.sql");

type Handler = (event: IpcMainInvokeEvent, ...args: never[]) => Promise<unknown>;
const registered = new Map<string, Handler>();
function handlerFor(channel: string): Handler {
  const entry = registered.get(channel);
  if (!entry) throw new Error(`No handler registered for ${channel}`);
  return entry;
}
const EVENT = {} as IpcMainInvokeEvent;

beforeAll(() => {
  registerMessageImportHandlers({
    isDestroyed: () => false,
    webContents: { send: jest.fn() },
  } as never);
  for (const [channel, handler] of mockIpcHandle.mock.calls as Array<[string, Handler]>) {
    registered.set(channel, handler);
  }
});

interface SeededAttachment {
  id: string;
  message_id: string;
  filename: string;
  mime_type: string;
  file_size_bytes: number;
  storage_path: string;
}

function seedMessage(id: string, userId: string, externalId: string): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, external_id, body_text, sent_at)
     VALUES (?, ?, 'imessage', 'inbound', ?, '', '2026-09-01T12:00:00Z')`,
  ).run(id, userId, externalId);
}

function seedAttachment(
  att: SeededAttachment,
  opts: { externalMessageId?: string | null; bytes?: Buffer } = {},
): void {
  if (opts.bytes) {
    mkdirSync(path.dirname(att.storage_path), { recursive: true });
    writeFileSync(att.storage_path, opts.bytes);
  }
  db.prepare(
    `INSERT INTO attachments (id, message_id, external_message_id, filename, mime_type, file_size_bytes, storage_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    att.id,
    att.message_id,
    opts.externalMessageId ?? null,
    att.filename,
    att.mime_type,
    att.file_size_bytes,
    att.storage_path,
  );
}

/** N messages of USER_A, one photo each, written to disk under userData. */
function seedConversation(n: number, bytesEach: number): SeededAttachment[] {
  const out: SeededAttachment[] = [];
  const payload = Buffer.alloc(bytesEach, 0x5a);
  for (let i = 0; i < n; i++) {
    const msgId = `msg-3763-${i}`;
    seedMessage(msgId, USER_A, `guid-3763-${i}`);
    const att: SeededAttachment = {
      id: `att3763-${String(i).padStart(4, "0")}`,
      message_id: msgId,
      filename: `IMG_${i}.jpg`,
      mime_type: "image/jpeg",
      file_size_bytes: bytesEach,
      storage_path: path.join(userData, "message-attachments", `att-${i}.jpg`),
    };
    seedAttachment(att, { bytes: payload });
    out.push(att);
  }
  // The batch lookup's real result shape: Map<message_id, rows>.
  mockGetAttachmentsByMessageIds.mockImplementation((ids: string[]) => {
    const map = new Map<string, SeededAttachment[]>();
    for (const a of out) if (ids.includes(a.message_id)) map.set(a.message_id, [a]);
    return map;
  });
  return out;
}

/** Every string value anywhere in a reply. */
function allStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, acc));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => allStrings(v, acc));
  return acc;
}

beforeEach(() => {
  jest.clearAllMocks();
  userData = mkdtempSync(path.join(os.tmpdir(), "keepr-3763-ud-"));
  outside = mkdtempSync(path.join(os.tmpdir(), "keepr-3763-out-"));
  db = openTestDb();
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  const insertUser = db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`,
  );
  insertUser.run(USER_A, "a@example.com", "oauth-3763-a");
  insertUser.run(USER_B, "b@example.com", "oauth-3763-b");
  mockLoadSession.mockResolvedValue({ user: { id: USER_A } });
});

afterEach(() => {
  db.close();
  rmSync(userData, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("messages:get-attachments-batch (BACKLOG-3763)", () => {
  it("returns metadata for every attachment and no file bytes", async () => {
    const N = 20;
    const BYTES = 64 * 1024;
    const seeded = seedConversation(N, BYTES);

    const reply = (await handlerFor("messages:get-attachments-batch")(
      EVENT,
      seeded.map((a) => a.message_id) as never,
    )) as Record<string, Array<Record<string, unknown>>>;

    // Every attachment is listed, with the fields the view renders from.
    const ids = Object.values(reply).flat().map((a) => a.id).sort();
    expect(ids).toEqual(seeded.map((a) => a.id).sort());
    for (const att of Object.values(reply).flat()) {
      expect(Object.keys(att).sort()).toEqual(
        ["file_size_bytes", "filename", "id", "message_id", "mime_type"],
      );
    }

    // No file was read, and nothing in the reply is file-sized.
    expect(mockGetAttachmentAsBase64).not.toHaveBeenCalled();
    const longest = Math.max(...allStrings(reply).map((s) => s.length));
    expect(longest).toBeLessThan(256);
    expect(JSON.stringify(reply).length).toBeLessThan(N * 512);
  });

  const measure = process.env.MEASURE_3763 === "1" ? it : it.skip;
  measure("MEASURE: 50 x 2 MB conversation reply size", async () => {
    const seeded = seedConversation(50, 2 * 1024 * 1024);
    const t0 = Date.now();
    const reply = await handlerFor("messages:get-attachments-batch")(
      EVENT,
      seeded.map((a) => a.message_id) as never,
    );
    const ms = Date.now() - t0;
    process.stderr.write(`MEASURE_3763 reply_bytes=${JSON.stringify(reply).length} handler_ms=${ms}\n`);
  });
});

describe("messages:get-attachment-data (BACKLOG-3763)", () => {
  const call = (arg: unknown) =>
    handlerFor("messages:get-attachment-data")(EVENT, arg as never) as Promise<{
      success: boolean;
      data?: string;
      mime_type?: string | null;
      reason?: string;
    }>;

  it("returns the bytes of one attachment owned by the signed-in user", async () => {
    const [att] = seedConversation(3, 1024);
    const result = await call(att.id);
    expect(result).toEqual({
      success: true,
      data: Buffer.alloc(1024, 0x5a).toString("base64"),
      mime_type: "image/jpeg",
    });
  });

  it("serves an attachment found through the Apple-id fallback (BACKLOG-3731 rule)", async () => {
    seedMessage("msg-3763-live", USER_A, "guid-3763-live");
    // A row whose message_id names a message that no longer exists.
    seedMessage("msg-3763-gone", USER_A, "guid-3763-gone");
    const att: SeededAttachment = {
      id: "att3763-fallback",
      message_id: "msg-3763-gone",
      filename: "IMG_f.jpg",
      mime_type: "image/jpeg",
      file_size_bytes: 10,
      storage_path: path.join(userData, "message-attachments", "f.jpg"),
    };
    seedAttachment(att, { externalMessageId: "guid-3763-live", bytes: Buffer.from("fallback!!") });
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM messages WHERE id = 'msg-3763-gone'").run();
    db.exec("PRAGMA foreign_keys = ON");

    const result = await call(att.id);
    expect(result.success).toBe(true);
  });

  it("refuses an id that is not in the database", async () => {
    seedConversation(2, 16);
    expect(await call("att3763-nope")).toEqual({ success: false, reason: "not_found" });
  });

  it.each([
    ["relative path", "../../etc/passwd"],
    ["absolute path", "/etc/passwd"],
    ["windows path", "C:\\Windows\\win.ini"],
    ["empty", ""],
    ["non-string", { storage_path: "/etc/passwd" }],
  ])("refuses path-like or malformed input (%s) without a lookup", async (_label, input) => {
    seedConversation(1, 16);
    expect(await call(input)).toEqual({ success: false, reason: "invalid_id" });
  });

  it("refuses another user's attachment", async () => {
    seedMessage("msg-3763-b", USER_B, "guid-3763-b");
    const att: SeededAttachment = {
      id: "att3763-userb",
      message_id: "msg-3763-b",
      filename: "IMG_b.jpg",
      mime_type: "image/jpeg",
      file_size_bytes: 5,
      storage_path: path.join(userData, "message-attachments", "b.jpg"),
    };
    seedAttachment(att, { bytes: Buffer.from("userb") });

    expect(await call(att.id)).toEqual({ success: false, reason: "not_found" });
    // Positive control on the same row: its owner gets it.
    mockLoadSession.mockResolvedValue({ user: { id: USER_B } });
    expect((await call(att.id)).success).toBe(true);
  });

  it("refuses everything when no one is signed in", async () => {
    const [att] = seedConversation(1, 16);
    mockLoadSession.mockResolvedValue(null);
    expect(await call(att.id)).toEqual({ success: false, reason: "not_signed_in" });
  });

  it("refuses a stored path outside the app data directory", async () => {
    seedMessage("msg-3763-x", USER_A, "guid-3763-x");
    const att: SeededAttachment = {
      id: "att3763-outside",
      message_id: "msg-3763-x",
      filename: "x.jpg",
      mime_type: "image/jpeg",
      file_size_bytes: 3,
      storage_path: path.join(outside, "x.jpg"),
    };
    seedAttachment(att, { bytes: Buffer.from("out") });
    expect(await call(att.id)).toEqual({ success: false, reason: "outside_app_data" });
  });

  it("refuses a file over the size cap, and serves one exactly at it", async () => {
    seedMessage("msg-3763-big", USER_A, "guid-3763-big");
    const big: SeededAttachment = {
      id: "att3763-big",
      message_id: "msg-3763-big",
      filename: "big.jpg",
      mime_type: "image/jpeg",
      file_size_bytes: MAX_INLINE_ATTACHMENT_BYTES + 1,
      storage_path: path.join(userData, "message-attachments", "big.jpg"),
    };
    seedAttachment(big, { bytes: Buffer.alloc(MAX_INLINE_ATTACHMENT_BYTES + 1) });
    expect(await call(big.id)).toEqual({ success: false, reason: "too_large" });

    const atCap: SeededAttachment = {
      ...big,
      id: "att3763-atcap",
      storage_path: path.join(userData, "message-attachments", "atcap.jpg"),
    };
    seedAttachment(atCap, { bytes: Buffer.alloc(MAX_INLINE_ATTACHMENT_BYTES) });
    expect((await call(atCap.id)).success).toBe(true);
  });

  it("reports a missing file", async () => {
    seedMessage("msg-3763-m", USER_A, "guid-3763-m");
    seedAttachment({
      id: "att3763-missing",
      message_id: "msg-3763-m",
      filename: "m.jpg",
      mime_type: "image/jpeg",
      file_size_bytes: 3,
      storage_path: path.join(userData, "message-attachments", "never-written.jpg"),
    });
    expect(await call("att3763-missing")).toEqual({ success: false, reason: "missing_file" });
  });
});
