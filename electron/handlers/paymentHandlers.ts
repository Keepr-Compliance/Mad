// ============================================
// PAYMENT IPC HANDLERS (BACKLOG-2015 — desktop PAYG card-purchase flow, 2005b)
//
// Renderer→main surface for the zero-balance card path. The renderer
// (PurchaseUnlockHandoff) consumes these; the fail-closed unlock decision is
// always made in main (paymentService → authoritative gate re-read). A portal
// 200 alone never unlocks.
//
// SECURITY NOTE: the `sessionId` passed to `payment:confirm` originates from an
// UNTRUSTED deep link (keepr://payment-callback — any local app can fire it). It
// is sanitized in paymentService and is NEVER trusted to grant anything;
// confirmation is a JWT-authed /status poke + the authoritative
// `transaction_unlocks` gate re-read.
// ============================================

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import paymentService from "../services/paymentService";
import logService from "../services/logService";
import type {
  BeginCheckoutResult,
  ChargeResult,
  PaymentConfirmResult,
  SavedCardStatus,
} from "../types/payment";

const MODULE = "PaymentHandlers";

/** Register all payment IPC handlers. */
export function registerPaymentHandlers(): void {
  // Flow A (first purchase / fallback): open Checkout in the system browser.
  ipcMain.handle(
    "payment:begin-checkout",
    async (
      _event: IpcMainInvokeEvent,
      localTransactionId: string,
    ): Promise<BeginCheckoutResult> => {
      if (!localTransactionId || typeof localTransactionId !== "string") {
        return { started: false, error: "error" };
      }
      return paymentService.beginCheckout(localTransactionId);
    },
  );

  // Flow B (repeat): one-click off-session charge of the saved card.
  ipcMain.handle(
    "payment:charge-saved-card",
    async (
      _event: IpcMainInvokeEvent,
      localTransactionId: string,
    ): Promise<ChargeResult> => {
      if (!localTransactionId || typeof localTransactionId !== "string") {
        return { outcome: "error" };
      }
      return paymentService.chargeSavedCard(localTransactionId);
    },
  );

  // Confirm after the browser return. THE unlock authority (fail-closed).
  ipcMain.handle(
    "payment:confirm",
    async (
      _event: IpcMainInvokeEvent,
      localTransactionId: string,
      sessionId: string | null,
    ): Promise<PaymentConfirmResult> => {
      if (!localTransactionId || typeof localTransactionId !== "string") {
        return { unlocked: false, reason: "error" };
      }
      // sessionId is UNTRUSTED; paymentService sanitizes it. Coerce non-strings to null.
      const safeSessionArg = typeof sessionId === "string" ? sessionId : null;
      return paymentService.confirm(localTransactionId, safeSessionArg);
    },
  );

  // Saved-card eligibility (pure optimization; the /charge 409 is authoritative).
  ipcMain.handle(
    "payment:has-saved-card",
    async (): Promise<SavedCardStatus> => {
      return paymentService.hasSavedCard();
    },
  );

  logService.debug("Payment handlers registered", MODULE);
}
