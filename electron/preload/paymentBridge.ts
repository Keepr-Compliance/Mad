/**
 * Payment Bridge (BACKLOG-2015 — desktop PAYG card-purchase flow, 2005b)
 *
 * Renderer→main IPC surface for the zero-balance card path, plus the
 * `payment:deep-link-callback` listener the renderer subscribes to so it knows
 * when the browser returned from Checkout / SCA. Every money / JWT / portal call
 * is made in main; the fail-closed unlock decision is main's (a portal 200 alone
 * never unlocks).
 */

import { ipcRenderer, IpcRendererEvent } from "electron";
import type {
  BeginCheckoutResult,
  ChargeResult,
  PaymentConfirmResult,
  SavedCardStatus,
} from "../types/payment";

export const paymentBridge = {
  /** Flow A: create + open the Checkout Session in the system browser. */
  beginCheckout: (localTransactionId: string): Promise<BeginCheckoutResult> =>
    ipcRenderer.invoke("payment:begin-checkout", localTransactionId),

  /** Flow B: one-click off-session charge of the saved card. */
  chargeSavedCard: (localTransactionId: string): Promise<ChargeResult> =>
    ipcRenderer.invoke("payment:charge-saved-card", localTransactionId),

  /**
   * Confirm a purchase after the browser return (fail-closed gate re-read).
   * @param sessionId untrusted deep-link session id (validated in main); null for Flow B.
   */
  confirm: (
    localTransactionId: string,
    sessionId: string | null,
  ): Promise<PaymentConfirmResult> =>
    ipcRenderer.invoke("payment:confirm", localTransactionId, sessionId),

  /** Saved-card eligibility (optimization; the /charge 409 is authoritative). */
  hasSavedCard: (): Promise<SavedCardStatus> =>
    ipcRenderer.invoke("payment:has-saved-card"),
};

/**
 * Deep-link callback listener (mirrors eventBridge.onDeepLinkAuthCallback).
 * Fired when the app receives `keepr://payment-callback?session=<id>` after the
 * browser Checkout / SCA return. The `sessionId` is UNTRUSTED (sanitized in
 * main) and is only used to poke the JWT-authed /status self-heal — the unlock
 * decision is the authoritative gate re-read.
 *
 * @param callback handler receiving the (sanitized) session id
 * @returns cleanup function that removes the listener
 */
export const paymentEventBridge = {
  onPaymentDeepLinkCallback: (
    callback: (data: { sessionId: string | null }) => void,
  ): (() => void) => {
    const listener = (
      _: IpcRendererEvent,
      data: { sessionId: string | null },
    ): void => callback(data);
    ipcRenderer.on("payment:deep-link-callback", listener);
    return () => ipcRenderer.removeListener("payment:deep-link-callback", listener);
  },
};
