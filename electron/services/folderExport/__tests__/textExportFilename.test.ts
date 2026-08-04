/**
 * @jest-environment node
 *
 * BACKLOG-2463 — the exported FILE NAME.
 *
 * This is the site that made the ticket a bug rather than a polish item.
 * `folderExportService` wrote `Unknown_Contact` into the name of a PDF inside the
 * audit package: it goes to the broker, it sits in their folder, and it survives
 * every later fix to the screen. The export was holding the phone number the
 * whole time — the phone IS the thread key — so the file could always have been
 * named after the number.
 *
 * Asserted as an EXACT SET of file names, not as a substring search: a test that
 * only checks "Unknown" is absent would still pass if the file were named after
 * nothing at all.
 */

const mockPrintToPDF = jest.fn().mockResolvedValue(Buffer.from("mock-pdf-data"));
const mockClose = jest.fn();
const mockIsDestroyed = jest.fn().mockReturnValue(false);

jest.mock("electron", () => ({
  BrowserWindow: jest.fn().mockImplementation(() => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    return {
      loadFile: async () => {
        if (handlers["did-finish-load"]) setImmediate(() => handlers["did-finish-load"]());
      },
      webContents: {
        printToPDF: mockPrintToPDF,
        on: (event: string, cb: (...args: unknown[]) => void) => {
          handlers[event] = cb;
        },
      },
      close: mockClose,
      isDestroyed: mockIsDestroyed,
    };
  }),
  app: { getPath: jest.fn(() => "/mock/temp") },
}));

/** Every path written, and every HTML document rendered on the way. */
const writtenPaths: string[] = [];
const renderedHtml: string[] = [];

jest.mock("fs/promises", () => ({
  writeFile: jest.fn(async (filePath: string, content: unknown) => {
    writtenPaths.push(filePath);
    if (typeof content === "string" && content.includes("<!DOCTYPE html>")) {
      renderedHtml.push(content);
    }
  }),
  mkdir: jest.fn().mockResolvedValue(undefined),
  access: jest.fn().mockResolvedValue(undefined),
  copyFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: { info: noop, warn: noop, error: noop, debug: noop, log: noop },
  };
});

jest.mock("../../databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: jest.fn().mockReturnValue({
      prepare: jest.fn().mockReturnValue({ all: jest.fn().mockReturnValue([]) }),
    }),
    getAttachmentsForExportBulk: jest.fn().mockReturnValue([]),
    getAttachmentsForMessageExport: jest.fn().mockReturnValue([]),
    getAttachmentsForEmailExport: jest.fn().mockReturnValue([]),
  },
}));

jest.mock("../../db/userDbService", () => ({
  __esModule: true,
  getUserById: jest.fn().mockResolvedValue(null),
}));

/**
 * The phone→name map is the ONLY channel by which a contact record reaches the
 * text export, so it is where an organisation-only party arrives as its
 * organisation. Everything else about the thread comes from the messages.
 */
const HANDLE_NAMES: Record<string, string> = {
  "2065559876": "Acme Title Co.",
};

jest.mock("../../contactResolutionService", () => ({
  __esModule: true,
  normalizePhone: (s: string) => (s || "").replace(/\D/g, "").slice(-10),
  extractParticipantHandles: () => [],
  resolveHandles: async () => HANDLE_NAMES,
  resolveGroupChatParticipants: async () => [],
}));

import path from "path";
import type { Communication, Transaction } from "../../../types/models";
import type { TransactionWithDetails } from "../../transactionService/types";
import folderExportService from "../folderExportService";

function text(over: Partial<Communication>): Communication {
  return {
    user_id: "user-1",
    direction: "inbound",
    communication_type: "text",
    channel: "text",
    has_attachments: false,
    is_false_positive: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  } as unknown as Communication;
}

const transaction = {
  id: "txn-2463",
  user_id: "user-1",
  property_address: "123 Test St",
  transaction_type: "purchase",
  created_at: "2026-01-01T00:00:00.000Z",
} as unknown as TransactionWithDetails & Transaction;

