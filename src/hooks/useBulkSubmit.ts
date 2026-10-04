/**
 * Custom hook for managing bulk transaction submission
 * Handles submitting multiple transactions for broker review sequentially.
 * Part of BACKLOG-392: Bulk Submit UI
 */
import { useState, useCallback, useRef, useEffect } from "react";
import type { Transaction, SubmissionStatus } from "@/types";

// ============================================
// TYPES
// ============================================

export interface BulkSubmitProgress {
  /** Current transaction being submitted */
  current: number;
  /** Total transactions to submit */
  total: number;
  /** Current transaction's progress */
  transactionProgress: {
    stage: "preparing" | "attachments" | "transaction" | "messages" | "complete" | "failed";
    stageProgress: number;
    overallProgress: number;
    currentItem?: string;
  } | null;
  /** Status of each transaction */
  results: BulkSubmitResult[];
}

export interface BulkSubmitResult {
  transactionId: string;
  propertyAddress: string;
  success: boolean;
  error?: string;
  submissionId?: string;
}

export interface TransactionForSubmit {
  id: string;
  property_address: string;
  submission_status?: SubmissionStatus;
  message_count: number;
  attachment_count: number;
}

export interface UseBulkSubmitResult {
  /** Whether submission is in progress */
  isSubmitting: boolean;
  /** Current progress */
  progress: BulkSubmitProgress | null;
  /** Start bulk submission */
  startBulkSubmit: (transactions: TransactionForSubmit[]) => Promise<BulkSubmitResult[]>;
  /** Cancel remaining submissions */
  cancelSubmission: () => void;
  /** Reset state */
  reset: () => void;
}

// ============================================
// HOOK IMPLEMENTATION
// ============================================

/**
 * Hook for managing bulk transaction submission
 * Submits transactions sequentially for reliability and clean cancellation
 */
export function useBulkSubmit(): UseBulkSubmitResult {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState<BulkSubmitProgress | null>(null);

  // Track if submission should be cancelled
  const cancelledRef = useRef(false);
  // Track cleanup function for progress listener
  const progressCleanupRef = useRef<(() => void) | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (progressCleanupRef.current) {
        progressCleanupRef.current();
      }
    };
  }, []);

  /**
   * Submit a single transaction
   */
  const submitSingle = useCallback(async (
    transaction: TransactionForSubmit,
    index: number,
    total: number
  ): Promise<BulkSubmitResult> => {
    // Set up progress listener
    if (progressCleanupRef.current) {
      progressCleanupRef.current();
    }

    progressCleanupRef.current = window.api.transactions.onSubmitProgress((progressData) => {
      setProgress(prev => prev ? {
        ...prev,
        transactionProgress: {
          stage: progressData.stage as "preparing" | "attachments" | "transaction" | "messages" | "complete" | "failed",
          stageProgress: progressData.stageProgress,
          overallProgress: progressData.overallProgress,
          currentItem: progressData.currentItem,
        }
      } : null);
    });

    try {
      // Determine if this is a resubmit
      const isResubmit = transaction.submission_status === "needs_changes" ||
                         transaction.submission_status === "rejected";

      const result = isResubmit
        ? await window.api.transactions.resubmit(transaction.id)
        : await window.api.transactions.submit(transaction.id);

      if (result.success) {
        return {
          transactionId: transaction.id,
          propertyAddress: transaction.property_address,
          success: true,
          submissionId: result.submissionId ?? undefined,
        };
      } else {
        return {
          transactionId: transaction.id,
          propertyAddress: transaction.property_address,
          success: false,
          error: result.error || "Unknown error",
        };
      }
    } catch (error) {
      return {
        transactionId: transaction.id,
        propertyAddress: transaction.property_address,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      // Clean up progress listener
      if (progressCleanupRef.current) {
        progressCleanupRef.current();
        progressCleanupRef.current = null;
      }
    }
  }, []);

  /**
   * Start bulk submission of transactions
   */
  const startBulkSubmit = useCallback(async (
    transactions: TransactionForSubmit[]
  ): Promise<BulkSubmitResult[]> => {
    if (transactions.length === 0) {
      return [];
    }

    cancelledRef.current = false;
    setIsSubmitting(true);
    setProgress({
      current: 0,
      total: transactions.length,
      transactionProgress: null,
      results: [],
    });

    const results: BulkSubmitResult[] = [];

    for (let i = 0; i < transactions.length; i++) {
      // Check if cancelled
      if (cancelledRef.current) {
        // Mark remaining as cancelled
        for (let j = i; j < transactions.length; j++) {
          results.push({
            transactionId: transactions[j].id,
            propertyAddress: transactions[j].property_address,
            success: false,
            error: "Cancelled",
          });
        }
        break;
      }

      // Update progress
      setProgress(prev => prev ? {
        ...prev,
        current: i + 1,
        transactionProgress: {
          stage: "preparing",
          stageProgress: 0,
          overallProgress: 0,
          currentItem: `Starting submission for ${transactions[i].property_address}...`,
        },
      } : null);

      // Submit transaction
      const result = await submitSingle(transactions[i], i, transactions.length);
      results.push(result);

      // Update progress with result
      setProgress(prev => prev ? {
        ...prev,
        results: [...prev.results, result],
        transactionProgress: result.success
          ? { stage: "complete", stageProgress: 100, overallProgress: 100, currentItem: "Complete" }
          : { stage: "failed", stageProgress: 0, overallProgress: 0, currentItem: result.error },
      } : null);
    }

    setIsSubmitting(false);
    return results;
  }, [submitSingle]);

  /**
   * Cancel remaining submissions
   */
  const cancelSubmission = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  /**
   * Reset state
   */
  const reset = useCallback(() => {
    setIsSubmitting(false);
    setProgress(null);
    cancelledRef.current = false;
  }, []);

  return {
    isSubmitting,
    progress,
    startBulkSubmit,
    cancelSubmission,
    reset,
  };
}

export default useBulkSubmit;
