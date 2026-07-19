/**
 * Payment Service (renderer) — BACKLOG-2015
 *
 * Type-safe abstraction over window.api.payment.* + the payment deep-link
 * listener. Consumed by PurchaseUnlockHandoff. All money / JWT / portal work is
 * done in the MAIN process; this only forwards intent and surfaces results.
 *
 * FAIL-CLOSED at the renderer boundary: if the bridge is unavailable or a call
 * throws, the result is a NON-unlocking / NON-starting outcome — never an
 * optimistic success. The authoritative unlock decision is always main's.
 */

import type {
  BeginCheckoutResult,
  ChargeResult,
  PaymentConfirmResult,
  SavedCardStatus,
} from "../../electron/types/payment";

export type {
  BeginCheckoutResult,
  ChargeResult,
  ChargeOutcome,
  PaymentConfirmResult,
  SavedCardStatus,
} from "../../electron/types/payment";

export const paymentService = {
  /** Flow A: create + open the Checkout Session in the system browser. */
  async beginCheckout(localTransactionId: string): Promise<BeginCheckoutResult> {
    try {
      if (!window.api?.payment?.beginCheckout) {
        return { started: false, error: "error" };
      }
      return await window.api.payment.beginCheckout(localTransactionId);
    } catch {
      return { started: false, error: "error" };
    }
  },

  /** Flow B: one-click off-session charge of the saved card. */
  async chargeSavedCard(localTransactionId: string): Promise<ChargeResult> {
    try {
      if (!window.api?.payment?.chargeSavedCard) {
        return { outcome: "error" };
      }
      return await window.api.payment.chargeSavedCard(localTransactionId);
    } catch {
      return { outcome: "error" };
    }
  },

  /**
   * Confirm a purchase after the browser return. Resolves unlocked ONLY on a
   * positive authoritative gate confirmation (main's decision). A thrown/absent
   * bridge resolves NOT unlocked (fail-closed).
   */
  async confirm(
    localTransactionId: string,
    sessionId: string | null,
  ): Promise<PaymentConfirmResult> {
    try {
      if (!window.api?.payment?.confirm) {
        return { unlocked: false, reason: "error" };
      }
      return await window.api.payment.confirm(localTransactionId, sessionId);
    } catch {
      return { unlocked: false, reason: "error" };
    }
  },

  /** Saved-card eligibility (optimization; the /charge 409 is authoritative). */
  async hasSavedCard(): Promise<SavedCardStatus> {
    try {
      if (!window.api?.payment?.hasSavedCard) return { hasSavedCard: false };
      return await window.api.payment.hasSavedCard();
    } catch {
      return { hasSavedCard: false };
    }
  },

  /**
   * Subscribe to the payment deep-link callback (browser returned from Checkout
   * / SCA). Returns a cleanup function. No-op (returns a noop cleanup) when the
   * bridge is unavailable.
   */
  onDeepLinkCallback(
    callback: (data: { sessionId: string | null }) => void,
  ): () => void {
    if (!window.api?.onPaymentDeepLinkCallback) return () => undefined;
    return window.api.onPaymentDeepLinkCallback(callback);
  },
};
