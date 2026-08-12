/**
 * Unit tests for Feedback Handlers
 * Tests feedback IPC handlers including:
 * - Feedback submission
 * - Transaction feedback retrieval
 * - Extraction metrics
 * - Smart suggestions
 * - Learning statistics
 */

import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
  type RegisteredIpcHandler,
} from "../../tests/support/ipcHandlerRegistry";
import type { IpcMainInvokeEvent } from "electron";
import type { UserFeedback } from "../types";

// Mock electron module
const mockIpcHandle = jest.fn();

jest.mock("electron", () => ({
  ipcMain: {
    handle: mockIpcHandle,
  },
}));

// Mock services - inline since jest.mock is hoisted
jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    saveFeedback: jest.fn(),
    getFeedbackByTransaction: jest.fn(),
    getFeedbackByField: jest.fn(),
    isInitialized: jest.fn().mockReturnValue(true),
  },
}));

jest.mock("../services/feedbackLearningService", () => ({
  __esModule: true,
  default: {
    clearCache: jest.fn(),
    generateSuggestion: jest.fn(),
    getLearningStats: jest.fn(),
  },
}));

// Mock FeedbackService
const mockRecordTransactionFeedback = jest.fn();
const mockRecordRoleFeedback = jest.fn();
const mockRecordCommunicationFeedback = jest.fn();
const mockGetFeedbackStats = jest.fn();

jest.mock("../services/feedbackService", () => ({
  __esModule: true,
  getFeedbackService: jest.fn(() => ({
    recordTransactionFeedback: mockRecordTransactionFeedback,
    recordRoleFeedback: mockRecordRoleFeedback,
    recordCommunicationFeedback: mockRecordCommunicationFeedback,
    getFeedbackStats: mockGetFeedbackStats,
  })),
}));

// Import after mocks are set up
import { registerFeedbackHandlers } from "../handlers/feedbackHandlers";
import databaseService from "../services/databaseService";

// Get the feedbackLearningService mock - need to use require since it's a CommonJS require in source
const feedbackLearningService =
  require("../services/feedbackLearningService").default;

// Get typed references to mocked services
const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;
const mockFeedbackLearningService = feedbackLearningService as jest.Mocked<
  typeof feedbackLearningService
>;

// Test UUIDs
const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_TXN_ID = "550e8400-e29b-41d4-a716-446655440001";

