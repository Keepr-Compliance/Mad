/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S2 — founder requirement: LOCAL EXPORTS ARE NEVER ENCRYPTED.
 *
 * Every export path that writes to a location the user chose must produce plain,
 * openable files when the SOURCE attachments are encrypted at rest. Each test
 * below runs a real export entry point, with real fs, against KEPRENC source
 * fixtures (createFileCrypto, 64-byte chunks), then walks EVERY output file:
 *   - no file contains the KEPRENC magic anywhere;
 *   - each file starts with its real magic (PDF / JPEG / PNG), or parses as JSON
 *     for manifest.json;
 *   - exported attachments are byte-identical to the plaintext fixtures;
 *   - every image embedded in a rendered PDF's HTML is a data: URI whose bytes
 *     are the plaintext image (real magic, no KEPRENC) — and at least one exists.
 *
 * Paths covered (all entry points that read attachment bytes for an export):
 *   X1  folderExportService.exportTransactionToFolder — emails/<thread>/attachments
 *       (attachmentHelpers), attachments/ (exportAttachments), texts/*.pdf images
 *   X2  enhancedExportService.exportTransaction, PDF + attachments folder —
 *       attachments/ (exportAttachments) + the combined PDF's images
 *   X3  folderExportService.exportTransactionToCombinedPDF — combined PDF images
 * The audit summary PDF and email-thread PDFs read no attachment bytes (they
 * list file names only); their files are still swept by X1/X2.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";

let tempDir = "/nonexistent";
let downloadsDir = "/nonexistent";
const renderedHtml: string[] = [];
const PDF_BYTES = Buffer.from("%PDF-1.7\n% mock rendered pdf\n");

jest.mock("electron", () => ({
  BrowserWindow: jest.fn().mockImplementation(() => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    return {
      loadFile: async (file: string) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        renderedHtml.push(require("fs").readFileSync(file, "utf8"));
        if (handlers["did-finish-load"]) setImmediate(() => handlers["did-finish-load"]());
      },
      webContents: {
        printToPDF: jest.fn(async () => PDF_BYTES),
        on: (event: string, cb: (...args: unknown[]) => void) => {
          handlers[event] = cb;
        },
      },
      close: jest.fn(),
      isDestroyed: jest.fn().mockReturnValue(false),
    };
  }),
  app: {
    getPath: jest.fn((kind: string) => (kind === "temp" ? tempDir : kind === "downloads" ? downloadsDir : "/nonexistent")),
    isPackaged: false,
  },
  net: { isOnline: jest.fn(() => false) },
}));
jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));

type Row = {
  id: string;
  message_id: string | null;
  email_id: string | null;
  filename: string;
  mime_type: string;
  storage_path: string;
  file_size_bytes: number;
};
const mockRows: Row[] = [];

jest.mock("../../databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: () => ({ prepare: () => ({ get: () => ({ cnt: 1 }), all: () => [], run: () => undefined }) }),
    getAttachmentsForExportBulk: (messageIds: string[], _ext: string[], emailIds: string[]) =>
      mockRows.filter(
        (r) => (r.message_id && messageIds.includes(r.message_id)) || (r.email_id && emailIds.includes(r.email_id)),
      ),
    getAttachmentsForEmailExport: (emailId: string) => mockRows.filter((r) => r.email_id === emailId),
    getAttachmentsForMessageWithFallback: (messageId: string) => mockRows.filter((r) => r.message_id === messageId),
  },
}));

const mockBudget = { bytes: 50 * 1024 * 1024 };
jest.mock("../../folderExport/textExportHelpers", () => ({
  ...jest.requireActual("../../folderExport/textExportHelpers"),
  newInlineImageBudget: () => ({ remaining: mockBudget.bytes }),
}));

import type { Communication } from "../../../types/models";
import type { TransactionWithDetails } from "../../transactionService/types";
import enhancedExportService from "../../enhancedExportService";
import folderExportService from "../../folderExportService";
import { testExportPlan } from "../../__tests__/helpers/exportPlanFixture";
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
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(200)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), crypto.randomBytes(250)]);

const MAGICS: Record<string, Buffer> = {
  ".pdf": Buffer.from("%PDF"),
  ".jpg": Buffer.from([0xff, 0xd8, 0xff]),
  ".png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
};

const TRANSACTION = {
  id: "txn-s2",
  user_id: "user-s2",
  property_address: "12 Plain Export Way",
  transaction_type: "purchase",
  started_at: "2026-03-01",
  closed_at: "2026-03-31",
  communications: [],
  contact_assignments: [],
} as unknown as TransactionWithDetails;

const textMsg = {
  id: "t1",
  message_id: "t1",
  user_id: "user-s2",
  thread_id: "thread-T",
  sender: "+15555550112",
  body_text: "photos attached",
  body_plain: "photos attached",
  direction: "inbound",
  sent_at: "2026-03-10T10:00:00Z",
  communication_type: "imessage",
  channel: "imessage",
  external_id: "guid-t1",
  associated_message_type: null,
  associated_message_guid: null,
  has_attachments: true,
  hidden_from_export: 0,
} as unknown as Communication;

const emailMsg = {
  id: "e1",
  user_id: "user-s2",
  thread_id: "thread-E",
  subject: "Signed contract",
  body: "<div>attached</div>",
  body_plain: "attached",
  sender: "agent@test.com",
  recipients: "client@test.com",
  direction: "inbound",
  sent_at: "2026-03-11T10:00:00Z",
  communication_type: "email",
  has_attachments: true,
  hidden_from_export: 0,
} as unknown as Communication;

let root: string;
let userData: string;

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

/** Every output file is plain and openable. Returns the files checked. */
function assertPlainOutputs(dir: string): string[] {
  const out = allFiles(dir);
  expect(out.length).toBeGreaterThan(0);
  const problems: string[] = [];
  for (const f of out) {
    const bytes = fs.readFileSync(f);
    if (bytes.includes(MAGIC)) problems.push(`${path.relative(dir, f)}: contains KEPRENC`);
    const ext = path.extname(f).toLowerCase();
    if (ext === ".json") {
      try {
        JSON.parse(bytes.toString("utf8"));
      } catch {
        problems.push(`${path.relative(dir, f)}: not JSON`);
      }
    } else if (MAGICS[ext]) {
      if (!bytes.subarray(0, MAGICS[ext].length).equals(MAGICS[ext])) {
        problems.push(`${path.relative(dir, f)}: wrong magic ${bytes.subarray(0, 8).toString("hex")}`);
      }
    } else {
      problems.push(`${path.relative(dir, f)}: unexpected output type`);
    }
  }
  expect(problems).toEqual([]);
  return out;
}

