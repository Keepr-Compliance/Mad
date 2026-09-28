/**
 * useSubmitForReview Hook
 *
 * Manages submission state and progress for the Submit for Review flow.
 * Part of BACKLOG-391: Submit for Review UI.
 */
import { useState, useCallback, useEffect, useRef } from "react";
import type {
  ChecklistsNotSentReason,
  SubmitProgress,
} from "../components/modals/SubmitForReviewModal";

interface UseSubmitForReviewOptions {
  transactionId: string;
  isResubmit?: boolean;
  onSuccess?: (submissionId: string) => void;
  onError?: (error: string) => void;
}

interface UseSubmitForReviewReturn {
  isSubmitting: boolean;
  progress: SubmitProgress | null;
  error: string | null;
  /**
   * BACKLOG-3600: why a SUCCESSFUL submission's checklists did not reach the
   * broker, as the main process reported it. `null` when there is nothing to
   * say — including after any failed submit.
   */
  checklistsNotSent: ChecklistsNotSentReason | null;
  submit: () => Promise<void>;
  reset: () => void;
}

export function useSubmitForReview({
  transactionId,
  isResubmit = false,
  onSuccess,
  onError,
}: UseSubmitForReviewOptions): UseSubmitForReviewReturn {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState<SubmitProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checklistsNotSent, setChecklistsNotSent] =
    useState<ChecklistsNotSentReason | null>(null);

  // Track cleanup function for progress listener
  const cleanupRef = useRef<(() => void) | null>(null);

  // Set up progress listener
  useEffect(() => {
    if (!window.api?.transactions?.onSubmitProgress) {
      return;
    }

    cleanupRef.current = window.api.transactions.onSubmitProgress(
      (progressData: { stage: string; stageProgress: number; overallProgress: number; currentItem?: string }) => {
        setProgress(progressData as SubmitProgress);
      }
    );

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, []);

  const submit = useCallback(async () => {
    if (!transactionId) {
      setError("Transaction ID is required");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setChecklistsNotSent(null);
    setProgress({
      stage: "preparing",
      stageProgress: 0,
      overallProgress: 0,
      currentItem: "Starting submission...",
    });

    try {
      const api = window.api?.transactions;
      if (!api) {
        throw new Error("Transaction API not available");
      }

      const result = isResubmit
        ? await api.resubmit(transactionId)
        : await api.submit(transactionId);

      if (result.success) {
        setChecklistsNotSent(result.checklistsNotSent ?? null);
        setProgress({
          stage: "complete",
          stageProgress: 100,
          overallProgress: 100,
          currentItem: "Submission complete!",
        });

        if (result.submissionId && onSuccess) {
          onSuccess(result.submissionId);
        }
      } else {
        const errorMessage = result.error || "Submission failed";
        setError(errorMessage);
        setProgress({
          stage: "failed",
          stageProgress: 0,
          overallProgress: 0,
          currentItem: errorMessage,
        });

        if (onError) {
          onError(errorMessage);
        }
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "An unexpected error occurred";
      setError(errorMessage);
      setProgress({
        stage: "failed",
        stageProgress: 0,
        overallProgress: 0,
        currentItem: errorMessage,
      });

      if (onError) {
        onError(errorMessage);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [transactionId, isResubmit, onSuccess, onError]);

  const reset = useCallback(() => {
    setIsSubmitting(false);
    setProgress(null);
    setError(null);
    setChecklistsNotSent(null);
  }, []);

  return {
    isSubmitting,
    progress,
    error,
    checklistsNotSent,
    submit,
    reset,
  };
}

export default useSubmitForReview;
