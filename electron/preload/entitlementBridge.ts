/**
 * Entitlement Bridge (BACKLOG-2006a)
 *
 * Renderer→main IPC surface for the per-transaction paywall. The renderer
 * paywall UI (BACKLOG-2075) consumes this to render the locked/unlocked state
 * and CTA; the gate decision is always made in main (fail-closed).
 */

import { ipcRenderer } from "electron";
import type {
  EntitlementStatus,
  UnlockQuote,
  UnlockResult,
} from "../types/entitlement";

export const entitlementBridge = {
  /**
   * Full entitlement snapshot for a transaction (gate decision + quote + balance).
   * @param localTransactionId the local Transaction.id
   */
  getStatus: (localTransactionId: string): Promise<EntitlementStatus> =>
    ipcRenderer.invoke("entitlement:get-status", localTransactionId),

  /** Live PAYG quote for the paid-unlock CTA (null when offline/unavailable). */
  getQuote: (): Promise<UnlockQuote | null> =>
    ipcRenderer.invoke("entitlement:get-quote"),

  /** Grant-credit balance (null when offline/unavailable). */
  getBalance: (): Promise<number | null> =>
    ipcRenderer.invoke("entitlement:get-balance"),

  /**
   * Unlock a transaction using a granted credit (grants-first). Online only.
   * @param localTransactionId the local Transaction.id
   */
  unlockWithCredit: (localTransactionId: string): Promise<UnlockResult> =>
    ipcRenderer.invoke("entitlement:unlock-with-credit", localTransactionId),
};
