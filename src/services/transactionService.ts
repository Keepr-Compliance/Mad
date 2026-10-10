/**
 * Transaction Service
 *
 * Service abstraction for transaction-related API calls.
 * Centralizes all window.api.transactions calls and provides type-safe wrappers.
 */

import type { Transaction } from "@/types";
import type { SubmissionScopeIpcResult } from "@electron/types/ipc/window-api-transactions";
import logger from '../utils/logger';
import type { EnsureMessagesCoverageResult, TextCoverageResult } from "../../electron/types/auditCoverage";
import type { TextPageCursor, TextThreadSummary, TextWindow } from "../../electron/types/textThreads";
import type { Communication } from "../../electron/types/models";

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
/** The preload API (a function so tests that swap `window.api` are honoured). */
const window_api = () => window.api;

/** BACKLOG-3884: in-flight `getTextCoverage` requests, by question. */
const textCoverageInFlight = new Map<string, Promise<TextCoverageResult | null>>();

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
  /**
   * BACKLOG-3663: per-source text coverage for one transaction (the Texts
   * tab). null when this build has no such IPC (never an error shown).
   */
  async getTextCoverage(transactionId: string, userId: string, chosenSource: string | null): Promise<TextCoverageResult | null> {
    const get = window.api?.transactions?.getTextCoverage;
    if (!get) return null;
    // BACKLOG-3884: the notice is mounted in two branches of the Texts tab and
    // remounts on every loading flip; one request per question in flight.
    const key = `${transactionId}|${userId}|${chosenSource ?? ""}`;
    const pending = textCoverageInFlight.get(key);
    if (pending) return pending;
    const request = Promise.resolve(get(transactionId, userId, chosenSource)).finally(() => {
      textCoverageInFlight.delete(key);
    });
    textCoverageInFlight.set(key, request);
    return request;
  },

  /** BACKLOG-3884: the Texts tab's conversation list (no texts). */
  async getTextThreads(transactionId: string, window: TextWindow | null): Promise<{ success: boolean; threads?: TextThreadSummary[]; error?: string }> {
    return window_api().transactions.getTextThreads(transactionId, window);
  },

  /** BACKLOG-3884: one page of one conversation, newest first. */
  async getTextThreadPage(
    transactionId: string,
    threadKeys: string[],
    window: TextWindow | null,
    cursor: TextPageCursor | null,
    limit: number,
  ): Promise<{ success: boolean; rows?: Communication[]; nextCursor?: TextPageCursor | null; error?: string }> {
    return window_api().transactions.getTextThreadPage(transactionId, threadKeys, window, cursor, limit);
  },

  /** BACKLOG-3884: the conversation a linked text belongs to. */
  async findTextThread(transactionId: string, messageId: string): Promise<string | null> {
    const r = await window_api().transactions.findTextThread(transactionId, messageId);
    return r.success ? (r.threadKey ?? null) : null;
  },

  /** BACKLOG-3884: remove whole conversations (every linked message, all history). */
  async unlinkTextThreads(transactionId: string, threadKeys: string[]): Promise<{ success: boolean; removed?: number; messageIds?: string[] | null; error?: string }> {
    return window_api().transactions.unlinkTextThreads(transactionId, threadKeys);
  },

  /** The Texts tab's "Update now" (Mac): a targeted messages import for an explicit start. */
  async ensureMessagesCoverage(userId: string, proposedStartISO: string | null, transactionId?: string): Promise<EnsureMessagesCoverageResult> {
    return window.api.transactions.ensureMessagesCoverage(userId, proposedStartISO, transactionId);
  },

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

  /**
   * BACKLOG-3683: what a submission with these (not yet saved) dates would
   * send. `candidate` must come from `confirmedDatesUpdate` — the same
   * payload the date save writes.
   */
  async getSubmissionScope(
    transactionId: string,
    candidate: { started_at: string | null; closed_at: string | null },
  ): Promise<SubmissionScopeIpcResult> {
    try {
      return await window.api.transactions.getSubmissionScope(transactionId, candidate);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  },
};

export default transactionService;
