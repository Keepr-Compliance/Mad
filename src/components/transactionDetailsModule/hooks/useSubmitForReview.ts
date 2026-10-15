/**
 * useSubmitForReview Hook
 *
 * Manages submission state and progress for the Submit for Review flow.
 * Part of BACKLOG-391: Submit for Review UI.
 *
 * BACKLOG-3403: Submit first asks the main process which attachments cannot
 * be sent (after downloading any that only needed downloading). If any, the
 * modal shows them with Go back / Continue anyway, and the submit carries the
 * agent's confirmation. BACKLOG-3398: Cancel calls the main process, which
 * stops the submission and removes what it wrote; the outcome is `cancelled`,
 * not an error.
 */
import { useState, useCallback, useEffect, useRef } from "react";
import type {
  ChecklistLinkGapItem,
  ChecklistsNotSentReason,
  NotIncludedItem,
  SubmitProgress,
} from "../components/modals/SubmitForReviewModal";
import { checklistService } from "../../../services/checklistService";

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
  /**
   * BACKLOG-3681: on a SUCCESSFUL submission, each attachment that was left
   * out and why. Empty when there is nothing to say.
   */
  notIncluded: NotIncludedItem[];
  /** BACKLOG-3403: the pre-flight is running (downloading and checking files). */
  isCheckingFiles: boolean;
  /**
   * BACKLOG-3403: attachments that cannot be sent, waiting for the agent's
   * Go back / Continue anyway. `null` when there is no question pending.
   */
  preflightItems: NotIncludedItem[] | null;
  /** BACKLOG-3403: the list changed after the agent confirmed it. */
  preflightChanged: boolean;
  /**
   * BACKLOG-3764: checklist evidence this submission would not send, shown
   * with the pre-flight. Empty when there is none.
   */
  preflightLinkGaps: ChecklistLinkGapItem[];
  /**
   * BACKLOG-3764: on a SUCCESSFUL submission, checklist evidence was dropped
   * that the pre-flight did not list.
   */
  checklistLinksNotAttached: boolean;
  /**
   * BACKLOG-3764: "Include it" for a group outside the audit dates — stores
   * the answer, then checks again.
   */
  includeLinkGap: (gap: ChecklistLinkGapItem) => Promise<void>;
  /** BACKLOG-3398: the agent cancelled and nothing was sent. */
  cancelled: boolean;
  /** BACKLOG-3398: a cancel was requested and is being carried out. */
  isCancelling: boolean;
  submit: () => Promise<void>;
  /** BACKLOG-3403: Continue anyway — send without the listed attachments. */
  confirmPreflight: () => Promise<void>;
  /** BACKLOG-3403: Go back — nothing is sent. */
  dismissPreflight: () => void;
  /**
   * BACKLOG-3398: cancel the running submission. Resolves false when the main
   * process refused (the final step had begun).
   */
  cancel: () => Promise<boolean>;
  reset: () => void;
}

function toItems(value: unknown): NotIncludedItem[] {
  return Array.isArray(value) ? (value as NotIncludedItem[]) : [];
}

