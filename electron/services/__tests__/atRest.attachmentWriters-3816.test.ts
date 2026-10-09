/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S1 — every attachment WRITER stores KEPRENC ciphertext.
 *
 * Runs the real writers (iPhone sync storeAttachments, macOS Messages
 * storeAttachments, email downloadEmailAttachments) against a real temp
 * userData and the REAL at-rest stack (dataKeyService + fileCrypto, key wrapped
 * by the test SecretStore). Nothing in the crypto path is mocked.
 *
 * Controls:
 *   W1 after each writer runs, the stored file starts with "KEPRENC", carries no
 *      JPEG/PNG/HEIC/PDF/SQLite magic, does not contain the plaintext, and
 *      decrypts back to it.
 *   W2 the dedupe hash (= the stored file name) is SHA-256 of the PLAINTEXT.
 *   F  (fix-up, SR R1/R2/A1) an attachment whose CONTENT starts with "KEPRENC" is
 *      plaintext like any other: writers read sources raw and store it sealed;
 *      a pre-upgrade plaintext file with that prefix reads back unchanged; a source
 *      that changes between hash and seal stores nothing.
 *   W3 file-data key unavailable -> nothing plaintext is written, the writer
 *      throws/returns the typed refusal, and the run STOPS (it is not swallowed
 *      into a per-attachment "skipped").
 *
 * Fixture shapes are transcribed from the producers, not invented:
 *   iOSAttachment            electron/types/iosMessages.ts:27 {id, guid, filename, mimeType, transferName}
 *   RawMacAttachment         electron/services/macOSMessagesImportService/types.ts:259
 *   EmailAttachmentMeta      electron/services/emailAttachmentService.ts:41
 *   attachments row columns  electron/database/schema.sql:31 (id, message_id, external_message_id,
 *                            filename, mime_type, file_size_bytes, storage_path)
 * File contents are synthetic bytes behind each format's real magic number.
 */

