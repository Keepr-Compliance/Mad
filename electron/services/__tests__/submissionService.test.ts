/**
 * @jest-environment node
 */

/**
 * Unit tests for SubmissionService
 * TASK-1779: Tests email attachment inclusion in broker portal upload
 * TASK-2100: Updated to test service-layer methods instead of raw SQL
 */

// Mock dependencies before importing
jest.mock("../supabaseService");
jest.mock("../supabaseStorageService");
jest.mock("../databaseService");
jest.mock("../logService");
jest.mock("../contactsService");
jest.mock("electron", () => ({
  app: {
    getVersion: jest.fn().mockReturnValue("2.0.0"),
  },
}));

import { submissionService } from "../submissionService";
import databaseService from "../databaseService";
import { textIdsForTests } from "./helpers/selectedTextIds";

// BACKLOG-3733: the text set the submit passes down; the loader forwards it.
const SELECTED = textIdsForTests(["msg-1"]);

describe("SubmissionService", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // TASK-2100: Mock new service-layer methods instead of getRawDatabase
    (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue([]);
    (databaseService.getTransactionMessages as jest.Mock).mockReturnValue([]);
    (databaseService.getTransactionEmails as jest.Mock).mockReturnValue([]);
  });

  describe("loadTransactionAttachments (internal)", () => {
    // Access the private method through reflection for testing
    const loadAttachments = async (transactionId: string, startDate?: Date, endDate?: Date) => {
      return (submissionService as any).loadTransactionAttachments(transactionId, startDate, endDate, SELECTED);
    };

    it("should return combined text message and email attachments", async () => {
      const mockTextAttachment = {
        id: "att-text-1",
        message_id: "msg-1",
        filename: "document.pdf",
        storage_path: "/path/to/document.pdf",
        created_at: "2024-01-15T10:00:00Z",
      };

      const mockEmailAttachment = {
        id: "att-email-1",
        email_id: "email-1",
        filename: "email-attachment.pdf",
        storage_path: "/path/to/email-attachment.pdf",
        created_at: "2024-01-16T10:00:00Z",
      };

      (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue([
        mockTextAttachment,
        mockEmailAttachment,
      ]);

      const result = await loadAttachments("txn-123");

      // Verify databaseService was called with the correct transaction ID
      expect(databaseService.getTransactionAttachments).toHaveBeenCalledWith("txn-123", undefined, undefined, SELECTED);

      // Verify both attachments are returned
      expect(result).toHaveLength(2);
      expect(result.map((a: any) => a.id)).toContain("att-text-1");
      expect(result.map((a: any) => a.id)).toContain("att-email-1");
    });

    it("should deduplicate attachments by id (handled by databaseService)", async () => {
      // databaseService.getTransactionAttachments already deduplicates
      const uniqueAttachment = {
        id: "att-dup-1",
        message_id: "msg-1",
        email_id: null,
        filename: "duplicate.pdf",
        storage_path: "/path/to/duplicate.pdf",
        created_at: "2024-01-15T10:00:00Z",
      };

      (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue([uniqueAttachment]);

      const result = await loadAttachments("txn-123");

      // Should have only 1 unique attachment
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("att-dup-1");
    });

    it("should return attachments sorted by created_at (handled by databaseService)", async () => {
      const olderAttachment = {
        id: "att-older",
        filename: "older.pdf",
        storage_path: "/path/to/older.pdf",
        created_at: "2024-01-10T10:00:00Z",
      };

      const newerAttachment = {
        id: "att-newer",
        filename: "newer.pdf",
        storage_path: "/path/to/newer.pdf",
        created_at: "2024-01-20T10:00:00Z",
      };

      // databaseService returns sorted results
      (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue([
        olderAttachment,
        newerAttachment,
      ]);

      const result = await loadAttachments("txn-123");

      expect(result).toHaveLength(2);
      // Older attachment should be first
      expect(result[0].id).toBe("att-older");
      expect(result[1].id).toBe("att-newer");
    });

    it("should handle empty results", async () => {
      (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue([]);

      const result = await loadAttachments("txn-123");

      expect(result).toHaveLength(0);
    });

    it("should pass date filters to databaseService", async () => {
      (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue([]);

      const startDate = new Date("2024-01-01");
      const endDate = new Date("2024-12-31");
      await loadAttachments("txn-123", startDate, endDate);

      // Verify date filters are passed through to databaseService
      expect(databaseService.getTransactionAttachments).toHaveBeenCalledWith("txn-123", startDate, endDate, SELECTED);
    });
  });
});
