/**
 * Entitlement Service (renderer) — BACKLOG-2006a
 *
 * Type-safe abstraction over window.api.entitlement.*. Consumed by
 * useTransactionEntitlement and the paywall UI (BACKLOG-2075).
 *
 * FAIL-CLOSED at the renderer boundary too: if the bridge is unavailable or a
 * call throws, `getStatus` resolves a LOCKED snapshot — never undefined, never
 * a thrown error that a caller might treat as "show content". The authoritative
 * decision is still main's; this only guarantees the renderer never falls open.
 */

import { getErrorMessage } from "./index";

// Re-export the shared IPC types so renderer consumers import from one place.
export type {
  EntitlementStatus,
  UnlockStatus,
  UnlockQuote,
  UnlockResult,
  LockReason,
} from "../../electron/types/entitlement";

import type {
  EntitlementStatus,
  UnlockQuote,
  UnlockResult,
} from "../../electron/types/entitlement";

/** A LOCKED snapshot used whenever the renderer cannot obtain a real answer. */
function lockedSnapshot(
  localTransactionId: string,
  lockReason: EntitlementStatus["lockReason"] = "error",
): EntitlementStatus {
  return {
    localTransactionId,
    status: "locked",
    lockReason,
    fromCache: false,
    quote: null,
    creditBalance: null,
  };
}

export const entitlementService = {
  /**
   * Full entitlement snapshot for a transaction. NEVER throws and NEVER returns
   * undefined — an unreachable bridge yields a LOCKED snapshot (fail-closed).
   */
  async getStatus(localTransactionId: string): Promise<EntitlementStatus> {
    try {
      if (!window.api?.entitlement?.getStatus) {
        return lockedSnapshot(localTransactionId, "error");
      }
      const result = await window.api.entitlement.getStatus(localTransactionId);
      // Defensive: a malformed response also resolves LOCKED.
      if (!result || result.status !== "unlocked") {
        return result && result.status === "locked"
          ? result
          : lockedSnapshot(localTransactionId, result?.lockReason ?? "error");
      }
      return result;
    } catch (error) {
      // Swallow to a LOCKED snapshot; surface the reason only for diagnostics.
      void getErrorMessage(error);
      return lockedSnapshot(localTransactionId, "error");
    }
  },

  /** Live PAYG quote for the CTA (null when offline/unavailable). */
  async getQuote(): Promise<UnlockQuote | null> {
    try {
      if (!window.api?.entitlement?.getQuote) return null;
      return await window.api.entitlement.getQuote();
    } catch {
      return null;
    }
  },

  /** Grant-credit balance (null when offline/unavailable). */
  async getBalance(): Promise<number | null> {
    try {
      if (!window.api?.entitlement?.getBalance) return null;
      return await window.api.entitlement.getBalance();
    } catch {
      return null;
    }
  },

  /**
   * Unlock via a granted credit (grants-first). A thrown/absent bridge resolves
   * to a failed, still-LOCKED result — never an optimistic unlock.
   */
  async unlockWithCredit(localTransactionId: string): Promise<UnlockResult> {
    try {
      if (!window.api?.entitlement?.unlockWithCredit) {
        return { success: false, status: "locked", error: "unavailable" };
      }
      return await window.api.entitlement.unlockWithCredit(localTransactionId);
    } catch (error) {
      return { success: false, status: "locked", error: getErrorMessage(error) };
    }
  },
};
