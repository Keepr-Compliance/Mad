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
 * BACKLOG-2866 — THE GATE ITSELF NOW LIVES IN `src/services/exportReviewGate.ts`.
 * It was extracted, not copied, because three more routes reach an export
 * (the brokerage-only header Export button, the submit modal's Export offer,
 * and Bulk Export from the transactions list) and the founder's rule is that
 * the mechanism stopping a Complete is the SAME one stopping an Export. Four
 * copies of one rule is how they drift. `requestExport` below is that same gate
 * run without the license branch, sharing this hook's `blockedCount` so all
 * three details-screen routes raise ONE P3 dialog.
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
import { evaluateExportGate } from "@/services/exportReviewGate";
import type { ReviewStateResult } from "../../../../electron/types/ipc/window-api-transactions";

export type CompleteTarget = "export" | "submit";

export interface UseCompleteTransactionArgs {
  /** The deal being gated. Carried so a refusal can name it. */
  transactionId: string;
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
  /**
   * BACKLOG-2866 — the SAME gate, then straight to export with no license
   * branch. Backs the brokerage-only header Export button and the submit
   * modal's Export offer, neither of which consulted review state before.
   */
  requestExport: () => Promise<void>;
  /** P3 "Review" — straight to S2. */
  reviewFromGate: () => void;
  /** P3 "Cancel" — back to S1, nothing completed. */
  cancelGate: () => void;
  /** Exposed so the branch is assertable without driving modals. */
  resolveTarget: () => CompleteTarget;
}

export function useCompleteTransaction({
  transactionId,
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

  /**
   * Run THE gate. Returns true when an export/complete may proceed.
   *
   * `evaluateExportGate` owns the rule — the click-time re-read, the
   * unreadable-queue block, the `count > 0` block. Nothing is re-implemented
   * here; the reader passed in is this transaction's BOUND refresh, so the gate
   * and the header badge read on one path.
   */
  const runGate = useCallback(async (): Promise<boolean> => {
    const decision = await evaluateExportGate([{ transactionId }], () =>
      refreshReviewState(),
    );
    if (!decision.allowed) {
      setBlockedCount(decision.blocked[0].count);
      return false;
    }
    setBlockedCount(null);
    return true;
  }, [transactionId, refreshReviewState]);

  const requestComplete = useCallback(async () => {
    if (!(await runGate())) return;
    if (resolveTarget() === "submit") {
      openSubmit();
    } else {
      openExport();
    }
  }, [runGate, resolveTarget, openExport, openSubmit]);

  const requestExport = useCallback(async () => {
    if (!(await runGate())) return;
    openExport();
  }, [runGate, openExport]);

  const reviewFromGate = useCallback(() => {
    setBlockedCount(null);
    openNeedsReview();
  }, [openNeedsReview]);

  const cancelGate = useCallback(() => setBlockedCount(null), []);

  return {
    blockedCount,
    requestComplete,
    requestExport,
    reviewFromGate,
    cancelGate,
    resolveTarget,
  };
}
