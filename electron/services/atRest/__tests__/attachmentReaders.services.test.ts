/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S2 — the main-process attachment readers decrypt on read.
 *
 * Fixtures are REAL KEPRENC files written by createFileCrypto (64-byte chunks)
 * into a real temp userData; the readers run their real code paths.
 *
 * Controls in this file (one per reader; each test reds when that reader goes
 * back to a raw read):
 *   R6  text-export HTML embeds images as data: URIs of the PLAINTEXT (no file://)
 *   R7a email attachment export (attachmentHelpers) writes the PLAINTEXT
 *   R7b folder export exportAttachments (folderExportService) writes the PLAINTEXT
 *   R8  text extraction stores text from the PLAINTEXT
 *   R9  broker upload sends the PLAINTEXT; preflight size = plaintext size
 *   PH  phase switch for the DB-path readers: plaintext ok before `done`, refused after
 *   NC  after the export/upload/extraction runs, no plaintext copy is left in userData
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";

const uploads: Array<{ path: string; body: Buffer }> = [];
const mockAttachmentRows: Array<Record<string, unknown>> = [];
const mockSetText = jest.fn();

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/nonexistent-userdata"), isPackaged: false },
  net: { isOnline: jest.fn(() => false) },
  BrowserWindow: jest.fn(),
}));
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn(), addBreadcrumb: jest.fn() }));
jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));
jest.mock("../../databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: () => ({ prepare: () => ({ get: () => ({ cnt: 1 }), all: () => [], run: () => undefined }) }),
    getAttachmentsForEmailExport: () => mockAttachmentRows,
    getAttachmentsForExportBulk: () => mockAttachmentRows,
    getAttachmentsForMessageWithFallback: () => mockAttachmentRows,
    setAttachmentTextContent: (...args: unknown[]) => mockSetText(...args),
  },
}));
jest.mock("../../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      storage: {
        from: () => ({
          upload: async (p: string, body: Buffer) => {
            uploads.push({ path: p, body: Buffer.from(body) });
            return { data: { path: p }, error: null };
          },
        }),
      },
    }),
  },
}));
jest.mock("googleapis", () => ({ google: { gmail: jest.fn() }, gmail_v1: {}, Auth: {} }));
jest.mock("../../db/userDbService", () => ({ __esModule: true, getUserById: jest.fn().mockResolvedValue(null) }));
jest.mock("../../gmailFetchService", () => ({ __esModule: true, default: { initialize: jest.fn() } }));
jest.mock("../../outlookFetchService", () => ({ __esModule: true, default: { initialize: jest.fn() } }));
jest.mock("../../emailAttachmentService", () => ({
  __esModule: true,
  default: { downloadEmailAttachments: jest.fn().mockResolvedValue(undefined) },
}));

import type { Communication } from "../../../types/models";
import { extractTextForAttachment } from "../../attachmentTextExtractionService";
import { exportEmailAttachmentsToThreadDirs } from "../../folderExport/attachmentHelpers";
import folderExportService from "../../folderExport/folderExportService";
import logService from "../../logService";
import {
  generateTextThreadHTML,
  resolveInlineImages,
  MAX_TOTAL_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  newInlineImageBudget,
} from "../../folderExport/textExportHelpers";
import { runSubmissionPreflight, setPreflightStatForTests } from "../../submissionPreflight";
import supabaseStorageService from "../../supabaseStorageService";
import { setAttachmentReaderDepsForTests } from "../attachmentReader";
import { createFileCrypto, MAGIC, type KeyResolver } from "../fileCrypto";
import { createMarkerStore } from "../markers";

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.randomBytes(16).toString("hex");
const resolver: KeyResolver = {
  currentKey: async () => ({ keyId: KEY_ID, key: KEY }),
  keyFor: async (id) => {
    if (id !== KEY_ID) throw new Error("unknown key");
    return KEY;
  },
};
const files = createFileCrypto(resolver, { chunkSize: 64 });

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(300)]);
const TEXT = Buffer.from("Inspection report: roof replaced 2019, encrypted at rest. ".repeat(6));

let root: string;
let userData: string;
let exportDir: string;
let encJpeg: string;
let encText: string;

function allFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** NC: no plaintext copy of a fixture anywhere in userData. */
function assertNoPlaintextInUserData(): void {
  const leaks = allFiles(userData).filter((f) => {
    if (path.basename(f) === "at-rest-state.json") return false;
    const bytes = fs.readFileSync(f);
    return (
      !bytes.subarray(0, MAGIC.length).equals(MAGIC) ||
      bytes.includes(JPEG.subarray(0, 32)) ||
      bytes.includes(TEXT.subarray(0, 32))
    );
  });
  expect(leaks).toEqual([]);
}

const textComm = (): Communication =>
  ({
    id: "t1",
    message_id: "t1",
    user_id: "u1",
    body_text: "photo",
    direction: "inbound",
    sender: "+15550100",
    sent_at: "2026-01-02T10:00:00Z",
    communication_type: "text",
    channel: "sms",
    has_attachments: true,
  }) as unknown as Communication;

const emailComm = (): Communication =>
  ({
    id: "e1",
    user_id: "u1",
    thread_id: "thread-A",
    subject: "Inspection",
    body: "<div>see attached</div>",
    sender: "a@test.com",
    recipients: "b@test.com",
    direction: "inbound",
    sent_at: "2026-01-02T10:00:00Z",
    communication_type: "email",
    has_attachments: true,
  }) as unknown as Communication;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-services-")));
  userData = path.join(root, "keepr");
  exportDir = path.join(root, "export");
  fs.mkdirSync(exportDir, { recursive: true });
  encJpeg = path.join(userData, "message-attachments", "f00d.jpg");
  encText = path.join(userData, "attachments", "e1", "report.txt");
  await files.encryptStreamToFile(Readable.from([JPEG]), encJpeg);
  await files.encryptStreamToFile(Readable.from([TEXT]), encText);
  setAttachmentReaderDepsForTests({
    files: () => files,
    markers: () => createMarkerStore({ userData: () => userData }),
    userData: () => userData,
  });
  uploads.length = 0;
  mockAttachmentRows.length = 0;
  mockSetText.mockReset();
  setPreflightStatForTests(null);
});

