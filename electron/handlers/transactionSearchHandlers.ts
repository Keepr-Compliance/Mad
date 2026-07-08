// ============================================
// TRANSACTION LINKED-CONTENT SEARCH IPC HANDLERS
// - transactions:search-linked-content (BACKLOG-1866): content linked to ONE
//   transaction (contacts/emails/texts).
// - transactions:search-global (BACKLOG-1876): all of a user's content, grouped
//   as transactions/contacts/emails/texts/unattached with transaction
//   attribution per hit.
// ============================================

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import logService from "../services/logService";
import { getRawDatabase } from "../services/db/core/dbConnection";
import {
  searchLinkedContent,
  searchGlobalContent,
  type LinkedContentSearchResults,
  type GlobalContentSearchResults,
  type SearchableDb,
} from "../services/db/transactionSearchDbService";
import { wrapHandler } from "../utils/wrapHandler";
import {
  ValidationError,
  validateTransactionId,
  validateUserId,
} from "../utils/validation";

export interface SearchLinkedContentResponse {
  success: boolean;
  results?: LinkedContentSearchResults;
  error?: string;
}

export interface SearchGlobalContentResponse {
  success: boolean;
  results?: GlobalContentSearchResults;
  error?: string;
}

/** Empty scoped result groups (no DB access needed). */
function emptyLinkedResults(): LinkedContentSearchResults {
  return {
    contacts: { items: [], total: 0 },
    emails: { items: [], total: 0 },
    texts: { items: [], total: 0 },
  };
}

/** Empty global result groups (no DB access needed). */
function emptyGlobalResults(): GlobalContentSearchResults {
  return {
    transactions: { items: [], total: 0 },
    contacts: { items: [], total: 0 },
    emails: { items: [], total: 0 },
    texts: { items: [], total: 0 },
    unattached: { items: [], total: 0 },
  };
}

/**
 * Register the linked-content (scoped) and global search IPC handlers.
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
          return { success: true, results: emptyLinkedResults() };
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

  // BACKLOG-1876: global (unscoped) search across all of the user's content.
  ipcMain.handle(
    "transactions:search-global",
    wrapHandler(
      async (
        _event: IpcMainInvokeEvent,
        userId: string,
        query: string,
      ): Promise<SearchGlobalContentResponse> => {
        const validatedUserId = validateUserId(userId);
        if (!validatedUserId) {
          throw new ValidationError("User ID validation failed", "userId");
        }

        const trimmed = typeof query === "string" ? query.trim() : "";
        // Empty query ⇒ no panel. Return empty groups without hitting the DB.
        if (trimmed.length === 0) {
          return { success: true, results: emptyGlobalResults() };
        }

        const db = getRawDatabase() as unknown as SearchableDb;
        const results = searchGlobalContent(db, validatedUserId, trimmed);

        logService.info("Global content search", "Transactions", {
          transactions: results.transactions.total,
          contacts: results.contacts.total,
          emails: results.emails.total,
          texts: results.texts.total,
          unattached: results.unattached.total,
        });

        return { success: true, results };
      },
      { module: "Transactions" },
    ),
  );
}
