/**
 * Integration Tests for Feedback Service
 *
 * Tests complete feedback flows including:
 * - Feedback recording (transaction/role/communication)
 * - Stats calculation and aggregation
 * - Accuracy tracking by provider/prompt version
 * - Systematic error detection
 * - Pattern identification across multiple feedback items
 *
 * These tests verify the integration between FeedbackService
 * and FeedbackLearningService using mocked database layer.
 */

import {
  FeedbackService,
  getFeedbackService,
  resetFeedbackService,
  TransactionFeedback,
  RoleFeedback,
  CommunicationFeedback,
} from "../feedbackService";
import feedbackLearningService from "../feedbackLearningService";
import databaseService from "../databaseService";
import type { UserFeedback } from "../../types";

// Mock the database service
jest.mock("../databaseService");

const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;

/**
 * `TransactionFeedback.corrections` declares only propertyAddress /
 * transactionType / add|removeCommunications, but rejection REASONS travel
 * through the same field: feedbackService JSON-stringifies the whole
 * `corrections` object into classification_feedback.corrected_value, and
 * feedbackLearningService.getLLMFeedbackAnalysis then mines that text for
 * systematic-error patterns — which is exactly what the tests below assert.
 * This alias lets the fixtures keep the real `{ reason }` payload while the
 * production declaration stays untouched.
 */
type RejectionCorrections = TransactionFeedback["corrections"];