afterEach(() => {
  setAttachmentReaderDepsForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("R6 text export HTML", () => {
  it("embeds the image as a data: URI of the plaintext, never file://", async () => {
    mockAttachmentRows.push({
      id: "a1", filename: "photo.jpg", mime_type: "image/jpeg", storage_path: encJpeg, file_size_bytes: 999,
    });
    const msgs = [textComm()];
    const lookup = await resolveInlineImages(msgs, () => mockAttachmentRows as never);
    const html = generateTextThreadHTML(
      msgs, { phone: "+15550100", name: "Pat" }, {}, false, 0, { hiddenTextCount: 0 }, undefined, lookup,
    );
    expect(html).toContain(`src="data:image/jpeg;base64,${JPEG.toString("base64")}"`);
    expect(html).not.toContain("file://");
    assertNoPlaintextInUserData();
  });

  it("a missing image is a placeholder line, not a broken file:// reference", async () => {
    mockAttachmentRows.push({
      id: "a2", filename: "gone.jpg", mime_type: "image/jpeg", storage_path: path.join(userData, "message-attachments", "gone.jpg"), file_size_bytes: 1,
    });
    const msgs = [textComm()];
    const lookup = await resolveInlineImages(msgs, () => mockAttachmentRows as never);
    const html = generateTextThreadHTML(
      msgs, { phone: "+15550100", name: "Pat" }, {}, false, 0, { hiddenTextCount: 0 }, undefined, lookup,
    );
    expect(html).toContain("[Image: gone.jpg - file not found]");
    expect(html).not.toContain("file://");
  });
});

describe("R6 fix-ups: unreadable images and the embed budget", () => {
  const render = (lookup: Awaited<ReturnType<typeof resolveInlineImages>>, msgs = [textComm()]) =>
    generateTextThreadHTML(msgs, { phone: "+15550100", name: "Pat" }, {}, false, 0, { hiddenTextCount: 0 }, undefined, lookup);

  it("a tampered encrypted image logs a typed error (no path) and reads as unverifiable, not 'not found'", async () => {
    const bytes = fs.readFileSync(encJpeg);
    bytes[bytes.length - 3] ^= 0xff; // damage the last chunk's tag
    fs.writeFileSync(encJpeg, bytes);
    mockAttachmentRows.push({
      id: "a9", filename: "tampered.jpg", mime_type: "image/jpeg", storage_path: encJpeg, file_size_bytes: 1,
    });
    (logService.error as jest.Mock).mockClear();
    const msgs = [textComm()];
    const html = render(await resolveInlineImages(msgs, () => mockAttachmentRows as never), msgs);
    expect(html).toContain("[Image: tampered.jpg - could not be decrypted or verified]");
    expect(html).not.toContain("file not found");
    expect(html).not.toContain("data:image");
    const calls = (logService.error as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual({ errorType: "AtRestIntegrityError" });
    expect(JSON.stringify(calls[0])).not.toContain(userData);
    expect(JSON.stringify(calls[0])).not.toContain("tampered.jpg");
  });

  it("the attachment_only branch also shows a placeholder for an unembeddable image", async () => {
    mockAttachmentRows.push({
      id: "a10", filename: "gone2.jpg", mime_type: "image/jpeg", storage_path: path.join(userData, "message-attachments", "gone2.jpg"), file_size_bytes: 1,
    });
    const msg = { ...textComm(), body_text: "", message_type: "attachment_only" } as unknown as Communication;
    const html = render(await resolveInlineImages([msg], () => mockAttachmentRows as never), [msg]);
    expect(html).toContain("[Image: gone2.jpg - file not found]");
  });

  it("past the total embed cap an image becomes a placeholder and the export still succeeds", async () => {
    const msgs = [textComm()];
    const budget = newInlineImageBudget();
    expect(budget.remaining).toBe(MAX_TOTAL_INLINE_IMAGE_BYTES);
    budget.remaining = JPEG.length; // room for exactly one image
    mockAttachmentRows.push(
      { id: "b1", filename: "one.jpg", mime_type: "image/jpeg", storage_path: encJpeg, file_size_bytes: 1 },
      { id: "b2", filename: "two.jpg", mime_type: "image/jpeg", storage_path: encJpeg, file_size_bytes: 1 },
    );
    const html = render(await resolveInlineImages(msgs, () => mockAttachmentRows as never, budget), msgs);
    expect(html.match(/src="data:image\/jpeg/g)).toHaveLength(1);
    expect(html).toContain("[Image: two.jpg - omitted to keep this export a manageable size]");
    expect(budget.remaining).toBe(0);
    expect(MAX_TOTAL_INLINE_IMAGE_BYTES).toBeGreaterThan(MAX_INLINE_IMAGE_BYTES);
  });
});

describe("R7 folder export copies decrypt into the export folder", () => {
  it("R7a email attachments (attachmentHelpers) are written as plaintext", async () => {
    mockAttachmentRows.push({
      id: "a3", filename: "report.txt", mime_type: "text/plain", storage_path: encText, file_size_bytes: TEXT.length,
    });
    const result = await exportEmailAttachmentsToThreadDirs([emailComm()], exportDir);
    expect(result.exported).toBe(1);
    const written = allFiles(exportDir);
    expect(written).toHaveLength(1);
    expect(fs.readFileSync(written[0]).equals(TEXT)).toBe(true);
    assertNoPlaintextInUserData();
  });

  it("R7b exportAttachments (folderExportService) writes plaintext", async () => {
    mockAttachmentRows.push({
      id: "a4", message_id: "t1", email_id: null, filename: "photo.jpg", mime_type: "image/jpeg", storage_path: encJpeg, file_size_bytes: 1,
    });
    await folderExportService.exportAttachments(
      { id: "txn", property_address: "1 Test St" } as never,
      [textComm()],
      exportDir,
      { hiddenTextCount: 0 },
    );
    const out = path.join(exportDir, "photo.jpg");
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out).equals(JPEG)).toBe(true);
    assertNoPlaintextInUserData();
  });
});

describe("R8 text extraction", () => {
  it("stores the text of the plaintext, read through one handle", async () => {
    const outcome = await extractTextForAttachment({
      id: "x1", storage_path: encText, mime_type: "text/plain", text_content: null,
    });
    expect(outcome).toBe("extracted");
    expect(mockSetText).toHaveBeenCalledWith("x1", TEXT.toString("utf8").trim());
    assertNoPlaintextInUserData();
  });

  it("the size cap applies to the plaintext size from the header", async () => {
    // ciphertext is larger than the plaintext: a cap between the two must PASS
    const cipherSize = fs.statSync(encText).size;
    expect(cipherSize).toBeGreaterThan(TEXT.length);
    const outcome = await extractTextForAttachment(
      { id: "x2", storage_path: encText, mime_type: "text/plain", text_content: null },
      { maxSizeBytes: TEXT.length },
    );
    expect(outcome).toBe("extracted");
  });
});

describe("R9 broker upload + preflight", () => {
  it("uploads the plaintext", async () => {
    const res = await supabaseStorageService.uploadAttachment("org", "sub", "att-1", encJpeg, "photo.jpg");
    expect(res.success).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].body.equals(JPEG)).toBe(true);
    assertNoPlaintextInUserData();
  });

  it("preflight reports the plaintext size, not the ciphertext size", async () => {
    const r = await runSubmissionPreflight({
      messages: [],
      emails: [{ id: "e1", has_attachments: 1 }],
      attachments: [{ id: "a5", email_id: "e1", filename: "photo.jpg", storage_path: encJpeg } as never],
      undownloadedEmailAttachments: [],
      textLabel: () => "",
    });
    expect(r.sendable.map((a) => a.id)).toEqual(["a5"]);
    expect(r.sizeById.get("a5")).toBe(JPEG.length);
    expect(fs.statSync(encJpeg).size).not.toBe(JPEG.length);
  });
});

describe("PH phase switch for DB-path readers", () => {
  it("plaintext passes before the scope is done and is refused after", async () => {
    const legacy = path.join(userData, "attachments", "e1", "legacy.txt");
    fs.writeFileSync(legacy, TEXT);
    const markers = createMarkerStore({ userData: () => userData });

    // before: every reader accepts the plaintext file
    expect(
      await extractTextForAttachment({ id: "p1", storage_path: legacy, mime_type: "text/plain", text_content: null }),
    ).toBe("extracted");
    expect((await supabaseStorageService.uploadAttachment("o", "s", "p1", legacy, "legacy.txt")).success).toBe(true);
    mockAttachmentRows.push({ id: "p1", filename: "legacy.txt", mime_type: "text/plain", storage_path: legacy, file_size_bytes: 1 });
    expect((await exportEmailAttachmentsToThreadDirs([emailComm()], path.join(exportDir, "before"))).exported).toBe(1);

    await markers.setScope("email-attachments", "done");

    // after: refused by each
    expect(
      await extractTextForAttachment({ id: "p2", storage_path: legacy, mime_type: "text/plain", text_content: null }),
    ).toBe("error");
    expect((await supabaseStorageService.uploadAttachment("o", "s", "p2", legacy, "legacy.txt")).success).toBe(false);
    const after = await exportEmailAttachmentsToThreadDirs([emailComm()], path.join(exportDir, "after"));
    expect(after.exported).toBe(0);
    expect(allFiles(path.join(exportDir, "after"))).toEqual([]);
    const pre = await runSubmissionPreflight({
      messages: [],
      emails: [{ id: "e1", has_attachments: 1 }],
      attachments: [{ id: "p3", email_id: "e1", filename: "legacy.txt", storage_path: legacy } as never],
      undownloadedEmailAttachments: [],
      textLabel: () => "",
    });
    expect(pre.sendable).toEqual([]);

    // ciphertext in the same scope still reads
    expect(
      await extractTextForAttachment({ id: "p4", storage_path: encText, mime_type: "text/plain", text_content: null }),
    ).toBe("extracted");
  });
});

// KP — see the note in attachmentReaders.handlers.test.ts. KNOWN RED until S1's
// hardened detection is merged into S2; then flip `it.failing` to `it`.
describe("KP export of a legacy plaintext file that starts with the magic bytes", () => {
  it.failing("exports it byte-identical", async () => {
    const forged = Buffer.concat([Buffer.from("KEPRENC"), crypto.randomBytes(200)]);
    const p = path.join(userData, "attachments", "e1", "legacy-kep.pdf");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, forged);
    mockAttachmentRows.push({ id: "kp", filename: "legacy-kep.pdf", mime_type: "application/pdf", storage_path: p, file_size_bytes: forged.length });
    const result = await exportEmailAttachmentsToThreadDirs([emailComm()], exportDir);
    expect(result.exported).toBe(1);
    const out = allFiles(exportDir);
    expect(out).toHaveLength(1);
    expect(fs.readFileSync(out[0]).equals(forged)).toBe(true);
  });
});