describe("Feedback Handlers", () => {
  let registeredHandlers: IpcHandlerRegistry;
  const mockEvent = {} as IpcMainInvokeEvent;

  beforeAll(() => {
    // Capture registered handlers
    registeredHandlers = createIpcHandlerRegistry();
    mockIpcHandle.mockImplementation((channel: string, handler: RegisteredIpcHandler) => {
      registeredHandlers.set(channel, handler);
    });

    // Register all handlers
    registerFeedbackHandlers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("feedback:submit", () => {
    const validFeedbackData = {
      transaction_id: TEST_TXN_ID,
      field_name: "property_address",
      original_value: "123 Main",
      corrected_value: "123 Main Street",
      feedback_type: "correction",
    };

    it("should submit feedback successfully", async () => {
      // Row the handler under test only reads `id` from; asserted to UserFeedback
      // rather than padded with user_id/created_at the assertions never look at.
      mockDatabaseService.saveFeedback.mockResolvedValue({
        id: "feedback-new",
        ...validFeedbackData,
      } as unknown as UserFeedback);

      const handler = registeredHandlers.get("feedback:submit");
      const result = await handler(mockEvent, TEST_USER_ID, validFeedbackData);

      expect(result.success).toBe(true);
      expect(result.feedbackId).toBe("feedback-new");
      expect(mockFeedbackLearningService.clearCache).toHaveBeenCalledWith(
        TEST_USER_ID,
        "correction",
      );
    });

    it("should handle feedback without field_name", async () => {
      const feedbackWithoutField = {
        transaction_id: TEST_TXN_ID,
        feedback_type: "general",
        comment: "Good extraction",
      };
      // See note above: only `id` is read back by the handler.
      mockDatabaseService.saveFeedback.mockResolvedValue({
        id: "feedback-new",
        ...feedbackWithoutField,
      } as unknown as UserFeedback);

      const handler = registeredHandlers.get("feedback:submit");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        feedbackWithoutField,
      );

      expect(result.success).toBe(true);
      expect(mockFeedbackLearningService.clearCache).toHaveBeenCalledWith(
        TEST_USER_ID,
        "general",
      );
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("feedback:submit");
      const result = await handler(mockEvent, "", validFeedbackData);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle invalid feedback data (non-object)", async () => {
      const handler = registeredHandlers.get("feedback:submit");
      const result = await handler(mockEvent, TEST_USER_ID, "not-an-object");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle null feedback data", async () => {
      const handler = registeredHandlers.get("feedback:submit");
      const result = await handler(mockEvent, TEST_USER_ID, null);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle database save failure", async () => {
      mockDatabaseService.saveFeedback.mockRejectedValue(
        new Error("Save failed"),
      );

      const handler = registeredHandlers.get("feedback:submit");
      const result = await handler(mockEvent, TEST_USER_ID, validFeedbackData);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Save failed");
    });

    it("should validate field_name length", async () => {
      const feedbackWithLongFieldName = {
        ...validFeedbackData,
        field_name: "a".repeat(150), // Too long
      };

      const handler = registeredHandlers.get("feedback:submit");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        feedbackWithLongFieldName,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });
  });

  describe("feedback:get-for-transaction", () => {
    it("should return feedback for transaction", async () => {
      // Rows are only counted by the assertion below, so they carry just the
      // columns the test cares about; asserted to UserFeedback[] at the boundary.
      const mockFeedback = [
        { id: "fb-1", field_name: "price", corrected_value: "$500,000" },
        {
          id: "fb-2",
          field_name: "closing_date",
          corrected_value: "2024-12-01",
        },
      ] as unknown as UserFeedback[];
      mockDatabaseService.getFeedbackByTransaction.mockResolvedValue(
        mockFeedback,
      );

      const handler = registeredHandlers.get("feedback:get-for-transaction");
      const result = await handler(mockEvent, TEST_TXN_ID);

      expect(result.success).toBe(true);
      expect(result.feedback).toHaveLength(2);
    });

    it("should return empty array when no feedback exists", async () => {
      mockDatabaseService.getFeedbackByTransaction.mockResolvedValue([]);

      const handler = registeredHandlers.get("feedback:get-for-transaction");
      const result = await handler(mockEvent, TEST_TXN_ID);

      expect(result.success).toBe(true);
      expect(result.feedback).toHaveLength(0);
    });

    it("should handle null transaction ID", async () => {
      const handler = registeredHandlers.get("feedback:get-for-transaction");
      const result = await handler(mockEvent, null);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
      expect(result.feedback).toEqual([]);
    });

    it("should handle invalid transaction ID", async () => {
      const handler = registeredHandlers.get("feedback:get-for-transaction");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle database error", async () => {
      mockDatabaseService.getFeedbackByTransaction.mockRejectedValue(
        new Error("Database error"),
      );

      const handler = registeredHandlers.get("feedback:get-for-transaction");
      const result = await handler(mockEvent, TEST_TXN_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Database error");
      expect(result.feedback).toEqual([]);
    });
  });

  describe("feedback:get-metrics", () => {
    it("should return extraction metrics", async () => {
      const handler = registeredHandlers.get("feedback:get-metrics");
      const result = await handler(mockEvent, TEST_USER_ID, "property_address");

      expect(result.success).toBe(true);
      expect(result.metrics).toEqual([]);
    });

    it("should work without field name filter", async () => {
      const handler = registeredHandlers.get("feedback:get-metrics");
      const result = await handler(mockEvent, TEST_USER_ID, null);

      expect(result.success).toBe(true);
      expect(result.metrics).toEqual([]);
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("feedback:get-metrics");
      const result = await handler(mockEvent, "", "property_address");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
      expect(result.metrics).toEqual([]);
    });

    it("should validate field name length", async () => {
      const handler = registeredHandlers.get("feedback:get-metrics");
      const result = await handler(mockEvent, TEST_USER_ID, "a".repeat(150));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });
  });

  describe("feedback:get-suggestion", () => {
    it("should return suggestion based on past patterns", async () => {
      mockFeedbackLearningService.generateSuggestion.mockResolvedValue({
        suggestedValue: "123 Main Street",
        confidence: 0.85,
        basedOnPatterns: 5,
      });

      const handler = registeredHandlers.get("feedback:get-suggestion");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        "property_address",
        "123 Main",
        0.5,
      );

      expect(result.success).toBe(true);
      expect(result.suggestion).toBeDefined();
      expect(result.suggestion.suggestedValue).toBe("123 Main Street");
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("feedback:get-suggestion");
      const result = await handler(
        mockEvent,
        "",
        "property_address",
        "123 Main",
        0.5,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle empty field name", async () => {
      const handler = registeredHandlers.get("feedback:get-suggestion");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        "",
        "123 Main",
        0.5,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle null extracted value", async () => {
      mockFeedbackLearningService.generateSuggestion.mockResolvedValue({
        suggestedValue: null,
        confidence: 0,
      });

      const handler = registeredHandlers.get("feedback:get-suggestion");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        "property_address",
        "",
        null,
      );

      expect(result.success).toBe(true);
    });

    it("should validate confidence range", async () => {
      const handler = registeredHandlers.get("feedback:get-suggestion");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        "property_address",
        "123 Main",
        1.5, // Invalid - should be 0-1
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
      // The validation message contains 'Confidence' (capitalized)
      expect(result.error.toLowerCase()).toContain("confidence");
    });

    it("should handle negative confidence", async () => {
      const handler = registeredHandlers.get("feedback:get-suggestion");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        "property_address",
        "123 Main",
        -0.5,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle suggestion generation failure", async () => {
      mockFeedbackLearningService.generateSuggestion.mockRejectedValue(
        new Error("Suggestion failed"),
      );

      const handler = registeredHandlers.get("feedback:get-suggestion");
      const result = await handler(
        mockEvent,
        TEST_USER_ID,
        "property_address",
        "123 Main",
        0.5,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Suggestion failed");
      expect(result.suggestion).toBeNull();
    });
  });

  describe("feedback:get-learning-stats", () => {
    it("should return learning statistics for field", async () => {
      mockFeedbackLearningService.getLearningStats.mockResolvedValue({
        totalCorrections: 10,
        patternMatches: 8,
        accuracy: 0.8,
        topPatterns: ["pattern1", "pattern2"],
      });

      const handler = registeredHandlers.get("feedback:get-learning-stats");
      const result = await handler(mockEvent, TEST_USER_ID, "property_address");

      expect(result.success).toBe(true);
      expect(result.stats).toBeDefined();
      expect(result.stats.totalCorrections).toBe(10);
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("feedback:get-learning-stats");
      const result = await handler(mockEvent, "", "property_address");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
      expect(result.stats).toBeNull();
    });

    it("should handle empty field name", async () => {
      const handler = registeredHandlers.get("feedback:get-learning-stats");
      const result = await handler(mockEvent, TEST_USER_ID, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should validate field name length", async () => {
      const handler = registeredHandlers.get("feedback:get-learning-stats");
      const result = await handler(mockEvent, TEST_USER_ID, "a".repeat(150));

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle stats retrieval failure", async () => {
      mockFeedbackLearningService.getLearningStats.mockRejectedValue(
        new Error("Stats retrieval failed"),
      );

      const handler = registeredHandlers.get("feedback:get-learning-stats");
      const result = await handler(mockEvent, TEST_USER_ID, "property_address");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Stats retrieval failed");
      expect(result.stats).toBeNull();
    });
  });

  // ============================================
  // LLM FEEDBACK HANDLERS TESTS
  // ============================================

  describe("feedback:record-transaction", () => {
    beforeEach(() => {
      mockRecordTransactionFeedback.mockReset();
    });

    it("should record transaction feedback successfully", async () => {
      mockRecordTransactionFeedback.mockResolvedValue("feedback-id");

      const feedback = {
        detectedTransactionId: TEST_TXN_ID,
        action: "confirm" as const,
        modelVersion: "gpt-4",
        promptVersion: "v1.0",
      };

      const handler = registeredHandlers.get("feedback:record-transaction");
      const result = await handler(mockEvent, TEST_USER_ID, feedback);

      expect(result.success).toBe(true);
      expect(mockRecordTransactionFeedback).toHaveBeenCalledWith(
        TEST_USER_ID,
        feedback,
      );
    });

    it("should record transaction rejection", async () => {
      mockRecordTransactionFeedback.mockResolvedValue("feedback-id");

      const feedback = {
        detectedTransactionId: TEST_TXN_ID,
        action: "reject" as const,
      };

      const handler = registeredHandlers.get("feedback:record-transaction");
      const result = await handler(mockEvent, TEST_USER_ID, feedback);

      expect(result.success).toBe(true);
      expect(mockRecordTransactionFeedback).toHaveBeenCalled();
    });

    it("should record transaction with corrections", async () => {
      mockRecordTransactionFeedback.mockResolvedValue("feedback-id");

      const feedback = {
        detectedTransactionId: TEST_TXN_ID,
        action: "confirm" as const,
        corrections: {
          propertyAddress: "456 Oak Ave",
          transactionType: "purchase",
        },
      };

      const handler = registeredHandlers.get("feedback:record-transaction");
      const result = await handler(mockEvent, TEST_USER_ID, feedback);

      expect(result.success).toBe(true);
    });

    it("should handle service error", async () => {
      mockRecordTransactionFeedback.mockRejectedValue(
        new Error("Service error"),
      );

      const feedback = {
        detectedTransactionId: TEST_TXN_ID,
        action: "confirm" as const,
      };

      const handler = registeredHandlers.get("feedback:record-transaction");
      const result = await handler(mockEvent, TEST_USER_ID, feedback);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Service error");
    });
  });

  describe("feedback:record-role", () => {
    beforeEach(() => {
      mockRecordRoleFeedback.mockReset();
    });

    it("should record role feedback successfully", async () => {
      mockRecordRoleFeedback.mockResolvedValue("feedback-id");

      const feedback = {
        transactionId: TEST_TXN_ID,
        contactId: "contact-123",
        originalRole: "Buyer",
        correctedRole: "Seller",
        modelVersion: "gpt-4",
      };

      const handler = registeredHandlers.get("feedback:record-role");
      const result = await handler(mockEvent, TEST_USER_ID, feedback);

      expect(result.success).toBe(true);
      expect(mockRecordRoleFeedback).toHaveBeenCalledWith(TEST_USER_ID, feedback);
    });

    it("should handle service error", async () => {
      mockRecordRoleFeedback.mockRejectedValue(new Error("Role error"));

      const feedback = {
        transactionId: TEST_TXN_ID,
        contactId: "contact-123",
        originalRole: "Buyer",
        correctedRole: "Seller",
      };

      const handler = registeredHandlers.get("feedback:record-role");
      const result = await handler(mockEvent, TEST_USER_ID, feedback);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Role error");
    });
  });

  describe("feedback:record-relevance", () => {
    beforeEach(() => {
      mockRecordCommunicationFeedback.mockReset();
    });

    it("should record relevance feedback for unlink", async () => {
      mockRecordCommunicationFeedback.mockResolvedValue("feedback-id");

      const feedback = {
        communicationId: "comm-123",
        wasRelevant: false,
        modelVersion: "gpt-4",
      };

      const handler = registeredHandlers.get("feedback:record-relevance");
      const result = await handler(mockEvent, TEST_USER_ID, feedback);

      expect(result.success).toBe(true);
      expect(mockRecordCommunicationFeedback).toHaveBeenCalledWith(
        TEST_USER_ID,
        feedback,
      );
    });

    it("should record relevance feedback for add", async () => {
      mockRecordCommunicationFeedback.mockResolvedValue("feedback-id");

      const feedback = {
        communicationId: "comm-123",
        wasRelevant: true,
        correctTransactionId: TEST_TXN_ID,
      };

      const handler = registeredHandlers.get("feedback:record-relevance");
      const result = await handler(mockEvent, TEST_USER_ID, feedback);

      expect(result.success).toBe(true);
    });

    it("should handle service error", async () => {
      mockRecordCommunicationFeedback.mockRejectedValue(
        new Error("Relevance error"),
      );

      const feedback = {
        communicationId: "comm-123",
        wasRelevant: false,
      };

      const handler = registeredHandlers.get("feedback:record-relevance");
      const result = await handler(mockEvent, TEST_USER_ID, feedback);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Relevance error");
    });
  });

  describe("feedback:get-stats", () => {
    beforeEach(() => {
      mockGetFeedbackStats.mockReset();
    });

    it("should return feedback stats successfully", async () => {
      const mockStats = {
        totalFeedback: 100,
        transactionApprovals: 70,
        transactionRejections: 15,
        transactionEdits: 15,
        roleCorrections: 10,
        communicationUnlinks: 5,
        communicationAdds: 3,
        approvalRate: 0.85,
        correctionRate: 0.15,
      };
      mockGetFeedbackStats.mockResolvedValue(mockStats);

      const handler = registeredHandlers.get("feedback:get-stats");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockStats);
      expect(mockGetFeedbackStats).toHaveBeenCalledWith(TEST_USER_ID);
    });

    it("should return empty stats for new user", async () => {
      const emptyStats = {
        totalFeedback: 0,
        transactionApprovals: 0,
        transactionRejections: 0,
        transactionEdits: 0,
        roleCorrections: 0,
        communicationUnlinks: 0,
        communicationAdds: 0,
        approvalRate: 0,
        correctionRate: 0,
      };
      mockGetFeedbackStats.mockResolvedValue(emptyStats);

      const handler = registeredHandlers.get("feedback:get-stats");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.data.totalFeedback).toBe(0);
    });

    it("should handle service error", async () => {
      mockGetFeedbackStats.mockRejectedValue(new Error("Stats error"));

      const handler = registeredHandlers.get("feedback:get-stats");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Stats error");
    });
  });
});
