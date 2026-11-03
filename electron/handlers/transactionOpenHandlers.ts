// ============================================
// "LAST OPENED" — IPC HANDLERS (BACKLOG-3965 PR-2)
// Handles: transactions:record-open,
//          transactions:get-recently-opened
// ============================================
//
// record-open is written by TransactionDetails when a deal opens (through
// src/services/transactionOpenService.ts, which never throws). It writes
// `transaction_opens` only — never the transactions row.
//
// get-recently-opened is read by the Dashboard's Recent panel (BACKLOG-3965
// PR-4b). Until PR-4b lands it has no renderer caller.
//
// A failure is thrown into wrapHandler, which logs it and reports it to Sentry,
// and answers { success: false }. The deal still opens: the renderer ignores it.

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import {
  getRecentlyOpenedTransactions,
  recordTransactionOpen,
} from "../services/db/transactionOpenDbService";
import type {
  RecentlyOpenedTransactionsResponse,
  RecordTransactionOpenResponse,
} from "../types/transactionOpen";
import { wrapHandler } from "../utils/wrapHandler";
import { ValidationError, validateTransactionId, validateUserId } from "../utils/validation";

/** How many deals the read returns when the caller does not say. */
export const RECENTLY_OPENED_DEFAULT_LIMIT = 5;

function requireTransactionId(transactionId: unknown): string {
  const validated = validateTransactionId(transactionId);
  if (!validated) throw new ValidationError("Transaction ID validation failed", "transactionId");
  return validated;
}

function requireUserId(userId: unknown): string {
  const validated = validateUserId(userId);
  if (!validated) throw new ValidationError("User ID validation failed", "userId");
  return validated;
}

function readLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return RECENTLY_OPENED_DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new ValidationError("limit must be a positive whole number", "limit");
  }
  return limit;
}

export function registerTransactionOpenHandlers(): void {
  ipcMain.handle(
    "transactions:record-open",
    wrapHandler(
      async (_event: IpcMainInvokeEvent, transactionId: unknown): Promise<RecordTransactionOpenResponse> => {
        const id = requireTransactionId(transactionId);
        const recorded = recordTransactionOpen(id, new Date().toISOString());
        return { success: true, recorded };
      },
      { module: "TransactionOpen" },
    ),
  );

  ipcMain.handle(
    "transactions:get-recently-opened",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        userId: unknown,
        limit?: unknown,
      ): Promise<RecentlyOpenedTransactionsResponse> => {
        const validatedUserId = requireUserId(userId);
        const transactions = getRecentlyOpenedTransactions(validatedUserId, readLimit(limit));
        return { success: true, transactions };
      },
      { module: "TransactionOpen" },
    ),
  );
}
