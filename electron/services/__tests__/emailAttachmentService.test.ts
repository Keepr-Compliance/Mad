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

// Mock dependencies before importing the service
jest.mock("../databaseService");
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../logService");
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn().mockReturnValue("/mock/user/data"),
  },
}));
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

    it("should skip existing attachments for same email", async () => {
      // Mock existing attachment found via service method
      (databaseService.hasAttachmentForEmail as jest.Mock).mockReturnValue(true);

      const result = await emailAttachmentService.downloadEmailAttachments(
        mockUserId,
        mockEmailId,
        mockExternalEmailId,
        "gmail",
        [mockAttachment]
      );

      expect(result.skipped).toBe(1);
      expect(result.details[0].reason).toContain("already exists");
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

  describe("filename sanitization", () => {
    it("should sanitize path traversal attempts", async () => {
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

      // Should succeed but with sanitized filename
      expect(result.stored).toBe(1);
      // The filename in details should be sanitized
      expect(result.details[0].filename).not.toContain("..");
      expect(result.details[0].filename).not.toContain("/");
    });

    it("should sanitize null bytes in filename", async () => {
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
      expect(result.details[0].filename).not.toContain("\x00");
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
      // BACKLOG-1786: normalize separators so the assertion holds on Windows,
      // where path.join produces backslashes instead of forward slashes.
      expect(dir.replace(/\\/g, "/")).toBe("/mock/user/data/attachments");
    });
  });
});