/** Exported attachment files equal the plaintext fixtures. */
function assertAttachmentBytes(outFiles: string[]): void {
  for (const [name, plain] of [["photo.jpg", JPEG], ["plan.png", PNG], ["contract.pdf", PDF]] as const) {
    const hits = outFiles.filter((f) => path.basename(f) === name);
    expect({ name, found: hits.length > 0 }).toEqual({ name, found: true });
    for (const h of hits) expect({ name, equal: fs.readFileSync(h).equals(plain) }).toEqual({ name, equal: true });
  }
}

/** Every image embedded in the rendered PDFs is plaintext; at least `min` exist. */
function assertEmbeddedImages(min: number): void {
  const uris = renderedHtml.flatMap((h) => [...h.matchAll(/src="data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)"/gi)]);
  expect(uris.length).toBeGreaterThanOrEqual(min);
  for (const m of uris) {
    const bytes = Buffer.from(m[2], "base64");
    expect(bytes.includes(MAGIC)).toBe(false);
    const ok = bytes.subarray(0, 3).equals(MAGICS[".jpg"]) || bytes.subarray(0, 4).equals(MAGICS[".png"]);
    expect({ mime: m[1], realMagic: ok }).toEqual({ mime: m[1], realMagic: true });
  }
  for (const h of renderedHtml) expect(h).not.toContain("file://");
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-exports-")));
  userData = path.join(root, "keepr");
  tempDir = path.join(root, "tmp");
  downloadsDir = path.join(root, "downloads");
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  const enc = async (rel: string, plain: Buffer) => {
    const p = path.join(userData, rel);
    await files.encryptStreamToFile(Readable.from([plain]), p);
    return p;
  };
  mockRows.length = 0;
  mockRows.push(
    { id: "a-jpg", message_id: "t1", email_id: null, filename: "photo.jpg", mime_type: "image/jpeg", storage_path: await enc("message-attachments/aa.jpg", JPEG), file_size_bytes: JPEG.length },
    { id: "a-png", message_id: "t1", email_id: null, filename: "plan.png", mime_type: "image/png", storage_path: await enc("message-attachments/bb.png", PNG), file_size_bytes: PNG.length },
    { id: "a-pdf", message_id: null, email_id: "e1", filename: "contract.pdf", mime_type: "application/pdf", storage_path: await enc("attachments/e1/cc.pdf", PDF), file_size_bytes: PDF.length },
  );
  for (const r of mockRows) expect(fs.readFileSync(r.storage_path).subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
  setAttachmentReaderDepsForTests({
    files: () => files,
    markers: () => createMarkerStore({ userData: () => userData }),
    userData: () => userData,
  });
  // Both scopes fully migrated: the strictest phase. Exports must still be plain.
  const markers = createMarkerStore({ userData: () => userData });
  await markers.setScope("message-attachments", "done");
  await markers.setScope("email-attachments", "done");
  renderedHtml.length = 0;
});

