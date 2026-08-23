/**
 * @jest-environment node
 */

/**
 * BACKLOG-2771 CONTROL 1, enhanced-PDF half.
 *
 * `folderExportAttachmentSelector-2769.test.ts` proves "Attachments = None
 * writes nothing" for the FOLDER export. That suite is folder-only: the
 * enhanced export ("One PDF" / "Summary") reaches attachments through a
 * different method (`enhancedExportService._exportPDF`), which had its own
 * hand-derived selector — `!summaryOnly && attachmentType !== "none"` — sitting
 * beside the folder exporter's `includeAttachments && attachmentType !== "none"`.
 * Two predicates, same question, neither aware of the other.
 *
 * Both now read one resolved flag. This suite asserts the observable
 * consequence for the enhanced path with the REAL folderExportService behind
 * it: zero `copyFile`, zero attachment directories, zero provider requests.
 *
 * Mock harness deliberately mirrors the 2769 suite, including
 * `net.isOnline: true` — an offline device makes the provider path bail early
 * and would make "zero downloads" pass for the wrong reason.
 */

import path from "path";

// --- Mocks -----------------------------------------------------------------

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

const createdDirs: string[] = [];
const copiedFiles: Array<{ src: string; dest: string }> = [];

jest.mock("fs/promises", () => ({
  mkdir: jest.fn(async (dirPath: string) => {
    createdDirs.push(dirPath);
    return undefined;
  }),
  copyFile: jest.fn(async (src: string, dest: string) => {
    copiedFiles.push({ src, dest });
    return undefined;
  }),
  access: jest.fn(async () => undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));

jest.mock("googleapis", () => ({ google: { gmail: jest.fn() }, gmail_v1: {}, Auth: {} }));

// --- Database: one attachment row per communication, locally present --------

interface AttachmentRow {
  id: string;
  message_id: string | null;
  email_id: string | null;
  filename: string;
  mime_type: string | null;
  storage_path: string | null;
  file_size_bytes: number | null;
}

const attachmentsTable: AttachmentRow[] = [
  {
    id: "att-email",
    message_id: null,
    email_id: "e1",
    filename: "purchase_agreement.pdf",
    mime_type: "application/pdf",
    storage_path: "/mock/cache/purchase_agreement.pdf",
    file_size_bytes: 2048,
  },
  {
    id: "att-text",
    message_id: "t1",
    email_id: null,
    filename: "site_photo.jpg",
    mime_type: "image/jpeg",
    storage_path: "/mock/cache/site_photo.jpg",
    file_size_bytes: 4096,
  },
];

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: () => ({
      prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined }),
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
  // BACKLOG-2757: `resolveHandles` returns { names, matches }; `matchedNamesFor`
  // is how a renderer asks how many contacts a handle names. This suite resolves
  // no handles at all, so both are empty — but the functions must EXIST, or the
  // export throws before it reaches anything this suite is about.
  resolveHandles: jest.fn().mockResolvedValue({ names: {}, matches: {} }),
  matchedNamesFor: jest.fn().mockReturnValue([]),
  nameForHandle: jest.fn().mockReturnValue(undefined),
  resolveGroupChatParticipants: jest.fn().mockResolvedValue(""),
  extractParticipantHandles: jest.fn().mockReturnValue([]),
}));

// --- Provider boundary: the observable for "did we hit Gmail/Outlook?" ------

const mockGmailInitialize = jest.fn().mockResolvedValue(true);
const mockGmailGetEmailById = jest.fn().mockResolvedValue({ attachments: [] });
const mockOutlookInitialize = jest.fn().mockResolvedValue(true);
const mockOutlookGetAttachments = jest.fn().mockResolvedValue([]);
const mockDownloadEmailAttachments = jest.fn().mockResolvedValue(undefined);

jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...a: unknown[]) => mockGmailInitialize(...a),
    getEmailById: (...a: unknown[]) => mockGmailGetEmailById(...a),
  },
}));

jest.mock("../outlookFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...a: unknown[]) => mockOutlookInitialize(...a),
    getAttachments: (...a: unknown[]) => mockOutlookGetAttachments(...a),
  },
}));

