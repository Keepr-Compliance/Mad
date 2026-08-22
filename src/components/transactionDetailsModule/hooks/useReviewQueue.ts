/**
 * useReviewQueue (BACKLOG-2791)
 *
 * The renderer's ONLY access to review state. It wraps `review:get-state`,
 * which is backed by reviewStateService.getReviewState — the single source of
 * truth that unions the pending queue with the legacy BACKLOG-2319
 * address_missing population (founder ruling 2026-08-22).
 *
 * Consequences that are deliberate:
 *  - the badge, the two tabs' needs-review sections, the combined Needs Review
 *    screen, and the Complete gate all read THIS hook, so they cannot disagree;
 *  - `count` is always `items.length`, never a separately-fetched number;
 *  - `refresh()` returns the fresh state so a caller (the Complete gate) can act
 *    on a value it just read, rather than on a render-stale prop.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewItemDto, ReviewStateResult } from "../../../../electron/types/ipc/window-api-transactions";

export interface UseReviewQueueResult {
  items: ReviewItemDto[];
  count: number;
  isLoading: boolean;
  /** Items added by the most recent sync — drives the P2 popup (0 = silent). */
  lastAdded: number;
  /** Re-read the queue. Returns the state it read, for read-then-act callers. */
  refresh: () => Promise<ReviewStateResult>;
  /** Run discovery. `reason` picks the scan axis. */
  runSync: (
    reason: "open" | "contact-change",
    contactIds?: string[],
  ) => Promise<number>;
  approve: (itemIds: string[]) => Promise<void>;
  reject: (itemIds: string[]) => Promise<void>;
  clearLastAdded: () => void;
}

const EMPTY: ReviewStateResult = { items: [], count: 0 };

export function useReviewQueue(transactionId: string | null): UseReviewQueueResult {
  const [state, setState] = useState<ReviewStateResult>(EMPTY);
  const [isLoading, setIsLoading] = useState(false);
  const [lastAdded, setLastAdded] = useState(0);

  // Guards a late response from a previous transaction overwriting this one's
  // state after a fast switch between deals.
  const activeId = useRef<string | null>(transactionId);
  useEffect(() => {
    activeId.current = transactionId;
  }, [transactionId]);

  const refresh = useCallback(async (): Promise<ReviewStateResult> => {
    if (!transactionId) return EMPTY;
    setIsLoading(true);
    try {
      const next = await window.api.transactions.getReviewState(transactionId);
      const safe: ReviewStateResult = next ?? EMPTY;
      if (activeId.current === transactionId) setState(safe);
      return safe;
    } catch {
      // A discovery failure must never blank the queue the user is looking at.
      return state;
    } finally {
      setIsLoading(false);
    }
  }, [transactionId, state]);

  const runSync = useCallback(
    async (reason: "open" | "contact-change", contactIds?: string[]): Promise<number> => {
      if (!transactionId) return 0;
      try {
        const result = await window.api.transactions.syncReviewQueue(
          transactionId,
          reason,
          contactIds,
        );
        const added = result?.added ?? 0;
        if (activeId.current === transactionId) setLastAdded(added);
        await refresh();
        return added;
      } catch {
        return 0;
      }
    },
    [transactionId, refresh],
  );

  const approve = useCallback(
    async (itemIds: string[]): Promise<void> => {
      if (itemIds.length === 0) return;
      await window.api.transactions.approveReviewItems(itemIds);
      await refresh();
    },
    [refresh],
  );

  const reject = useCallback(
    async (itemIds: string[]): Promise<void> => {
      if (itemIds.length === 0) return;
      await window.api.transactions.rejectReviewItems(itemIds);
      await refresh();
    },
    [refresh],
  );

  const clearLastAdded = useCallback(() => setLastAdded(0), []);

  return {
    items: state.items,
    count: state.count,
    isLoading,
    lastAdded,
    refresh,
    runSync,
    approve,
    reject,
    clearLastAdded,
  };
}
