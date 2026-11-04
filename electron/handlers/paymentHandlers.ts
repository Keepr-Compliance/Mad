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
  BeginSubscriptionResult,
  ChargeResult,
  GateReadResult,
  PaymentConfirmResult,
  SavedCardStatus,
} from "../types/payment";

/**
 * BACKLOG-3676 (S4): input check for the new transaction-id channels. A
 * non-empty string of at most 128 characters; anything else is refused.
 */
export function isValidTransactionIdArg(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

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

  // BACKLOG-3676: open the Agent plan Stripe Checkout. Takes NO argument; the
  // portal route reads only the Bearer JWT.
  ipcMain.handle(
    "payment:begin-subscription",
    async (): Promise<BeginSubscriptionResult> => paymentService.beginSubscription(),
  );

  // BACKLOG-3676: after the Agent plan Checkout returns. Polls fresh gate reads
  // (fail-closed); unlocked ONLY when the gate says so.
  ipcMain.handle(
    "payment:confirm-subscription",
    async (_event: IpcMainInvokeEvent, localTransactionId: unknown): Promise<PaymentConfirmResult> => {
      if (!isValidTransactionIdArg(localTransactionId)) {
        return { unlocked: false, reason: "error" };
      }
      return paymentService.confirmSubscription(localTransactionId);
    },
  );

  // BACKLOG-3676 (R6): "Try again" / "Check again" — one fresh gate read.
  ipcMain.handle(
    "payment:refresh-gate",
    async (_event: IpcMainInvokeEvent, localTransactionId: unknown): Promise<GateReadResult> => {
      if (!isValidTransactionIdArg(localTransactionId)) {
        return { unlocked: false };
      }
      return paymentService.refreshGate(localTransactionId);
    },
  );

  logService.debug("Payment handlers registered", MODULE);
}
