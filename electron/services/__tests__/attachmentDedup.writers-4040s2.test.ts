/**
 * @jest-environment node
 */
/**
 * BACKLOG-4040 S2 — the Mac and iPhone dedup branch links a new row to a file
 * that EXISTS, and new files get a lower-case extension.
 *
 * Runs the real writers (macOSMessagesImportService.storeAttachments,
 * iPhoneSyncStorageService.storeAttachments) against a real temp userData and the
 * real at-rest stack, as atRest.attachmentWriters-3816 does.
 *
 *   D1  a known hash whose file is gone -> the file is written again; the row
 *       points at a file that exists.
 *   D2  the same bytes already stored under another extension (`h.jpg`) -> the
 *       new row (`IMG.jpeg`) points at `h.jpg`, which exists; before the fix it
 *       pointed at `h.jpeg`, which never existed.
 *   D3  `SHOT.PNG` is stored as `<hash>.png`.
 *   D4  `a.png` then `B.PNG`, same bytes -> one file, both rows point at it.
 *   E   EXISTING rows written by the pre-fix writers (fixture captured at
 *       2ae4eb35a, see fixtures/4040-s2-prefix-writer-rows.json) are never
 *       rewritten, and every file they reference still exists after a post-fix
 *       import of the same bytes.
 *
 * Fixture shapes: RawMacAttachment (macOSMessagesImportService/types.ts),
 * iOSAttachment (types/iosMessages.ts), attachments columns (database/schema.sql).
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
    getMessageIdsByExternalIds: (userId: string, ids: readonly string[]) => {
      const table = (iphoneDb.getMessageIdMap(userId) as Map<string, string> | undefined) ?? new Map<string, string>();
      return new Map(ids.filter((g) => table.has(g)).map((g) => [g, table.get(g)!] as [string, string]));
    },
    getExistingAttachmentRecordsForMessages: () => new Set<string>(),
    insertAttachment: (...a: unknown[]) => iphoneDb.insertAttachment(...a),
  },
}));
jest.mock("../db/externalContactDbService");
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: { resolveAttachmentPath: jest.fn(), flushRejectedPathSummary: jest.fn() },
}));
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
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import macOSMessagesImportService from "../macOSMessagesImportService";
import { getDataKeyService } from "../atRest/dataKeyService";
import { resetAtRestWriteRefusalForTests, sealBufferToFile } from "../atRest/attachmentWriter";
import type { iOSMessage } from "../../types/iosMessages";
import type { RawMacAttachment } from "../macOSMessagesImportService/types";

const GB = 1024 * 1024 * 1024;
const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
/** Deterministic bytes, so the pre-fix fixture's file names are reproducible. */
const bytesFor = (label: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`4040-s2-${label}-`.repeat(64))]);

let scratchDir: string;
let sourceDir: string;
let msgDir: string;

beforeEach(async () => {
  jest.clearAllMocks();
  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-4040s2-app-"));
  sourceDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-4040s2-src-"));
  msgDir = nodePath.join(scratchDir, "message-attachments");
  (app.getPath as jest.Mock).mockImplementation((name: string) =>
    name === "userData" ? scratchDir : nodePath.join(scratchDir, `path-${name}`),
  );
  getDataKeyService().clearCache();
  resetAtRestWriteRefusalForTests();
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
});

