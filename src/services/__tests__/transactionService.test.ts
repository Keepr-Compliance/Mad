/**
 * TransactionService Tests
 *
 * TASK-1018: Comprehensive unit tests for transactionService.ts
 *
 * Mock Pattern (from TASK-1017 authService.test.ts):
 * =====================================
 * 1. Mock window.api at module level using Object.defineProperty
 * 2. Create individual mock functions for each API method
 * 3. Reset all mocks in beforeEach with jest.clearAllMocks()
 * 4. Configure mock return values per test case
 * 5. Test both success and error paths for each method
 *
 * API Surface Tested:
 * - Utility functions: isValidISODate, createTimestamp, isValidDetectionStatus, isValidTransactionStatus
 * - CRUD: update, getAll, getDetails, delete
 * - Business logic: recordFeedback, approve, reject, restore
 */

import {
  transactionService,
  isValidISODate,
  createTimestamp,
  isValidDetectionStatus,
  isValidTransactionStatus,
} from "../transactionService";
import type { Transaction } from "@/types";

// ============================================
// MOCK SETUP
// ============================================

// Mock functions for window.api.transactions methods
const mockUpdate = jest.fn();
const mockGetAll = jest.fn();
const mockGetDetails = jest.fn();
const mockDelete = jest.fn();

// Mock functions for window.api.feedback methods
const mockRecordTransaction = jest.fn();

// Mock console.error to prevent noise and verify it's called on errors
const mockConsoleError = jest.spyOn(console, "error").mockImplementation(() => {});

// Setup window.api mock before tests
beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        update: mockUpdate,
        getAll: mockGetAll,
        getDetails: mockGetDetails,
        delete: mockDelete,
      },
      feedback: {
        recordTransaction: mockRecordTransaction,
      },
    },
    writable: true,
    configurable: true,
  });
});

// Reset all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

// Restore console.error after all tests
afterAll(() => {
  mockConsoleError.mockRestore();
});

// ============================================
// TEST FIXTURES
// ============================================

// BACKLOG-2414: both fixtures are deliberately partial `Transaction` rows — they
// carry only the columns these service tests read. `message_count`,
// `attachment_count`, `export_status` and `export_count` are required on the row
// type but absent here; they are asserted through with `toEqual`, so adding them
// would change the expected payload rather than just the typing.
const mockTransaction = {
  id: "txn-123",
  user_id: "user-123",
  property_address: "123 Main St",
  status: "active",
  detection_status: "confirmed",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
} as Transaction;

