/**
 * @jest-environment node
 */

/**
 * Unit tests for FolderExportService
 * Tests text thread PDF export functionality including:
 * - Thread grouping by thread_id
 * - Contact name resolution
 * - Group chat detection
 * - HTML generation
 */

import { jest } from "@jest/globals";

// Store HTML content for test verification (TASK-1802)
let lastLoadedHtmlContent: string | null = null;

// Mock electron
const mockPrintToPDF = jest.fn().mockResolvedValue(Buffer.from("mock-pdf-data"));
const mockLoadFile = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn();
const mockIsDestroyed = jest.fn().mockReturnValue(false);

jest.mock("electron", () => ({
  BrowserWindow: jest.fn().mockImplementation(() => {
    // Capture event handlers so loadFile can fire "did-finish-load"
    // (BACKLOG-1584 combined path uses the did-finish-load pattern).
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    return {
      loadFile: (...args: unknown[]) => {
        const result = mockLoadFile(...args);
        // Fire did-finish-load asynchronously to resolve the render promise.
        if (handlers["did-finish-load"]) {
          setImmediate(() => handlers["did-finish-load"]());
        }
        return result;
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
  app: {
    getPath: jest.fn((pathType: string) => {
      if (pathType === "downloads") return "/mock/downloads";
      if (pathType === "temp") return "/mock/temp";
      return "/mock/path";
    }),
  },
}));

// Mock fs/promises - capture HTML content for test verification
const mockWriteFile = jest.fn().mockImplementation(async (filePath: string, content: unknown) => {
  // Store HTML content for later verification if it's an HTML file
  if (typeof content === "string" && content.includes("<!DOCTYPE html>")) {
    lastLoadedHtmlContent = content;
  }
  return undefined;
});
const mockMkdir = jest.fn().mockResolvedValue(undefined);
const mockAccess = jest.fn().mockResolvedValue(undefined);
const mockCopyFile = jest.fn().mockResolvedValue(undefined);
const mockUnlink = jest.fn().mockResolvedValue(undefined);

jest.mock("fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  access: mockAccess,
  copyFile: mockCopyFile,
  unlink: mockUnlink,
}));

// Mock logService - use factory to ensure all methods are available
jest.mock("../logService", () => {
  const mockLog = jest.fn();
  return {
    __esModule: true,
    default: {
      info: mockLog,
      warn: mockLog,
      error: mockLog,
      debug: mockLog,
      log: mockLog,
    },
  };
});

// Mock databaseService
const mockPrepare = jest.fn().mockReturnValue({
  all: jest.fn().mockReturnValue([]),
});

jest.mock("../databaseService", () => ({
  default: {
    getRawDatabase: jest.fn().mockReturnValue({
      prepare: mockPrepare,
    }),
  },
}));

import type { Communication, Transaction } from "../../types/models";

// Import standalone helper functions extracted from FolderExportService
import {
  stripHtmlQuotedContent,
  stripPlainTextQuotedContent,
  stripQuotedContent,
  isHtmlContent,
  stripSubjectPrefixes,
} from "../folderExport/emailExportHelpers";
import { getThreadKey as getThreadKeyHelper } from "../folderExport/textExportHelpers";

describe("FolderExportService", () => {
  let folderExportService: typeof import("../folderExportService").default;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();

    // Reset HTML content capture for special message type tests
    lastLoadedHtmlContent = null;

    // Reset mock implementations
    mockPrepare.mockReturnValue({
      all: jest.fn().mockReturnValue([]),
    });

    const module = await import("../folderExportService");
    folderExportService = module.default;
  });

  describe("getDefaultExportPath", () => {
    it("should generate path in downloads folder", () => {
      const transaction = {
        id: "txn-123",
        property_address: "123 Main St",
      } as Transaction;

      const result = folderExportService.getDefaultExportPath(transaction);

      expect(result).toContain("mock");
      expect(result).toContain("downloads");
      expect(result).toContain("Transaction_");
      expect(result).toContain("123_Main_St");
    });

    it("should sanitize special characters in folder name", () => {
      const transaction = {
        id: "txn-456",
        property_address: "456 Oak Ave, Unit #5/A",
      } as Transaction;

      const result = folderExportService.getDefaultExportPath(transaction);

      // Should not contain special characters
      expect(result).not.toContain(",");
      expect(result).not.toContain("#");
      expect(result).not.toMatch(/\/A/);
      expect(result).toContain("456_Oak_Ave");
    });
  });

  describe("exportTransactionToFolder - texts as PDFs", () => {
    const mockTransaction: Transaction = {
      id: "txn-test",
      user_id: "user-123",
      property_address: "123 Test St",
      transaction_type: "purchase",
      is_active: true,
      created_at: new Date().toISOString(),
    } as Transaction;

    const createTextMessage = (
      id: string,
      threadId: string,
      sender: string,
      body: string,
      direction: "inbound" | "outbound",
      participants?: string,
      sentAt?: string
    ): Communication => ({
      id,
      user_id: "user-123",
      thread_id: threadId,
      sender,
      body_text: body,
      body_plain: body,
      direction,
      participants,
      sent_at: sentAt || "2024-01-15T10:00:00Z",
      communication_type: "text",
      channel: "text",
      has_attachments: false,
      is_false_positive: false,
      created_at: new Date().toISOString(),
    } as unknown as Communication);

    it("should group messages by thread_id and export as PDFs", async () => {
      const texts: Communication[] = [
        createTextMessage("msg-1", "thread-A", "+15551234567", "Hello", "inbound"),
        createTextMessage("msg-2", "thread-A", "+15551234567", "How are you?", "inbound", undefined, "2024-01-15T10:01:00Z"),
        createTextMessage("msg-3", "thread-B", "+15559876543", "Different thread", "inbound"),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      // Should create texts directory (path separator varies by OS)
      const textsDirectoryCreated = mockMkdir.mock.calls.some(
        (call: unknown[]) => (call[0] as string).includes("texts")
      );
      expect(textsDirectoryCreated).toBe(true);

      // Should export 2 PDFs (2 threads) - files are named text_XXX not thread_XXX
      const textPdfCalls = mockWriteFile.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes("text_") && (call[0] as string).endsWith(".pdf")
      );
      expect(textPdfCalls).toHaveLength(2);

      // Check file naming pattern
      const fileNames = textPdfCalls.map((call: unknown[]) => call[0]);
      expect(fileNames.some((f: unknown) => (f as string).includes("text_001_"))).toBe(true);
      expect(fileNames.some((f: unknown) => (f as string).includes("text_002_"))).toBe(true);
      expect(fileNames.every((f: unknown) => (f as string).endsWith(".pdf"))).toBe(true);
    });

    it("should use participants for grouping when thread_id is not available", async () => {
      const texts: Communication[] = [
        createTextMessage(
          "msg-1",
          "", // No thread_id
          "+15551234567",
          "Message 1",
          "inbound",
          JSON.stringify({ from: "+15551234567", to: ["+15550001111"] })
        ),
        createTextMessage(
          "msg-2",
          "", // No thread_id
          "+15551234567",
          "Message 2",
          "inbound",
          JSON.stringify({ from: "+15551234567", to: ["+15550001111"] })
        ),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      // Should export 1 PDF (same participants = same thread)
      const textPdfCalls = mockWriteFile.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes("text_")
      );
      expect(textPdfCalls).toHaveLength(1);
    });

    it("should use phone number when contact name is not available", async () => {
      // When no contact names are found, the phone number should appear
      const texts: Communication[] = [
        createTextMessage("msg-1", "thread-A", "+15551234567", "Hello", "inbound"),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      // Check that phone number is used when no contact name is found
      const htmlContent = lastLoadedHtmlContent;
      expect(htmlContent).not.toBeNull();
      // Phone number should appear in the conversation header
      expect(htmlContent).toContain("+15551234567");
    });

    it("should detect group chats with more than 2 participants", async () => {
      const texts: Communication[] = [
        createTextMessage(
          "msg-1",
          "thread-group",
          "+15551111111",
          "Group message",
          "inbound",
          JSON.stringify({
            from: "+15551111111",
            to: ["+15552222222", "+15553333333"],
          })
        ),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      // Check that the HTML contains "Group Chat" badge
      const htmlContent = lastLoadedHtmlContent;
      expect(htmlContent).not.toBeNull();
      expect(htmlContent).toContain("Group Chat");
    });

    it("should show 'You' for outbound messages", async () => {
      const texts: Communication[] = [
        createTextMessage("msg-1", "thread-A", null as unknown as string, "Outbound message", "outbound"),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      // Check that the HTML shows "You" as sender
      const htmlContent = lastLoadedHtmlContent;
      expect(htmlContent).not.toBeNull();
      expect(htmlContent).toContain(">You<");
    });

    it("should sort messages chronologically within thread", async () => {
      const texts: Communication[] = [
        createTextMessage("msg-2", "thread-A", "+15551234567", "Second", "inbound", undefined, "2024-01-15T10:05:00Z"),
        createTextMessage("msg-1", "thread-A", "+15551234567", "First", "inbound", undefined, "2024-01-15T10:00:00Z"),
        createTextMessage("msg-3", "thread-A", "+15551234567", "Third", "inbound", undefined, "2024-01-15T10:10:00Z"),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      // Check that messages appear in order in the HTML
      const htmlContent = lastLoadedHtmlContent;
      expect(htmlContent).not.toBeNull();

      const firstIndex = htmlContent.indexOf("First");
      const secondIndex = htmlContent.indexOf("Second");
      const thirdIndex = htmlContent.indexOf("Third");

      expect(firstIndex).toBeLessThan(secondIndex);
      expect(secondIndex).toBeLessThan(thirdIndex);
    });

    it("should include message count in header", async () => {
      const texts: Communication[] = [
        createTextMessage("msg-1", "thread-A", "+15551234567", "One", "inbound"),
        createTextMessage("msg-2", "thread-A", "+15551234567", "Two", "inbound", undefined, "2024-01-15T10:01:00Z"),
        createTextMessage("msg-3", "thread-A", "+15551234567", "Three", "inbound", undefined, "2024-01-15T10:02:00Z"),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      // Check that the HTML contains message count
      const htmlContent = lastLoadedHtmlContent;
      expect(htmlContent).not.toBeNull();
      expect(htmlContent).toContain("3 messages");
    });

    it("should handle single message threads correctly", async () => {
      const texts: Communication[] = [
        createTextMessage("msg-1", "thread-single", "+15551234567", "Only message", "inbound"),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      // Check singular form "message" not "messages"
      const htmlContent = lastLoadedHtmlContent;
      expect(htmlContent).not.toBeNull();
      expect(htmlContent).toContain("1 message");
      expect(htmlContent).not.toContain("1 messages");
    });

    it("should escape HTML in message content", async () => {
      const texts: Communication[] = [
        createTextMessage("msg-1", "thread-A", "+15551234567", "<script>alert('xss')</script>", "inbound"),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      // Check that script tags are escaped
      const htmlContent = lastLoadedHtmlContent;
      expect(htmlContent).not.toBeNull();
      expect(htmlContent).not.toContain("<script>alert");
      expect(htmlContent).toContain("&lt;script&gt;");
    });

    it("should include timestamps for each message", async () => {
      const texts: Communication[] = [
        createTextMessage("msg-1", "thread-A", "+15551234567", "Hello", "inbound", undefined, "2024-01-15T14:30:00Z"),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      // Check that timestamp appears
      const htmlContent = lastLoadedHtmlContent;
      expect(htmlContent).not.toBeNull();
      // Should contain formatted date (e.g., "Jan 15, 2024")
      expect(htmlContent).toContain("Jan");
      expect(htmlContent).toContain("15");
      expect(htmlContent).toContain("2024");
    });
  });

  describe("PDF file naming", () => {
    const mockTransaction: Transaction = {
      id: "txn-test",
      user_id: "user-123",
      property_address: "123 Test St",
      transaction_type: "purchase",
      is_active: true,
      created_at: new Date().toISOString(),
    } as Transaction;

    it("should name files with zero-padded index", async () => {
      const texts: Communication[] = Array.from({ length: 3 }, (_, i) =>
        ({
          id: `msg-${i}`,
          user_id: "user-123",
          thread_id: `thread-${i}`,
          sender: "+1555000000" + i,
          body_text: `Message ${i}`,
          direction: "inbound",
          sent_at: "2024-01-15T10:00:00Z",
          communication_type: "text",
          channel: "text",
          has_attachments: false,
          is_false_positive: false,
          created_at: new Date().toISOString(),
        } as unknown as Communication)
      );

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      const textPdfCalls = mockWriteFile.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes("text_")
      );

      const fileNames = textPdfCalls.map((call: unknown[]) => call[0] as string);
      expect(fileNames.some(f => f.includes("text_001_"))).toBe(true);
      expect(fileNames.some(f => f.includes("text_002_"))).toBe(true);
      expect(fileNames.some(f => f.includes("text_003_"))).toBe(true);
    });

    it("should include date from first message in filename", async () => {
      const texts: Communication[] = [
        {
          id: "msg-1",
          user_id: "user-123",
          thread_id: "thread-A",
          sender: "+15551234567",
          body_text: "Hello",
          direction: "inbound",
          sent_at: "2024-03-20T10:00:00Z",
          communication_type: "text",
          channel: "text",
          has_attachments: false,
          is_false_positive: false,
          created_at: new Date().toISOString(),
        } as unknown as Communication,
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      const textPdfCalls = mockWriteFile.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes("text_")
      );

      expect(textPdfCalls[0][0]).toContain("2024-03-20");
    });
  });

  describe("text message attachments", () => {
    const mockTransaction: Transaction = {
      id: "txn-test",
      user_id: "user-123",
      property_address: "123 Test St",
      transaction_type: "purchase",
      is_active: true,
      created_at: new Date().toISOString(),
    } as Transaction;

    it("should include CSS styles for attachments in text thread PDF", async () => {
      // Verify that the CSS styles for attachment-image and attachment-ref are included
      const texts: Communication[] = [
        {
          id: "text-msg-1",
          user_id: "user-123",
          thread_id: "thread-A",
          sender: "+15551234567",
          body_text: "Hello",
          direction: "inbound",
          sent_at: "2024-01-15T10:00:00Z",
          communication_type: "sms",
          channel: "sms",
          has_attachments: false,
          is_false_positive: false,
          created_at: new Date().toISOString(),
        } as unknown as Communication,
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false,
        }
      );

      // Check the HTML contains the attachment CSS styles
      const htmlContent = lastLoadedHtmlContent;
      expect(htmlContent).not.toBeNull();
      expect(htmlContent).toContain(".attachment-image");
      expect(htmlContent).toContain(".attachment-ref");
    });

    it("should create texts folder when exporting text messages", async () => {
      // This test verifies that text messages are properly handled
      const texts: Communication[] = [
        {
          id: "text-msg-1",
          user_id: "user-123",
          thread_id: "thread-A",
          sender: "+15551234567",
          body_text: "Hello",
          direction: "inbound",
          sent_at: "2024-01-15T10:00:00Z",
          communication_type: "sms",
          channel: "sms",
          has_attachments: false,
          is_false_positive: false,
          created_at: new Date().toISOString(),
        } as unknown as Communication,
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        texts,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: false,
          includeTexts: true,
          includeAttachments: false, // Don't include attachments to avoid DB call
        }
      );

      // Verify texts folder was created (path separator varies by OS)
      const textsDirectoryCreated = mockMkdir.mock.calls.some(
        (call: unknown[]) => (call[0] as string).includes("texts")
      );
      expect(textsDirectoryCreated).toBe(true);

      // Verify a text thread PDF was written
      const textPdfCalls = mockWriteFile.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes("text_") && (call[0] as string).endsWith(".pdf")
      );
      expect(textPdfCalls.length).toBeGreaterThan(0);
    });
  });

  describe("stripHtmlQuotedContent", () => {
    // Use standalone helper function (extracted from FolderExportService)
    const strip = (html: string): string =>
      stripHtmlQuotedContent(html);

    it("should strip Gmail quoted blocks (div.gmail_quote)", () => {
      const html = `<div>Original message content</div><div class="gmail_quote">On Mon, Jan 1 wrote:<br><blockquote>Quoted text</blockquote></div>`;
      const result = strip(html);
      expect(result).toContain("Original message content");
      expect(result).not.toContain("gmail_quote");
      expect(result).not.toContain("Quoted text");
    });

    it("should strip Gmail blockquotes", () => {
      const html = `<p>My reply</p><blockquote class="gmail_quote" style="margin:0">Previous email</blockquote>`;
      const result = strip(html);
      expect(result).toContain("My reply");
      expect(result).not.toContain("Previous email");
    });

    it("should strip Outlook divRplyFwdMsg blocks", () => {
      const html = `<div>Reply content here</div><div id="divRplyFwdMsg" dir="ltr"><font><b>From:</b> sender</font><div>Original message</div></div>`;
      const result = strip(html);
      expect(result).toContain("Reply content here");
      expect(result).not.toContain("divRplyFwdMsg");
      expect(result).not.toContain("Original message");
    });

    it("should strip Outlook x_divRplyFwdMsg (prefixed) blocks", () => {
      const html = `<div>My reply</div><div id="x_divRplyFwdMsg"><hr>Quoted</div>`;
      const result = strip(html);
      expect(result).toContain("My reply");
      expect(result).not.toContain("Quoted");
    });

    it("should strip Outlook mobile separator line", () => {
      const html = `<div>Content</div><div id="ms-outlook-mobile-body-separator-line" style="height:1px"></div><div>Old message</div>`;
      const result = strip(html);
      expect(result).toContain("Content");
      expect(result).not.toContain("Old message");
    });

    it("should strip Outlook hr with tabindex=-1", () => {
      const html = `<div>New content</div><hr tabindex="-1" style="display:inline-block;width:98%"><div id="divRplyFwdMsg">Old content</div>`;
      const result = strip(html);
      expect(result).toContain("New content");
      expect(result).not.toContain("Old content");
    });

    it("should strip Outlook border-top style hr with display:inline-block", () => {
      const html = `<p>Reply</p><hr style="display:inline-block;width:98%;border-top:1px solid #ccc"><div>From: sender</div>`;
      const result = strip(html);
      expect(result).toContain("Reply");
      expect(result).not.toContain("From: sender");
    });

    it("should strip Proton Mail quoted blocks", () => {
      const html = `<div>My Proton Mail reply</div><div class="protonmail_quote"><blockquote class="protonmail_quote" type="cite">Original sender content</blockquote></div>`;
      const result = strip(html);
      expect(result).toContain("My Proton Mail reply");
      expect(result).not.toContain("protonmail_quote");
      expect(result).not.toContain("Original sender content");
    });

    it("should strip generic blockquote with type=cite", () => {
      const html = `<p>Reply text</p><blockquote type="cite">Cited content from previous email</blockquote>`;
      const result = strip(html);
      expect(result).toContain("Reply text");
      expect(result).not.toContain("Cited content");
    });

    it("should strip '-----Original Message-----' dividers", () => {
      const html = `<div>My reply</div><div>-----Original Message-----</div><div>From: someone</div>`;
      const result = strip(html);
      expect(result).toContain("My reply");
      expect(result).not.toContain("Original Message");
    });

    it("should strip bare '-----Original Message-----' without wrapping div", () => {
      const html = `<p>Reply</p>-----Original Message-----<br>Old content`;
      const result = strip(html);
      expect(result).toContain("Reply");
      expect(result).not.toContain("Old content");
    });

    it("should strip 'On ... wrote:' header lines in divs", () => {
      const html = `<div>My response</div><div>On January 15, 2024 at 2:30 PM John wrote:</div><div>Previous message</div>`;
      const result = strip(html);
      expect(result).toContain("My response");
      expect(result).not.toContain("John wrote:");
    });

    it("should strip 'On ... wrote:' header lines in p tags", () => {
      const html = `<p>Response</p><p>On Mon, Jan 15, 2024 at 2:30 PM John Doe &lt;john@example.com&gt; wrote:</p>`;
      const result = strip(html);
      expect(result).toContain("Response");
      expect(result).not.toContain("wrote:");
    });

    it("should return content unchanged when no quotes present", () => {
      const html = `<div>Just a simple email with no quoted content</div>`;
      const result = strip(html);
      expect(result).toBe(html);
    });

    it("should return empty/minimal content when body is all quoted", () => {
      const html = `<div class="gmail_quote">On Mon wrote:<br>Everything is quoted</div>`;
      const result = strip(html);
      expect(result).not.toContain("Everything is quoted");
    });

    it("should strip Outlook border:none + border-top div pattern", () => {
      const html = `<p>Reply text</p><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p><b>From:</b> sender@example.com</p></div>`;
      const result = strip(html);
      expect(result).toContain("Reply text");
      expect(result).not.toContain("sender@example.com");
    });

    it("should NOT strip legitimate div with decorative border-top", () => {
      const html = `<div>Content</div><div style="border-top:2px solid red;padding:10px">This is a styled section, not a quote</div>`;
      const result = strip(html);
      expect(result).toContain("Content");
      expect(result).toContain("This is a styled section, not a quote");
    });
  });

  describe("stripPlainTextQuotedContent", () => {
    const strip = (text: string): string =>
      stripPlainTextQuotedContent(text);

    it("should strip lines starting with >", () => {
      const text = "My reply\n\n> Original message\n> Second quoted line";
      const result = strip(text);
      expect(result).toContain("My reply");
      expect(result).not.toContain("Original message");
      expect(result).not.toContain("Second quoted line");
    });

    it("should stop at 'On ... wrote:' line", () => {
      const text = "My reply\n\nOn Mon, Jan 15, 2024 at 2:30 PM John Doe wrote:\n> Quoted text";
      const result = strip(text);
      expect(result).toContain("My reply");
      expect(result).not.toContain("John Doe wrote:");
      expect(result).not.toContain("Quoted text");
    });

    it("should stop at '-----Original Message-----'", () => {
      const text = "Reply content\n\n-----Original Message-----\nFrom: sender\nSent: Monday\nOld message";
      const result = strip(text);
      expect(result).toContain("Reply content");
      expect(result).not.toContain("Original Message");
      expect(result).not.toContain("Old message");
    });

    it("should return text unchanged when no quotes", () => {
      const text = "Just a plain email\nWith multiple lines\nNo quoting here";
      const result = strip(text);
      expect(result).toBe(text);
    });

    it("should handle text that is all quoted", () => {
      const text = "> Everything\n> Is\n> Quoted";
      const result = strip(text);
      expect(result).toBe("");
    });

    it("should handle indented > markers", () => {
      const text = "Reply\n  > Indented quote\n  > More quoted";
      const result = strip(text);
      expect(result).toContain("Reply");
      expect(result).not.toContain("Indented quote");
    });
  });

  describe("stripQuotedContent", () => {
    const strip = (body: string, isHtml: boolean): string =>
      stripQuotedContent(body, isHtml);

    it("should route HTML content to HTML stripper", () => {
      const html = `<div>Reply</div><div class="gmail_quote">Quoted</div>`;
      const result = strip(html, true);
      expect(result).toContain("Reply");
      expect(result).not.toContain("Quoted");
    });

    it("should route plain text to plain text stripper", () => {
      const text = "Reply\n> Quoted line";
      const result = strip(text, false);
      expect(result).toContain("Reply");
      expect(result).not.toContain("Quoted line");
    });
  });

  describe("isHtmlContent", () => {
    const isHtml = (body: string | null): boolean =>
      isHtmlContent(body);

    it("should detect HTML with common tags", () => {
      expect(isHtml("<div>Hello</div>")).toBe(true);
      expect(isHtml("<p>Paragraph</p>")).toBe(true);
      expect(isHtml("<html><body>Content</body></html>")).toBe(true);
      expect(isHtml("<br>")).toBe(true);
      expect(isHtml("<table><tr><td>Cell</td></tr></table>")).toBe(true);
    });

    it("should not falsely detect plain text with < symbols", () => {
      expect(isHtml("x < y")).toBe(false);
      expect(isHtml("price <$500")).toBe(false);
      expect(isHtml("a < b and c > d")).toBe(false);
    });

    it("should handle null/undefined", () => {
      expect(isHtml(null)).toBe(false);
      expect(isHtml(undefined as any)).toBe(false);
    });

    it("should handle empty string", () => {
      expect(isHtml("")).toBe(false);
    });
  });

  describe("stripSubjectPrefixes", () => {
    const stripPrefix = (subject: string): string =>
      stripSubjectPrefixes(subject);

    it("should strip Re: prefix", () => {
      expect(stripPrefix("Re: Meeting tomorrow")).toBe("Meeting tomorrow");
    });

    it("should strip Fwd: prefix", () => {
      expect(stripPrefix("Fwd: Important document")).toBe("Important document");
    });

    it("should strip FW: prefix", () => {
      expect(stripPrefix("FW: Status update")).toBe("Status update");
    });

    it("should strip multiple nested prefixes", () => {
      expect(stripPrefix("Re: Re: Re: Original subject")).toBe("Original subject");
      expect(stripPrefix("Re: Fwd: Re: Chain mail")).toBe("Chain mail");
    });

    it("should preserve subjects without prefixes", () => {
      expect(stripPrefix("Meeting tomorrow")).toBe("Meeting tomorrow");
      expect(stripPrefix("Regular email")).toBe("Regular email");
    });

    it("should be case insensitive", () => {
      expect(stripPrefix("RE: Caps")).toBe("Caps");
      expect(stripPrefix("re: lower")).toBe("lower");
      expect(stripPrefix("fwd: forward")).toBe("forward");
    });
  });

  describe("getThreadKey — email fallback", () => {
    const getThreadKey = (msg: Partial<Communication>): string =>
      getThreadKeyHelper(msg as Communication);

    it("should use thread_id when available", () => {
      const result = getThreadKey({ thread_id: "AAMkAGE1MDQ5NjU3" } as any);
      expect(result).toBe("AAMkAGE1MDQ5NjU3");
    });

    it("should group emails by normalized subject + participants when no thread_id", () => {
      const email1 = {
        communication_type: "email",
        subject: "Re: Project update",
        sender: "alice@example.com",
        recipients: "bob@example.com",
      };
      const email2 = {
        communication_type: "email",
        subject: "Re: Re: Project update",
        sender: "bob@example.com",
        recipients: "alice@example.com",
      };
      // Both should produce the same key (same subject after stripping, same participants sorted)
      const key1 = getThreadKey(email1 as any);
      const key2 = getThreadKey(email2 as any);
      expect(key1).toBe(key2);
    });

    it("should not use phone normalization for emails", () => {
      const email = {
        communication_type: "email",
        subject: "Test",
        sender: "user@example.com",
        recipients: "other@example.com",
        participants: JSON.stringify({ from: "user@example.com", to: ["other@example.com"] }),
      };
      const result = getThreadKey(email as any);
      expect(result).toContain("email-thread-");
      expect(result).not.toContain("participants-");
    });

    it("should fall back to msg-id for emails with no subject or participants", () => {
      const email = {
        id: "msg-999",
        communication_type: "email",
      };
      const result = getThreadKey(email as any);
      expect(result).toBe("msg-msg-999");
    });

    it("should still use phone normalization for text messages", () => {
      const text = {
        communication_type: "text",
        participants: JSON.stringify({ from: "+15551234567", to: ["+15559876543"] }),
      };
      const result = getThreadKey(text as any);
      expect(result).toContain("participants-");
    });
  });

  describe("email thread export", () => {
    const mockTransaction: Transaction = {
      id: "txn-email-test",
      user_id: "user-123",
      property_address: "456 Email Ave",
      transaction_type: "purchase",
      is_active: true,
      created_at: new Date().toISOString(),
    } as Transaction;

    const createEmail = (
      id: string,
      threadId: string,
      subject: string,
      body: string,
      direction: "inbound" | "outbound",
      sender: string,
      recipients: string,
      sentAt: string
    ): Communication => ({
      id,
      user_id: "user-123",
      thread_id: threadId,
      subject,
      body,
      sender,
      recipients,
      direction,
      sent_at: sentAt,
      communication_type: "email",
      channel: "email",
      has_attachments: false,
      is_false_positive: false,
      created_at: new Date().toISOString(),
    } as unknown as Communication);

    it("should export emails in thread mode by default (one PDF per thread)", async () => {
      const emails: Communication[] = [
        createEmail("e1", "thread-A", "Project update", "<div>First email</div>", "inbound", "alice@test.com", "bob@test.com", "2024-01-15T10:00:00Z"),
        createEmail("e2", "thread-A", "Re: Project update", "<div>Reply</div>", "outbound", "bob@test.com", "alice@test.com", "2024-01-15T11:00:00Z"),
        createEmail("e3", "thread-B", "Different topic", "<div>Other email</div>", "inbound", "carol@test.com", "bob@test.com", "2024-01-15T12:00:00Z"),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        emails,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: true,
          includeTexts: false,
          includeAttachments: false,
        }
      );

      // Should export 2 thread PDFs (thread-A and thread-B)
      const threadPdfCalls = mockWriteFile.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes("thread_") && (call[0] as string).endsWith(".pdf")
      );
      expect(threadPdfCalls).toHaveLength(2);
    });

    it("should export emails in individual mode (one PDF per email, quotes stripped)", async () => {
      const emails: Communication[] = [
        createEmail("e1", "thread-A", "Update", "<div>First</div>", "inbound", "alice@test.com", "bob@test.com", "2024-01-15T10:00:00Z"),
        createEmail("e2", "thread-A", "Re: Update", '<div>Reply</div><div class="gmail_quote">Quoted first</div>', "outbound", "bob@test.com", "alice@test.com", "2024-01-15T11:00:00Z"),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        emails,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: true,
          includeTexts: false,
          includeAttachments: false,
          emailExportMode: "individual",
        }
      );

      // Should export 2 individual PDFs
      const emailPdfCalls = mockWriteFile.mock.calls.filter(
        (call: unknown[]) => (call[0] as string).includes("email_") && (call[0] as string).endsWith(".pdf")
      );
      expect(emailPdfCalls).toHaveLength(2);
    });

    it("should strip quotes in thread mode HTML generation", async () => {
      const emails: Communication[] = [
        createEmail("e1", "thread-A", "Topic", "<div>Original message</div>", "inbound", "alice@test.com", "bob@test.com", "2024-01-15T10:00:00Z"),
        createEmail("e2", "thread-A", "Re: Topic", '<div>My reply</div><div class="gmail_quote"><blockquote>Original message</blockquote></div>', "outbound", "bob@test.com", "alice@test.com", "2024-01-15T11:00:00Z"),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        emails,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: true,
          includeTexts: false,
          includeAttachments: false,
        }
      );

      // The thread HTML should contain both messages but the reply should have quotes stripped
      const htmlContent = lastLoadedHtmlContent;
      expect(htmlContent).not.toBeNull();
      expect(htmlContent).toContain("Original message");
      expect(htmlContent).toContain("My reply");
      // gmail_quote should have been stripped
      expect(htmlContent).not.toContain("gmail_quote");
    });

    it("should strip Re:/Fwd: from thread header subject", async () => {
      const emails: Communication[] = [
        createEmail("e1", "thread-A", "Re: Re: Important topic", "<div>Content</div>", "inbound", "alice@test.com", "bob@test.com", "2024-01-15T10:00:00Z"),
      ];

      await folderExportService.exportTransactionToFolder(
        mockTransaction,
        emails,
        {
          transactionId: mockTransaction.id,
          outputPath: "/mock/output",
          includeEmails: true,
          includeTexts: false,
          includeAttachments: false,
        }
      );

      const htmlContent = lastLoadedHtmlContent;
      expect(htmlContent).not.toBeNull();
      // The thread header h1 should have Re: stripped
      expect(htmlContent).toContain("Important topic");
      // Should not have "Re: Re:" in the thread header (it's OK in individual message subjects)
      const h1Match = htmlContent?.match(/<h1>(.*?)<\/h1>/);
      expect(h1Match?.[1]).not.toMatch(/^Re:/i);
    });
  });

  // BACKLOG-2161: the Summary_Report email index must honor Email Mode.
  describe("summary email index honors Email Mode (BACKLOG-2161)", () => {
    const mockTransaction: Transaction = {
      id: "txn-index-mode",
      user_id: "user-123",
      property_address: "10 Index Way",
      transaction_type: "purchase",
      is_active: true,
      created_at: new Date().toISOString(),
    } as Transaction;

    const createEmail = (
      id: string,
      threadId: string,
      subject: string,
      sender: string,
      sentAt: string
    ): Communication => ({
      id,
      user_id: "user-123",
      thread_id: threadId,
      subject,
      body: "<div>x</div>",
      sender,
      recipients: "bob@test.com",
      direction: "inbound",
      sent_at: sentAt,
      communication_type: "email",
      channel: "email",
      has_attachments: false,
      is_false_positive: false,
      created_at: new Date().toISOString(),
    } as unknown as Communication);

    // 3 emails across 2 threads (thread-A has 2, thread-B has 1) → app shows
    // "2 conversations - 3 emails".
    const emails = (): Communication[] => [
      createEmail("e1", "thread-A", "Closing", "alice@test.com", "2024-01-15T10:00:00Z"),
      createEmail("e2", "thread-A", "Re: Closing", "bob@test.com", "2024-01-15T11:00:00Z"),
      createEmail("e3", "thread-B", "Inspection", "carol@test.com", "2024-01-15T12:00:00Z"),
    ];

    /** Pull the Summary_Report HTML from all captured writeFile calls. */
    const capturedSummaryHtml = (): string => {
      const call = mockWriteFile.mock.calls.find(
        (c: unknown[]) =>
          typeof c[1] === "string" &&
          (c[1] as string).includes("Transaction Audit Summary") &&
          (c[1] as string).includes("Email Threads Index")
      );
      return (call?.[1] as string) ?? "";
    };

    /** Count rendered email index rows (.email-item) in the email section. */
    const countEmailItemRows = (html: string): number => {
      const section = html.split("Email Threads Index")[1]?.split("Text Threads Index")[0] ?? "";
      return (section.match(/class="email-item"/g) || []).length;
    };

    it("Thread View (default): header shows THREAD count and one row per thread", async () => {
      await folderExportService.exportTransactionToFolder(mockTransaction, emails(), {
        transactionId: mockTransaction.id,
        outputPath: "/mock/output",
        includeEmails: true,
        includeTexts: false,
        includeAttachments: false,
        emailExportMode: "thread",
      });

      const html = capturedSummaryHtml();
      expect(html).not.toBe("");
      // 2 threads, not 3 emails. BACKLOG-2161 founder QA refinement: header
      // mirrors the app's on-screen "N conversations (M emails)" phrasing.
      // BACKLOG-1842 (visual-polish, founder QA): inner parens replaced with
      // " - " to avoid the awkward nested-parens "(N (M))" reading.
      expect(html).toContain("Email Threads Index (2 conversations - 3 emails)");
      expect(html).not.toContain("Email Threads Index (2 conversations (3 emails))");
      expect(html).not.toContain("Email Threads Index (2)</h3>");
      expect(html).not.toContain("Email Threads Index (3)");
      // One .email-item row per thread.
      expect(countEmailItemRows(html)).toBe(2);
      // Identity: both thread subjects appear; the multi-email thread notes its size.
      expect(html).toContain("Closing (2 emails)");
      expect(html).toContain("Inspection");
      // BACKLOG-2161 founder QA refinement: multi-email thread row is marked;
      // the single-email thread row is not.
      expect(html).toContain('<div class="email-item" data-multi="true">');
      expect(html).toContain('<div class="email-item" data-multi="false">');
    });

    it("defaults to Thread View when emailExportMode is omitted", async () => {
      await folderExportService.exportTransactionToFolder(mockTransaction, emails(), {
        transactionId: mockTransaction.id,
        outputPath: "/mock/output",
        includeEmails: true,
        includeTexts: false,
        includeAttachments: false,
        // emailExportMode intentionally omitted
      });

      const html = capturedSummaryHtml();
      expect(html).toContain("Email Threads Index (2 conversations - 3 emails)");
      expect(countEmailItemRows(html)).toBe(2);
    });

    it("Individual: header shows EMAIL count and one row per email (unchanged)", async () => {
      await folderExportService.exportTransactionToFolder(mockTransaction, emails(), {
        transactionId: mockTransaction.id,
        outputPath: "/mock/output",
        includeEmails: true,
        includeTexts: false,
        includeAttachments: false,
        emailExportMode: "individual",
      });

      const html = capturedSummaryHtml();
      expect(html).not.toBe("");
      // 3 individual emails.
      expect(html).toContain("Email Threads Index (3)");
      expect(html).not.toContain("Email Threads Index (2)");
      expect(countEmailItemRows(html)).toBe(3);
      // Individual mode does NOT annotate rows with an email count.
      expect(html).not.toContain("(2 emails)");
    });
  });

  // BACKLOG-1584: single combined PDF with a hyperlinked index and back-links.
  describe("combined PDF export - hyperlinked index (BACKLOG-1584)", () => {
    const mockTransaction = {
      id: "txn-combined",
      user_id: "user-123",
      property_address: "789 Combined Rd",
      transaction_type: "purchase",
      is_active: true,
      created_at: new Date().toISOString(),
      communications: [],
      contact_assignments: [],
    } as unknown as import("../transactionService/types").TransactionWithDetails;

    const mkEmail = (
      id: string,
      threadId: string,
      subject: string,
      body: string,
      sentAt: string
    ): Communication => ({
      id,
      user_id: "user-123",
      thread_id: threadId,
      subject,
      body,
      sender: `${id}@test.com`,
      recipients: "bob@test.com",
      direction: "inbound",
      sent_at: sentAt,
      communication_type: "email",
      channel: "email",
      has_attachments: false,
      is_false_positive: false,
      created_at: new Date().toISOString(),
    } as unknown as Communication);

    const mkText = (
      id: string,
      threadId: string,
      body: string,
      sentAt: string,
      from: string
    ): Communication => ({
      id,
      user_id: "user-123",
      thread_id: threadId,
      body_text: body,
      body_plain: body,
      sender: from,
      direction: "inbound",
      sent_at: sentAt,
      communication_type: "sms",
      channel: "text",
      participants: JSON.stringify({ from, to: ["+15550000000"] }),
      has_attachments: false,
      is_false_positive: false,
      created_at: new Date().toISOString(),
    } as unknown as Communication);

    /** Collect the id set from a captured combined HTML document. */
    const idSet = (html: string, re: RegExp): Set<string> => {
      const ids = new Set<string>();
      let m: RegExpExecArray | null;
      const g = new RegExp(re.source, "g");
      while ((m = g.exec(html)) !== null) ids.add(m[1]);
      return ids;
    };
    /** Collect the href-target set (without leading #) from index rows. */
    const hrefSet = (html: string): Set<string> => {
      const hrefs = new Set<string>();
      const g = /href="#([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = g.exec(html)) !== null) hrefs.add(m[1]);
      return hrefs;
    };

    it("renders BOTH email and text sections with matching anchor ids, index hrefs, and back-links", async () => {
      const comms: Communication[] = [
        mkEmail("e1", "thread-A", "Alpha topic", "<div>Alpha body</div>", "2024-01-10T10:00:00Z"),
        mkEmail("e2", "thread-A", "Re: Alpha topic", "<div>Alpha reply</div>", "2024-01-10T11:00:00Z"),
        mkEmail("e3", "thread-B", "Beta topic", "<div>Beta body</div>", "2024-01-11T09:00:00Z"),
        mkText("t1", "text-A", "Hi there", "2024-01-12T08:00:00Z", "+15551110000"),
        mkText("t2", "text-B", "Second convo", "2024-01-13T08:00:00Z", "+15552220000"),
      ];

      await folderExportService.exportTransactionToCombinedPDF(
        mockTransaction,
        comms,
        "/mock/output/Combined_Report.pdf",
        false
      );

      const html = lastLoadedHtmlContent;
      expect(html).not.toBeNull();
      const doc = html as string;

      // Index section headings carry the back-link target ids.
      expect(doc).toContain('id="email-threads-index"');
      expect(doc).toContain('id="text-threads-index"');

      // Two email threads (A, B) → email-thread-0 / email-thread-1 section ids.
      const emailSectionIds = idSet(doc, /id="(email-thread-\d+)"/);
      expect(emailSectionIds).toEqual(new Set(["email-thread-0", "email-thread-1"]));

      // Two text threads → text-thread-0 / text-thread-1 section ids AND per-row
      // index ids text-idx-0 / text-idx-1.
      const textSectionIds = idSet(doc, /id="(text-thread-\d+)"/);
      expect(textSectionIds).toEqual(new Set(["text-thread-0", "text-thread-1"]));
      const textRowIds = idSet(doc, /id="(text-idx-\d+)"/);
      expect(textRowIds).toEqual(new Set(["text-idx-0", "text-idx-1"]));

      // Every section anchor is the target of at least one index href (identity,
      // not counts): the href set must be a superset of all section ids.
      const hrefs = hrefSet(doc);
      for (const id of [...emailSectionIds, ...textSectionIds]) {
        expect(hrefs.has(id)).toBe(true);
      }

      // Back-links: emails → email index heading; texts → their exact index row.
      expect(hrefs.has("email-threads-index")).toBe(true);
      expect(hrefs.has("text-idx-0")).toBe(true);
      expect(hrefs.has("text-idx-1")).toBe(true);

      // Text rows keep the unchanged "View Full ->" affordance.
      expect(doc).toContain("View Full");
      // BACKLOG-2161 founder QA refinement: thread-A (e1+e2, multi-email) links
      // "View Thread ->"; thread-B (e3 alone, single-email) links "View ->".
      expect(doc).toContain('href="#email-thread-0">View Thread &rarr;');
      expect(doc).toContain('href="#email-thread-1">View &rarr;');
    });

    it("BACKLOG-2161: maps each per-THREAD index row to its thread section (one row per thread)", async () => {
      // 3 emails across 2 threads. Post-BACKLOG-2161 the combined email index is
      // per-THREAD (2 rows), each View Full linking to its thread section — the
      // index rows, sections, and targets line up 1:1.
      const comms: Communication[] = [
        mkEmail("e1", "thread-A", "Alpha", "<div>a</div>", "2024-01-10T10:00:00Z"),
        mkEmail("e2", "thread-B", "Beta", "<div>b</div>", "2024-01-11T10:00:00Z"),
        mkEmail("e3", "thread-A", "Re: Alpha", "<div>a2</div>", "2024-01-12T10:00:00Z"),
      ];

      await folderExportService.exportTransactionToCombinedPDF(
        mockTransaction,
        comms,
        "/mock/output/Combined_Report.pdf",
        false
      );
      const doc = lastLoadedHtmlContent as string;

      // 2 email index rows (one per thread), each a view link to a section
      // (class name is unchanged; BACKLOG-2161 founder QA refinement only
      // changes the link TEXT, not the CSS class used to locate it).
      const viewFullTargets = (doc.match(/class="view-full-link" href="#(email-thread-\d+)"/g) || [])
        .map((s) => s.replace(/.*#/, "").replace(/"$/, ""));
      expect(viewFullTargets).toHaveLength(2);
      // Ordered oldest-first: thread-A (first email 01-10) → 0, thread-B → 1.
      expect(viewFullTargets).toEqual(["email-thread-0", "email-thread-1"]);
      // The two thread sections exist and match the targets exactly (identity).
      const emailSectionIds = idSet(doc, /id="(email-thread-\d+)"/);
      expect(emailSectionIds).toEqual(new Set(viewFullTargets));
      // Email index count reflects THREADS (2) and TOTAL EMAILS (3), mirroring
      // the app's on-screen "N conversations (M emails)" phrasing.
      // BACKLOG-1842 (visual-polish, founder QA): inner parens replaced with
      // " - " to avoid the awkward nested-parens "(N (M))" reading.
      expect(doc).toContain("Email Threads Index (2 conversations - 3 emails)");
      // BACKLOG-2161 founder QA refinement: thread-A (2 emails) links "View
      // Thread →"; thread-B (1 email) links "View →".
      expect(doc).toContain('href="#email-thread-0">View Thread &rarr;');
      expect(doc).toContain('href="#email-thread-1">View &rarr;');
      expect(doc).not.toContain('href="#email-thread-1">View Thread &rarr;');
    });

    it("summaryOnly renders index only — NO section anchors, View-Full, or back-links", async () => {
      const comms: Communication[] = [
        mkEmail("e1", "thread-A", "Alpha", "<div>a</div>", "2024-01-10T10:00:00Z"),
        mkText("t1", "text-A", "Hi", "2024-01-12T08:00:00Z", "+15551110000"),
      ];

      await folderExportService.exportTransactionToCombinedPDF(
        mockTransaction,
        comms,
        "/mock/output/Combined_Summary.pdf",
        true
      );
      const doc = lastLoadedHtmlContent as string;

      // Index headings still get ids (they are harmless anchors), but there are
      // NO full sections and NO links.
      expect(doc).not.toContain('id="email-thread-0"');
      expect(doc).not.toContain('id="text-thread-0"');
      expect(doc).not.toContain("View Full");
      // No back-link ANCHOR elements (the .doc-back-link CSS rule may exist in
      // the shared <style>, but no <a class="doc-back-link"> should be emitted).
      expect(doc).not.toMatch(/<a[^>]*class="doc-back-link"/);
      expect(hrefSet(doc).size).toBe(0);
    });

    it("email-only export renders ONLY email sections (no text anchors)", async () => {
      const comms: Communication[] = [
        mkEmail("e1", "thread-A", "Alpha", "<div>a</div>", "2024-01-10T10:00:00Z"),
        mkEmail("e2", "thread-B", "Beta", "<div>b</div>", "2024-01-11T10:00:00Z"),
      ];

      await folderExportService.exportTransactionToCombinedPDF(
        mockTransaction,
        comms,
        "/mock/output/Combined_Report.pdf",
        false
      );
      const doc = lastLoadedHtmlContent as string;

      expect(idSet(doc, /id="(email-thread-\d+)"/)).toEqual(
        new Set(["email-thread-0", "email-thread-1"])
      );
      expect(idSet(doc, /id="(text-thread-\d+)"/).size).toBe(0);
      expect(idSet(doc, /id="(text-idx-\d+)"/).size).toBe(0);
    });

    it("text-only export renders ONLY text sections (no email anchors)", async () => {
      const comms: Communication[] = [
        mkText("t1", "text-A", "Hi there", "2024-01-12T08:00:00Z", "+15551110000"),
        mkText("t2", "text-B", "Second convo", "2024-01-13T08:00:00Z", "+15552220000"),
      ];

      await folderExportService.exportTransactionToCombinedPDF(
        mockTransaction,
        comms,
        "/mock/output/Combined_Report.pdf",
        false
      );
      const doc = lastLoadedHtmlContent as string;

      expect(idSet(doc, /id="(text-thread-\d+)"/)).toEqual(
        new Set(["text-thread-0", "text-thread-1"])
      );
      expect(idSet(doc, /id="(text-idx-\d+)"/)).toEqual(
        new Set(["text-idx-0", "text-idx-1"])
      );
      expect(idSet(doc, /id="(email-thread-\d+)"/).size).toBe(0);
    });

    it("sanitizes malicious HTML email bodies before injection (XSS)", async () => {
      const comms: Communication[] = [
        mkEmail(
          "e1",
          "thread-A",
          "Danger",
          '<div>Safe text</div><script>alert("xss")</script><img src="x" onerror="alert(1)">',
          "2024-01-10T10:00:00Z"
        ),
      ];

      await folderExportService.exportTransactionToCombinedPDF(
        mockTransaction,
        comms,
        "/mock/output/Combined_Report.pdf",
        false
      );
      const doc = lastLoadedHtmlContent as string;

      expect(doc).toContain("Safe text");
      // Script tag and inline event handler must be stripped by DOMPurify.
      expect(doc).not.toContain("<script>");
      expect(doc).not.toContain("onerror");
    });
  });
});