afterEach(async () => {
  jest.restoreAllMocks();
  mockDb?.close();
  await fs.rm(scratchDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type MacStore = (
  userId: string,
  attachments: RawMacAttachment[],
  messageIdMap: Map<string, string>,
) => Promise<{ stored: number; skipped: number }>;
const macStore = (
  macOSMessagesImportService as unknown as { storeAttachments: MacStore }
).storeAttachments.bind(macOSMessagesImportService) as MacStore;

let macSeq = 0;
async function macRow(name: string, bytes: Buffer, guid: string): Promise<RawMacAttachment> {
  const dir = nodePath.join(sourceDir, `mac-${macSeq++}`);
  await fs.mkdir(dir, { recursive: true });
  const p = nodePath.join(dir, name);
  await fs.writeFile(p, bytes);
  return {
    attachment_id: macSeq,
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

/** Import Mac attachments, one message per row (guid -> internal id). */
async function macImport(rows: RawMacAttachment[]): Promise<void> {
  await macStore("user-1", rows, new Map(rows.map((r) => [r.message_guid, `internal-${r.message_guid}`])));
}

function macRowsByGuid(guid: string): Array<{ storage_path: string }> {
  return mockDb
    .prepare("SELECT storage_path FROM attachments WHERE external_message_id = ?")
    .all(guid) as Array<{ storage_path: string }>;
}

/** A row another writer (Google Messages, iPhone) left, with its file sealed on disk. */
async function seedForeignRow(id: string, storedName: string, bytes: Buffer, opts: { writeFile?: boolean } = {}): Promise<string> {
  const p = nodePath.join(msgDir, storedName);
  if (opts.writeFile !== false) {
    await fs.mkdir(msgDir, { recursive: true });
    await sealBufferToFile(p, bytes);
  }
  mockDb
    .prepare("INSERT INTO attachments (id, message_id, external_message_id, filename, storage_path) VALUES (?, ?, ?, ?, ?)")
    .run(id, `foreign-msg-${id}`, `foreign-${id}`, storedName, p);
  return p;
}

type IPhoneStore = (
  userId: string,
  messages: iOSMessage[],
  backupPath: string,
) => Promise<{ stored: number; skipped: number }>;
const iphoneStore = (
  iPhoneSyncStorageService as unknown as { storeAttachments: IPhoneStore }
).storeAttachments.bind(iPhoneSyncStorageService) as IPhoneStore;

async function iphoneImport(
  sources: Array<{ id: number; name: string; bytes: Buffer }>,
  existingStoragePaths: string[],
): Promise<Array<{ storagePath: string; filename: string }>> {
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
  iphoneDb.getAttachmentStoragePaths.mockReturnValue(existingStoragePaths.map((storage_path) => ({ storage_path })));
  iphoneDb.getExistingAttachmentRecords.mockReturnValue(new Set());
  const messages = sources.map(
    (s) =>
      ({
        id: s.id,
        guid: `msg-guid-${s.id}`,
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
          { id: s.id, guid: `att-guid-${s.id}`, filename: `~/Library/SMS/Attachments/0a/10/${s.name}`, mimeType: "image/jpeg", transferName: s.name },
        ],
      }) as unknown as iOSMessage,
  );
  await iphoneStore("user-1", messages, backup);
  return iphoneDb.insertAttachment.mock.calls.map((c) => ({ storagePath: c[0].storagePath, filename: c[0].filename }));
}

const exists = (p: string) => fsSync.existsSync(p);
/** Exact-name presence: on a case-insensitive volume existsSync("h.png") is true for "h.PNG". */
const listed = async (p: string) => (await fs.readdir(nodePath.dirname(p)).catch(() => [] as string[])).includes(nodePath.basename(p));

// ---------------------------------------------------------------------------
// macOS Messages
// ---------------------------------------------------------------------------

describe("macOS Messages dedup (storeAttachments)", () => {
  it("D1: a known hash whose file is gone is written again, and the row points at a file that exists", async () => {
    const bytes = bytesFor("d1");
    const h = sha256(bytes);
    // Another writer's row for the same bytes; its file was removed by a cleanup.
    await seedForeignRow("gone", `${h}.jpg`, bytes, { writeFile: false });

    await macImport([await macRow("IMG_1.jpg", bytes, "d1")]);

    const [row] = macRowsByGuid("d1");
    expect(row).toBeDefined();
    expect(exists(row.storage_path)).toBe(true);
    expect(nodePath.basename(row.storage_path)).toBe(`${h}.jpg`);
  });

  it("D2: same bytes already stored as h.jpg; a Mac IMG.jpeg links to h.jpg, which exists", async () => {
    const bytes = bytesFor("d2");
    const h = sha256(bytes);
    const rcsPath = await seedForeignRow("rcs", `${h}.jpg`, bytes);

    await macImport([await macRow("IMG.jpeg", bytes, "d2")]);

    const [row] = macRowsByGuid("d2");
    expect(row).toBeDefined();
    expect(exists(row.storage_path)).toBe(true);
    // Linked to the existing file, not a second copy and not a missing name.
    expect(row.storage_path).toBe(rcsPath);
    expect(await fs.readdir(msgDir)).toEqual([`${h}.jpg`]);
  });

  it("D3: SHOT.PNG is stored with a lower-case extension", async () => {
    const bytes = bytesFor("d3");
    const h = sha256(bytes);

    await macImport([await macRow("SHOT.PNG", bytes, "d3")]);

    const [row] = macRowsByGuid("d3");
    expect(nodePath.basename(row.storage_path)).toBe(`${h}.png`);
    expect(await listed(row.storage_path)).toBe(true);
  });

  it("D4: a.png then B.PNG with the same bytes: one file, both rows point at it", async () => {
    const bytes = bytesFor("d4");
    const h = sha256(bytes);

    await macImport([await macRow("a.png", bytes, "d4a")]);
    await macImport([await macRow("B.PNG", bytes, "d4b")]);

    const a = macRowsByGuid("d4a")[0].storage_path;
    const b = macRowsByGuid("d4b")[0].storage_path;
    expect(nodePath.basename(a)).toBe(`${h}.png`);
    expect(b).toBe(a);
    expect(await fs.readdir(msgDir)).toEqual([`${h}.png`]);
  });
});

// ---------------------------------------------------------------------------
// iPhone sync
// ---------------------------------------------------------------------------

describe("iPhone sync dedup (storeAttachments)", () => {
  it("D1i: a known hash whose file is gone is written again", async () => {
    const bytes = bytesFor("d1i");
    const h = sha256(bytes);
    const gone = nodePath.join(msgDir, `${h}.jpg`);

    const rows = await iphoneImport([{ id: 1, name: "IMG_1.jpg", bytes }], [gone]);

    expect(rows).toHaveLength(1);
    expect(exists(rows[0].storagePath)).toBe(true);
  });

  it("D2i: same bytes stored by the Mac as h.jpeg; an iPhone IMG.jpg links to h.jpeg, which exists", async () => {
    const bytes = bytesFor("d2i");
    const h = sha256(bytes);
    await fs.mkdir(msgDir, { recursive: true });
    const macPath = nodePath.join(msgDir, `${h}.jpeg`);
    await sealBufferToFile(macPath, bytes);

    const rows = await iphoneImport([{ id: 1, name: "IMG_1.jpg", bytes }], [macPath]);

    expect(rows).toHaveLength(1);
    expect(exists(rows[0].storagePath)).toBe(true);
    expect(rows[0].storagePath).toBe(macPath);
    expect(await fs.readdir(msgDir)).toEqual([`${h}.jpeg`]);
  });
});

// ---------------------------------------------------------------------------
// Existing rows written by the pre-fix writers
// ---------------------------------------------------------------------------

/**
 * Captured at 2ae4eb35a (before this fix) by running the REAL pre-fix Mac writer
 * through the harness above: Google Messages `h.jpg` then Mac `IMG.jpeg` (d2),
 * Mac `SHOT.PNG` (d3), Mac `a.png` then `B.PNG` (d4) and the reverse (d4r).
 * Bytes are `bytesFor("fx-<scenario>")`. Row ids were uuids, replaced by tokens.
 */

type FixtureRow = { id: string; external_message_id: string; filename: string; storage_path: string };
type Scenario = { rows: FixtureRow[]; files: string[] };
const prefixRows = JSON.parse(
  fsSync.readFileSync(nodePath.join(__dirname, "fixtures", "4040-s2-prefix-writer-rows.json"), "utf8"),
) as { scenarios: Record<string, Scenario> };

describe("E: existing rows from the pre-fix writers are never rewritten and keep their files", () => {
  const scenarios = prefixRows.scenarios;

  it("the fixture holds the pre-fix shapes (a row pointing at a missing h.jpeg; an upper-case .PNG row)", () => {
    expect(scenarios.d2.rows.map((r) => nodePath.extname(r.storage_path))).toEqual([".jpg", ".jpeg"]);
    expect(scenarios.d2.files.map((f) => nodePath.extname(f))).toEqual([".jpg"]);
    expect(nodePath.extname(scenarios.d3.files[0])).toBe(".PNG");
    expect(scenarios.d4.rows.map((r) => nodePath.extname(r.storage_path))).toEqual([".png", ".PNG"]);
  });

  it.each(Object.keys(prefixRows.scenarios))(
    "%s: a post-fix import of the same bytes leaves every existing row as it was and links to an existing file",
    async (name) => {
      const sc = scenarios[name];
      const b = bytesFor(`fx-${name}`);
      await fs.mkdir(msgDir, { recursive: true });
      for (const f of sc.files) await sealBufferToFile(nodePath.join(msgDir, f), b);
      const ins = mockDb.prepare(
        "INSERT INTO attachments (id, message_id, external_message_id, filename, storage_path) VALUES (?, ?, ?, ?, ?)",
      );
      for (const r of sc.rows) ins.run(r.id, `m-${r.id}`, r.external_message_id, r.filename, nodePath.join(scratchDir, r.storage_path));
      const before = mockDb.prepare("SELECT id, storage_path FROM attachments ORDER BY id").all();

      await macImport([await macRow("NEW.JPEG", b, `new-${name}`)]);

      // No existing row rewritten.
      const existing = mockDb
        .prepare(`SELECT id, storage_path FROM attachments WHERE external_message_id != ? ORDER BY id`)
        .all(`new-${name}`);
      expect(existing).toEqual(before);
      // Every file that existed is still there, under its exact name.
      expect(await fs.readdir(msgDir)).toEqual(expect.arrayContaining(sc.files));
      // The new row points at a file that exists, and no second copy was written.
      const [row] = macRowsByGuid(`new-${name}`);
      expect(exists(row.storage_path)).toBe(true);
      expect((await fs.readdir(msgDir)).length).toBe(sc.files.length);
    },
  );
});
