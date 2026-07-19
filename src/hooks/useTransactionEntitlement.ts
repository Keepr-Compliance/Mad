/**
 * useTransactionEntitlement Hook (BACKLOG-2006a)
 *
 * Per-transaction paywall state for the renderer. Consumed by the paywall UI
 * (BACKLOG-2075) to decide shield vs content and to render the unlock CTA.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FAIL-CLOSED (the whole point):
 *   - `state` starts as "loading". The paywall UI MUST render the shield for
 *     BOTH "loading" AND "locked" — content is shown ONLY for "unlocked".
 *   - Any fetch error resolves to "locked" (never "unlocked").
 *   - There is no code path where an error or a pending fetch reveals content.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * StrictMode-safe: the effect uses a per-run `cancelled` flag and re-runs on
 * `localTransactionId` VALUE change (no didMount guard, which misfires under
 * StrictMode's dev double-invoke). A superseded run never calls setState.
 *
 * @example
 * const { isUnlocked, isLoading, status, quote, creditBalance, refresh } =
 *   useTransactionEntitlement(transactionId);
 * // Render content ONLY when isUnlocked; otherwise render the shield.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { entitlementService } from "../services/entitlementService";
import type {
  EntitlementStatus,
  UnlockQuote,
  UnlockResult,
} from "../services/entitlementService";

/** Renderer-facing tri-state. "loading" and "locked" both mean "show shield". */
export type EntitlementState = "loading" | "locked" | "unlocked";

export interface UseTransactionEntitlementReturn {
  /** Tri-state. Only "unlocked" may reveal content. */
  state: EntitlementState;
  /** true iff state === "unlocked". Convenience for the content/shield decision. */
  isUnlocked: boolean;
  /** true while the first (or a refreshing) fetch is in flight. Renders shield. */
  isLoading: boolean;
  /** Full snapshot (null until first resolve). Locked snapshots carry quote/balance. */
  status: EntitlementStatus | null;
  /** Live PAYG quote for the CTA (null when unlocked/offline/unavailable). */
  quote: UnlockQuote | null;
  /** Grant-credit balance (null when unlocked/offline/unavailable). */
  creditBalance: number | null;
  /** Why it is locked (diagnostic; undefined when unlocked). */
  lockReason: EntitlementStatus["lockReason"];
  /** Re-fetch the entitlement snapshot from main. */
  refresh: () => Promise<void>;
  /** Unlock with a granted credit, then refresh. Returns the raw result. */
  unlockWithCredit: () => Promise<UnlockResult>;
}

export function useTransactionEntitlement(
  localTransactionId: string | undefined,
): UseTransactionEntitlementReturn {
  // FAIL-CLOSED initial state: nothing is unlocked until positively confirmed.
  const [status, setStatus] = useState<EntitlementStatus | null>(null);
  const [state, setState] = useState<EntitlementState>("loading");

  // Tracks the transaction id of the in-flight/most-recent fetch so a stale
  // resolve (e.g. after the id changed) can be ignored — value comparison,
  // StrictMode-safe.
  const activeIdRef = useRef<string | undefined>(undefined);

  const fetchStatus = useCallback(
    async (txId: string, isCancelled: () => boolean): Promise<void> => {
      const result = await entitlementService.getStatus(txId);
      if (isCancelled()) return; // superseded run — do not touch state
      setStatus(result);
      setState(result.status === "unlocked" ? "unlocked" : "locked");
    },
    [],
  );

  useEffect(() => {
    // No transaction ⇒ stay fail-closed (locked), no fetch.
    if (!localTransactionId) {
      setStatus(null);
      setState("locked");
      return;
    }

    let cancelled = false;
    activeIdRef.current = localTransactionId;
    // Reset to loading (renders shield) whenever the target transaction changes.
    setState("loading");
    setStatus(null);

    void fetchStatus(localTransactionId, () => cancelled);

    return () => {
      cancelled = true;
    };
  }, [localTransactionId, fetchStatus]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!localTransactionId) return;
    // Re-fetch WITHOUT flipping to "loading" — keeps a currently-unlocked view
    // stable while refreshing (a locked view stays a shield either way).
    const result = await entitlementService.getStatus(localTransactionId);
    if (activeIdRef.current !== localTransactionId) return; // id changed mid-flight
    setStatus(result);
    setState(result.status === "unlocked" ? "unlocked" : "locked");
  }, [localTransactionId]);

  const unlockWithCredit = useCallback(async (): Promise<UnlockResult> => {
    if (!localTransactionId) {
      return { success: false, status: "locked", error: "no_transaction" };
    }
    const result = await entitlementService.unlockWithCredit(localTransactionId);
    // Re-derive authoritative state from main after the attempt.
    await refresh();
    return result;
  }, [localTransactionId, refresh]);

  return useMemo(
    () => ({
      state,
      isUnlocked: state === "unlocked",
      isLoading: state === "loading",
      status,
      quote: status?.quote ?? null,
      creditBalance: status?.creditBalance ?? null,
      lockReason: status?.lockReason,
      refresh,
      unlockWithCredit,
    }),
    [state, status, refresh, unlockWithCredit],
  );
}

export default useTransactionEntitlement;
