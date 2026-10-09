/**
 * @jest-environment node
 */

/**
 * BACKLOG-3683 (coordinator routing 2026-10-04) — the export PDF lists, at
 * its end, the attachments this export selected but could not include.
 *
 * Runs the REAL enhancedExportService → folderExportService path (harness
 * mirrors enhancedExportAttachmentSelector-2771). Four attachment rows:
 *   - present            → copied, not listed
 *   - no local path      → the export downloads it first; if the mailbox
 *                          does not return it → listed "Couldn't be
 *                          downloaded from the mailbox"
 *   - path, file gone    → listed "No longer on this computer"
 *   - copy throws        → listed "Could not be copied"
 *
 * C5a MUTATION: skip the `sections.push` of the files section → red.
 * C5b MUTATION: render the PDF before exporting attachments (old order) →
 *     the list is not known yet → red.
 * C7 MUTATION: skip the download step in `_exportPDF` → the downloadable
 *     attachment is listed instead of included → red.
 */

jest.mock("electron", () => ({
  BrowserWindow: jest.fn().mockImplementation(() => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    return {
      loadFile: () => {
        if (handlers["did-finish-load"]) {
          setImmediate(() => handlers["did-finish-load"]());
        }
        return Promise.resolve(undefined);
      },
      webContents: {
        printToPDF: jest.fn().mockResolvedValue(Buffer.from("mock-pdf-data")),
        on: (event: string, cb: (...args: unknown[]) => void) => {
          handlers[event] = cb;
        },
      },
      close: jest.fn(),
      isDestroyed: jest.fn().mockReturnValue(false),
    };
  }),
  app: {
    getPath: jest.fn((pathType: string) => {
      if (pathType === "downloads") return "/mock/downloads";
      if (pathType === "temp") return "/mock/temp";
      return "/mock/path";
    }),
  },
  net: { isOnline: jest.fn().mockReturnValue(true) },
}));

jest.mock("fs", () => ({ existsSync: jest.fn().mockReturnValue(false) }));

const htmlDocs: string[] = [];
const copied: string[] = [];

jest.mock("fs/promises", () => ({
  mkdir: jest.fn(async () => undefined),
  copyFile: jest.fn(async (src: string) => {
    if (src.endsWith("locked.pdf")) throw new Error("EACCES");
    copied.push(src);
    return undefined;
  }),
  access: jest.fn(async (p: string) => {
    if (p.endsWith("gone.jpg")) throw new Error("ENOENT");
    return undefined;
  }),
  writeFile: jest.fn(async (_p: string, content: unknown) => {
    if (typeof content === "string" && content.includes("<!DOCTYPE html>")) htmlDocs.push(content);
    return undefined;
  }),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

// BACKLOG-3816 S2: attachment copies now go through the at-rest reader
// (decryptToFile). This suite is about WHICH files are exported and WHERE, so the
// reader is routed to this file's copyFile mock; decrypt-on-read is proven in
// electron/services/atRest/__tests__/attachmentReaders.test.ts.
jest.mock("../atRest/attachmentReader", () => ({
  decryptStoredAttachmentTo: (src: string, dest: string) =>
    (jest.requireMock("fs/promises") as { copyFile: (a: string, b: string) => Promise<void> }).copyFile(src, dest),
  readStoredAttachment: jest.fn(async () => Buffer.alloc(0)),
  statStoredAttachment: jest.fn(async () => null),
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));

jest.mock("googleapis", () => ({ google: { gmail: jest.fn() }, gmail_v1: {}, Auth: {} }));

// Emails the download step's SQL reports as missing bytes (set in beforeEach).
let missingEmails: Array<{ id: string; external_id: string; source: string; user_id: string }> = [];

const attachmentsTable = [
  { id: "a-ok", message_id: null, email_id: "e1", filename: "agreement.pdf", mime_type: "application/pdf", storage_path: "/cache/agreement.pdf", file_size_bytes: 10 },
  { id: "a-nodl", message_id: null, email_id: "e1", filename: "addendum.pdf", mime_type: "application/pdf", storage_path: null, file_size_bytes: 10 },
  { id: "a-gone", message_id: "t1", email_id: null, filename: "gone.jpg", mime_type: "image/jpeg", storage_path: "/cache/gone.jpg", file_size_bytes: 10 },
  { id: "a-lock", message_id: null, email_id: "e1", filename: "locked.pdf", mime_type: "application/pdf", storage_path: "/cache/locked.pdf", file_size_bytes: 10 },
];

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: () => ({
      // The bytes-missing query of the shared download step: the emails it
      // should fetch from the mailbox.
      prepare: () => ({ get: () => undefined, all: () => missingEmails, run: () => undefined }),
    }),
    getAttachmentsForEmailExport: (emailId: string) =>
      attachmentsTable.filter((r) => r.email_id === emailId),
    getAttachmentsForExportBulk: (messageIds: string[], _ext: string[], emailIds: string[]) =>
      attachmentsTable.filter(
        (r) =>
          (r.email_id !== null && emailIds.includes(r.email_id)) ||
          (r.message_id !== null && messageIds.includes(r.message_id)),
      ),
    getAttachmentsForMessageWithFallback: () => [],
  },
}));