afterEach(() => {
  setAttachmentReaderDepsForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

const plan = (opts: Record<string, unknown> = {}) =>
  testExportPlan([textMsg, emailMsg], { startDate: "2026-03-01", endDate: "2026-03-31", ...opts } as never);

describe("local exports are plaintext when the sources are encrypted", () => {
  it("X1 folder export: every file plain; attachments byte-identical; text PDF images plain", async () => {
    const outDir = path.join(root, "folder-export");
    await folderExportService.exportTransactionToFolder(TRANSACTION, plan(), {
      transactionId: TRANSACTION.id,
      outputPath: outDir,
    });
    const out = assertPlainOutputs(outDir);
    assertAttachmentBytes(out);
    assertEmbeddedImages(2);
  });

  it("X2 PDF export with attachments folder: every file plain; combined PDF images plain", async () => {
    await enhancedExportService.exportTransaction(TRANSACTION, plan({ format: "pdf", attachmentType: "all" }), {
      exportFormat: "pdf",
    });
    const out = assertPlainOutputs(downloadsDir);
    assertAttachmentBytes(out);
    assertEmbeddedImages(2);
  });

  it("X3 single combined PDF: plain PDF file; embedded images plain", async () => {
    const outFile = path.join(root, "combined", "Audit.pdf");
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await folderExportService.exportTransactionToCombinedPDF(TRANSACTION, [textMsg, emailMsg], outFile, {
      hiddenTextCount: 0,
      hiddenTexts: [],
      filesNotIncluded: [],
    } as never);
    assertPlainOutputs(path.dirname(outFile));
    assertEmbeddedImages(2);
  });

  it("X4 combined PDF: the image budget is SHARED by every thread (room for one image, two threads)", async () => {
    const secondThread = {
      ...textMsg, id: "t2", message_id: "t2", thread_id: "thread-U", sender: "+15125550199", external_id: "guid-t2",
      sent_at: "2026-03-12T10:00:00Z",
    } as unknown as Communication;
    mockRows.length = 0;
    for (const [id, msg] of [["t1", "x1"], ["t2", "x2"]]) {
      const p = path.join(userData, `message-attachments/${msg}.jpg`);
      await files.encryptStreamToFile(Readable.from([JPEG]), p);
      mockRows.push({ id: `img-${id}`, message_id: id, email_id: null, filename: `${id}.jpg`, mime_type: "image/jpeg", storage_path: p, file_size_bytes: JPEG.length });
    }
    mockBudget.bytes = JPEG.length + 1;
    try {
      const outFile = path.join(root, "shared", "Audit.pdf");
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      await folderExportService.exportTransactionToCombinedPDF(TRANSACTION, [textMsg, secondThread], outFile, {
        hiddenTextCount: 0, hiddenTexts: [], filesNotIncluded: [],
      } as never);
    } finally {
      mockBudget.bytes = 50 * 1024 * 1024;
    }
    const html = renderedHtml.join("\n");
    expect(html.match(/src="data:image\/jpeg;base64,/g)).toHaveLength(1);
    expect(html.match(/omitted to keep this export a manageable size/g)).toHaveLength(1);
  });

  it("the export temp HTML is removed (no plaintext left in the temp dir)", async () => {
    await folderExportService.exportTransactionToFolder(TRANSACTION, plan(), {
      transactionId: TRANSACTION.id,
      outputPath: path.join(root, "fx"),
    });
    expect(allFiles(tempDir)).toEqual([]);
  });
});
