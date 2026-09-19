/**
 * @jest-environment node
 */

/**
 * BACKLOG-3449 — THE COMBINED PDF CARRIES THE PROPERTY ADDRESS.
 *
 * The combined report used to be written as a bare `Combined_Report.pdf` inside
 * a `Transaction_<address>_<ts>` folder. The folder said which transaction it
 * was; the PDF did not — so a report moved, emailed or dropped into a shared
 * drive on its own was indistinguishable from every other combined report.
 *
 * Harness mirrors `enhancedExportAttachmentSelector-2771.test.ts`: the REAL
 * `folderExportService` runs behind `enhancedExportService`, with `fs/promises`
 * mocked so the actual WRITE path is the observable — not an argument handed to
 * a mocked renderer. If the two ever disagreed, this suite would follow the
 * bytes.
 *
 * Assertions are on the EXACT basename, never `toContain`. With an address that
 * holds a `/`, an unsanitized name makes `path.join` create a directory level,
 * and a substring assertion on the full path would still pass while the file
 * landed somewhere no one is looking.
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

const writtenPaths: string[] = [];
const createdDirs: string[] = [];

jest.mock("fs/promises", () => ({
  mkdir: jest.fn(async (dirPath: string) => {
    createdDirs.push(dirPath);
    return undefined;
  }),
  writeFile: jest.fn(async (filePath: string) => {
    writtenPaths.push(filePath);
    return undefined;
  }),
  copyFile: jest.fn().mockResolvedValue(undefined),
  access: jest.fn(async () => undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));

jest.mock("googleapis", () => ({ google: { gmail: jest.fn() }, gmail_v1: {}, Auth: {} }));

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: () => ({
      prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined }),
    }),
    getAttachmentsForEmailExport: () => [],
    getAttachmentsForExportBulk: () => [],
    getAttachmentsForMessageWithFallback: () => [],
  },
}));

jest.mock("../db/userDbService", () => ({
  __esModule: true,
  getUserById: jest.fn().mockResolvedValue(null),
}));

jest.mock("../contactResolutionService", () => ({
  __esModule: true,
  resolveHandles: jest.fn().mockResolvedValue({ names: {}, matches: {} }),
  matchedNamesFor: jest.fn().mockReturnValue([]),
  nameForHandle: jest.fn().mockReturnValue(undefined),
  resolveGroupChatParticipants: jest.fn().mockResolvedValue(""),
  extractParticipantHandles: jest.fn().mockReturnValue([]),
}));

import type { Communication } from "../../types/models";
import type { TransactionWithDetails } from "../transactionService/types";
import enhancedExportService from "../enhancedExportService";
// BACKLOG-2771: plans are built by the REAL resolver, never by hand.
import { testExportPlan } from "./helpers/exportPlanFixture";

// --- Fixtures ---------------------------------------------------------------

/** CI runs Windows too, where `path.join` produces backslashes. */
const norm = (p: string): string => p.replace(/\\/g, "/");

/** The one PDF this export wrote. Throws rather than returning undefined. */
const writtenPdf = (): string => {
  const pdfs = writtenPaths.map(norm).filter((p) => p.endsWith(".pdf"));
  if (pdfs.length !== 1) {
    throw new Error(`expected exactly 1 PDF write, got ${pdfs.length}: ${pdfs.join(", ")}`);
  }
  return pdfs[0];
};

const transactionAt = (propertyAddress: string): TransactionWithDetails =>
  ({
    id: "txn-3449",
    user_id: "user-123",
    property_address: propertyAddress,
    transaction_type: "purchase",
    created_at: "2024-01-01T00:00:00Z",
    communications: [],
    contact_assignments: [],
  }) as unknown as TransactionWithDetails;

const comms = (): Communication[] =>
  [
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
      has_attachments: false,
      created_at: "2024-01-01T00:00:00Z",
    },
  ] as unknown as Communication[];

/**
 * `attachmentType: "all"` is what puts the export on the FOLDER branch — the
 * branch that owns the combined PDF's name. It is also the ExportModal default
 * (`ExportModal.tsx:58`), so this is the path a user lands on without choosing
 * anything.
 */
const runFolderPdfExport = async (propertyAddress: string): Promise<void> => {
  const plan = testExportPlan(comms(), { format: "pdf", attachmentType: "all" });
  await enhancedExportService.exportTransaction(transactionAt(propertyAddress), plan, {
    exportFormat: "pdf",
  });
};

/** `attachmentType: "none"` takes the single-file branch instead. */
const runSinglePdfExport = async (propertyAddress: string): Promise<void> => {
  const plan = testExportPlan(comms(), { format: "pdf", attachmentType: "none" });
  await enhancedExportService.exportTransaction(transactionAt(propertyAddress), plan, {
    exportFormat: "pdf",
  });
};

// --- Tests ------------------------------------------------------------------

describe("BACKLOG-3449: the combined PDF is named after the property address", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    writtenPaths.length = 0;
    createdDirs.length = 0;
  });

  it("names the PDF for the address, sanitizing the characters a path cannot hold", async () => {
    // `/` and `:` are the two that matter: `/` would otherwise create a
    // directory level, `:` is illegal on Windows.
    await runFolderPdfExport("27 Selector Way / Unit 2: Rear");

    const pdf = writtenPdf();
    expect(path.basename(pdf)).toBe("27_Selector_Way_Unit_2_Rear_-_Combined_Report.pdf");
    // No `/` from the address survived into a directory level: the file sits
    // directly in the export folder.
    expect(path.dirname(pdf)).toMatch(
      /^\/mock\/downloads\/Transaction_27_Selector_Way_Unit_2_Rear_\d+$/,
    );
  });

  it("is no longer the address-free literal the report used to ship as", async () => {
    await runFolderPdfExport("27 Selector Way / Unit 2: Rear");

    expect(path.basename(writtenPdf())).not.toBe("Combined_Report.pdf");
  });

  it("tracks the address rather than being a second hardcoded name", async () => {
    // A fix that swapped one constant for another would pass the two
    // assertions above. A different transaction must produce a different name.
    await runFolderPdfExport("123 Main St");

    expect(path.basename(writtenPdf())).toBe("123_Main_St_-_Combined_Report.pdf");
  });

  it("leaves the FOLDER name exactly as it was", async () => {
    await runFolderPdfExport("123 Main St");

    const folders = createdDirs
      .map(norm)
      .filter((d) => d.startsWith("/mock/downloads/") && !d.endsWith("/attachments"));
    expect(folders).toHaveLength(1);
    expect(path.basename(folders[0])).toMatch(/^Transaction_123_Main_St_\d+$/);
  });

  it("leaves the no-attachments branch alone — it already carried the address", async () => {
    await runSinglePdfExport("123 Main St");

    expect(path.basename(writtenPdf())).toMatch(/^Transaction_Full_123_Main_St_\d+\.pdf$/);
  });
});
