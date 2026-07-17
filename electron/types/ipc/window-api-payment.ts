/**
 * WindowApi Payment sub-interface (BACKLOG-2015)
 *
 * Renderer→main surface for the desktop PAYG card-purchase flow. The renderer
 * (PurchaseUnlockHandoff) consumes these to drive Checkout / one-click / SCA /
 * offline states; every money / JWT / portal call is made in the MAIN process.
 * The fail-closed unlock decision is always the authoritative gate re-read in
 * main — a portal 200 alone never unlocks (see electron/types/payment.ts).
 */

import type {
  BeginCheckoutResult,
  ChargeResult,
  PaymentConfirmResult,
  SavedCardStatus,
} from "../payment";

export interface WindowApiPayment {
  /**
   * Flow A (first purchase / fallback): create a Stripe Checkout Session and
   * open it in the system browser. The renderer then waits for the
   * `payment:deep-link-callback` event and calls `confirm`.
   */
  beginCheckout: (localTransactionId: string) => Promise<BeginCheckoutResult>;
  /**
   * Flow B (repeat): one-click off-session charge of the saved card at the fresh
   * server quote. Handles SCA (opens the hosted URL, or signals a Checkout
   * fallback when Stripe gives no URL), hard decline, and the no-saved-card 409.
   */
  chargeSavedCard: (localTransactionId: string) => Promise<ChargeResult>;
  /**
   * Confirm a purchase after the Checkout / SCA browser return. Polls the portal
   * status and re-reads the authoritative unlock gate; resolves unlocked ONLY on
   * a positive gate confirmation (fail-closed).
   * @param sessionId untrusted deep-link session id (validated in main); may be
   *   null for Flow B, where confirmation is purely the gate re-read.
   */
  confirm: (
    localTransactionId: string,
    sessionId: string | null,
  ) => Promise<PaymentConfirmResult>;
  /**
   * Whether the user has a saved card (Flow B eligibility). Pure optimization;
   * the /charge 409 remains authoritative. Re-check per purchase intent.
   */
  hasSavedCard: () => Promise<SavedCardStatus>;
}