/**
 * Four threads, ordered by first message so the thread index is deterministic:
 *
 *  1. a number we hold with no contact record  -> named for the number
 *  2. an organisation-only party               -> named for the organisation
 *  3. a thread that never carried a handle     -> the chain's terminal fallback
 *  4. an unresolvable group chat               -> named for the chat (unchanged)
 */
const texts: Communication[] = [
  text({
    id: "m-nameless",
    thread_id: "th-nameless",
    sender: "+12065551234",
    body_text: "Closing docs are attached.",
    sent_at: "2026-01-15T10:00:00.000Z",
  }),
  text({
    id: "m-org",
    thread_id: "th-org",
    sender: "+12065559876",
    body_text: "Title commitment ready.",
    sent_at: "2026-01-16T10:00:00.000Z",
  }),
  text({
    id: "m-nohandle",
    thread_id: "th-nohandle",
    body_text: "…",
    sent_at: "2026-01-17T10:00:00.000Z",
  }),
  text({
    id: "m-group",
    thread_id: "th-group",
    body_text: "hi all",
    sent_at: "2026-01-18T10:00:00.000Z",
    participants: JSON.stringify({ chat_members: ["+12065551234", "+12065559876"] }),
  }),
];

/** File names written into the `texts/` directory, separator-agnostic. */
function exportedTextFileNames(): string[] {
  return writtenPaths
    .filter((p) => p.endsWith(".pdf"))
    .filter((p) => path.basename(path.dirname(p)) === "texts")
    .map((p) => path.basename(p));
}

describe("exported text-thread file names (BACKLOG-2463)", () => {
  beforeAll(async () => {
    await folderExportService.exportTransactionToFolder(transaction, texts, {
      transactionId: transaction.id,
      outputPath: path.join("/mock", "output"),
      includeEmails: false,
      includeTexts: true,
      includeAttachments: false,
    });
  });

  it("names every thread file after the party — exact set", () => {
    expect(exportedTextFileNames()).toEqual([
      // The number, sanitised — not the word "Unknown".
      "text_001_1_206_555-1234_2026-01-15.pdf",
      // The organisation, via the shared chain.
      "text_002_Acme_Title_Co_2026-01-16.pdf",
      // The chain's terminal fallback, reached only because every field is empty.
      "text_003_No_name_2026-01-17.pdf",
      // Byte-identical to what shipped before this change.
      "text_004_Group_Chat_2026-01-18.pdf",
    ]);
  });

  it("writes no file naming anyone Unknown", () => {
    for (const p of writtenPaths) {
      expect(path.basename(p).toLowerCase()).not.toContain("unknown");
    }
  });

  it("every exported name is legal on Windows", () => {
    // CI runs on Windows; a name macOS accepts can be refused outright there.
    for (const name of exportedTextFileNames()) {
      expect(name).toMatch(/^[A-Za-z0-9_.-]+$/);
      expect(name).not.toMatch(/[<>:"/\\|?*]/);
      expect(name).not.toMatch(/[. ]$/);
      expect(name.length).toBeLessThanOrEqual(255);
    }
  });

  it("names the nameless party the same way in the file BODY as in the file NAME", () => {
    // The two used to disagree, which is how one of them stayed wrong.
    const thread = renderedHtml.find((h) => h.includes("Closing docs are attached."));
    expect(thread).toBeDefined();
    expect(thread).toContain(
      '<h1>Conversation with +1 (206) 555-1234 <span class="badge">#001</span></h1>',
    );
    expect(exportedTextFileNames()[0]).toBe("text_001_1_206_555-1234_2026-01-15.pdf");
    expect(thread!.toLowerCase()).not.toContain("unknown");
  });

  it("names the handle-less thread with the terminal fallback in body and name alike", () => {
    const thread = renderedHtml.find((h) => h.includes('<h1>No name <span class="badge">'));
    expect(thread).toBeDefined();
    expect(exportedTextFileNames()[2]).toBe("text_003_No_name_2026-01-17.pdf");
  });
});
