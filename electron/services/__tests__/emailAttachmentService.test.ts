/**
 * @jest-environment node
 */

/**
 * Unit tests for EmailAttachmentService
 * TASK-1775: Tests email attachment download and storage functionality
 * TASK-2100: Updated to test service-layer methods instead of raw SQL
 */

import fs from "fs/promises";
import crypto from "crypto";
import path from "path";

// Mocked app.getPath("userData"), resolved to an OS-ABSOLUTE path so that the
// product's path.join(...) and path.resolve(...) AGREE on Windows as well as POSIX:
//   - POSIX:   path.resolve("/mock/user/data") → "/mock/user/data" (unchanged)
//   - Windows: path.resolve("/mock/user/data") → drive-absolute, e.g. "D:\\mock\\user\\data"
// Real Electron userData is ALWAYS drive-absolute, so this mirrors production. Without
// the drive, path.join stays drive-RELATIVE ("\\mock\\...") while path.resolve prepends
// the cwd drive ("D:\\mock\\..."), so the stored storage_path (path.join) and the on-disk
// write path (path.resolve) diverged by the "D:" prefix on Windows only. The electron
// getPath mock below computes the SAME value inline (it can't reference this const — jest
// hoists the mock factory above this declaration).
const MOCK_USER_DATA = path.resolve("/mock/user/data");

// Mock dependencies before importing the service
jest.mock("../databaseService");
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../logService");
jest.mock("electron", () => {
  // Compute inline: this factory is hoisted above the MOCK_USER_DATA declaration, so it
  // can't reference it. path.resolve is deterministic (depends only on cwd), so this
  // yields the identical OS-absolute value as MOCK_USER_DATA.
  const nodePath = require("path");
  return {
    app: {
      getPath: jest.fn().mockReturnValue(nodePath.resolve("/mock/user/data")),
    },
  };
});
jest.mock("fs/promises", () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(Buffer.from("test content")),
  access: jest.fn().mockRejectedValue(new Error("File not found")),
}));

import emailAttachmentService, {
  EmailAttachmentMeta,
} from "../emailAttachmentService";
import databaseService from "../databaseService";
import gmailFetchService from "../gmailFetchService";
import outlookFetchService from "../outlookFetchService";