jest.mock("../db/userDbService", () => ({
  __esModule: true,
  getUserById: jest.fn().mockResolvedValue(null),
}));

jest.mock("../contactResolutionService", () => ({
  __esModule: true,
  // The text's sender resolves to a contact name; the PDF must print the name.
  resolveHandles: jest.fn().mockResolvedValue({ names: { "+15550123": "Pat Fixture" }, matches: {} }),
  matchedNamesFor: jest.fn().mockReturnValue([]),
  nameForHandle: jest.fn().mockReturnValue(undefined),
  resolveGroupChatParticipants: jest.fn().mockResolvedValue(""),
  extractParticipantHandles: jest.fn().mockReturnValue([]),
  normalizePhone: jest.fn((p: string) => p),
}));

jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn().mockResolvedValue(true), getEmailById: jest.fn().mockResolvedValue({ attachments: [] }) },
}));
jest.mock("../outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn().mockResolvedValue(true), getAttachments: jest.fn().mockResolvedValue([]) },
}));
jest.mock("../emailAttachmentService", () => ({
  __esModule: true,
  default: { downloadEmailAttachments: jest.fn().mockResolvedValue(undefined) },
}));

import type { Communication } from "../../types/models";
import type { TransactionWithDetails } from "../transactionService/types";
import type { ExportAttachmentType } from "../exportPlan";
import enhancedExportService from "../enhancedExportService";
import { testExportPlan } from "./helpers/exportPlanFixture";

const mockTransaction = {
  id: "txn-3683",
  user_id: "user-123",
  property_address: "36 Export Lane",
  transaction_type: "purchase",
  created_at: "2024-01-01T00:00:00Z",
  communications: [],
  contact_assignments: [],
} as unknown as TransactionWithDetails;

const comms = (): Communication[] => [
  {
    id: "e1", user_id: "user-123", thread_id: "thread-A", subject: "Closing package",
    body: "<div>body</div>", sender: "alice@test.com", recipients: "bob@test.com",
    direction: "inbound", sent_at: "2024-01-15T10:00:00Z", communication_type: "email",
    channel: "email", has_attachments: true, created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "t1", message_id: "t1", user_id: "user-123", thread_id: "thread-T",
    body_text: "photo attached", sender: "+15550123", direction: "inbound",
    sent_at: "2024-01-16T10:00:00Z", communication_type: "sms", channel: "sms",
    has_attachments: true, created_at: "2024-01-01T00:00:00Z",
  },
] as unknown as Communication[];

const runPdfExport = async (attachmentType: ExportAttachmentType, summaryOnly = false) => {
  const plan = testExportPlan(comms(), { format: "pdf", attachmentType, summaryOnly });
  await enhancedExportService.exportTransaction(mockTransaction, plan, { exportFormat: "pdf", summaryOnly });
};

/** The combined PDF's HTML (the one carrying the summary index). */
const pdfHtml = (): string => {
  const doc = htmlDocs.find((h) => h.includes("doc-summary"));
  expect(doc).toBeDefined();
  return doc as string;
};

