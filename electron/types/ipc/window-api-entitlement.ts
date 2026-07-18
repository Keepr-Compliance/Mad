/**
 * WindowApi Entitlement sub-interface (BACKLOG-2006a)
 *
 * The per-transaction paywall surface exposed to the renderer. The renderer
 * consumes these to render locked/unlocked state and the unlock CTA; the
 * fail-closed gate decision is always made in the main process.
 */

import type {
  EntitlementStatus,
  UnlockQuote,
  UnlockResult,
} from "../entitlement";

export interface WindowApiEntitlement {
  /** Full entitlement snapshot for a transaction (gate decision + quote + balance). */
  getStatus: (localTransactionId: string) => Promise<EntitlementStatus>;
  /** Live PAYG quote for the paid-unlock CTA (null when offline/unavailable). */
  getQuote: () => Promise<UnlockQuote | null>;
  /** Grant-credit balance (null when offline/unavailable). */
  getBalance: () => Promise<number | null>;
  /**
   * BACKLOG-2090: ids of transactions this device has a confirmed unlock for,
   * powering the transaction-list "Unlocked" badge with one call. Fail-closed to
   * [] on any failure.
   */
  getUnlockedIds: () => Promise<string[]>;
  /** Unlock a transaction using a granted credit (grants-first). Online only. */
  unlockWithCredit: (localTransactionId: string) => Promise<UnlockResult>;
}