describe("EmailAttachmentService", () => {
  const mockUserId = "user-123";
  const mockEmailId = "email-456";
  const mockExternalEmailId = "gmail-msg-789";

  const mockAttachment: EmailAttachmentMeta = {
    filename: "document.pdf",
    mimeType: "application/pdf",
    size: 1024,
    attachmentId: "att-123",
  };

  const mockAttachmentData = Buffer.from("PDF content here");

  beforeEach(() => {
    jest.clearAllMocks();

    // TASK-2100: Mock new service-layer methods instead of getRawDatabase
    (databaseService.getAttachmentStoragePaths as jest.Mock).mockReturnValue([]);
    (databaseService.hasAttachmentForEmail as jest.Mock).mockReturnValue(false);
    (databaseService.createAttachmentRecord as jest.Mock).mockReturnValue(undefined);
    (databaseService.getAttachmentsByEmailId as jest.Mock).mockReturnValue([]);
    // BACKLOG-1870: reconcile-with-sync methods. Default: no pre-existing row.
    (databaseService.getEmailAttachmentByFilename as jest.Mock).mockReturnValue(
      undefined
    );
    (databaseService.setEmailAttachmentStorage as jest.Mock).mockReturnValue(
      undefined
    );

    (gmailFetchService.getAttachment as jest.Mock).mockResolvedValue(
      mockAttachmentData
    );
    (outlookFetchService.getAttachment as jest.Mock).mockResolvedValue(
      mockAttachmentData
    );
  });

  describe("downloadEmailAttachments", () => {
    it("should return empty result for no attachments", async () => {
      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "gmail",
        []
      );

      expect(result.success).toBe(true);
      expect(result.stored).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
    });

    it("should download and store Gmail attachment", async () => {
      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "gmail",
        [mockAttachment]
      );

      expect(gmailFetchService.getAttachment).toHaveBeenCalledWith(
        mockExternalEmailId,
        mockAttachment.attachmentId
      );
      expect(result.stored).toBe(1);
      expect(result.errors).toBe(0);
    });

    it("should download and store Outlook attachment", async () => {
      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "outlook",
        [mockAttachment]
      );

      expect(outlookFetchService.getAttachment).toHaveBeenCalledWith(
        mockExternalEmailId,
        mockAttachment.attachmentId
      );
      expect(result.stored).toBe(1);
      expect(result.errors).toBe(0);
    });

    it("should skip oversized attachments", async () => {
      const largeAttachment: EmailAttachmentMeta = {
        ...mockAttachment,
        size: 60 * 1024 * 1024, // 60MB, over 50MB limit
      };

      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "gmail",
        [largeAttachment]
      );

      expect(gmailFetchService.getAttachment).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
      expect(result.details[0].reason).toContain("exceeds");
    });

    it("should handle download errors gracefully", async () => {
      (gmailFetchService.getAttachment as jest.Mock).mockRejectedValue(
        new Error("Network error")
      );

      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "gmail",
        [mockAttachment]
      );

      expect(result.errors).toBe(1);
      expect(result.stored).toBe(0);
      expect(result.details[0].status).toBe("error");
    });

    it("should skip attachments already downloaded (row has storage_path)", async () => {
      // BACKLOG-1870: a row whose bytes are already stored (storage_path set) is skipped.
      (databaseService.getEmailAttachmentByFilename as jest.Mock).mockReturnValue({
        id: "att-existing",
        storage_path: "/mock/user/data/attachments/abc.pdf",
      });

      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "gmail",
        [mockAttachment]
      );

      expect(result.skipped).toBe(1);
      expect(result.details[0].reason).toContain("already downloaded");
      // No bytes fetched, no new record created.
      expect(gmailFetchService.getAttachment).not.toHaveBeenCalled();
      expect(databaseService.createAttachmentRecord).not.toHaveBeenCalled();
    });

    it("BACKLOG-1870: reconciles a sync-created metadata row (storage_path NULL) by backfilling the SAME row, not inserting a duplicate", async () => {
      // A metadata-only row exists from sync: same id, storage_path still NULL.
      (databaseService.getEmailAttachmentByFilename as jest.Mock).mockReturnValue({
        id: "att-sync-meta",
        storage_path: null,
      });

      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "gmail",
        [mockAttachment]
      );

      // Bytes ARE downloaded now...
      expect(gmailFetchService.getAttachment).toHaveBeenCalledWith(
        mockExternalEmailId,
        mockAttachment.attachmentId
      );
      // ...and storage is filled on the SAME row by id — no duplicate INSERT.
      expect(databaseService.setEmailAttachmentStorage).toHaveBeenCalledTimes(1);
      const [rowId, storagePath, sizeBytes] = (
        databaseService.setEmailAttachmentStorage as jest.Mock
      ).mock.calls[0];
      expect(rowId).toBe("att-sync-meta");
      expect(typeof storagePath).toBe("string");
      expect(sizeBytes).toBe(mockAttachmentData.length);
      expect(databaseService.createAttachmentRecord).not.toHaveBeenCalled();
      expect(result.stored).toBe(1);
    });

    it("BACKLOG-1870: reconciles a spaced/special-char filename via the RAW display name (routes through the real sanitizer, no orphan/duplicate)", async () => {
      // Regression for the sync↔download key mismatch: sync stores the RAW trimmed
      // filename, but the download path used to look up the SANITIZED name and miss.
      // sanitizeFileSystemName is NOT mocked here, so it runs for real:
      //   "Purchase Agreement (final).pdf" → "Purchase_Agreement_final_.pdf".
      const rawFilename = "Purchase Agreement (final).pdf";
      const sanitizedFilename = "Purchase_Agreement_final_.pdf"; // what the old code keyed on

      // The sync row exists ONLY under the RAW filename (storage_path NULL).
      (databaseService.getEmailAttachmentByFilename as jest.Mock).mockImplementation(
        (_emailId: string, filename: string) =>
          filename === rawFilename
            ? { id: "att-sync-row", storage_path: null }
            : undefined
      );

      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "outlook",
        [
          {
            filename: rawFilename,
            mimeType: "application/pdf",
            size: 2048,
            attachmentId: "att-x",
          },
        ]
      );

      // The lookup used the RAW display name (matching what sync stored)...
      expect(databaseService.getEmailAttachmentByFilename).toHaveBeenCalledWith(
        mockEmailId,
        rawFilename
      );
      // ...NOT the sanitized variant (the old bug).
      expect(databaseService.getEmailAttachmentByFilename).not.toHaveBeenCalledWith(
        mockEmailId,
        sanitizedFilename
      );
      // Reconciled the SAME sync row by id — exactly one row, no orphan/duplicate.
      expect(databaseService.setEmailAttachmentStorage).toHaveBeenCalledTimes(1);
      expect(
        (databaseService.setEmailAttachmentStorage as jest.Mock).mock.calls[0][0]
      ).toBe("att-sync-row");
      expect(databaseService.createAttachmentRecord).not.toHaveBeenCalled();
      expect(result.stored).toBe(1);
      // The result surfaces the real display name, not the underscored one.
      expect(result.details[0].filename).toBe(rawFilename);
    });

    it("BACKLOG-1870: a fresh download (no sync row) stores the RAW display filename as the DB key", async () => {
      // No pre-existing row anywhere (default mock returns undefined).
      const rawFilename = "Wire Instructions #2.pdf";

      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "gmail",
        [
          {
            filename: rawFilename,
            mimeType: "application/pdf",
            size: 1024,
            attachmentId: "att-y",
          },
        ]
      );

      // Inserted with the RAW filename so a later sync upsert reconciles by key.
      expect(databaseService.createAttachmentRecord).toHaveBeenCalledTimes(1);
      const insertArg = (databaseService.createAttachmentRecord as jest.Mock).mock
        .calls[0][0];
      expect(insertArg.filename).toBe(rawFilename);
      expect(result.stored).toBe(1);
    });

    it("should deduplicate files by content hash", async () => {
      // First download
      await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "gmail",
        [mockAttachment]
      );

      // Check that file was written
      expect(fs.writeFile).toHaveBeenCalled();

      // Reset writeFile mock for second test
      (fs.writeFile as jest.Mock).mockClear();

      // Mock that file already exists (same content hash)
      const contentHash = crypto
        .createHash("sha256")
        .update(mockAttachmentData)
        .digest("hex");
      (databaseService.getAttachmentStoragePaths as jest.Mock).mockReturnValue([
        { storage_path: `/mock/path/${contentHash}.pdf` },
      ]);

      // Second download with same content should not write file
      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        "email-different",
        "gmail-msg-different",
        "gmail",
        [mockAttachment]
      );

      // File should not be written again (deduplicated)
      expect(fs.writeFile).not.toHaveBeenCalled();
      // But record should still be created
      expect(result.stored).toBe(1);
    });
  });

  describe("filename safety (on-disk path)", () => {
    // BACKLOG-1870: the DB/display filename now stores the RAW name (so it reconciles
    // with the sync-persisted row). Filesystem safety is enforced where it matters —
    // the on-disk STORAGE path is content-hash-named, and the EXPORT path re-sanitizes
    // (folderExport sanitizeFileName) — so a traversal/null-byte name never reaches disk.
    it("keeps the on-disk storage path safe for a traversal-style filename", async () => {
      const maliciousAttachment: EmailAttachmentMeta = {
        filename: "../../../etc/passwd",
        mimeType: "text/plain",
        size: 100,
        attachmentId: "att-malicious",
      };

      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "gmail",
        [maliciousAttachment]
      );

      expect(result.stored).toBe(1);
      // File written to disk is content-hash-named under the attachments dir — never
      // a traversal path. Derive the dir the SAME way the product code does
      // (path.resolve(path.join(userData, "attachments"))) so the assertion is
      // separator-agnostic and correct on Windows.
      const attachmentsDir = path.resolve(path.join(MOCK_USER_DATA, "attachments"));
      const writtenPath = (fs.writeFile as jest.Mock).mock.calls[0][0] as string;
      expect(writtenPath.startsWith(attachmentsDir + path.sep)).toBe(true);
      // Traversal guard (separator-agnostic): the written path stays inside the dir.
      expect(path.relative(attachmentsDir, writtenPath).startsWith("..")).toBe(false);
      expect(writtenPath).not.toContain("..");
      expect(writtenPath).not.toContain("passwd");
      // The persisted storage_path is that same safe path...
      const insertArg = (databaseService.createAttachmentRecord as jest.Mock).mock
        .calls[0][0];
      expect(insertArg.storagePath).toBe(writtenPath);
      // ...while the DB/display filename retains the RAW name (display + search only).
      expect(insertArg.filename).toBe("../../../etc/passwd");
      expect(result.details[0].filename).toBe("../../../etc/passwd");
    });

    it("keeps the on-disk storage path safe for a null-byte filename", async () => {
      const maliciousAttachment: EmailAttachmentMeta = {
        filename: "file\x00.pdf",
        mimeType: "application/pdf",
        size: 100,
        attachmentId: "att-null",
      };

      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "gmail",
        [maliciousAttachment]
      );

      expect(result.stored).toBe(1);
      const attachmentsDir = path.resolve(path.join(MOCK_USER_DATA, "attachments"));
      const writtenPath = (fs.writeFile as jest.Mock).mock.calls[0][0] as string;
      expect(writtenPath.startsWith(attachmentsDir + path.sep)).toBe(true);
      expect(path.relative(attachmentsDir, writtenPath).startsWith("..")).toBe(false);
      expect(writtenPath).not.toContain("\x00");
    });

    it("should handle empty filename", async () => {
      const emptyNameAttachment: EmailAttachmentMeta = {
        filename: "",
        mimeType: "application/pdf",
        size: 100,
        attachmentId: "att-empty",
      };

      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "gmail",
        [emptyNameAttachment]
      );

      expect(result.stored).toBe(1);
      // Should use default "attachment" name
      expect(result.details[0].filename).toBe("attachment");
    });
  });

  describe("getAttachmentsForEmail", () => {
    it("should return attachments for an email", async () => {
      const mockAttachments = [
        {
          id: "att-1",
          filename: "doc.pdf",
          mime_type: "application/pdf",
          file_size_bytes: 1024,
          storage_path: "/mock/path/hash.pdf",
        },
      ];

      (databaseService.getAttachmentsByEmailId as jest.Mock).mockReturnValue(mockAttachments);

      const result =
        await emailAttachmentService.getAttachmentsForEmail(mockEmailId);

      expect(result).toEqual(mockAttachments);
    });

    it("should return empty array on error", async () => {
      (databaseService.getAttachmentsByEmailId as jest.Mock).mockImplementation(() => {
        throw new Error("Database error");
      });

      const result =
        await emailAttachmentService.getAttachmentsForEmail(mockEmailId);

      expect(result).toEqual([]);
    });
  });

  describe("getAttachmentsDirectory", () => {
    it("should return the correct attachments directory path", () => {
      const dir = emailAttachmentService.getAttachmentsDirectory();
      // Derive the expected path from the same mocked userData (now OS-absolute) so the
      // assertion holds on Windows (drive-absolute, "\\" sep) AND POSIX with no hardcoded
      // separator or drive letter.
      expect(dir).toBe(path.join(MOCK_USER_DATA, "attachments"));
    });
  });
});
