// ============================================
// TRANSACTION LINKED-CONTENT SEARCH IPC HANDLER (BACKLOG-1866)
// Channel: transactions:search-linked-content
// Searches ONLY content linked to a single transaction (contacts/emails/texts).
// ============================================

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import logService from "../services/logService";
import { getRawDatabase } from "../services/db/core/dbConnection";
import {
  searchLinkedContent,
  type LinkedContentSearchResults,
  type SearchableDb,
} from "../services/db/transactionSearchDbService";
import { wrapHandler } from "../utils/wrapHandler";
import { ValidationError, validateTransactionId } from "../utils/validation";

export interface SearchLinkedContentResponse {
  success: boolean;
  results?: LinkedContentSearchResults;
  error?: string;
}

/**
 * Register the linked-content search IPC handler.
 */
export function registerTransactionSearchHandlers(): void {
  ipcMain.handle(
    "transactions:search-linked-content",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        transactionId: string,
        query: string,
      ): Promise<SearchLinkedContentResponse> => {
        const validatedTxnId = validateTransactionId(transactionId);
        if (!validatedTxnId) {
          throw new ValidationError(
            "Transaction ID validation failed",
            "transactionId",
          );
        }

        const trimmed = typeof query === "string" ? query.trim() : "";
        // Empty query ⇒ no panel. Return empty groups without hitting the DB.
        if (trimmed.length === 0) {
          return {
            success: true,
            results: {
              contacts: { items: [], total: 0 },
              emails: { items: [], total: 0 },
              texts: { items: [], total: 0 },
            },
          };
        }

        const db = getRawDatabase() as unknown as SearchableDb;
        const results = searchLinkedContent(db, validatedTxnId, trimmed);

        logService.info("Linked-content search", "Transactions", {
          transactionId: validatedTxnId,
          contacts: results.contacts.total,
          emails: results.emails.total,
          texts: results.texts.total,
        });

        return { success: true, results };
      },
      { module: "Transactions" },
    ),
  );
}