jest.mock("../emailAttachmentService", () => ({
  __esModule: true,
  default: { downloadEmailAttachments: (...a: unknown[]) => mockDownloadEmailAttachments(...a) },
}));

import type { Communication } from "../../types/models";
import type { TransactionWithDetails } from "../transactionService/types";
import type { ExportAttachmentType } from "../exportPlan";
import enhancedExportService from "../enhancedExportService";
// BACKLOG-2771: plans are built by the REAL resolver, never by hand.
import { testExportPlan } from "./helpers/exportPlanFixture";

// --- Fixtures ---------------------------------------------------------------

const norm = (p: string): string => p.replace(/\\/g, "/");

const attachmentDirs = (): string[] =>
  createdDirs.map(norm).filter((d) => d.endsWith("/attachments"));

const providerCallCount = (): number =>
  mockGmailInitialize.mock.calls.length +
  mockGmailGetEmailById.mock.calls.length +
  mockOutlookInitialize.mock.calls.length +
  mockOutlookGetAttachments.mock.calls.length +
  mockDownloadEmailAttachments.mock.calls.length;

const mockTransaction = {
  id: "txn-2771",
  user_id: "user-123",
  property_address: "27 Selector Way",
  transaction_type: "purchase",
  created_at: "2024-01-01T00:00:00Z",
  communications: [],
  contact_assignments: [],
} as unknown as TransactionWithDetails;

const comms = (): Communication[] => [
  {
    id: "e1",
    user_id: "user-123",
    thread_id: "thread-A",
    subject: "Closing",
    body: "<div>body</div>",
    sender: "alice@test.com",
    recipients: "bob@test.com",
    direction: "inbound",
    sent_at: "2024-01-15T10:00:00Z",
    communication_type: "email",
    channel: "email",
    has_attachments: true,
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "t1",
    message_id: "t1",
    user_id: "user-123",
    thread_id: "thread-T",
    body_text: "photo attached",
    direction: "inbound",
    sent_at: "2024-01-16T10:00:00Z",
    communication_type: "sms",
    channel: "sms",
    has_attachments: true,
    created_at: "2024-01-01T00:00:00Z",
  },
] as unknown as Communication[];

const runPdfExport = async (
  attachmentType: ExportAttachmentType,
  summaryOnly = false,
): Promise<void> => {
  const plan = testExportPlan(comms(), { format: "pdf", attachmentType, summaryOnly });
  await enhancedExportService.exportTransaction(mockTransaction, plan, {
    exportFormat: "pdf",
    summaryOnly,
  });
};

// --- Tests ------------------------------------------------------------------

describe("BACKLOG-2771: the enhanced PDF export honors the attachment selector", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createdDirs.length = 0;
    copiedFiles.length = 0;
  });

  it('"none" copies NO files and creates NO attachments directory', async () => {
    await runPdfExport("none");

    expect(copiedFiles).toEqual([]);
    expect(attachmentDirs()).toEqual([]);
  });

  it('"none" makes NO provider requests', async () => {
    await runPdfExport("none");

    expect(providerCallCount()).toBe(0);
  });

  it("a summary-only PDF copies nothing even when the user selected ALL attachments", async () => {
    await runPdfExport("all", true);

    expect(copiedFiles).toEqual([]);
    expect(attachmentDirs()).toEqual([]);
  });

  it("ANTI-VACUITY: the same path DOES copy both attachments when \"all\" is selected", async () => {
    // Without this, every assertion above could pass because the fixture has no
    // attachment the exporter could ever find.
    await runPdfExport("all");

    expect(copiedFiles.map((c) => path.basename(norm(c.dest))).sort()).toEqual([
      "purchase_agreement.pdf",
      "site_photo.jpg",
    ]);
    expect(attachmentDirs().length).toBeGreaterThan(0);
  });

  it('"email" copies the email attachment only', async () => {
    await runPdfExport("email");

    expect(copiedFiles.map((c) => path.basename(norm(c.dest)))).toEqual([
      "purchase_agreement.pdf",
    ]);
  });

  it('"text" copies the text attachment only', async () => {
    await runPdfExport("text");

    expect(copiedFiles.map((c) => path.basename(norm(c.dest)))).toEqual(["site_photo.jpg"]);
  });
});
