/**
 * useUnlockedTransactionIds Hook (BACKLOG-2090)
 *
 * One-shot batch lookup of the transaction ids THIS device has a confirmed
 * unlock for, so the transaction list can render an at-a-glance "Unlocked" badge
 * without one entitlement fetch per row.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FAIL-CLOSED: the returned Set starts EMPTY and only gains ids on a positive
 * resolve. Any error resolves to an empty Set — the badge then shows every row
 * LOCKED rather than falsely "unlocked". A tx unlocked on another device won't
 * appear until this device confirms it, which is the intended (fail-closed)
 * behaviour, not a bug.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * StrictMode-safe: the effect uses a per-run `cancelled` flag (no didMount
 * guard, which misfires under StrictMode's dev double-invoke). `refreshKey`
 * bumps re-run the fetch (e.g. after an unlock elsewhere in the UI).
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { entitlementService } from "../services/entitlementService";
import { logger } from "../utils/logger";

export interface UseUnlockedTransactionIdsReturn {
  /** The set of local transaction ids confirmed-unlocked on this device. */
  unlockedIds: Set<string>;
  /** True while the first (or a refreshing) fetch is in flight. */
  loading: boolean;
  /** Re-fetch the unlocked-ids set from main. */
  refresh: () => void;
}

export function useUnlockedTransactionIds(): UseUnlockedTransactionIdsReturn {
  const [unlockedIds, setUnlockedIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const ids = await entitlementService.getUnlockedIds();
        if (cancelled) return;
        setUnlockedIds(new Set(ids));
      } catch (error) {
        if (cancelled) return;
        // Fail-closed: on error, treat everything as locked.
        logger.warn("[useUnlockedTransactionIds] fetch failed", error);
        setUnlockedIds(new Set());
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const refresh = useCallback((): void => {
    setRefreshKey((k) => k + 1);
  }, []);

  return useMemo(
    () => ({ unlockedIds, loading, refresh }),
    [unlockedIds, loading, refresh],
  );
}

export default useUnlockedTransactionIds;
