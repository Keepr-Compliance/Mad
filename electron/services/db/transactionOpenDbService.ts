/**
 * "Last opened" storage — BACKLOG-3965 PR-2.
 *
 * Writes and reads `transaction_opens` only. See transactionOpenSql.ts for why
 * this is its own table and never a column on `transactions`.
 */
import { dbAll, dbRun } from "./core/dbConnection";
import type { RecentlyOpenedTransaction } from "../../types/transactionOpen";
import {
  GET_RECENTLY_OPENED_TRANSACTIONS_SQL,
  RECORD_TRANSACTION_OPEN_SQL,
} from "./transactionOpenSql";

/** The most rows one read returns. The Dashboard shows five. */
export const RECENTLY_OPENED_MAX_LIMIT = 50;

/**
 * Record that a deal was opened at `openedAt` (ISO 8601 UTC). Returns false
 * when no deal has that id; nothing is written then.
 */
export function recordTransactionOpen(transactionId: string, openedAt: string): boolean {
  return dbRun(RECORD_TRANSACTION_OPEN_SQL, [openedAt, transactionId]).changes > 0;
}

/** The deals this user opened most recently, newest first. */
export function getRecentlyOpenedTransactions(
  userId: string,
  limit: number,
): RecentlyOpenedTransaction[] {
  const bounded = Math.max(1, Math.min(RECENTLY_OPENED_MAX_LIMIT, Math.floor(limit)));
  return dbAll<RecentlyOpenedTransaction>(GET_RECENTLY_OPENED_TRANSACTIONS_SQL, [userId, bounded]);
}
