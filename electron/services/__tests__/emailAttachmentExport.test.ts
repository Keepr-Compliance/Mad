/**
 * @jest-environment node
 */

/**
 * TASK-2050: Tests for email attachment export functionality
 *
 * Tests:
 * - resolveFilenameConflict produces unique names
 * - exportEmailAttachmentsToThreadDirs creates correct directory structure
 * - Missing attachments are skipped with warning
 * - Export with 0 attachments produces valid result (no crash)
 * - Size warning is logged when attachments exceed 50MB threshold
 * - Export result includes proper attachment metadata
 */

import { jest } from "@jest/globals";

// --- Mocks ---

// Mock electron
jest.mock("electron", () => ({
  BrowserWindow: jest.fn().mockImplementation(() => ({
    loadFile: jest.fn().mockResolvedValue(undefined),
    webContents: { printToPDF: jest.fn().mockResolvedValue(Buffer.from("mock-pdf")) },
    close: jest.fn(),
  })),
  app: {
    getPath: jest.fn((pathType: string) => {
      if (pathType === "downloads") return "/mock/downloads";
      if (pathType === "temp") return "/mock/temp";
      return "/mock/path";
    }),
  },
}));

// Track which paths exist (for existsSync mock)
let existingPaths = new Set<string>();

// Mock fs (sync) for existsSync used by resolveFilenameConflict
// Normalize path separators for cross-platform compatibility (Windows uses backslashes)
const normalizePath = (p: string) => p.replace(/\\/g, "/");
const mockExistsSync = jest.fn((p: string) => existingPaths.has(normalizePath(p)));
jest.mock("fs", () => ({
  existsSync: mockExistsSync,
}));

// Track copied files and created directories
const copiedFiles: Array<{ src: string; dest: string }> = [];
const createdDirs: string[] = [];
let accessiblePaths = new Set<string>();

// Mock fs/promises
const mockMkdir = jest.fn();
const mockCopyFile = jest.fn();
const mockAccess = jest.fn();
const mockWriteFile = jest.fn();
const mockUnlink = jest.fn();

jest.mock("fs/promises", () => ({
  mkdir: mockMkdir,
  copyFile: mockCopyFile,
  access: mockAccess,
  writeFile: mockWriteFile,
  unlink: mockUnlink,
}));

// Mock logService
const mockWarn = jest.fn();
const mockInfo = jest.fn();
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn((...args: unknown[]) => mockInfo(...args)),
    warn: jest.fn((...args: unknown[]) => mockWarn(...args)),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
  },
}));

// Mock databaseService - return configurable attachment rows
let mockAttachmentRows: Array<{
  id: string;
  filename: string;
  mime_type: string | null;
  storage_path: string | null;
  file_size_bytes: number | null;
}> = [];

const mockAll = jest.fn();
const mockGet = jest.fn();
const mockRun = jest.fn();
const mockPrepare = jest.fn();
const mockGetRawDatabase = jest.fn();
const mockGetAttachmentsForEmailExport = jest.fn();

// Mock googleapis before any imports that depend on it (BACKLOG-1369: attachmentHelpers now imports emailAttachmentService → gmailFetchService → googleapis)
jest.mock("googleapis", () => ({
  google: { gmail: jest.fn() },
  gmail_v1: {},
  Auth: {},
}));

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: (...args: unknown[]) => mockGetRawDatabase(...args),
    getAttachmentsForEmailExport: (...args: unknown[]) => mockGetAttachmentsForEmailExport(...args),
  },
}));

// Import after mocks
import type { Communication } from "../../types/models";
import {
  resolveFilenameConflict,
  sanitizeFileName,
  exportEmailAttachmentsToThreadDirs,
} from "../folderExport/attachmentHelpers";

// Helper to create mock email communications
function createEmail(
  id: string,
  threadId: string,
  subject: string,
  hasAttachments: boolean = true
): Communication {
  return {
    id,
    user_id: "user-123",
    thread_id: threadId,
    subject,
    sender: "alice@test.com",
    recipients: "bob@test.com",
    direction: "inbound",
    sent_at: "2024-01-15T10:00:00Z",
    communication_type: "email",
    channel: "email",
    has_attachments: hasAttachments,
    is_false_positive: false,
    created_at: new Date().toISOString(),
  } as unknown as Communication;
}

