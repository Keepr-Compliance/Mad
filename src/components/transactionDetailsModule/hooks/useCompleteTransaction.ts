/**
 * useCompleteTransaction — Flow B (BACKLOG-2792)
 *
 * The whole of the Complete button's behaviour, in one place, because it is a
 * multi-step flow (gate → license branch → modal) and those belong in a
 * dedicated hook rather than inline in TransactionDetails.
 *
 * The flow, exactly as the founder specified it:
 *
 *   click Complete
 *     └─ queue empty?
 *          no  → P3 "N communications need to be reviewed" [Review] [Cancel]
 *                 There is NO bypass. Completion only proceeds when the queue is
 *                 empty AND Complete is clicked again.
 *          yes → license branch
 *                 individual (no broker org) → the existing export flow (S3)
 *                 broker-org member          → the submit flow (S4), whose
 *                                              confirmation offers Export → S3
 *
 * TWO THINGS THAT ARE LOAD-BEARING:
 *
 * 1. THE GATE RE-READS THE COUNT AT CLICK TIME. It calls refresh() and acts on
 *    the returned value, never on a render-stale prop. A prop-based gate opens
 *    the export modal for a queue that filled a moment ago, and no test that
 *    renders with a fixed prop would ever catch it.
 *
 * 2. THE LICENSE BRANCH FAILS CLOSED, TO EXPORT. It uses useLicense()
 *    (`canSubmit && !!organizationId`), NOT useFeatureGate().isAllowed, which
 *    returns `?? true` while entitlements are loading. Failing open there would
 *    route an INDIVIDUAL whose feature rows had not loaded into the broker
 *    submit flow — taking away the export that is their only completion path.
 */
import { useCallback, useState } from "react";
import { useLicense } from "@/contexts/LicenseContext";
import type { ReviewStateResult } from "../../../../electron/types/ipc/window-api-transactions";

export type CompleteTarget = "export" | "submit";

export interface UseCompleteTransactionArgs {
  /** Re-reads the ONE review state. Must hit the service, not a cached prop. */
  refreshReviewState: () => Promise<ReviewStateResult>;
  openExport: () => void;
  openSubmit: () => void;
  openNeedsReview: () => void;
}

export interface UseCompleteTransactionResult {
  /**
   * Non-null while P3 is up; carries the count the gate actually read.
   * `-1` means the queue could not be READ — the gate blocks rather than
   * assuming empty.
   */
  blockedCount: number | null;
  requestComplete: () => Promise<void>;
  /** P3 "Review" — straight to S2. */
  reviewFromGate: () => void;
  /** P3 "Cancel" — back to S1, nothing completed. */
  cancelGate: () => void;
  /** Exposed so the branch is assertable without driving modals. */
  resolveTarget: () => CompleteTarget;
}

export function useCompleteTransaction({
  refreshReviewState,
  openExport,
  openSubmit,
  openNeedsReview,
}: UseCompleteTransactionArgs): UseCompleteTransactionResult {
  const { canSubmit, organizationId } = useLicense();
  const [blockedCount, setBlockedCount] = useState<number | null>(null);

  // Broker-org member → submit. Anything else, including "still loading" and
  // "no organization", → export. Fails closed.
  const resolveTarget = useCallback(
    (): CompleteTarget => (canSubmit && !!organizationId ? "submit" : "export"),
    [canSubmit, organizationId],
  );

  const requestComplete = useCallback(async () => {
    // Re-read at click time — see note 1 above.
    //
    // A THROW here means "cannot confirm the queue is empty", which is not the
    // same as "the queue is empty". Completing on an unverified queue is the
    // failure this gate exists to prevent, so an unreadable queue blocks. The
    // hook re-throws only on a COLD failure (nothing ever loaded); once a good
    // read exists it falls back to that rather than nagging.
    let state: ReviewStateResult;
    try {
      state = await refreshReviewState();
    } catch {
      setBlockedCount(-1);
      return;
    }
    if (state.count > 0) {
      setBlockedCount(state.count);
      return;
    }
    setBlockedCount(null);
    if (resolveTarget() === "submit") {
      openSubmit();
    } else {
      openExport();
    }
  }, [refreshReviewState, resolveTarget, openExport, openSubmit]);

  const reviewFromGate = useCallback(() => {
    setBlockedCount(null);
    openNeedsReview();
  }, [openNeedsReview]);

  const cancelGate = useCallback(() => setBlockedCount(null), []);

  return { blockedCount, requestComplete, reviewFromGate, cancelGate, resolveTarget };
}
