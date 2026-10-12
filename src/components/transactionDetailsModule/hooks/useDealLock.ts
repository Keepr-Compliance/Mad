/**
 * BACKLOG-3910 (slice b): the deal screen's view of the locked-deal state.
 * One status check (`dealLockReason`, mirrored from the main process), so the
 * notice and every Sync button agree with what the main process enforces.
 */
import { useMemo } from "react";
import { dealLockReason, type DealLockReason } from "../../../utils/dealLock";

export interface DealLockState {
  locked: boolean;
  reason: DealLockReason | null;
}

export function useDealLock(
  transaction: { submission_status?: string | null } | null | undefined,
): DealLockState {
  const status = transaction?.submission_status ?? null;
  return useMemo(() => {
    const reason = dealLockReason(status);
    return { locked: reason !== null, reason };
  }, [status]);
}