function toGaps(value: unknown): ChecklistLinkGapItem[] {
  return Array.isArray(value) ? (value as ChecklistLinkGapItem[]) : [];
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
  const [notIncluded, setNotIncluded] = useState<NotIncludedItem[]>([]);
  const [isCheckingFiles, setIsCheckingFiles] = useState(false);
  const [preflightItems, setPreflightItems] = useState<NotIncludedItem[] | null>(null);
  const [preflightChanged, setPreflightChanged] = useState(false);
  const [preflightLinkGaps, setPreflightLinkGaps] = useState<ChecklistLinkGapItem[]>([]);
  const [checklistLinksNotAttached, setChecklistLinksNotAttached] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  // Track cleanup function for progress listener
  const cleanupRef = useRef<(() => void) | null>(null);
  /** Bumped by reset(): a pre-flight answer for an abandoned run is ignored. */
  const runRef = useRef(0);

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

  const fail = useCallback(
    (errorMessage: string) => {
      setError(errorMessage);
      setProgress({
        stage: "failed",
        stageProgress: 0,
        overallProgress: 0,
        currentItem: errorMessage,
      });
      onError?.(errorMessage);
    },
    [onError]
  );

  /** Send, with the keys the agent confirmed (none when nothing was listed). */
  const send = useCallback(
    async (acceptedExclusionKeys: string[]) => {
      setIsSubmitting(true);
      setError(null);
      setChecklistsNotSent(null);
      setChecklistLinksNotAttached(false);
      setNotIncluded([]);
      setCancelled(false);
      setIsCancelling(false);
      setPreflightItems(null);
      setPreflightChanged(false);
      setPreflightLinkGaps([]);
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

        const options = { acceptedExclusionKeys };
        const result = isResubmit
          ? await api.resubmit(transactionId, options)
          : await api.submit(transactionId, options);

        if (result.success) {
          setChecklistsNotSent(result.checklistsNotSent ?? null);
          setChecklistLinksNotAttached(result.checklistLinksNotAttached === true);
          setNotIncluded(toItems(result.notIncluded));
          setProgress({
            stage: "complete",
            stageProgress: 100,
            overallProgress: 100,
            currentItem: "Submission complete!",
          });

          if (result.submissionId && onSuccess) {
            onSuccess(result.submissionId);
          }
        } else if (result.cancelled) {
          // BACKLOG-3398: a user action, not a failure — no error toast.
          setCancelled(true);
          setProgress(null);
        } else if (result.preflightChanged) {
          // BACKLOG-3403: nothing was sent; ask again with the new list.
          setProgress(null);
          setPreflightItems(toItems(result.notIncluded));
          setPreflightLinkGaps(toGaps(result.checklistLinkGaps));
          setPreflightChanged(true);
        } else {
          fail(result.error || "Submission failed");
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : "An unexpected error occurred");
      } finally {
        setIsSubmitting(false);
        setIsCancelling(false);
      }
    },
    [transactionId, isResubmit, onSuccess, fail]
  );

  const submit = useCallback(async () => {
    if (!transactionId) {
      setError("Transaction ID is required");
      return;
    }
    const run = ++runRef.current;
    setError(null);
    setCancelled(false);
    setPreflightItems(null);
    setPreflightChanged(false);
    setPreflightLinkGaps([]);
    setIsCheckingFiles(true);
    let items: NotIncludedItem[] = [];
    let gaps: ChecklistLinkGapItem[] = [];
    try {
      const api = window.api?.transactions;
      if (!api?.submitPreflight) {
        throw new Error("Transaction API not available");
      }
      const answer = await api.submitPreflight(transactionId);
      if (run !== runRef.current) return;
      if (!answer.success) {
        setIsCheckingFiles(false);
        fail(answer.error || "Could not check the attachments");
        return;
      }
      items = toItems(answer.notIncluded);
      gaps = toGaps(answer.checklistLinkGaps);
    } catch (err) {
      if (run !== runRef.current) return;
      setIsCheckingFiles(false);
      fail(err instanceof Error ? err.message : "Could not check the attachments");
      return;
    }
    setIsCheckingFiles(false);
    if (items.length > 0 || gaps.length > 0) {
      setPreflightItems(items);
      setPreflightLinkGaps(gaps);
      return;
    }
    await send([]);
  }, [transactionId, send, fail]);

  const confirmPreflight = useCallback(async () => {
    const keys = [
      ...(preflightItems ?? []).map((item) => item.key),
      ...preflightLinkGaps.map((gap) => gap.key),
    ];
    await send(keys);
  }, [preflightItems, preflightLinkGaps, send]);

  const dismissPreflight = useCallback(() => {
    setPreflightItems(null);
    setPreflightChanged(false);
    setPreflightLinkGaps([]);
  }, []);

  const includeLinkGap = useCallback(
    async (gap: ChecklistLinkGapItem) => {
      const result = await checklistService.includeLinkOutsideDates(transactionId, gap.linkId);
      if (!result.success) {
        fail(result.error || "Could not include it");
        return;
      }
      // Check again: the list changes once the answer is stored.
      await submit();
    },
    [transactionId, fail, submit]
  );

  const cancel = useCallback(async (): Promise<boolean> => {
    const api = window.api?.transactions;
    if (!api?.cancelSubmit) return false;
    setIsCancelling(true);
    try {
      const answer = await api.cancelSubmit(transactionId);
      if (!answer.cancelled) {
        setIsCancelling(false);
        return false;
      }
      return true;
    } catch {
      setIsCancelling(false);
      return false;
    }
  }, [transactionId]);

  const reset = useCallback(() => {
    runRef.current += 1;
    setIsSubmitting(false);
    setProgress(null);
    setError(null);
    setChecklistsNotSent(null);
    setNotIncluded([]);
    setIsCheckingFiles(false);
    setPreflightItems(null);
    setPreflightChanged(false);
    setPreflightLinkGaps([]);
    setChecklistLinksNotAttached(false);
    setCancelled(false);
    setIsCancelling(false);
  }, []);

  return {
    isSubmitting,
    progress,
    error,
    checklistsNotSent,
    notIncluded,
    isCheckingFiles,
    preflightItems,
    preflightChanged,
    preflightLinkGaps,
    checklistLinksNotAttached,
    includeLinkGap,
    cancelled,
    isCancelling,
    submit,
    confirmPreflight,
    dismissPreflight,
    cancel,
    reset,
  };
}

export default useSubmitForReview;