import * as os from "os";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as nodePath from "path";
import * as crypto from "crypto";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let mockDb: DatabaseType;
const iphoneDb = {
  getMessageIdMap: jest.fn(),
  getAttachmentStoragePaths: jest.fn(),
  getExistingAttachmentRecords: jest.fn(),
  insertAttachment: jest.fn(),
};
const emailDb = {
  findEmailAttachmentRow: jest.fn(),
  createAttachmentRecord: jest.fn(),
  setEmailAttachmentStorage: jest.fn(),
};

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
  default: {
    getRawDatabase: () => mockDb,
    getMessageIdMap: (...a: unknown[]) => iphoneDb.getMessageIdMap(...a),
    getAttachmentStoragePaths: (...a: unknown[]) => iphoneDb.getAttachmentStoragePaths(...a),
    getExistingAttachmentRecords: (...a: unknown[]) => iphoneDb.getExistingAttachmentRecords(...a),
    insertAttachment: (...a: unknown[]) => iphoneDb.insertAttachment(...a),
    findEmailAttachmentRow: (...a: unknown[]) => emailDb.findEmailAttachmentRow(...a),
    createAttachmentRecord: (...a: unknown[]) => emailDb.createAttachmentRecord(...a),
    setEmailAttachmentStorage: (...a: unknown[]) => emailDb.setEmailAttachmentStorage(...a),
  },
}));
jest.mock("../db/externalContactDbService");
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: { resolveAttachmentPath: jest.fn(), flushRejectedPathSummary: jest.fn() },
}));
jest.mock("../gmailFetchService", () => ({ __esModule: true, default: { getAttachment: jest.fn() } }));
jest.mock("../outlookFetchService", () => ({ __esModule: true, default: { getAttachment: jest.fn() } }));
jest.mock("../attachmentTextExtractionService", () => ({
  extractTextForAttachment: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../utils/messageParser", () => ({ __esModule: true, getMessageText: jest.fn(async () => "") }));
jest.mock("cli-progress", () => ({
  __esModule: true,
  default: {
    SingleBar: jest.fn().mockImplementation(() => ({ start: jest.fn(), update: jest.fn(), increment: jest.fn(), stop: jest.fn() })),
    Presets: { shades_classic: {} },
  },
}));

import { app } from "electron";
import { iOSMessagesParser } from "../iosMessagesParser";
import gmailFetchService from "../gmailFetchService";
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import macOSMessagesImportService from "../macOSMessagesImportService";
import emailAttachmentService from "../emailAttachmentService";
import { getAtRestFiles, getDataKeyService, DATA_KEY_STORE_FILENAME } from "../atRest/dataKeyService";
import { HEADER_BYTES, MAGIC } from "../atRest/fileCrypto";
import * as attachmentWriter from "../atRest/attachmentWriter";
import * as importHelpers from "../macOSMessagesImportService/importHelpers";
import {
  AtRestWriteRefusedError,
  AT_REST_WRITE_REFUSED_MESSAGE,
  getAtRestWriteRefusal,
  resetAtRestWriteRefusalForTests,
  sealBufferToFile,
} from "../atRest/attachmentWriter";
import type { iOSMessage } from "../../types/iosMessages";
import type { RawMacAttachment } from "../macOSMessagesImportService/types";

const GB = 1024 * 1024 * 1024;

// Real magic numbers. HEIC's brand sits at offset 4 ("ftyp" box), not 0.
const FORMATS = {
  jpeg: { ext: ".jpg", mime: "image/jpeg", magic: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
  png: { ext: ".png", mime: "image/png", magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  heic: { ext: ".heic", mime: "image/heic", magic: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic")]) },
  pdf: { ext: ".pdf", mime: "application/pdf", magic: Buffer.from("%PDF-1.7\n") },
};
const ALL_MAGICS = [
  ...Object.values(FORMATS).map((f) => f.magic),
  Buffer.from("ftyp"),
  Buffer.from("SQLite format 3\0"),
];

function fixture(kind: keyof typeof FORMATS, size = 3000): Buffer {
  return Buffer.concat([FORMATS[kind].magic, crypto.randomBytes(size)]);
}
/**
 * Sender-chosen plaintext that starts with the KEPRENC magic (SR finding 4).
 *   magic  — "KEPRENC" + random bytes (the SR probe).
 *   header — a well-formed v1 header (version 1, algorithm 1, zero reserved bytes,
 *            1 MiB chunk) + 5 bytes: only the file-size/layout rule says it is not
 *            a container, so a magic-only OR header-only check misclassifies it.
 *   perfect — a STRUCTURALLY VALID container (header + 16-byte "tag" + 100 bytes:
 *            exactly one chunk) that no Keepr key sealed. Any reader classifies it
 *            as KEPRENC, so only a writer that reads its SOURCE raw can store it —
 *            through openDecryptStream it fails on a key id that is not held.
 */
const FORGED = {
  magic: () => Buffer.concat([MAGIC, crypto.randomBytes(3000)]),
  header: () => {
    const h = Buffer.alloc(HEADER_BYTES, 0);
    MAGIC.copy(h, 0);
    h[7] = 1;
    h[8] = 1;
    crypto.randomBytes(32).copy(h, 12);
    h.writeUInt32BE(1024 * 1024, 44);
    return Buffer.concat([h, crypto.randomBytes(5)]);
  },
  perfect: () => {
    const h = Buffer.alloc(HEADER_BYTES, 0);
    MAGIC.copy(h, 0);
    h[7] = 1;
    h[8] = 1;
    crypto.randomBytes(32).copy(h, 12);
    h.writeUInt32BE(1024 * 1024, 44);
    return Buffer.concat([h, crypto.randomBytes(16 + 100)]);
  },
};
/** Forgeries a pre-upgrade plaintext file can carry and still read back as plaintext. */
const FORGED_NOT_CONTAINER = ["magic", "header"] as const;
const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** W1: the file on disk is KEPRENC, shows no format magic or plaintext, and round-trips. */
async function expectSealed(filePath: string, plaintext: Buffer): Promise<void> {
  const raw = await fs.readFile(filePath);
  expect(raw.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
  for (const magic of ALL_MAGICS) {
    expect({ file: nodePath.basename(filePath), magicAt: raw.indexOf(magic) }).toEqual({
      file: nodePath.basename(filePath),
      magicAt: -1,
    });
  }
  expect(raw.indexOf(plaintext.subarray(0, 64))).toBe(-1);
  expect((await getAtRestFiles().readAllDecrypted(filePath)).equals(plaintext)).toBe(true);
}

async function filesIn(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).map((n) => nodePath.join(dir, n));
  } catch {
    return [];
  }
}

/** A key store that exists but cannot be read: the real DataKeyUnavailableError path. */
async function breakKeyStore(): Promise<void> {
  await fs.writeFile(nodePath.join(scratchDir, DATA_KEY_STORE_FILENAME), "{ not json");
  getDataKeyService().clearCache();
}

let scratchDir: string;
let sourceDir: string;

beforeEach(async () => {
  jest.clearAllMocks();
  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-3816-app-"));
  sourceDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-3816-src-"));
  (app.getPath as jest.Mock).mockImplementation((name: string) =>
    name === "userData" ? scratchDir : nodePath.join(scratchDir, `path-${name}`),
  );
  getDataKeyService().clearCache();
  resetAtRestWriteRefusalForTests();
});

afterEach(async () => {
  jest.restoreAllMocks();
  mockDb?.close();
  await fs.rm(scratchDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// iPhone sync
// ---------------------------------------------------------------------------

type IPhoneStore = (
  userId: string,
  messages: iOSMessage[],
  backupPath: string,
) => Promise<{ stored: number; skipped: number; skippedByReason: Record<string, number> }>;
const iphoneStore = (
  iPhoneSyncStorageService as unknown as { storeAttachments: IPhoneStore }
).storeAttachments.bind(iPhoneSyncStorageService) as IPhoneStore;

function iphoneMessage(id: number, att: { name: string; mime: string }): iOSMessage {
  return {
    id,
    guid: `msg-guid-${id}`,
    text: "",
    handle: "+15555550112",
    isFromMe: false,
    date: new Date("2026-09-01T10:00:00Z"),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    chatId: 1,
    service: "iMessage",
    attachments: [
      {
        id,
        guid: `att-guid-${id}`,
        filename: `~/Library/SMS/Attachments/0a/10/${att.name}`,
        mimeType: att.mime,
        transferName: att.name,
      },
    ],
  } as unknown as iOSMessage;
}

/** Writes each source into a fake backup and wires the parser + DB mocks to it. */
async function setUpIphone(sources: Array<{ id: number; name: string; mime: string; bytes: Buffer }>) {
  const backup = nodePath.join(sourceDir, "backup");
  await fs.mkdir(backup, { recursive: true });
  const byName = new Map<string, string>();
  for (const s of sources) {
    const p = nodePath.join(backup, `src-${s.id}`);
    await fs.writeFile(p, s.bytes);
    byName.set(s.name, p);
  }
  (iOSMessagesParser.resolveAttachmentPath as jest.Mock).mockImplementation(
    (_b: string, filename: string) => byName.get(nodePath.basename(filename)) ?? null,
  );
  iphoneDb.getMessageIdMap.mockReturnValue(new Map(sources.map((s) => [`msg-guid-${s.id}`, `internal-${s.id}`])));
  iphoneDb.getAttachmentStoragePaths.mockReturnValue([]);
  iphoneDb.getExistingAttachmentRecords.mockReturnValue(new Set());
  return {
    backup,
    byName,
    messages: sources.map((s) => iphoneMessage(s.id, s)),
  };
}

describe("iPhone sync attachments (iPhoneSyncStorageService.storeAttachments)", () => {
  it("W1: every stored file is KEPRENC ciphertext with no format magic, for each format", async () => {
    const sources = (Object.keys(FORMATS) as Array<keyof typeof FORMATS>).map((kind, i) => ({
      id: i + 1,
      name: `IMG_000${i + 1}${FORMATS[kind].ext}`,
      mime: FORMATS[kind].mime,
      bytes: fixture(kind),
    }));
    const { backup, messages } = await setUpIphone(sources);

    const result = await iphoneStore("user-1", messages, backup);

    expect(result.stored).toBe(sources.length);
    const rows = iphoneDb.insertAttachment.mock.calls.map((c) => c[0]);
    expect(rows).toHaveLength(sources.length);
    for (const [i, s] of sources.entries()) {
      // file_size_bytes is the PLAINTEXT size; storage_path is named by sha256(plaintext).
      expect(rows[i].fileSizeBytes).toBe(s.bytes.length);
      expect(nodePath.basename(rows[i].storagePath)).toBe(`${sha256(s.bytes)}${nodePath.extname(s.name)}`);
      await expectSealed(rows[i].storagePath, s.bytes);
    }
  });

  it("W2: the dedupe hash is SHA-256 of the plaintext; the extension is lower-cased", async () => {
    const plain = fixture("heic");
    const { backup, messages } = await setUpIphone([
      { id: 1, name: "IMG_0100.HEIC", mime: "image/heic", bytes: plain },
    ]);

    const result = await iphoneStore("user-1", messages, backup);

    expect(result.stored).toBe(1);
    const row = iphoneDb.insertAttachment.mock.calls[0][0];
    // The product lower-cases the extension.
    expect(nodePath.basename(row.storagePath)).toBe(`${sha256(plain)}.heic`);
    expect(row.fileSizeBytes).toBe(plain.length);
    await expectSealed(row.storagePath, plain);
  });

  it("W2: a second message with the same plaintext dedupes onto the first file", async () => {
    const plain = fixture("jpeg");
    const { backup, messages } = await setUpIphone([
      { id: 1, name: "a.jpg", mime: "image/jpeg", bytes: plain },
      { id: 2, name: "b.jpg", mime: "image/jpeg", bytes: plain },
    ]);

    await iphoneStore("user-1", messages, backup);

    const paths = iphoneDb.insertAttachment.mock.calls.map((c) => c[0].storagePath);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(paths[1]);
    expect(await filesIn(nodePath.join(scratchDir, "message-attachments"))).toHaveLength(1);
  });

  it("W3: key unavailable -> nothing written, typed refusal thrown (not swallowed as skipped), remembered", async () => {
    const { backup, messages } = await setUpIphone([
      { id: 1, name: "a.jpg", mime: "image/jpeg", bytes: fixture("jpeg") },
      { id: 2, name: "b.png", mime: "image/png", bytes: fixture("png") },
    ]);
    await breakKeyStore();

    await expect(iphoneStore("user-1", messages, backup)).rejects.toBeInstanceOf(AtRestWriteRefusedError);

    expect(await filesIn(nodePath.join(scratchDir, "message-attachments"))).toEqual([]);
    expect(iphoneDb.insertAttachment).not.toHaveBeenCalled();
    expect(getAtRestWriteRefusal()).not.toBeNull();
  });

  it("W3: persistSyncResult reports the refusal with the user-facing message", async () => {
    const { backup, messages } = await setUpIphone([{ id: 1, name: "a.jpg", mime: "image/jpeg", bytes: fixture("jpeg") }]);
    await breakKeyStore();
    const conversations = [{ chatId: 1, guid: "chat-1", participants: ["+15555550112"], messages, isGroupChat: false }];
    const persist = iPhoneSyncStorageService.persistSyncResult.bind(iPhoneSyncStorageService) as unknown as (
      ...a: unknown[]
    ) => Promise<{ success: boolean; error?: string; atRestRefused?: boolean }>;
    const storeMessages = jest
      .spyOn(iPhoneSyncStorageService as unknown as { storeMessages: () => unknown }, "storeMessages")
      .mockResolvedValue({ stored: 1, skipped: 0 } as never);
    jest
      .spyOn(iPhoneSyncStorageService as unknown as { storeContacts: () => unknown }, "storeContacts")
      .mockResolvedValue({ stored: 0, skipped: 0 } as never);

    const result = await persist(
      "user-1",
      { success: true, messages, conversations, contacts: [], backupPath: backup, error: null },
      backup,
    );

    expect(storeMessages).toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, atRestRefused: true, error: AT_REST_WRITE_REFUSED_MESSAGE });
    expect(await filesIn(nodePath.join(scratchDir, "message-attachments"))).toEqual([]);
  });
});

describe("iPhone sync — forged KEPRENC content and mid-copy changes (fix-up)", () => {
  it("F-R1: attachments whose content starts with KEPRENC are stored, sealed, and round-trip", async () => {
    const sources = [
      { id: 1, name: "IMG_0201.jpg", mime: "image/jpeg", bytes: FORGED.magic() },
      { id: 2, name: "doc.pdf", mime: "application/pdf", bytes: FORGED.header() },
      { id: 3, name: "IMG_0203.png", mime: "image/png", bytes: FORGED.perfect() },
    ];
    const { backup, messages } = await setUpIphone(sources);

    const result = await iphoneStore("user-1", messages, backup);

    expect(result).toMatchObject({ stored: 3, skipped: 0 });
    const rows = iphoneDb.insertAttachment.mock.calls.map((c) => c[0]);
    for (const [i, s] of sources.entries()) {
      expect(rows[i].fileSizeBytes).toBe(s.bytes.length);
      expect(nodePath.basename(rows[i].storagePath)).toBe(`${sha256(s.bytes)}${nodePath.extname(s.name)}`);
      await expectSealed(rows[i].storagePath, s.bytes);
    }
  });

  it("F-A1: the source changes between hash and seal -> no row, no stored file", async () => {
    const { backup, byName, messages } = await setUpIphone([
      { id: 1, name: "a.jpg", mime: "image/jpeg", bytes: fixture("jpeg") },
    ]);
    const realHash = attachmentWriter.hashSourceFile;
    jest.spyOn(attachmentWriter, "hashSourceFile").mockImplementation(async (p: string) => {
      const h = await realHash(p);
      await fs.writeFile(byName.get("a.jpg")!, fixture("jpeg")); // swapped after hashing
      return h;
    });

    const result = await iphoneStore("user-1", messages, backup);

    expect(result.stored).toBe(0);
    expect(result.skippedByReason.error).toBe(1);
    expect(iphoneDb.insertAttachment).not.toHaveBeenCalled();
    expect(await filesIn(nodePath.join(scratchDir, "message-attachments"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// macOS Messages import
// ---------------------------------------------------------------------------

type MacStore = (
  userId: string,
  attachments: RawMacAttachment[],
  messageIdMap: Map<string, string>,
) => Promise<{ stored: number; skipped: number }>;
const macStore = (
  macOSMessagesImportService as unknown as { storeAttachments: MacStore }
).storeAttachments.bind(macOSMessagesImportService) as MacStore;

function macSchema(): void {
  mockDb = new Database(":memory:");
  mockDb.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, external_id TEXT);
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, message_id TEXT, external_message_id TEXT, filename TEXT,
      mime_type TEXT, file_size_bytes INTEGER, storage_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const bsize = 4096;
  jest.spyOn(fsSync.promises, "statfs").mockResolvedValue({
    type: 26, bsize, blocks: (500 * GB) / bsize, bfree: (101 * GB) / bsize, bavail: (100 * GB) / bsize, files: 1000, ffree: 900,
  } as fsSync.StatsFs);
}

async function macRow(name: string, bytes: Buffer, guid: string): Promise<RawMacAttachment> {
  const p = nodePath.join(sourceDir, name);
  await fs.writeFile(p, bytes);
  return {
    attachment_id: Math.floor(Math.random() * 1e9),
    message_id: 1,
    message_guid: guid,
    guid: `att-${guid}`,
    filename: p,
    mime_type: null,
    transfer_name: name,
    total_bytes: bytes.length,
    is_outgoing: 0,
  };
}

describe("macOS Messages attachments (macOSMessagesImportService.storeAttachments)", () => {
  it("W1: every stored file is KEPRENC ciphertext, named by sha256(plaintext)", async () => {
    macSchema();
    const kinds = Object.keys(FORMATS) as Array<keyof typeof FORMATS>;
    const plain = kinds.map((k) => fixture(k));
    const rows = await Promise.all(kinds.map((k, i) => macRow(`file${i}${FORMATS[k].ext}`, plain[i], `m${i}`)));

    const result = await macStore("user-1", rows, new Map(rows.map((r, i) => [r.message_guid, `internal-${i}`])));

    expect(result.stored).toBe(kinds.length);
    const stored = mockDb.prepare("SELECT filename, storage_path FROM attachments").all() as Array<{ filename: string; storage_path: string }>;
    expect(stored).toHaveLength(kinds.length);
    for (const [i, k] of kinds.entries()) {
      const row = stored.find((r) => r.filename === `file${i}${FORMATS[k].ext}`)!;
      expect(nodePath.basename(row.storage_path)).toBe(`${sha256(plain[i])}${FORMATS[k].ext}`);
      await expectSealed(row.storage_path, plain[i]);
    }
  });

  it("reader: getAttachmentAsBase64 returns the decrypted bytes", async () => {
    macSchema();
    const plain = fixture("png");
    const row = await macRow("x.png", plain, "m1");
    await macStore("user-1", [row], new Map([["m1", "internal-1"]]));
    const { storage_path } = mockDb.prepare("SELECT storage_path FROM attachments").get() as { storage_path: string };

    const b64 = await macOSMessagesImportService.getAttachmentAsBase64(storage_path);

    expect(Buffer.from(b64!, "base64").equals(plain)).toBe(true);
  });

  it("W3: key unavailable -> nothing written, typed refusal thrown (not swallowed as skipped)", async () => {
    macSchema();
    const rows = [await macRow("a.jpg", fixture("jpeg"), "m1"), await macRow("b.pdf", fixture("pdf"), "m2")];
    await breakKeyStore();

    await expect(
      macStore("user-1", rows, new Map([["m1", "i1"], ["m2", "i2"]])),
    ).rejects.toBeInstanceOf(AtRestWriteRefusedError);

    expect(await filesIn(nodePath.join(scratchDir, "message-attachments"))).toEqual([]);
    expect((mockDb.prepare("SELECT COUNT(*) c FROM attachments").get() as { c: number }).c).toBe(0);
  });
});

describe("macOS Messages — forged KEPRENC content and mid-copy changes (fix-up)", () => {
  it("F-R1: attachments whose content starts with KEPRENC are stored, sealed, and read back", async () => {
    macSchema();
    const plain = [FORGED.magic(), FORGED.header(), FORGED.perfect()];
    const names = ["f0.jpg", "f1.pdf", "f2.png"];
    const rows = await Promise.all(names.map((n, i) => macRow(n, plain[i], `m${i}`)));

    const result = await macStore("user-1", rows, new Map(names.map((_n, i) => [`m${i}`, `i${i}`])));

    expect(result.stored).toBe(3);
    for (const [i, name] of names.entries()) {
      const { storage_path } = mockDb
        .prepare("SELECT storage_path FROM attachments WHERE filename = ?")
        .get(name) as { storage_path: string };
      expect(nodePath.basename(storage_path)).toBe(`${sha256(plain[i])}${nodePath.extname(name)}`);
      await expectSealed(storage_path, plain[i]);
      const b64 = await macOSMessagesImportService.getAttachmentAsBase64(storage_path);
      expect(Buffer.from(b64!, "base64").equals(plain[i])).toBe(true);
    }
  });

  it.each(FORGED_NOT_CONTAINER)(
    "F-R2: a PRE-UPGRADE plaintext file starting with KEPRENC (%s) reads back unchanged",
    async (kind) => {
      const plain = FORGED[kind]();
      const old = nodePath.join(scratchDir, "message-attachments", `${sha256(plain)}.jpg`);
      await fs.mkdir(nodePath.dirname(old), { recursive: true });
      await fs.writeFile(old, plain);

      const b64 = await macOSMessagesImportService.getAttachmentAsBase64(old);

      expect(b64).not.toBeNull();
      expect(Buffer.from(b64!, "base64").equals(plain)).toBe(true);
    },
  );

  it("F-A1: the source changes between hash and seal -> no row, no stored file", async () => {
    macSchema();
    const row = await macRow("a.jpg", fixture("jpeg"), "m1");
    const realHash = importHelpers.generateContentHash;
    jest.spyOn(importHelpers, "generateContentHash").mockImplementation(async (p: string) => {
      const h = await realHash(p);
      await fs.writeFile(row.filename!, fixture("jpeg")); // swapped after hashing
      return h;
    });

    const result = await macStore("user-1", [row], new Map([["m1", "i1"]]));

    expect(result.stored).toBe(0);
    expect((mockDb.prepare("SELECT COUNT(*) c FROM attachments").get() as { c: number }).c).toBe(0);
    expect(await filesIn(nodePath.join(scratchDir, "message-attachments"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Email attachments
// ---------------------------------------------------------------------------

describe("email attachments (emailAttachmentService.downloadEmailAttachments)", () => {
  const meta = (filename: string, mimeType: string, size: number, attachmentId: string) => ({
    filename,
    mimeType,
    size,
    partId: null,
    attachmentId,
  });

  beforeEach(() => {
    iphoneDb.getAttachmentStoragePaths.mockReturnValue([]);
    emailDb.findEmailAttachmentRow.mockReturnValue(undefined);
    emailDb.createAttachmentRecord.mockImplementation(() => crypto.randomUUID());
  });

  it("W1: the stored file is KEPRENC ciphertext with no format magic", async () => {
    const pdf = fixture("pdf");
    const png = fixture("png");
    (gmailFetchService.getAttachment as jest.Mock).mockImplementation(async (_m: string, id: string) =>
      id === "att-pdf" ? pdf : png,
    );

    const result = await emailAttachmentService.downloadEmailAttachments("user-1", "email-1", "gmail-msg-1", "gmail", [
      meta("contract.pdf", "application/pdf", pdf.length, "att-pdf"),
      meta("image001.png", "image/png", png.length, "att-png"),
    ]);

    expect(result).toMatchObject({ success: true, stored: 2, errors: 0 });
    const dir = nodePath.join(scratchDir, "attachments");
    await expectSealed(nodePath.join(dir, `${sha256(pdf)}.pdf`), pdf);
    await expectSealed(nodePath.join(dir, `${sha256(png)}.png`), png);
  });

  it("F-R1: email attachments whose content starts with KEPRENC are stored, sealed, and round-trip", async () => {
    const a = FORGED.magic();
    const b = FORGED.header();
    const c = FORGED.perfect();
    const byId: Record<string, Buffer> = { "att-a": a, "att-b": b, "att-c": c };
    (gmailFetchService.getAttachment as jest.Mock).mockImplementation(async (_m: string, id: string) => byId[id]);

    const result = await emailAttachmentService.downloadEmailAttachments("user-1", "email-1", "gmail-msg-1", "gmail", [
      meta("a.pdf", "application/pdf", a.length, "att-a"),
      meta("b.png", "image/png", b.length, "att-b"),
      meta("c.jpg", "image/jpeg", c.length, "att-c"),
    ]);

    expect(result).toMatchObject({ success: true, stored: 3, errors: 0 });
    const dir = nodePath.join(scratchDir, "attachments");
    await expectSealed(nodePath.join(dir, `${sha256(a)}.pdf`), a);
    await expectSealed(nodePath.join(dir, `${sha256(b)}.png`), b);
    await expectSealed(nodePath.join(dir, `${sha256(c)}.jpg`), c);
  });

  it("W3: key unavailable -> nothing written, the run stops with the typed refusal", async () => {
    (gmailFetchService.getAttachment as jest.Mock).mockResolvedValue(fixture("pdf"));
    await breakKeyStore();

    const result = await emailAttachmentService.downloadEmailAttachments("user-1", "email-1", "gmail-msg-1", "gmail", [
      meta("a.pdf", "application/pdf", 3000, "att-1"),
      meta("b.pdf", "application/pdf", 3000, "att-2"),
    ]);

    expect(result.success).toBe(false);
    expect(result.atRestRefused).toBe(true);
    // Stopped at the first refusal: one detail, not one per attachment.
    expect(result.details).toEqual([{ filename: "a.pdf", status: "error", reason: AT_REST_WRITE_REFUSED_MESSAGE }]);
    expect(gmailFetchService.getAttachment).toHaveBeenCalledTimes(1);
    expect(await filesIn(nodePath.join(scratchDir, "attachments"))).toEqual([]);
    expect(emailDb.createAttachmentRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The refusal is remembered for the process (SR N3)
// ---------------------------------------------------------------------------

describe("remembered refusal", () => {
  it("after one refusal, later writes refuse WITHOUT asking for the key again", async () => {
    await breakKeyStore();
    const dest = nodePath.join(scratchDir, "message-attachments", "a.jpg");
    await expect(sealBufferToFile(dest, fixture("jpeg"))).rejects.toBeInstanceOf(AtRestWriteRefusedError);

    // The store goes away: a fresh key lookup would now CREATE a key (no ciphertext
    // exists anywhere under userData). A remembered refusal never looks.
    await fs.rm(nodePath.join(scratchDir, DATA_KEY_STORE_FILENAME));
    getDataKeyService().clearCache();
    await expect(sealBufferToFile(dest, fixture("jpeg"))).rejects.toBeInstanceOf(AtRestWriteRefusedError);

    expect(fsSync.existsSync(nodePath.join(scratchDir, DATA_KEY_STORE_FILENAME))).toBe(false);
    expect(fsSync.existsSync(dest)).toBe(false);
  });
});