describe("Feedback Integration Tests", () => {
  const TEST_USER_ID = "test-user-integration-001";
  const TEST_USER_ID_2 = "test-user-integration-002";
  let feedbackService: FeedbackService;

  // In-memory storage for simulating database behavior
  let feedbackStorage: UserFeedback[];

  beforeEach(() => {
    jest.clearAllMocks();
    resetFeedbackService();
    feedbackService = getFeedbackService();
    feedbackLearningService.clearCache(TEST_USER_ID);
    feedbackLearningService.clearCache(TEST_USER_ID_2);

    // Reset in-memory storage
    feedbackStorage = [];

    // Mock saveFeedback to store in memory
    mockDatabaseService.saveFeedback.mockImplementation(async (data) => {
      const feedback: UserFeedback = {
        id: `fb-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        user_id: data.user_id,
        transaction_id: data.transaction_id,
        message_id: data.message_id,
        contact_id: data.contact_id,
        feedback_type: data.feedback_type,
        original_value: data.original_value,
        corrected_value: data.corrected_value,
        created_at: new Date().toISOString(),
      };
      feedbackStorage.push(feedback);
      return feedback;
    });

    // Mock getFeedbackByField to retrieve from memory (queries by feedback_type)
    mockDatabaseService.getFeedbackByField.mockImplementation(
      async (userId, fieldName, limit = 100) => {
        return feedbackStorage
          .filter((f) => f.user_id === userId && f.feedback_type === fieldName)
          .slice(0, limit);
      }
    );
  });

  // ============================================
  // FEEDBACK RECORDING FLOW TESTS
  // ============================================

  describe("Feedback Recording Flow", () => {
    it("should record transaction approval and persist all fields", async () => {
      const feedback: TransactionFeedback = {
        detectedTransactionId: "tx-001",
        action: "confirm",
        modelVersion: "openai:gpt-4o-mini",
        promptVersion: "v1.0.0",
      };

      await feedbackService.recordTransactionFeedback(TEST_USER_ID, feedback);

      expect(mockDatabaseService.saveFeedback).toHaveBeenCalledTimes(1);
      expect(feedbackStorage).toHaveLength(1);

      const saved = feedbackStorage[0];
      expect(saved.user_id).toBe(TEST_USER_ID);
      expect(saved.transaction_id).toBe("tx-001");
      expect(saved.feedback_type).toBe("transaction_link");

      // Verify metadata in original_value
      const metadata = JSON.parse(saved.original_value || "{}");
      expect(metadata.action).toBe("transaction_approved");
      expect(metadata.category).toBe("llm_transaction_action");
      expect(metadata.dbFeedbackType).toBe("confirmation");
      expect(metadata.modelVersion).toBe("openai:gpt-4o-mini");
      expect(metadata.promptVersion).toBe("v1.0.0");
    });

    it("should record transaction rejection with reason", async () => {
      const feedback: TransactionFeedback = {
        detectedTransactionId: "tx-002",
        action: "reject",
        modelVersion: "anthropic:claude-3-haiku",
      };

      await feedbackService.recordTransactionFeedback(TEST_USER_ID, feedback);

      expect(feedbackStorage).toHaveLength(1);

      const saved = feedbackStorage[0];
      expect(saved.feedback_type).toBe("transaction_link");

      const metadata = JSON.parse(saved.original_value || "{}");
      expect(metadata.action).toBe("transaction_rejected");
      expect(metadata.dbFeedbackType).toBe("rejection");
    });

    it("should record transaction approval with corrections as edit", async () => {
      const feedback: TransactionFeedback = {
        detectedTransactionId: "tx-003",
        action: "confirm",
        corrections: {
          propertyAddress: "123 Main St, Updated",
          transactionType: "sale",
        },
        modelVersion: "gpt-4",
      };

      await feedbackService.recordTransactionFeedback(TEST_USER_ID, feedback);

      const saved = feedbackStorage[0];
      expect(saved.feedback_type).toBe("transaction_link");

      const metadata = JSON.parse(saved.original_value || "{}");
      expect(metadata.action).toBe("transaction_edited");
      expect(metadata.dbFeedbackType).toBe("correction");

      const corrections = JSON.parse(saved.corrected_value || "{}");
      expect(corrections.propertyAddress).toBe("123 Main St, Updated");
      expect(corrections.transactionType).toBe("sale");
    });

    it("should record role correction with evidence", async () => {
      const feedback: RoleFeedback = {
        transactionId: "tx-001",
        contactId: "contact-001",
        originalRole: "buyer_agent",
        correctedRole: "seller_agent",
        modelVersion: "gpt-4-turbo",
        promptVersion: "role-v2.0",
      };

      await feedbackService.recordRoleFeedback(TEST_USER_ID, feedback);

      expect(feedbackStorage).toHaveLength(1);

      const saved = feedbackStorage[0];
      expect(saved.feedback_type).toBe("contact_role");
      expect(saved.contact_id).toBe("contact-001");
      expect(saved.corrected_value).toBe("seller_agent");

      const metadata = JSON.parse(saved.original_value || "{}");
      expect(metadata.action).toBe("contact_role_corrected");
      expect(metadata.category).toBe("llm_contact_role");
      expect(metadata.contactId).toBe("contact-001");
      expect(metadata.originalRole).toBe("buyer_agent");
      expect(metadata.modelVersion).toBe("gpt-4-turbo");
    });

    it("should record communication unlink feedback", async () => {
      const feedback: CommunicationFeedback = {
        communicationId: "comm-001",
        wasRelevant: false,
        modelVersion: "claude-3-sonnet",
      };

      await feedbackService.recordCommunicationFeedback(TEST_USER_ID, feedback);

      const saved = feedbackStorage[0];
      expect(saved.message_id).toBe("comm-001");
      expect(saved.feedback_type).toBe("message_relevance");

      const metadata = JSON.parse(saved.original_value || "{}");
      expect(metadata.action).toBe("communication_unlinked");
      expect(metadata.wasRelevant).toBe(false);
      expect(metadata.dbFeedbackType).toBe("rejection");
    });

    it("should record communication add feedback with correct transaction", async () => {
      const feedback: CommunicationFeedback = {
        communicationId: "comm-002",
        wasRelevant: true,
        correctTransactionId: "tx-correct",
        modelVersion: "gpt-4",
      };

      await feedbackService.recordCommunicationFeedback(TEST_USER_ID, feedback);

      const saved = feedbackStorage[0];
      expect(saved.message_id).toBe("comm-002");
      expect(saved.feedback_type).toBe("message_relevance");
      expect(saved.corrected_value).toBe("tx-correct");

      const metadata = JSON.parse(saved.original_value || "{}");
      expect(metadata.action).toBe("communication_added");
      expect(metadata.wasRelevant).toBe(true);
      expect(metadata.dbFeedbackType).toBe("confirmation");
    });
  });

  // ============================================
  // STATS CALCULATION TESTS
  // ============================================

  describe("Stats Calculation", () => {
    it("should calculate stats correctly after recording multiple feedback items", async () => {
      // Record various feedback types
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "confirm",
        modelVersion: "gpt-4",
      });

      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx2",
        action: "confirm",
        modelVersion: "gpt-4",
      });

      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx3",
        action: "reject",
        modelVersion: "gpt-4",
      });

      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx4",
        action: "confirm",
        corrections: { propertyAddress: "456 Oak Ave" },
        modelVersion: "gpt-4",
      });

      await feedbackService.recordRoleFeedback(TEST_USER_ID, {
        transactionId: "tx1",
        contactId: "c1",
        originalRole: "buyer",
        correctedRole: "seller",
      });

      await feedbackService.recordCommunicationFeedback(TEST_USER_ID, {
        communicationId: "comm1",
        wasRelevant: false,
      });

      await feedbackService.recordCommunicationFeedback(TEST_USER_ID, {
        communicationId: "comm2",
        wasRelevant: true,
        correctTransactionId: "tx1",
      });

      const stats = await feedbackService.getFeedbackStats(TEST_USER_ID);

      expect(stats.totalFeedback).toBe(7);
      expect(stats.transactionApprovals).toBe(2);
      expect(stats.transactionRejections).toBe(1);
      expect(stats.transactionEdits).toBe(1);
      expect(stats.roleCorrections).toBe(1);
      expect(stats.communicationUnlinks).toBe(1);
      expect(stats.communicationAdds).toBe(1);

      // Approval rate: (2 approvals + 1 edit) / 4 total = 0.75
      expect(stats.approvalRate).toBe(0.75);
      // Correction rate: 1 edit / 4 total = 0.25
      expect(stats.correctionRate).toBe(0.25);
    });

    it("should return zero stats for user with no feedback", async () => {
      const stats = await feedbackService.getFeedbackStats("new-user");

      expect(stats.totalFeedback).toBe(0);
      expect(stats.transactionApprovals).toBe(0);
      expect(stats.transactionRejections).toBe(0);
      expect(stats.transactionEdits).toBe(0);
      expect(stats.roleCorrections).toBe(0);
      expect(stats.communicationUnlinks).toBe(0);
      expect(stats.communicationAdds).toBe(0);
      expect(stats.approvalRate).toBe(0);
      expect(stats.correctionRate).toBe(0);
    });

    it("should isolate stats between different users", async () => {
      // User 1 feedback
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "confirm",
      });
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx2",
        action: "confirm",
      });

      // User 2 feedback
      await feedbackService.recordTransactionFeedback(TEST_USER_ID_2, {
        detectedTransactionId: "tx3",
        action: "reject",
      });

      const stats1 = await feedbackService.getFeedbackStats(TEST_USER_ID);
      const stats2 = await feedbackService.getFeedbackStats(TEST_USER_ID_2);

      expect(stats1.totalFeedback).toBe(2);
      expect(stats1.transactionApprovals).toBe(2);
      expect(stats1.transactionRejections).toBe(0);

      expect(stats2.totalFeedback).toBe(1);
      expect(stats2.transactionApprovals).toBe(0);
      expect(stats2.transactionRejections).toBe(1);
    });
  });

  // ============================================
  // ACCURACY BY PROVIDER TESTS
  // ============================================

  describe("Accuracy by Provider", () => {
    it("should calculate accuracy separately for different providers", async () => {
      // OpenAI model - 2 approvals
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "confirm",
        modelVersion: "openai:gpt-4o-mini",
      });
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx2",
        action: "confirm",
        modelVersion: "openai:gpt-4o-mini",
      });

      // Anthropic model - 1 rejection
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx3",
        action: "reject",
        modelVersion: "anthropic:claude-3-haiku",
      });

      const analysis =
        await feedbackLearningService.getLLMFeedbackAnalysis(TEST_USER_ID);

      expect(analysis.accuracyByProvider["openai:gpt-4o-mini"]).toBeDefined();
      expect(analysis.accuracyByProvider["openai:gpt-4o-mini"].approvals).toBe(
        2
      );
      expect(analysis.accuracyByProvider["openai:gpt-4o-mini"].rejections).toBe(
        0
      );
      expect(analysis.accuracyByProvider["openai:gpt-4o-mini"].rate).toBe(1);

      expect(
        analysis.accuracyByProvider["anthropic:claude-3-haiku"]
      ).toBeDefined();
      expect(
        analysis.accuracyByProvider["anthropic:claude-3-haiku"].approvals
      ).toBe(0);
      expect(
        analysis.accuracyByProvider["anthropic:claude-3-haiku"].rejections
      ).toBe(1);
      expect(analysis.accuracyByProvider["anthropic:claude-3-haiku"].rate).toBe(
        0
      );
    });

    it("should count transaction_edited as approval for accuracy", async () => {
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "confirm",
        corrections: { propertyAddress: "123 Main St" },
        modelVersion: "gpt-4-turbo",
      });

      const analysis =
        await feedbackLearningService.getLLMFeedbackAnalysis(TEST_USER_ID);

      expect(analysis.accuracyByProvider["gpt-4-turbo"].approvals).toBe(1);
      expect(analysis.accuracyByProvider["gpt-4-turbo"].rate).toBe(1);
    });

    it("should track accuracy by prompt version", async () => {
      // v1.0 prompt - mixed results
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "confirm",
        modelVersion: "gpt-4",
        promptVersion: "v1.0",
      });
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx2",
        action: "reject",
        modelVersion: "gpt-4",
        promptVersion: "v1.0",
      });

      // v2.0 prompt - all approved
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx3",
        action: "confirm",
        modelVersion: "gpt-4",
        promptVersion: "v2.0",
      });
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx4",
        action: "confirm",
        modelVersion: "gpt-4",
        promptVersion: "v2.0",
      });

      const analysis =
        await feedbackLearningService.getLLMFeedbackAnalysis(TEST_USER_ID);

      expect(analysis.accuracyByPromptVersion["v1.0"].rate).toBe(0.5);
      expect(analysis.accuracyByPromptVersion["v2.0"].rate).toBe(1);
    });
  });

  // ============================================
  // SYSTEMATIC ERROR DETECTION TESTS
  // ============================================

  describe("Systematic Error Detection", () => {
    it("should identify systematic errors from repeated rejections", async () => {
      // Record multiple rejections with same reason
      for (let i = 0; i < 5; i++) {
        await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
          detectedTransactionId: `tx-${i}`,
          action: "reject",
          corrections: { reason: "Escrow officer emails misclassified" } as unknown as RejectionCorrections,
        });
      }

      const analysis =
        await feedbackLearningService.getLLMFeedbackAnalysis(TEST_USER_ID);

      expect(analysis.systematicErrors.length).toBeGreaterThan(0);
      expect(analysis.systematicErrors[0].pattern).toContain("Escrow");
      expect(analysis.systematicErrors[0].frequency).toBe(5);
    });

    it("should sort systematic errors by frequency descending", async () => {
      // 3 rejections with reason A
      for (let i = 0; i < 3; i++) {
        await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
          detectedTransactionId: `tx-a-${i}`,
          action: "reject",
          corrections: { reason: "Wrong property type detected" } as unknown as RejectionCorrections,
        });
      }

      // 5 rejections with reason B
      for (let i = 0; i < 5; i++) {
        await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
          detectedTransactionId: `tx-b-${i}`,
          action: "reject",
          corrections: { reason: "Not a real estate transaction" } as unknown as RejectionCorrections,
        });
      }

      const analysis =
        await feedbackLearningService.getLLMFeedbackAnalysis(TEST_USER_ID);

      expect(analysis.systematicErrors.length).toBe(2);
      expect(analysis.systematicErrors[0].frequency).toBe(5);
      expect(analysis.systematicErrors[0].pattern).toContain(
        "Not a real estate"
      );
      expect(analysis.systematicErrors[1].frequency).toBe(3);
    });

    it("should return empty array when no rejections exist", async () => {
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "confirm",
      });

      const analysis =
        await feedbackLearningService.getLLMFeedbackAnalysis(TEST_USER_ID);

      expect(analysis.systematicErrors).toEqual([]);
    });

    it("should not count single occurrence as systematic error", async () => {
      // Single rejection - should not be counted as systematic
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "reject",
        corrections: { reason: "One-off error" } as unknown as RejectionCorrections,
      });

      const analysis =
        await feedbackLearningService.getLLMFeedbackAnalysis(TEST_USER_ID);

      // Single occurrence patterns are filtered out
      expect(analysis.systematicErrors).toEqual([]);
    });
  });

  // ============================================
  // FULL FLOW INTEGRATION TESTS
  // ============================================

  describe("Complete Feedback Flow Integration", () => {
    it("should track full feedback lifecycle from record to analysis", async () => {
      // Step 1: Record various feedback
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "confirm",
        modelVersion: "gpt-4",
        promptVersion: "v1.0",
      });

      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx2",
        action: "confirm",
        corrections: { propertyAddress: "Updated Address" },
        modelVersion: "gpt-4",
        promptVersion: "v1.0",
      });

      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx3",
        action: "reject",
        corrections: { reason: "Duplicate detection" } as unknown as RejectionCorrections,
        modelVersion: "claude-3",
        promptVersion: "v1.0",
      });

      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx4",
        action: "reject",
        corrections: { reason: "Duplicate detection" } as unknown as RejectionCorrections,
        modelVersion: "claude-3",
        promptVersion: "v1.0",
      });

      await feedbackService.recordRoleFeedback(TEST_USER_ID, {
        transactionId: "tx1",
        contactId: "c1",
        originalRole: "buyer",
        correctedRole: "seller",
        modelVersion: "gpt-4",
      });

      // Step 2: Get basic stats
      const stats = await feedbackService.getFeedbackStats(TEST_USER_ID);
      expect(stats.totalFeedback).toBe(5);
      expect(stats.transactionApprovals).toBe(1);
      expect(stats.transactionEdits).toBe(1);
      expect(stats.transactionRejections).toBe(2);
      expect(stats.roleCorrections).toBe(1);
      expect(stats.approvalRate).toBe(0.5); // (1 + 1) / 4

      // Step 3: Get full LLM analysis
      const analysis =
        await feedbackLearningService.getLLMFeedbackAnalysis(TEST_USER_ID);

      // Total LLM feedback (only transaction actions, not role)
      expect(analysis.totalLLMFeedback).toBe(4);

      // Overall accuracy: 2 approved / 4 total = 0.5
      expect(analysis.overallAccuracy).toBe(0.5);

      // GPT-4 accuracy: 2/2 = 1.0 (1 approve + 1 edit)
      expect(analysis.accuracyByProvider["gpt-4"].rate).toBe(1);

      // Claude-3 accuracy: 0/2 = 0.0 (2 rejects)
      expect(analysis.accuracyByProvider["claude-3"].rate).toBe(0);

      // Systematic error: Duplicate detection (2 occurrences)
      expect(analysis.systematicErrors.length).toBe(1);
      expect(analysis.systematicErrors[0].pattern).toContain("Duplicate");
      expect(analysis.systematicErrors[0].frequency).toBe(2);
    });

    it("should handle feedback persistence across service reset", async () => {
      // Record feedback
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "confirm",
      });

      // Reset service (simulates app restart, but storage persists)
      resetFeedbackService();
      feedbackService = getFeedbackService();

      // Stats should still be available (from database)
      const stats = await feedbackService.getFeedbackStats(TEST_USER_ID);
      expect(stats.totalFeedback).toBe(1);
      expect(stats.transactionApprovals).toBe(1);
    });

    it("should properly categorize all feedback types", async () => {
      // All transaction actions
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "confirm",
      });
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx2",
        action: "reject",
      });
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx3",
        action: "confirm",
        corrections: { propertyAddress: "test" },
      });
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx4",
        action: "merge",
      });

      // Role correction
      await feedbackService.recordRoleFeedback(TEST_USER_ID, {
        transactionId: "tx1",
        contactId: "c1",
        originalRole: "a",
        correctedRole: "b",
      });

      // Communication feedback
      await feedbackService.recordCommunicationFeedback(TEST_USER_ID, {
        communicationId: "comm1",
        wasRelevant: true,
        correctTransactionId: "tx1",
      });
      await feedbackService.recordCommunicationFeedback(TEST_USER_ID, {
        communicationId: "comm2",
        wasRelevant: false,
      });

      const stats = await feedbackService.getFeedbackStats(TEST_USER_ID);

      // Verify all categories
      expect(stats.transactionApprovals).toBe(1);
      expect(stats.transactionRejections).toBe(2); // reject + merge
      expect(stats.transactionEdits).toBe(1);
      expect(stats.roleCorrections).toBe(1);
      expect(stats.communicationAdds).toBe(1);
      expect(stats.communicationUnlinks).toBe(1);

      expect(stats.totalFeedback).toBe(7);
    });
  });

  // ============================================
  // EDGE CASE TESTS
  // ============================================

  describe("Edge Cases", () => {
    it("should handle feedback without model/prompt version", async () => {
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "confirm",
        // No modelVersion or promptVersion
      });

      const analysis =
        await feedbackLearningService.getLLMFeedbackAnalysis(TEST_USER_ID);

      // Should be tracked under "unknown"
      expect(analysis.accuracyByProvider["unknown"]).toBeDefined();
      expect(analysis.accuracyByProvider["unknown"].approvals).toBe(1);
    });

    it("should handle empty corrections object", async () => {
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "confirm",
        corrections: {}, // Empty object - should be treated as approval, not edit
      });

      const stats = await feedbackService.getFeedbackStats(TEST_USER_ID);
      expect(stats.transactionApprovals).toBe(1);
      expect(stats.transactionEdits).toBe(0);
    });

    it("should handle high volume of feedback", async () => {
      // Record 50 feedback items
      for (let i = 0; i < 50; i++) {
        await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
          detectedTransactionId: `tx-${i}`,
          action: i % 3 === 0 ? "reject" : "confirm",
          modelVersion: `model-${i % 5}`,
        });
      }

      const stats = await feedbackService.getFeedbackStats(TEST_USER_ID);
      expect(stats.totalFeedback).toBe(50);

      const analysis =
        await feedbackLearningService.getLLMFeedbackAnalysis(TEST_USER_ID);
      expect(analysis.totalLLMFeedback).toBe(50);

      // Should have 5 different providers
      expect(Object.keys(analysis.accuracyByProvider).length).toBe(5);
    });

    it("should handle special characters in correction values", async () => {
      await feedbackService.recordTransactionFeedback(TEST_USER_ID, {
        detectedTransactionId: "tx1",
        action: "confirm",
        corrections: {
          propertyAddress: '123 Main St, Apt #5 "The Lofts"',
        },
      });

      const stats = await feedbackService.getFeedbackStats(TEST_USER_ID);
      expect(stats.transactionEdits).toBe(1);

      // Verify the value was stored correctly
      const saved = feedbackStorage[0];
      const corrections = JSON.parse(saved.corrected_value || "{}");
      expect(corrections.propertyAddress).toContain("The Lofts");
    });
  });
});
