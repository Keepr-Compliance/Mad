/**
 * "Last opened" types — BACKLOG-3965 PR-2.
 *
 * Type-only, in `electron/types/`, so the renderer may import it (the
 * BACKLOG-2075 rule: a renderer import of a file holding VALUES drags
 * main-process code into the Vite bundle).
 */

/** One deal the user opened recently, newest first. */
export interface RecentlyOpenedTransaction {
  transactionId: string;
  propertyAddress: string;
  /** transactions.status ('active', 'closed', ...). */
  status: string | null;
  /** When the deal was last opened on this device, ISO 8601 UTC. */
  openedAt: string;
  /** Required checklist items ticked, summed across every checklist on the deal. */
  requiredDone: number;
  /** Required checklist items, summed across every checklist on the deal. */
  requiredTotal: number;
}

/** What `transactions:record-open` answers. */
export interface RecordTransactionOpenResponse {
  success: boolean;
  /** False when no deal has that id (nothing was written). */
  recorded?: boolean;
  error?: string;
}

/** What `transactions:get-recently-opened` answers. */
export interface RecentlyOpenedTransactionsResponse {
  success: boolean;
  transactions?: RecentlyOpenedTransaction[];
  error?: string;
}
