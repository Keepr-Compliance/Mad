/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S1 — RCS images are stored as KEPRENC ciphertext.
 *
 * Drives the HANDLER's real dependency object (`mediaDeps`, the one the live
 * extension bridge and the cache staging use) with the real at-rest stack, so a
 * handler that went back to a plain write turns this red.
 *
 *   W1 storeImage (live import) and RcsCacheStaging.stageImage -> commit (cache
 *      Sync) both leave KEPRENC on disk, no JPEG/PNG magic, no plaintext; the
 *      staged temp is ciphertext too, and the commit moves ciphertext.
 *   W3 key unavailable -> storeImage rejects with the typed refusal and writes nothing.
 *
 * Image body shape transcribed from parseIncomingImage (electron/services/rcsImportMedia.ts:91):
 * {conversationId, msgId, index, mimeType, base64}. Bytes are synthetic behind real magic numbers.
 */

import * as os from "os";
import * as fs from "fs";
import * as nodePath from "path";
import * as crypto from "crypto";

const mockDb = {
  getMessageIdMap: jest.fn(),
  getExistingAttachmentRecords: jest.fn(),
  insertAttachment: jest.fn(),
  markMessageHasAttachments: jest.fn(),
};

jest.mock("electron", () => ({
  app: { isPackaged: true, getPath: jest.fn(), getAppPath: () => require("os").tmpdir() },
  ipcMain: { handle: jest.fn() },
  shell: { openExternal: jest.fn() },
  clipboard: { writeText: jest.fn() },
}));
jest.mock("../../services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../../capabilities/windowsProvider", () => ({ hostWindows: { broadcast: jest.fn() } }));
jest.mock("../../windowRegistry", () => ({ getMainWindow: () => null }));
jest.mock("../../utils/bringAppToFront", () => ({ bringAppToFront: jest.fn(), bringAppToFrontOrFlash: jest.fn() }));
jest.mock("../../services/autoLinkService", () => ({ autoLinkNewMessagesForUser: jest.fn() }));
jest.mock("../../services/sessionService", () => ({ __esModule: true, default: { loadSession: async () => null } }));
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    getMessageIdMap: (...a: unknown[]) => mockDb.getMessageIdMap(...a),
    getExistingAttachmentRecords: (...a: unknown[]) => mockDb.getExistingAttachmentRecords(...a),
    insertAttachment: (...a: unknown[]) => mockDb.insertAttachment(...a),
    markMessageHasAttachments: (...a: unknown[]) => mockDb.markMessageHasAttachments(...a),
  },
}));
jest.mock("../../services/db/core/dbConnection", () => ({
  ...jest.requireActual("../../services/db/core/dbConnection"),
  dbTransaction: (fn: () => unknown) => fn(),
}));

import { app } from "electron";
import { storeImage } from "../../services/rcsImportMedia";
import { rcsExternalId } from "../../services/rcsImportStore";
import { getAtRestFiles, getDataKeyService, DATA_KEY_STORE_FILENAME } from "../../services/atRest/dataKeyService";
import { MAGIC } from "../../services/atRest/fileCrypto";
import { AtRestWriteRefusedError, resetAtRestWriteRefusalForTests } from "../../services/atRest/attachmentWriter";

/* eslint-disable @typescript-eslint/no-require-imports */
const { mediaDeps } = require("../rcsImportHandlers") as typeof import("../rcsImportHandlers");
/* eslint-enable @typescript-eslint/no-require-imports */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHAT = "c".repeat(64);

let userData: string;

