/**
 * useCreditBalance Hook (BACKLOG-2090)
 *
 * Persistent, always-visible grant-credit balance for the app chrome (rendered
 * by CreditBalanceChip in the transaction toolbar) — so remaining credits are
 * visible at a glance, not only inside the unlock prompt.
 *
 * `balance` is null when the balance cannot be obtained (offline / bridge
 * unavailable / error). Consumers should HIDE the chip on null rather than show
 * "0", so an unavailable balance never reads as "no credits".
 *
 * StrictMode-safe: per-run `cancelled` flag, no didMount guard.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { entitlementService } from "../services/entitlementService";
import { logger } from "../utils/logger";

export interface UseCreditBalanceReturn {
  /** Remaining grant credits, or null when unavailable (offline/error). */
  balance: number | null;
  /** True while the first (or a refreshing) fetch is in flight. */
  loading: boolean;
  /** Re-fetch the balance from main. */
  refresh: () => void;
}

export function useCreditBalance(): UseCreditBalanceReturn {
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const value = await entitlementService.getBalance();
        if (cancelled) return;
        setBalance(value);
      } catch (error) {
        if (cancelled) return;
        logger.warn("[useCreditBalance] fetch failed", error);
        setBalance(null);
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
    () => ({ balance, loading, refresh }),
    [balance, loading, refresh],
  );
}

export default useCreditBalance;
