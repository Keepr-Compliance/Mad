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
import { resolveHandles, nameForHandle } from "../services/contactResolutionService";
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

/**
 * BACKLOG-2816 — turn a thread-level hit's raw member handles into contact names.
 *
 * The founder's rule for the group-name result row is "with name not numbers".
 * So a member that resolves to a contact is listed BY NAME, and a member that
 * does not is OMITTED — not shown as digits, not shown as a formatted number.
 * A group where nobody is a saved contact therefore shows its name and no member
 * line, which is honest; a row of raw digits is the thing he ruled out.
 *
 * Resolution goes through the SHARED `resolveHandles` (contactResolutionService)
 * — the same resolver `AttachMessagesModal` uses. One round trip for every hit in
 * the response, not one per row.
 *
 * Mutates the hits in place: they are freshly built by the search service in this
 * same call and are not shared with anything else.
 */
async function attachMemberNames(
  hits: Array<{ memberHandles?: string[]; memberNames?: string[] }>,
  userId?: string,
): Promise<void> {
  const all = new Set<string>();
  for (const hit of hits) {
    for (const handle of hit.memberHandles ?? []) all.add(handle);
  }
  if (all.size === 0) return;

  const resolution = await resolveHandles([...all], userId);

  for (const hit of hits) {
    const handles = hit.memberHandles;
    if (!handles || handles.length === 0) continue;
    const resolved: string[] = [];
    for (const handle of handles) {
      // BACKLOG-2757: read through `nameForHandle`, never by direct indexing.
      // `resolvePhoneNames` keys `names` by the NORMALIZED handle
      // (`legacyDigitKey`, i.e. last-10 digits), so `names["+14155550100"]`
      // is always undefined and every member line silently went blank.
      const name = nameForHandle(resolution, handle);
      // Omit rather than fall back to the number — see above.
      if (name && name.trim()) resolved.push(name.trim());
    }
    hit.memberNames = resolved;
  }
}

/** Empty scoped result groups (no DB access needed). */
function emptyLinkedResults(): LinkedContentSearchResults {
  return {
    contacts: { items: [], hasMore: false },
    emails: { items: [], hasMore: false },
    texts: { items: [], hasMore: false },
    groupChats: { items: [], hasMore: false },
  };
}

/** Empty global result groups (no DB access needed). */
function emptyGlobalResults(): GlobalContentSearchResults {
  return {
    transactions: { items: [], hasMore: false },
    contacts: { items: [], hasMore: false },
    emails: { items: [], hasMore: false },
    texts: { items: [], hasMore: false },
    groupChats: { items: [], hasMore: false },
    unattached: { items: [], hasMore: false },
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
        // BACKLOG-2816: group-name rows carry member handles; show contact names.
        // BACKLOG-2858: those rows now live in `groupChats`, which is where the
        // handles are. Resolving `texts` alone would have quietly stopped
        // resolving anything — every message row's `memberHandles` is undefined.
        await attachMemberNames(results.groupChats.items);

        logService.info("Linked-content search", "Transactions", {
          transactionId: validatedTxnId,
          // BACKLOG-2863: the search no longer computes totals, so the log
          // records what was RETURNED. Renaming the keys keeps a reader of old
          // log lines from comparing two different quantities under one name.
          contactsReturned: results.contacts.items.length,
          emailsReturned: results.emails.items.length,
          textsReturned: results.texts.items.length,
          groupChatsReturned: results.groupChats.items.length,
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
        // BACKLOG-2816/2858: the Group chats category and the Unattached bucket
        // both carry group-name rows (the unattached ones stay in Unattached by
        // design), so both are resolved in ONE round trip.
        await attachMemberNames(
          [...results.groupChats.items, ...results.unattached.items],
          validatedUserId,
        );

        logService.info("Global content search", "Transactions", {
          // BACKLOG-2863: see the scoped handler — returned rows, not totals.
          transactionsReturned: results.transactions.items.length,
          contactsReturned: results.contacts.items.length,
          emailsReturned: results.emails.items.length,
          textsReturned: results.texts.items.length,
          groupChatsReturned: results.groupChats.items.length,
          unattachedReturned: results.unattached.items.length,
        });

        return { success: true, results };
      },
      { module: "Transactions" },
    ),
  );
}