const mockTransactionList: Transaction[] = [
  mockTransaction,
  {
    id: "txn-456",
    user_id: "user-123",
    property_address: "456 Oak Ave",
    status: "pending",
    detection_status: "pending",
    created_at: "2024-01-02T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  } as Transaction,
];

const mockUserId = "user-123";
const mockTransactionId = "txn-123";

// ============================================
// UTILITY FUNCTION TESTS
// ============================================

describe("Utility Functions", () => {
  describe("isValidISODate", () => {
    it("should return true for valid ISO 8601 date strings", () => {
      expect(isValidISODate("2024-01-15T10:30:00Z")).toBe(true);
      expect(isValidISODate("2024-01-15T10:30:00.123Z")).toBe(true);
      expect(isValidISODate("2024-01-15T10:30:00+05:00")).toBe(true);
    });

    it("should return false for invalid date strings", () => {
      expect(isValidISODate("not-a-date")).toBe(false);
      expect(isValidISODate("2024-13-45")).toBe(false);
      expect(isValidISODate("")).toBe(false);
    });

    it("should return false for date without T separator (date-only)", () => {
      expect(isValidISODate("2024-01-15")).toBe(false);
    });

    it("should return false for null/undefined values", () => {
      expect(isValidISODate(null as unknown as string)).toBe(false);
      expect(isValidISODate(undefined as unknown as string)).toBe(false);
    });
  });

  describe("createTimestamp", () => {
    it("should return a valid ISO 8601 timestamp", () => {
      const timestamp = createTimestamp();
      expect(isValidISODate(timestamp)).toBe(true);
    });

    it("should return a timestamp close to current time", () => {
      const before = Date.now();
      const timestamp = createTimestamp();
      const after = Date.now();

      const timestampMs = new Date(timestamp).getTime();
      expect(timestampMs).toBeGreaterThanOrEqual(before);
      expect(timestampMs).toBeLessThanOrEqual(after);
    });
  });

  describe("isValidDetectionStatus", () => {
    it("should return true for valid detection status values", () => {
      expect(isValidDetectionStatus("pending")).toBe(true);
      expect(isValidDetectionStatus("confirmed")).toBe(true);
      expect(isValidDetectionStatus("rejected")).toBe(true);
    });

    it("should return false for invalid detection status values", () => {
      expect(isValidDetectionStatus("invalid")).toBe(false);
      expect(isValidDetectionStatus("PENDING")).toBe(false);
      expect(isValidDetectionStatus("")).toBe(false);
      expect(isValidDetectionStatus(null)).toBe(false);
      expect(isValidDetectionStatus(undefined)).toBe(false);
      expect(isValidDetectionStatus(123)).toBe(false);
    });
  });

  describe("isValidTransactionStatus", () => {
    it("should return true for valid transaction status values", () => {
      expect(isValidTransactionStatus("pending")).toBe(true);
      expect(isValidTransactionStatus("active")).toBe(true);
      expect(isValidTransactionStatus("closed")).toBe(true);
      expect(isValidTransactionStatus("rejected")).toBe(true);
    });

    it("should return false for invalid transaction status values", () => {
      expect(isValidTransactionStatus("invalid")).toBe(false);
      expect(isValidTransactionStatus("ACTIVE")).toBe(false);
      expect(isValidTransactionStatus("")).toBe(false);
      expect(isValidTransactionStatus(null)).toBe(false);
      expect(isValidTransactionStatus(undefined)).toBe(false);
      expect(isValidTransactionStatus(123)).toBe(false);
    });
  });
});

// ============================================
// UPDATE METHOD TESTS
// ============================================

describe("transactionService", () => {
  describe("update", () => {
    it("should update transaction successfully with valid data", async () => {
      mockUpdate.mockResolvedValue({ success: true });

      const result = await transactionService.update(mockTransactionId, {
        status: "active",
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockUpdate).toHaveBeenCalledWith(mockTransactionId, {
        status: "active",
      });
    });

    it("should return error for invalid detection_status", async () => {
      const result = await transactionService.update(mockTransactionId, {
        detection_status: "invalid" as never,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid detection status");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("should return error for invalid status", async () => {
      const result = await transactionService.update(mockTransactionId, {
        status: "invalid" as never,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid status");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("should return error for invalid reviewed_at date format", async () => {
      const result = await transactionService.update(mockTransactionId, {
        reviewed_at: "2024-01-15", // Missing T separator
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid ISO date format for reviewed_at");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("should allow null reviewed_at value", async () => {
      mockUpdate.mockResolvedValue({ success: true });

      const result = await transactionService.update(mockTransactionId, {
        reviewed_at: null as unknown as string,
      });

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("should accept valid reviewed_at ISO date", async () => {
      mockUpdate.mockResolvedValue({ success: true });

      const result = await transactionService.update(mockTransactionId, {
        reviewed_at: "2024-01-15T10:30:00Z",
      });

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(mockTransactionId, {
        reviewed_at: "2024-01-15T10:30:00Z",
      });
    });

    it("should return error when API returns failure", async () => {
      mockUpdate.mockResolvedValue({ success: false, error: "Database error" });

      const result = await transactionService.update(mockTransactionId, {
        status: "active",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Database error");
    });

    it("should catch and return error when API throws exception", async () => {
      mockUpdate.mockRejectedValue(new Error("Network error"));

      const result = await transactionService.update(mockTransactionId, {
        status: "active",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
    });

    it("should handle unknown error types", async () => {
      mockUpdate.mockRejectedValue("String error");

      const result = await transactionService.update(mockTransactionId, {
        status: "active",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown error");
    });
  });

  // ============================================
  // RECORD FEEDBACK METHOD TESTS
  // ============================================

  describe("recordFeedback", () => {
    const feedbackPayload = {
      detectedTransactionId: mockTransactionId,
      action: "confirm" as const,
    };

    it("should record feedback successfully", async () => {
      mockRecordTransaction.mockResolvedValue({ success: true });

      const result = await transactionService.recordFeedback(mockUserId, feedbackPayload);

      expect(result.success).toBe(true);
      expect(mockRecordTransaction).toHaveBeenCalledWith(mockUserId, feedbackPayload);
    });

    it("should return error when userId is missing", async () => {
      const result = await transactionService.recordFeedback("", feedbackPayload);

      expect(result.success).toBe(false);
      expect(result.error).toBe("User ID is required for feedback recording");
      expect(mockRecordTransaction).not.toHaveBeenCalled();
    });

    it("should silently succeed even when API throws exception (feedback is non-critical)", async () => {
      mockRecordTransaction.mockRejectedValue(new Error("Feedback service unavailable"));

      const result = await transactionService.recordFeedback(mockUserId, feedbackPayload);

      // Feedback failure is silent - returns success
      expect(result.success).toBe(true);
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("[ERROR] Failed to record feedback:"),
        "Feedback service unavailable"
      );
    });

    it("should handle corrections in payload", async () => {
      mockRecordTransaction.mockResolvedValue({ success: true });
      const payloadWithCorrections = {
        ...feedbackPayload,
        corrections: { field: "value" },
      };

      const result = await transactionService.recordFeedback(mockUserId, payloadWithCorrections);

      expect(result.success).toBe(true);
      expect(mockRecordTransaction).toHaveBeenCalledWith(mockUserId, payloadWithCorrections);
    });
  });

  // ============================================
  // APPROVE METHOD TESTS
  // ============================================

  describe("approve", () => {
    it("should approve transaction successfully", async () => {
      mockUpdate.mockResolvedValue({ success: true });
      mockRecordTransaction.mockResolvedValue({ success: true });

      const result = await transactionService.approve(mockTransactionId, mockUserId);

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(mockTransactionId, expect.objectContaining({
        detection_status: "confirmed",
        status: "active",
        reviewed_at: expect.any(String),
      }));
      expect(mockRecordTransaction).toHaveBeenCalledWith(mockUserId, {
        detectedTransactionId: mockTransactionId,
        action: "confirm",
      });
    });

    it("should return error when userId is missing", async () => {
      const result = await transactionService.approve(mockTransactionId, "");

      expect(result.success).toBe(false);
      expect(result.error).toBe("User ID is required to approve a transaction");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("should return error when update fails", async () => {
      mockUpdate.mockResolvedValue({ success: false, error: "Update failed" });

      const result = await transactionService.approve(mockTransactionId, mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Update failed");
      expect(mockRecordTransaction).not.toHaveBeenCalled();
    });

    it("should succeed even if feedback recording fails (non-blocking)", async () => {
      mockUpdate.mockResolvedValue({ success: true });
      mockRecordTransaction.mockRejectedValue(new Error("Feedback failed"));

      const result = await transactionService.approve(mockTransactionId, mockUserId);

      expect(result.success).toBe(true);
    });
  });

  // ============================================
  // REJECT METHOD TESTS
  // ============================================

  describe("reject", () => {
    it("should reject transaction successfully with reason", async () => {
      mockUpdate.mockResolvedValue({ success: true });
      mockRecordTransaction.mockResolvedValue({ success: true });

      const result = await transactionService.reject(mockTransactionId, mockUserId, "Not a real transaction");

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(mockTransactionId, expect.objectContaining({
        detection_status: "rejected",
        rejection_reason: "Not a real transaction",
        reviewed_at: expect.any(String),
      }));
      expect(mockRecordTransaction).toHaveBeenCalledWith(mockUserId, {
        detectedTransactionId: mockTransactionId,
        action: "reject",
        corrections: { reason: "Not a real transaction" },
      });
    });

    it("should reject transaction successfully without reason", async () => {
      mockUpdate.mockResolvedValue({ success: true });
      mockRecordTransaction.mockResolvedValue({ success: true });

      const result = await transactionService.reject(mockTransactionId, mockUserId);

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(mockTransactionId, expect.objectContaining({
        detection_status: "rejected",
        rejection_reason: undefined,
      }));
      expect(mockRecordTransaction).toHaveBeenCalledWith(mockUserId, {
        detectedTransactionId: mockTransactionId,
        action: "reject",
        corrections: undefined,
      });
    });

    it("should work with undefined userId (no feedback recording)", async () => {
      mockUpdate.mockResolvedValue({ success: true });

      const result = await transactionService.reject(mockTransactionId, undefined);

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalled();
      expect(mockRecordTransaction).not.toHaveBeenCalled();
    });

    it("should return error when update fails", async () => {
      mockUpdate.mockResolvedValue({ success: false, error: "Rejection failed" });

      const result = await transactionService.reject(mockTransactionId, mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Rejection failed");
      expect(mockRecordTransaction).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // RESTORE METHOD TESTS
  // ============================================

  describe("restore", () => {
    it("should restore rejected transaction successfully", async () => {
      mockUpdate.mockResolvedValue({ success: true });
      mockRecordTransaction.mockResolvedValue({ success: true });

      const result = await transactionService.restore(mockTransactionId, mockUserId);

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(mockTransactionId, expect.objectContaining({
        detection_status: "confirmed",
        status: "active",
        reviewed_at: expect.any(String),
        rejection_reason: null,
      }));
      expect(mockRecordTransaction).toHaveBeenCalledWith(mockUserId, {
        detectedTransactionId: mockTransactionId,
        action: "confirm",
        corrections: { reason: "Restored from rejection" },
      });
    });

    it("should work with undefined userId (no feedback recording)", async () => {
      mockUpdate.mockResolvedValue({ success: true });

      const result = await transactionService.restore(mockTransactionId, undefined);

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalled();
      expect(mockRecordTransaction).not.toHaveBeenCalled();
    });

    it("should return error when update fails", async () => {
      mockUpdate.mockResolvedValue({ success: false, error: "Restore failed" });

      const result = await transactionService.restore(mockTransactionId, mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Restore failed");
      expect(mockRecordTransaction).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // GET ALL METHOD TESTS
  // ============================================

  describe("getAll", () => {
    it("should return all transactions successfully", async () => {
      mockGetAll.mockResolvedValue({ success: true, transactions: mockTransactionList });

      const result = await transactionService.getAll(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockTransactionList);
      expect(mockGetAll).toHaveBeenCalledWith(mockUserId);
    });

    it("should return empty array when no transactions exist", async () => {
      mockGetAll.mockResolvedValue({ success: true, transactions: [] });

      const result = await transactionService.getAll(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it("should handle undefined transactions field", async () => {
      mockGetAll.mockResolvedValue({ success: true });

      const result = await transactionService.getAll(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it("should return error when API returns failure", async () => {
      mockGetAll.mockResolvedValue({ success: false, error: "User not found" });

      const result = await transactionService.getAll(mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("User not found");
    });

    it("should catch and return error when API throws exception", async () => {
      mockGetAll.mockRejectedValue(new Error("Database connection lost"));

      const result = await transactionService.getAll(mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Database connection lost");
    });
  });

  // ============================================
  // GET DETAILS METHOD TESTS
  // ============================================

  describe("getDetails", () => {
    it("should return transaction details successfully", async () => {
      mockGetDetails.mockResolvedValue({ success: true, transaction: mockTransaction });

      const result = await transactionService.getDetails(mockTransactionId);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockTransaction);
      expect(mockGetDetails).toHaveBeenCalledWith(mockTransactionId);
    });

    it("should return error when transaction not found", async () => {
      mockGetDetails.mockResolvedValue({ success: false, error: "Transaction not found" });

      const result = await transactionService.getDetails("nonexistent-id");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Transaction not found");
    });

    it("should catch and return error when API throws exception", async () => {
      mockGetDetails.mockRejectedValue(new Error("Query timeout"));

      const result = await transactionService.getDetails(mockTransactionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Query timeout");
    });
  });

  // ============================================
  // DELETE METHOD TESTS
  // ============================================

  describe("delete", () => {
    it("should delete transaction successfully", async () => {
      mockDelete.mockResolvedValue({ success: true });

      const result = await transactionService.delete(mockTransactionId);

      expect(result.success).toBe(true);
      expect(mockDelete).toHaveBeenCalledWith(mockTransactionId);
    });

    it("should catch and return error when API throws exception", async () => {
      mockDelete.mockRejectedValue(new Error("Transaction has dependencies"));

      const result = await transactionService.delete(mockTransactionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Transaction has dependencies");
    });

    it("should handle unknown error types", async () => {
      mockDelete.mockRejectedValue({ code: "FOREIGN_KEY_VIOLATION" });

      const result = await transactionService.delete(mockTransactionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown error");
    });
  });
});
