/**
 * Transaction Service
 *
 * Service abstraction for transaction-related API calls.
 * Centralizes all window.api.transactions calls and provides type-safe wrappers.
 */

import type { Transaction } from "@/types";
import logger from '../utils/logger';

/**
 * Valid detection status values
 */
export type DetectionStatus = "pending" | "confirmed" | "rejected";

/**
 * Valid transaction status values
 */
export type TransactionStatus = "pending" | "active" | "closed" | "rejected";

/**
 * Transaction update payload with detection fields
 */
export interface TransactionUpdatePayload {
  detection_status?: DetectionStatus;
  status?: TransactionStatus;
  reviewed_at?: string;
  rejection_reason?: string | null;
  [key: string]: unknown;
}

/**
 * Feedback action type
 */
export type FeedbackAction = "confirm" | "reject";

/**
 * Transaction feedback payload
 */
export interface TransactionFeedbackPayload {
  detectedTransactionId: string;
  action: FeedbackAction;
  corrections?: Record<string, unknown>;
}

/**
 * Result type for API operations
 */
export interface ApiResult<T = void> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * Validates that a string is a valid ISO 8601 date
 */
export function isValidISODate(dateString: string): boolean {
  if (!dateString || typeof dateString !== "string") {
    return false;
  }
  const date = new Date(dateString);
  return !isNaN(date.getTime()) && dateString.includes("T");
}

/**
 * Creates a valid ISO timestamp for the current moment
 */
export function createTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Validates detection status value
 */
export function isValidDetectionStatus(status: unknown): status is DetectionStatus {
  return status === "pending" || status === "confirmed" || status === "rejected";
}

/**
 * Validates transaction status value
 */
export function isValidTransactionStatus(status: unknown): status is TransactionStatus {
  return status === "pending" || status === "active" || status === "closed" || status === "rejected";
}

/**
 * Transaction Service class
 * Provides a clean abstraction over window.api.transactions
 */
export const transactionService = {
  /**
   * Update a transaction with validated data
   */
  async update(
    transactionId: string,
    updates: TransactionUpdatePayload
  ): Promise<ApiResult> {
    try {
      // Validate detection_status if provided
      if (updates.detection_status !== undefined) {
        if (!isValidDetectionStatus(updates.detection_status)) {
          return {
            success: false,
            error: `Invalid detection status: ${updates.detection_status}`,
          };
        }
      }

      // Validate status if provided
      if (updates.status !== undefined) {
        if (!isValidTransactionStatus(updates.status)) {
          return {
            success: false,
            error: `Invalid status: ${updates.status}`,
          };
        }
      }

      // Validate reviewed_at if provided
      if (updates.reviewed_at !== undefined && updates.reviewed_at !== null) {
        if (!isValidISODate(updates.reviewed_at)) {
          return {
            success: false,
            error: `Invalid ISO date format for reviewed_at: ${updates.reviewed_at}`,
          };
        }
      }

      const result = await window.api.transactions.update(transactionId, updates);
      return { success: result.success, error: result.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  },

  /**
   * Record transaction feedback for learning
   */
  async recordFeedback(
    userId: string,
    payload: TransactionFeedbackPayload
  ): Promise<ApiResult> {
    try {
      if (!userId) {
        return { success: false, error: "User ID is required for feedback recording" };
      }

      await window.api.feedback.recordTransaction(userId, payload);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to record feedback:", message);
      // Don't fail the whole operation if feedback fails
      return { success: true }; // Silently succeed - feedback is not critical
    }
  },

  /**
   * Approve a pending transaction
   * Sets detection_status to "confirmed" and status to "active"
   */
  async approve(transactionId: string, userId: string): Promise<ApiResult> {
    if (!userId) {
      return { success: false, error: "User ID is required to approve a transaction" };
    }

    const updateResult = await this.update(transactionId, {
      detection_status: "confirmed",
      status: "active",
      reviewed_at: createTimestamp(),
    });

    if (!updateResult.success) {
      return updateResult;
    }

    // Record feedback (non-blocking)
    await this.recordFeedback(userId, {
      detectedTransactionId: transactionId,
      action: "confirm",
    });

    return { success: true };
  },

  /**
   * Reject a transaction
   * Sets detection_status to "rejected" with optional reason
   */
  async reject(
    transactionId: string,
    userId: string | undefined,
    reason?: string
  ): Promise<ApiResult> {
    const updateResult = await this.update(transactionId, {
      detection_status: "rejected",
      rejection_reason: reason || undefined,
      reviewed_at: createTimestamp(),
    });

    if (!updateResult.success) {
      return updateResult;
    }

    // Record feedback if userId available (non-blocking)
    if (userId) {
      await this.recordFeedback(userId, {
        detectedTransactionId: transactionId,
        action: "reject",
        corrections: reason ? { reason } : undefined,
      });
    }

    return { success: true };
  },

  /**
   * Restore a rejected transaction to active
   * Sets detection_status to "confirmed" and clears rejection_reason
   */
  async restore(transactionId: string, userId: string | undefined): Promise<ApiResult> {
    const updateResult = await this.update(transactionId, {
      detection_status: "confirmed",
      status: "active",
      reviewed_at: createTimestamp(),
      rejection_reason: null,
    });

    if (!updateResult.success) {
      return updateResult;
    }

    // Record feedback if userId available (non-blocking)
    if (userId) {
      await this.recordFeedback(userId, {
        detectedTransactionId: transactionId,
        action: "confirm",
        corrections: { reason: "Restored from rejection" },
      });
    }

    return { success: true };
  },

  /**
   * Get all transactions for a user
   */
  async getAll(userId: string): Promise<ApiResult<Transaction[]>> {
    try {
      const result = await window.api.transactions.getAll(userId);
      if (result.success) {
        return { success: true, data: result.transactions || [] };
      }
      return { success: false, error: result.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  },

  /**
   * Get transaction details
   */
  async getDetails(transactionId: string): Promise<ApiResult<Transaction>> {
    try {
      const result = await window.api.transactions.getDetails(transactionId);
      if (result.success) {
        return { success: true, data: result.transaction as Transaction };
      }
      return { success: false, error: result.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  },

  /**
   * Delete a transaction
   */
  async delete(transactionId: string): Promise<ApiResult> {
    try {
      await window.api.transactions.delete(transactionId);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  },

  /**
   * BACKLOG-3366: hide one text from this transaction's export. The text stays
   * linked and visible (gray). `data.hidden` is read back by the main process.
   */
  async hideTextFromExport(
    transactionId: string,
    messageId: string,
  ): Promise<ApiResult<{ hidden: boolean }>> {
    try {
      const result = await window.api.transactions.hideTextFromExport(transactionId, messageId);
      if (result.success) {
        return { success: true, data: { hidden: !!result.hidden } };
      }
      return { success: false, error: result.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  },

  /**
   * BACKLOG-3366: put a hidden text back into this transaction's export. Never
   * gated. `data.hidden` is read back by the main process.
   */
  async unhideTextFromExport(
    transactionId: string,
    messageId: string,
  ): Promise<ApiResult<{ hidden: boolean }>> {
    try {
      const result = await window.api.transactions.unhideTextFromExport(transactionId, messageId);
      if (result.success) {
        return { success: true, data: { hidden: !!result.hidden } };
      }
      return { success: false, error: result.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  },
};

export default transactionService;