describe("TASK-2050: Email Attachment Export", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    existingPaths = new Set();
    copiedFiles.length = 0;
    createdDirs.length = 0;
    accessiblePaths = new Set();
    mockAttachmentRows = [];

    // Re-set fs (sync) mock after clearAllMocks (normalize for Windows backslashes)
    mockExistsSync.mockImplementation((p: string) => existingPaths.has(normalizePath(p)));

    // Re-set database mock chain after clearAllMocks
    mockAll.mockImplementation(() => mockAttachmentRows);
    mockGet.mockReturnValue(undefined);
    mockRun.mockReturnValue(undefined);
    mockPrepare.mockReturnValue({
      all: mockAll,
      get: mockGet,
      run: mockRun,
    });
    mockGetRawDatabase.mockReturnValue({
      prepare: mockPrepare,
    });
    // getAttachmentsForEmailExport delegates to mockAll to reuse per-test overrides
    mockGetAttachmentsForEmailExport.mockImplementation((...args: unknown[]) => mockAll(...args));

    // Re-set fs/promises mock implementations
    mockMkdir.mockImplementation(async (dirPath: string) => {
      createdDirs.push(dirPath);
      return undefined;
    });
    mockCopyFile.mockImplementation(async (src: string, dest: string) => {
      copiedFiles.push({ src, dest });
      return undefined;
    });
    mockAccess.mockImplementation(async (filePath: string) => {
      if (!accessiblePaths.has(filePath)) {
        throw new Error("ENOENT: no such file or directory");
      }
      return undefined;
    });
    mockWriteFile.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  describe("resolveFilenameConflict", () => {
    it("should return sanitized filename when no conflict exists", () => {
      const result = resolveFilenameConflict("/some/dir", "report.pdf");
      expect(result).toBe("report.pdf");
    });

    it("should append counter when filename already exists", () => {
      existingPaths.add("/some/dir/report.pdf");
      const result = resolveFilenameConflict("/some/dir", "report.pdf");
      // sanitizeFileName collapses "report (1).pdf" -> "report_1_.pdf"
      expect(result).toBe("report_1_.pdf");
    });

    it("should increment counter until unique name found", () => {
      existingPaths.add("/some/dir/report.pdf");
      existingPaths.add("/some/dir/report_1_.pdf");
      existingPaths.add("/some/dir/report_2_.pdf");
      const result = resolveFilenameConflict("/some/dir", "report.pdf");
      expect(result).toBe("report_3_.pdf");
    });

    it("should handle filenames without extensions", () => {
      existingPaths.add("/some/dir/readme");
      const result = resolveFilenameConflict("/some/dir", "readme");
      // basename without ext = "readme", ext = "", so counter appended
      expect(result).toContain("readme");
      expect(result).toContain("1");
    });

    it("should sanitize special characters in filenames", () => {
      const result = resolveFilenameConflict("/some/dir", "my file (draft).pdf");
      // sanitizeFileName collapses multiple underscores
      expect(result).toBe("my_file_draft_.pdf");
    });
  });

  describe("sanitizeFileName", () => {
    it("should replace invalid characters with underscores", () => {
      expect(sanitizeFileName("hello world!.pdf")).toBe("hello_world_.pdf");
    });

    it("should collapse multiple underscores", () => {
      expect(sanitizeFileName("a   b   c.txt")).toBe("a_b_c.txt");
    });

    it("should truncate to 100 characters", () => {
      const longName = "a".repeat(150) + ".pdf";
      expect(sanitizeFileName(longName).length).toBeLessThanOrEqual(100);
    });
  });

  describe("exportEmailAttachmentsToThreadDirs", () => {
    it("should produce valid result with 0 attachments (no crash)", async () => {
      const emails = [createEmail("e1", "thread-A", "Test email", false)];
      mockAttachmentRows = [];

      const result = await exportEmailAttachmentsToThreadDirs(emails, "/mock/export/emails");

      expect(result.exported).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.totalSizeBytes).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.items).toHaveLength(0);
    });

    it("should export attachments from 2 email threads into correct directory structure", async () => {
      const emails = [
        createEmail("e1", "thread-A", "Contract email"),
        createEmail("e2", "thread-A", "Re: Contract email"),
        createEmail("e3", "thread-B", "Inspection report"),
      ];

      // When getAttachmentsForEmail is called, return different results per email
      mockAll.mockImplementation((...args: unknown[]) => {
        const emailId = args[0] as string;
        if (emailId === "e1") {
          return [{
            id: "att-1",
            filename: "contract.pdf",
            mime_type: "application/pdf",
            storage_path: "/cache/abc123.pdf",
            file_size_bytes: 5000,
          }];
        }
        if (emailId === "e2") {
          return [{
            id: "att-2",
            filename: "amendment.docx",
            mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            storage_path: "/cache/def456.docx",
            file_size_bytes: 3000,
          }];
        }
        if (emailId === "e3") {
          return [{
            id: "att-3",
            filename: "inspection.pdf",
            mime_type: "application/pdf",
            storage_path: "/cache/ghi789.pdf",
            file_size_bytes: 8000,
          }];
        }
        return [];
      });

      // Mark all storage paths as accessible
      accessiblePaths.add("/cache/abc123.pdf");
      accessiblePaths.add("/cache/def456.docx");
      accessiblePaths.add("/cache/ghi789.pdf");

      const result = await exportEmailAttachmentsToThreadDirs(emails, "/mock/export/emails");

      expect(result.exported).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.totalSizeBytes).toBe(16000);
      expect(result.errors).toHaveLength(0);
      expect(result.items).toHaveLength(3);

      // Verify directory creation for both threads
      const threadADir = createdDirs.find((d) => d.includes("thread-A") && d.includes("attachments"));
      const threadBDir = createdDirs.find((d) => d.includes("thread-B") && d.includes("attachments"));
      expect(threadADir).toBeDefined();
      expect(threadBDir).toBeDefined();

      // Verify files were copied
      expect(copiedFiles).toHaveLength(3);
      expect(copiedFiles.some((f) => f.src === "/cache/abc123.pdf")).toBe(true);
      expect(copiedFiles.some((f) => f.src === "/cache/def456.docx")).toBe(true);
      expect(copiedFiles.some((f) => f.src === "/cache/ghi789.pdf")).toBe(true);

      // Verify items have correct metadata
      const contractItem = result.items.find((i) => i.filename === "contract.pdf");
      expect(contractItem).toBeDefined();
      expect(contractItem!.emailId).toBe("e1");
      expect(contractItem!.threadId).toBe("thread-A");
      expect(contractItem!.contentType).toBe("application/pdf");
      expect(contractItem!.sizeBytes).toBe(5000);
      expect(contractItem!.status).toBe("exported");
      expect(contractItem!.exportPath).toContain("attachments");
    });

    it("should skip missing attachments gracefully and continue with others", async () => {
      const emails = [createEmail("e1", "thread-A", "Mixed attachments")];

      mockAll.mockReturnValue([
        {
          id: "att-1",
          filename: "exists.pdf",
          mime_type: "application/pdf",
          storage_path: "/cache/exists.pdf",
          file_size_bytes: 1000,
        },
        {
          id: "att-2",
          filename: "missing.pdf",
          mime_type: "application/pdf",
          storage_path: "/cache/missing.pdf",
          file_size_bytes: 2000,
        },
        {
          id: "att-3",
          filename: "no-path.pdf",
          mime_type: "application/pdf",
          storage_path: null,
          file_size_bytes: 3000,
        },
      ]);

      // Only the first file is accessible
      accessiblePaths.add("/cache/exists.pdf");

      const result = await exportEmailAttachmentsToThreadDirs(emails, "/mock/export/emails");

      expect(result.exported).toBe(1);
      expect(result.skipped).toBe(2);
      expect(result.totalSizeBytes).toBe(1000);
      expect(result.errors).toHaveLength(2);

      // Verify the accessible file was copied
      expect(copiedFiles).toHaveLength(1);
      expect(copiedFiles[0].src).toBe("/cache/exists.pdf");

      // Verify items track all attachments with correct statuses
      expect(result.items).toHaveLength(3);
      expect(result.items.find((i) => i.filename === "exists.pdf")!.status).toBe("exported");
      expect(result.items.find((i) => i.filename === "missing.pdf")!.status).toBe("skipped");
      expect(result.items.find((i) => i.filename === "no-path.pdf")!.status).toBe("skipped");
    });

    it("should log size warning when attachments exceed 50MB threshold", async () => {
      const emails = [createEmail("e1", "thread-A", "Large attachments")];

      mockAll.mockReturnValue([
        {
          id: "att-1",
          filename: "large-file.zip",
          mime_type: "application/zip",
          storage_path: "/cache/large.zip",
          file_size_bytes: 60 * 1024 * 1024, // 60MB
        },
      ]);

      accessiblePaths.add("/cache/large.zip");

      const result = await exportEmailAttachmentsToThreadDirs(emails, "/mock/export/emails");

      expect(result.exported).toBe(1);
      expect(result.totalSizeBytes).toBe(60 * 1024 * 1024);

      // Verify warning was logged
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining("60.0MB"),
        "FolderExport"
      );
    });

    it("should NOT log size warning when attachments are under 50MB", async () => {
      const emails = [createEmail("e1", "thread-A", "Small attachments")];

      mockAll.mockReturnValue([
        {
          id: "att-1",
          filename: "small.pdf",
          mime_type: "application/pdf",
          storage_path: "/cache/small.pdf",
          file_size_bytes: 1024,
        },
      ]);

      accessiblePaths.add("/cache/small.pdf");

      await exportEmailAttachmentsToThreadDirs(emails, "/mock/export/emails");

      // Verify NO size warning was logged (warn may be called for other reasons)
      const sizeWarningCalls = mockWarn.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("MB")
      );
      expect(sizeWarningCalls).toHaveLength(0);
    });

    it("should handle emails with no id gracefully", async () => {
      const emails = [
        { ...createEmail("e1", "thread-A", "Normal"), id: undefined } as unknown as Communication,
      ];

      const result = await exportEmailAttachmentsToThreadDirs(emails, "/mock/export/emails");

      expect(result.exported).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("BACKLOG-2161: falls back to the on-screen subject key when thread_id is missing", async () => {
      const email = createEmail("email-solo-123", "", "No thread");
      (email as any).thread_id = undefined;

      mockAll.mockReturnValue([
        {
          id: "att-1",
          filename: "doc.pdf",
          mime_type: "application/pdf",
          storage_path: "/cache/doc.pdf",
          file_size_bytes: 500,
        },
      ]);

      accessiblePaths.add("/cache/doc.pdf");

      const result = await exportEmailAttachmentsToThreadDirs([email], "/mock/export/emails");

      expect(result.exported).toBe(1);
      // BACKLOG-2161: emails now group by the SAME key the app uses on-screen
      // (getEmailIndexThreadKey): thread_id → normalized subject (NO participants).
      // So the no-thread_id fallback is `subject-<normalized subject>`, matching
      // the app's conversation grouping — not the old participants-based key.
      expect(result.items[0].threadId).toBe("subject-no thread");

      // Dir should contain the sanitized thread key.
      const attachDir = createdDirs.find((d) => d.includes("subject-no_thread"));
      expect(attachDir).toBeDefined();
    });

    it("should handle duplicate filenames within same thread", async () => {
      const emails = [
        createEmail("e1", "thread-A", "Email 1"),
        createEmail("e2", "thread-A", "Email 2"),
      ];

      // Both emails have an attachment with the same filename
      mockAll.mockImplementation((...args: unknown[]) => {
        const emailId = args[0] as string;
        if (emailId === "e1" || emailId === "e2") {
          return [{
            id: emailId === "e1" ? "att-1" : "att-2",
            filename: "document.pdf",
            mime_type: "application/pdf",
            storage_path: emailId === "e1" ? "/cache/a.pdf" : "/cache/b.pdf",
            file_size_bytes: 1000,
          }];
        }
        return [];
      });

      accessiblePaths.add("/cache/a.pdf");
      accessiblePaths.add("/cache/b.pdf");

      const result = await exportEmailAttachmentsToThreadDirs(emails, "/mock/export/emails");

      expect(result.exported).toBe(2);

      // Both should have been exported with different filenames
      const filenames = result.items.map((i) => i.filename);
      expect(filenames[0]).toBe("document.pdf");
      // Second should have a counter appended
      expect(filenames[1]).not.toBe(filenames[0]);
      expect(filenames[1]).toContain("document");
    });

    it("should use threadNameMap for folder names when provided", async () => {
      const emails = [
        createEmail("e1", "thread-A", "Contract Review"),
        createEmail("e2", "thread-B", "Inspection Report"),
      ];

      mockAll.mockImplementation((...args: unknown[]) => {
        const emailId = args[0] as string;
        if (emailId === "e1") {
          return [{
            id: "att-1",
            filename: "contract.pdf",
            mime_type: "application/pdf",
            storage_path: "/cache/contract.pdf",
            file_size_bytes: 1000,
          }];
        }
        if (emailId === "e2") {
          return [{
            id: "att-2",
            filename: "report.pdf",
            mime_type: "application/pdf",
            storage_path: "/cache/report.pdf",
            file_size_bytes: 2000,
          }];
        }
        return [];
      });

      accessiblePaths.add("/cache/contract.pdf");
      accessiblePaths.add("/cache/report.pdf");

      // Provide a threadNameMap that maps thread IDs to human-readable names
      const threadNameMap = new Map<string, string>();
      threadNameMap.set("thread-A", "thread_001_2024-01-15_Contract_Review");
      threadNameMap.set("thread-B", "thread_002_2024-01-15_Inspection_Report");

      const result = await exportEmailAttachmentsToThreadDirs(
        emails,
        "/mock/export/emails",
        threadNameMap,
      );

      expect(result.exported).toBe(2);

      // Verify directories use human-readable names from the map
      const threadADir = createdDirs.find((d) =>
        d.includes("thread_001_2024-01-15_Contract_Review") && d.includes("attachments")
      );
      const threadBDir = createdDirs.find((d) =>
        d.includes("thread_002_2024-01-15_Inspection_Report") && d.includes("attachments")
      );
      expect(threadADir).toBeDefined();
      expect(threadBDir).toBeDefined();

      // Verify export paths in result items use the human-readable names
      const contractItem = result.items.find((i) => i.filename === "contract.pdf");
      expect(contractItem!.exportPath).toContain("thread_001_2024-01-15_Contract_Review");

      const reportItem = result.items.find((i) => i.filename === "report.pdf");
      expect(reportItem!.exportPath).toContain("thread_002_2024-01-15_Inspection_Report");
    });

    it("should fall back to sanitized threadKey when threadNameMap has no entry", async () => {
      const emails = [createEmail("e1", "thread-X", "Unmapped thread")];

      mockAll.mockReturnValue([{
        id: "att-1",
        filename: "doc.pdf",
        mime_type: "application/pdf",
        storage_path: "/cache/doc.pdf",
        file_size_bytes: 500,
      }]);

      accessiblePaths.add("/cache/doc.pdf");

      // Provide a threadNameMap that does NOT include thread-X
      const threadNameMap = new Map<string, string>();
      threadNameMap.set("thread-OTHER", "thread_001_2024-01-15_Other");

      const result = await exportEmailAttachmentsToThreadDirs(
        emails,
        "/mock/export/emails",
        threadNameMap,
      );

      expect(result.exported).toBe(1);

      // Should fall back to sanitized thread key
      const attachDir = createdDirs.find((d) => d.includes("thread-X") && d.includes("attachments"));
      expect(attachDir).toBeDefined();
    });

    it("should fall back to sanitized threadKey when no threadNameMap provided", async () => {
      const emails = [createEmail("e1", "thread-A", "Test email")];

      mockAll.mockReturnValue([{
        id: "att-1",
        filename: "file.pdf",
        mime_type: "application/pdf",
        storage_path: "/cache/file.pdf",
        file_size_bytes: 1000,
      }]);

      accessiblePaths.add("/cache/file.pdf");

      // Call without threadNameMap (backward compatibility)
      const result = await exportEmailAttachmentsToThreadDirs(emails, "/mock/export/emails");

      expect(result.exported).toBe(1);

      // Should use sanitized thread key as folder name
      const attachDir = createdDirs.find((d) => d.includes("thread-A") && d.includes("attachments"));
      expect(attachDir).toBeDefined();
    });

    it("should skip non-email communications", async () => {
      const textMsg = {
        id: "msg-1",
        user_id: "user-123",
        thread_id: "thread-text",
        sender: "+15551234567",
        body_text: "Hello",
        direction: "inbound",
        sent_at: "2024-01-15T10:00:00Z",
        communication_type: "text",
        channel: "text",
        has_attachments: true,
        is_false_positive: false,
        created_at: new Date().toISOString(),
      } as unknown as Communication;

      const result = await exportEmailAttachmentsToThreadDirs([textMsg], "/mock/export/emails");

      expect(result.exported).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });
});