async function expectSealed(filePath: string, plaintext: Buffer): Promise<void> {
  const raw = await fs.promises.readFile(filePath);
  expect(raw.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
  expect(raw.indexOf(JPEG)).toBe(-1);
  expect(raw.indexOf(PNG)).toBe(-1);
  expect(raw.indexOf(plaintext.subarray(0, 64))).toBe(-1);
  expect((await getAtRestFiles().readAllDecrypted(filePath)).equals(plaintext)).toBe(true);
}

beforeEach(async () => {
  jest.clearAllMocks();
  userData = await fs.promises.mkdtemp(nodePath.join(os.tmpdir(), "keepr-3816-rcs-"));
  (app.getPath as jest.Mock).mockImplementation((name: string) =>
    name === "userData" ? userData : nodePath.join(userData, `path-${name}`),
  );
  getDataKeyService().clearCache();
  resetAtRestWriteRefusalForTests();
  mockDb.getMessageIdMap.mockReturnValue(new Map([[rcsExternalId(CHAT, "m1"), "internal-1"]]));
  mockDb.getExistingAttachmentRecords.mockReturnValue(new Set());
});

afterEach(async () => {
  await fs.promises.rm(userData, { recursive: true, force: true });
});

describe("RCS media writer (rcsImportHandlers.mediaDeps)", () => {
  it("W1: storeImage through the handler's deps stores KEPRENC ciphertext", async () => {
    const plain = Buffer.concat([JPEG, crypto.randomBytes(4000)]);
    const result = await storeImage(
      { conversationId: "conv-1", msgId: "m1", index: 0, mimeType: "image/jpeg", base64: plain.toString("base64") },
      "user-1",
      mediaDeps,
      CHAT,
    );

    expect(result).toMatchObject({ stored: true, alreadyPresent: false });
    const row = mockDb.insertAttachment.mock.calls[0][0];
    expect(nodePath.dirname(row.storagePath)).toBe(nodePath.join(userData, "message-attachments"));
    expect(nodePath.basename(row.storagePath)).toBe(`${crypto.createHash("sha256").update(plain).digest("hex")}.jpg`);
    expect(row.fileSizeBytes).toBe(plain.length);
    await expectSealed(row.storagePath, plain);
  });

  it("F-R1: an image whose content starts with KEPRENC is stored, sealed, and round-trips", async () => {
    const plain = Buffer.concat([MAGIC, crypto.randomBytes(4000)]);
    const result = await storeImage(
      { conversationId: "conv-1", msgId: "m1", index: 0, mimeType: "image/jpeg", base64: plain.toString("base64") },
      "user-1",
      mediaDeps,
      CHAT,
    );

    expect(result).toMatchObject({ stored: true, alreadyPresent: false });
    const row = mockDb.insertAttachment.mock.calls[0][0];
    expect(row.fileSizeBytes).toBe(plain.length);
    await expectSealed(row.storagePath, plain);
  });

  it("W1: the staging writer (same deps) writes ciphertext; the commit move keeps it ciphertext", async () => {
    const plain = Buffer.concat([PNG, crypto.randomBytes(4000)]);
    const staged = nodePath.join(userData, "rcs-cache-staging", "job", "slot.png");
    await fs.promises.mkdir(nodePath.dirname(staged), { recursive: true });

    await mediaDeps.writeSealed(staged, plain);
    await expectSealed(staged, plain);

    // The commit's move is a rename of that file — the bytes that land are the sealed ones.
    const target = nodePath.join(userData, "message-attachments", "x.png");
    await fs.promises.mkdir(nodePath.dirname(target), { recursive: true });
    await fs.promises.rename(staged, target);
    await expectSealed(target, plain);
  });

  it("W3: key unavailable -> typed refusal, nothing written, no row", async () => {
    await fs.promises.writeFile(nodePath.join(userData, DATA_KEY_STORE_FILENAME), "{ not json");
    getDataKeyService().clearCache();
    const plain = Buffer.concat([JPEG, crypto.randomBytes(100)]);

    await expect(
      storeImage(
        { conversationId: "conv-1", msgId: "m1", index: 0, mimeType: "image/jpeg", base64: plain.toString("base64") },
        "user-1",
        mediaDeps,
        CHAT,
      ),
    ).rejects.toBeInstanceOf(AtRestWriteRefusedError);

    const dir = nodePath.join(userData, "message-attachments");
    expect(fs.existsSync(dir) ? await fs.promises.readdir(dir) : []).toEqual([]);
    expect(mockDb.insertAttachment).not.toHaveBeenCalled();
  });
});
