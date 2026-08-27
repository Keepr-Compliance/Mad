// ============================================
// USER FEEDBACK IPC HANDLERS
// For user corrections and extraction accuracy tracking
// ============================================

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import databaseService from "../services/databaseService";
import logService from "../services/logService";
import type { UserFeedback } from "../types/models";
import {
  getFeedbackService,
  TransactionFeedback,
  RoleFeedback,
  CommunicationFeedback,
} from "../services/feedbackService";

// Services (still JS - to be migrated)
const feedbackLearningService =
  require("../services/feedbackLearningService").default;

// Import validation utilities
import {
  ValidationError,
  validateUserId,
  validateTransactionId,
  validateString,
  sanitizeObject,
} from "../utils/validation";

// Type definitions
interface FeedbackResponse {
  success: boolean;
  error?: string;
  feedbackId?: string;
  feedback?: unknown[];
  metrics?: unknown[];
  suggestion?: unknown;
  stats?: unknown;
  data?: unknown;
}

/**
 * Register all feedback-related IPC handlers
 */
export const registerFeedbackHandlers = (): void => {
  // Submit user feedback
  ipcMain.handle(
    "feedback:submit",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      feedbackData: unknown,
    ): Promise<FeedbackResponse> => {
      try {
        // Validate inputs
        const validatedUserId = validateUserId(userId);

        // Validate feedback data object
        if (!feedbackData || typeof feedbackData !== "object") {
          throw new ValidationError(
            "Feedback data must be an object",
            "feedbackData",
          );
        }

        const sanitizedData = sanitizeObject(feedbackData);

        // Validate required fields in feedback data
        if ((sanitizedData as any).feedback_type) {
          (sanitizedData as any).feedback_type = validateString(
            (sanitizedData as any).feedback_type,
            "feedback_type",
            {
              required: false,
              maxLength: 100,
            },
          );
        }

        // BACKLOG-2560: a `field_name` validation used to sit here. There is no
        // `field_name` column on `classification_feedback` (schema.sql:950) —
        // the only one in the schema belongs to `extracted_transaction_data`.
        // The value was validated, spread into `saveFeedback`, and dropped by
        // its explicit INSERT column list. Validating a phantom reads as
        // coverage while proving nothing about the row that lands.

        const feedback = await databaseService.saveFeedback({
          user_id: validatedUserId,
          ...(sanitizedData as any),
        } as Omit<UserFeedback, "id" | "created_at">);

        // Clear pattern cache for this feedback type so new patterns are detected
        if ((sanitizedData as any).feedback_type) {
          feedbackLearningService.clearCache(
            validatedUserId,
            (sanitizedData as any).feedback_type,
          );
        }

        return {
          success: true,
          feedbackId: feedback.id,
        };
      } catch (error) {
        logService.error("[Main] Submit feedback failed:", "Feedback", { error });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get feedback for a transaction
  ipcMain.handle(
    "feedback:get-for-transaction",
    async (
      event: IpcMainInvokeEvent,
      transactionId: string | null,
    ): Promise<FeedbackResponse> => {
      try {
        // Validate input
        if (!transactionId) {
          throw new ValidationError(
            "Transaction ID is required",
            "transactionId",
          );
        }
        const validatedTransactionId = validateTransactionId(transactionId)!;

        const feedback = await databaseService.getFeedbackByTransaction(
          validatedTransactionId,
        );

        return {
          success: true,
          feedback,
        };
      } catch (error) {
        logService.error("[Main] Get feedback failed:", "Feedback", { error });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
            feedback: [],
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          feedback: [],
        };
      }
    },
  );

  // Get extraction metrics
  ipcMain.handle(
    "feedback:get-metrics",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      fieldName: string | null = null,
    ): Promise<FeedbackResponse> => {
      try {
        // Validate inputs
        const _validatedUserId = validateUserId(userId);

        // Validate fieldName (optional)
        const _validatedFieldName = fieldName
          ? validateString(fieldName, "fieldName", {
              required: false,
              maxLength: 100,
            })
          : null;

        // TODO: Implement getExtractionMetrics in databaseService
        // For now, return empty metrics
        const metrics: Record<string, unknown>[] = [];

        return {
          success: true,
          metrics,
        };
      } catch (error) {
        logService.error("[Main] Get extraction metrics failed:", "Feedback", { error });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
            metrics: [],
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          metrics: [],
        };
      }
    },
  );

  // Get smart suggestion based on past patterns
  ipcMain.handle(
    "feedback:get-suggestion",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      fieldName: string,
      extractedValue: string,
      confidence: number | null,
    ): Promise<FeedbackResponse> => {
      try {
        // Validate inputs
        const validatedUserId = validateUserId(userId);

        const validatedFieldName = validateString(fieldName, "fieldName", {
          required: true,
          maxLength: 100,
        });

        const validatedExtractedValue = validateString(
          extractedValue,
          "extractedValue",
          {
            required: false,
            maxLength: 1000,
          },
        );

        // Validate confidence (should be a number between 0 and 1)
        let validatedConfidence = confidence;
        if (confidence !== null && confidence !== undefined) {
          const confNum = Number(confidence);
          if (isNaN(confNum) || confNum < 0 || confNum > 1) {
            throw new ValidationError(
              "Confidence must be a number between 0 and 1",
              "confidence",
            );
          }
          validatedConfidence = confNum;
        }

        const suggestion = await feedbackLearningService.generateSuggestion(
          validatedUserId,
          validatedFieldName,
          validatedExtractedValue,
          validatedConfidence,
        );

        return {
          success: true,
          suggestion,
        };
      } catch (error) {
        logService.error("[Main] Get suggestion failed:", "Feedback", { error });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
            suggestion: null,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          suggestion: null,
        };
      }
    },
  );

  // Get learning statistics for a field
  ipcMain.handle(
    "feedback:get-learning-stats",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      fieldName: string,
    ): Promise<FeedbackResponse> => {
      try {
        // Validate inputs
        const validatedUserId = validateUserId(userId);

        const validatedFieldName = validateString(fieldName, "fieldName", {
          required: true,
          maxLength: 100,
        });

        const stats = await feedbackLearningService.getLearningStats(
          validatedUserId,
          validatedFieldName,
        );

        return {
          success: true,
          stats,
        };
      } catch (error) {
        logService.error("[Main] Get learning stats failed:", "Feedback", { error });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
            stats: null,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          stats: null,
        };
      }
    },
  );

  // ============================================
  // LLM FEEDBACK HANDLERS
  // For recording user feedback on LLM-detected transactions
  // ============================================

  // Record transaction feedback (approve/reject/edit)
  ipcMain.handle(
    "feedback:record-transaction",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
      feedback: TransactionFeedback,
    ): Promise<FeedbackResponse> => {
      try {
        const feedbackService = getFeedbackService();
        await feedbackService.recordTransactionFeedback(userId, feedback);
        return { success: true };
      } catch (error) {
        logService.error("[Feedback] Error recording transaction feedback:", "Feedback", { error });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Record role feedback (contact role corrections)
  ipcMain.handle(
    "feedback:record-role",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
      feedback: RoleFeedback,
    ): Promise<FeedbackResponse> => {
      try {
        const feedbackService = getFeedbackService();
        await feedbackService.recordRoleFeedback(userId, feedback);
        return { success: true };
      } catch (error) {
        logService.error("[Feedback] Error recording role feedback:", "Feedback", { error });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Record communication relevance feedback
  ipcMain.handle(
    "feedback:record-relevance",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
      feedback: CommunicationFeedback,
    ): Promise<FeedbackResponse> => {
      try {
        const feedbackService = getFeedbackService();
        await feedbackService.recordCommunicationFeedback(userId, feedback);
        return { success: true };
      } catch (error) {
        logService.error("[Feedback] Error recording relevance feedback:", "Feedback", { error });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get aggregated feedback statistics
  ipcMain.handle(
    "feedback:get-stats",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<FeedbackResponse> => {
      try {
        const feedbackService = getFeedbackService();
        const stats = await feedbackService.getFeedbackStats(userId);
        return { success: true, data: stats };
      } catch (error) {
        logService.error("[Feedback] Error getting stats:", "Feedback", { error });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
};
