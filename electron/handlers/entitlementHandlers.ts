// ============================================
// ENTITLEMENT IPC HANDLERS (BACKLOG-2006a)
//
// Exposes the per-transaction paywall entitlement state to the renderer.
// The renderer paywall UI (BACKLOG-2075/2006b) consumes these; it NEVER makes
// the gate decision itself — the fail-closed decision is made here in main.
//
// Also emits the scoped `paywall-viewed` analytics event when a status query
// resolves LOCKED. Emitting from HERE (rather than shipping a broad renderer
// analytics bridge) keeps the analytics surface small and main-controlled.
// ============================================

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import entitlementService from "../services/entitlementService";
import supabaseService from "../services/supabaseService";
import logService from "../services/logService";
import { PAYWALL_ANALYTICS_EVENTS } from "../types/entitlement";
import type { EntitlementStatus, UnlockResult } from "../types/entitlement";

const MODULE = "EntitlementHandlers";

/**
 * Emit `paywall-viewed` for a locked transaction. Best-effort, non-throwing;
 * de-duplication of repeated views is the renderer's concern (it calls
 * get-status once per locked view).
 */
async function emitPaywallViewed(
  localTransactionId: string,
  lockReason: EntitlementStatus["lockReason"],
): Promise<void> {
  try {
    const session = await supabaseService.getAuthSession();
    if (!session?.userId) return; // no user ⇒ nothing to attribute
    await supabaseService.trackEvent(
      session.userId,
      PAYWALL_ANALYTICS_EVENTS.PAYWALL_VIEWED,
      { transaction_id: localTransactionId, lock_reason: lockReason ?? null },
    );
  } catch (error) {
    logService.warn("[Entitlement] Failed to emit paywall-viewed", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Register all entitlement IPC handlers.
 */
export function registerEntitlementHandlers(): void {
  // Full entitlement snapshot for a transaction (gate decision + quote + balance).
  ipcMain.handle(
    "entitlement:get-status",
    async (
      _event: IpcMainInvokeEvent,
      localTransactionId: string,
    ): Promise<EntitlementStatus> => {
      if (!localTransactionId || typeof localTransactionId !== "string") {
        // Fail-closed on bad input: report LOCKED rather than throwing.
        return {
          localTransactionId: String(localTransactionId ?? ""),
          status: "locked",
          lockReason: "error",
          fromCache: false,
          quote: null,
          creditBalance: null,
        };
      }

      const status = await entitlementService.getEntitlementStatus(localTransactionId);

      // Scoped analytics: emit paywall-viewed exactly when a view resolves LOCKED.
      if (status.status === "locked") {
        void emitPaywallViewed(localTransactionId, status.lockReason);
      }

      return status;
    },
  );

  // Live PAYG quote for the paid-unlock CTA (null offline/unavailable).
  ipcMain.handle("entitlement:get-quote", async () => {
    return entitlementService.getNextUnlockQuote();
  });

  // Grant-credit balance (credits spend before card; null offline/unavailable).
  ipcMain.handle("entitlement:get-balance", async () => {
    return entitlementService.getCreditBalance();
  });

  // Unlock a transaction using a granted credit (grants-first path). Online only.
  ipcMain.handle(
    "entitlement:unlock-with-credit",
    async (
      _event: IpcMainInvokeEvent,
      localTransactionId: string,
    ): Promise<UnlockResult> => {
      if (!localTransactionId || typeof localTransactionId !== "string") {
        return { success: false, status: "locked", error: "invalid_transaction_id" };
      }
      return entitlementService.unlockWithCredit(localTransactionId);
    },
  );

  logService.debug("Entitlement handlers registered", MODULE);
}
