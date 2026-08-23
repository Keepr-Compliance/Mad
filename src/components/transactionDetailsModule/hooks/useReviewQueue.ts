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
import { logger } from "../../../utils/logger";
import type { ReviewItemDto, ReviewStateResult } from "../../../../electron/types/ipc/window-api-transactions";

export interface UseReviewQueueResult {
  items: ReviewItemDto[];
  count: number;
  isLoading: boolean;
  /** Items added by the most recent sync — drives the popup (0 = silent). */
  lastAdded: number;
  /** Items LINKED outright by the most recent sync — the popup's "L". */
  lastLinked: number;
  /**
   * The popup's N — what the most recent sync FOUND, linked plus queued.
   *
   * The contract fires the popup "only when this run found something", with
   * N = L + R. Both gates used to read R alone, so a sweep that linked six
   * emails and queued none was silent — and the dialog's own R=0 copy shape
   * (pinned by reviewFounderFeedback-2791) was unreachable in the app. Exposed
   * as one number so the render gate reads it rather than re-deriving the rule.
   */
  lastFound: number;
  /**
   * Increments on every review-state change.
   *
   * Fed into the Removed sections' refreshKey so they re-fetch too: a trash on a
   * needs-review card writes an ignored_communications row (the item genuinely
   * IS removed), but "Show removed" fetches on mount and never heard about it,
   * so the founder saw the email vanish into nothing.
   */
  changeToken: number;
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
  const [lastLinked, setLastLinked] = useState(0);
  const [changeToken, setChangeToken] = useState(0);

  // Guards a late response from a previous transaction overwriting this one's
  // state after a fast switch between deals.
  // Latest state without making `refresh` depend on it (a state-dependent
  // refresh changes identity every render and re-subscribes the event listener).
  const stateRef = useRef<ReviewStateResult>(EMPTY);
  const hasLoadedRef = useRef(false);

  const activeId = useRef<string | null>(transactionId);
  useEffect(() => {
    activeId.current = transactionId;
    // Switching deals resets the announcement — a count from the previous deal
    // must never be shown against this one.
    setLastAdded(0);
    setLastLinked(0);
    setState(EMPTY);
    stateRef.current = EMPTY;
    hasLoadedRef.current = false;
  }, [transactionId]);

  const refresh = useCallback(async (): Promise<ReviewStateResult> => {
    if (!transactionId) return EMPTY;
    setIsLoading(true);
    try {
      const next = await window.api.transactions.getReviewState(transactionId);
      const safe: ReviewStateResult = next ?? EMPTY;
      stateRef.current = safe;
      hasLoadedRef.current = true;
      setChangeToken((t) => t + 1);
      if (activeId.current === transactionId) setState(safe);
      return safe;
    } catch (error) {
      // A read failure must never blank the queue the user is looking at, and
      // must never be reported as an EMPTY queue.
      //
      // The Complete gate calls this and completes when count is 0. Returning
      // the initial empty state on a COLD failure — the very first read, before
      // anything has loaded — would have told the gate "nothing to review" while
      // the database queue was full, and completion would proceed. So the throw
      // is re-thrown when there is no known-good state to fall back on; the gate
      // treats that as "cannot confirm" and refuses rather than sails through.
      logger.error("Review state read failed", error);
      if (!hasLoadedRef.current) throw error;
      return stateRef.current;
    } finally {
      setIsLoading(false);
    }
  }, [transactionId]);

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
        // MAX, not overwrite — and this is load-bearing under StrictMode.
        //
        // StrictMode is ON (src/main.tsx), so the on-open effect fires TWICE per
        // mount. The first sweep reports what it queued and advances the
        // watermark; the second correctly reports 0, because nothing is new any
        // more. Assigning the latest value therefore reset lastAdded to 0 before
        // paint and the popup never appeared — in dev only, which is exactly
        // where the founder does his QA, so the test plan's step 1 would have
        // read as a failure.
        //
        // Per the repo's StrictMode rule this is a VALUE COMPARISON, not a
        // skip-first-run guard: both invocations run, and the state keeps the
        // larger. Dismissal clears it, and switching deals resets it, so a stale
        // number cannot survive either boundary.
        if (activeId.current === transactionId) {
          setLastAdded((prev) => Math.max(prev, added));
          setLastLinked((prev) => Math.max(prev, result?.linked ?? 0));
        }
        await refresh();
        return added;
      } catch (error) {
        // BACKLOG-2791: LOG, never swallow silently. A thrown sweep — exactly the
        // contact_phones.phone_number class of bug the real-schema fixture caught
        // — is otherwise indistinguishable from "nothing new was found", which is
        // the single most reassuring thing this UI can say.
        logger.error("Review queue sync failed", error);
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

  const clearLastAdded = useCallback(() => {
    setLastAdded(0);
    setLastLinked(0);
  }, []);

  /**
   * Subscribe to main-process queue changes.
   *
   * This is what makes a T2 (contact-save) sync visible. The main process runs
   * the sweep — on contacts:update, on batchUpdateContacts, on deal creation —
   * and without this the renderer never learned: items landed in the database
   * and the screen showed nothing, with a stale badge, until the next open.
   *
   * `added` is taken from the EVENT rather than re-derived, because only the run
   * that produced it knows what it queued.
   */
  useEffect(() => {
    if (!transactionId) return;
    // Optional-chained because the details screen must not fail to mount when
    // the subscriber is absent — an older preload bundle, or one of the many
    // existing suites that mock `window.api.transactions` partially. The queue
    // still works without it; only main-process-initiated updates wait for the
    // next open, which is the pre-broadcast behaviour.
    //
    // This cannot hide a real wiring break: reviewQueueTriggers-2791 asserts the
    // preload bridge and the window-api type both expose onReviewQueueChanged,
    // so removing it goes red there.
    const subscribe = window.api?.transactions?.onReviewQueueChanged;
    if (typeof subscribe !== "function") return;
    const unsubscribe = subscribe((data) => {
      if (data.transactionId !== transactionId) return;
      setState((prev) => ({ ...prev, count: data.outstanding }));
      // N = L + R: a run that only LINKED still found something and still
      // announces itself. Gating on `added` alone silenced exactly the
      // audit-range-extension case where the new mail names the property and
      // links outright.
      if (data.added > 0 || (data.linked ?? 0) > 0) {
        setLastAdded((prev) => Math.max(prev, data.added));
        setLastLinked((prev) => Math.max(prev, data.linked ?? 0));
      }
      void refresh();
    });
    return unsubscribe;
  }, [transactionId, refresh]);

  return {
    items: state.items,
    count: state.count,
    isLoading,
    lastAdded,
    lastLinked,
    lastFound: lastAdded + lastLinked,
    changeToken,
    refresh,
    runSync,
    approve,
    reject,
    clearLastAdded,
  };
}