beforeEach(() => {
  jest.clearAllMocks();
  htmlDocs.length = 0;
  copied.length = 0;
  // a-nodl (email e1, no file) is exactly what the bytes-missing SQL returns.
  missingEmails = [{ id: "e1", external_id: "ext-e1", source: "outlook", user_id: "user-123" }];
  const row = attachmentsTable.find((r) => r.id === "a-nodl");
  if (row) row.storage_path = null;
  jest.requireMock("../outlookFetchService").default.getAttachments.mockResolvedValue([]);
  jest.requireMock("../emailAttachmentService").default.downloadEmailAttachments.mockResolvedValue(undefined);
});

describe("BACKLOG-3683 — the export PDF lists files it could not include", () => {
  it("ends with a 'Files not included' section: file, source message, reason", async () => {
    await runPdfExport("all");
    const doc = pdfHtml();
    expect(doc).toContain('id="files-not-included"');
    expect(doc).toContain("Files not included");
    const section = doc.slice(doc.indexOf('id="files-not-included"'));
    expect(section).toContain("addendum.pdf");
    expect(section).toContain("Couldn&#039;t be downloaded from the mailbox");
    expect(section).not.toContain("Not downloaded to this computer");
    // The download was attempted: the mailbox was asked and returned nothing.
    expect(jest.requireMock("../outlookFetchService").default.getAttachments).toHaveBeenCalledWith("ext-e1");
    expect(section).toContain("gone.jpg");
    expect(section).toContain("No longer on this computer");
    expect(section).toContain("Text from Pat Fixture");
    expect(section).not.toContain("+15550123");
    expect(section).toContain("locked.pdf");
    expect(section).toContain("Could not be copied");
    expect(section).toContain("Email &quot;Closing package&quot;");
    expect(section).not.toContain("agreement.pdf</td>");
    // Last: no thread section after it.
    expect(section).not.toMatch(/id="(email|text)-thread-\d+"/);
    expect(copied).toEqual(["/cache/agreement.pdf"]);
  });

  it("nothing at zero: no section when every selected file was included", async () => {
    const saved = attachmentsTable.splice(1, 3);
    try {
      await runPdfExport("all");
      expect(copied).toEqual(["/cache/agreement.pdf"]);
      expect(pdfHtml()).not.toContain('id="files-not-included"');
    } finally {
      attachmentsTable.push(...saved);
    }
  });

  it("a PDF without attachment files lists nothing", async () => {
    await runPdfExport("none");
    expect(pdfHtml()).not.toContain('id="files-not-included"');
  });

  describe("download first (founder rule: the same ordering applies to export)", () => {
    const outlook = () => jest.requireMock("../outlookFetchService").default;
    const downloader = () => jest.requireMock("../emailAttachmentService").default;

    beforeEach(() => {
      outlook().getAttachments.mockResolvedValue([
        { id: "g-1", name: "addendum.pdf", contentType: "application/pdf", size: 10 },
      ]);
    });

    it("a not-yet-downloaded attachment the mailbox returns is downloaded and included, not listed", async () => {
      downloader().downloadEmailAttachments.mockImplementation(async () => {
        const row = attachmentsTable.find((r) => r.id === "a-nodl");
        if (row) row.storage_path = "/cache/addendum.pdf";
      });
      await runPdfExport("all");
      expect(downloader().downloadEmailAttachments).toHaveBeenCalledWith(
        "user-123", "e1", "ext-e1", "outlook", expect.any(Array),
      );
      expect(copied).toEqual(["/cache/agreement.pdf", "/cache/addendum.pdf"]);
      const doc = pdfHtml();
      const section = doc.slice(doc.indexOf('id="files-not-included"'));
      expect(section).not.toContain("addendum.pdf");
      expect(section).not.toContain("Couldn&#039;t be downloaded from the mailbox");
    });

    it("an attachment whose download fails is listed as couldn't be downloaded from the mailbox", async () => {
      downloader().downloadEmailAttachments.mockRejectedValue(new Error("mailbox 503"));
      await runPdfExport("all");
      expect(downloader().downloadEmailAttachments).toHaveBeenCalledTimes(1);
      expect(copied).toEqual(["/cache/agreement.pdf"]);
      const doc = pdfHtml();
      const section = doc.slice(doc.indexOf('id="files-not-included"'));
      expect(section).toMatch(/addendum\.pdf<\/td>[\s\S]*?Couldn&#039;t be downloaded from the mailbox/);
    });
  });
});
