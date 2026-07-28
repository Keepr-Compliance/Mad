// ============================================
// EMAIL AUTO-LINK IPC HANDLERS
// Handles: auto-link-texts, resync-auto-link, update-address-filter
// Extracted from emailSyncHandlers.ts (TASK-2065)
// BACKLOG-1364: Added update-address-filter handler
// ============================================

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import transactionService from "../services/transactionService";
import logService from "../services/logService";
import { autoLinkAllToTransaction } from "../services/messageMatchingService";
import {
  autoLinkCommunicationsForContact,
  expandAttachedThreadsForUser,
} from "../services/autoLinkService";
import { wrapHandler } from "../utils/wrapHandler";
import type { TransactionResponse } from "../types/handlerTypes";
import {
  ValidationError,
  validateTransactionId,
} from "../utils/validation";

/**
 * Register email auto-link IPC handlers
 */
export function registerEmailAutoLinkHandlers(): void {
  // Auto-link text messages to a transaction based on assigned contacts
  ipcMain.handle(
    "transactions:auto-link-texts",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Auto-linking communications to transaction", "Transactions", {
        transactionId,
      });

      // Validate transaction ID
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      const result = await autoLinkAllToTransaction(validatedTransactionId);

      logService.info("Auto-link communications complete", "Transactions", {
        transactionId: validatedTransactionId,
        linked: result.linked,
        skipped: result.skipped,
        errors: result.errors.length,
      });

      return {
        success: result.errors.length === 0,
        linked: result.linked,
        skipped: result.skipped,
        errors: result.errors.length > 0 ? result.errors : undefined,
      };
    }, { module: "Transactions" }),
  );

  // Re-sync auto-link communications for all contacts on a transaction
  // Use when contacts have been updated and user wants to re-link communications
  ipcMain.handle(
    "transactions:resync-auto-link",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Re-syncing auto-link for transaction", "Transactions", {
        transactionId,
      });

      // Validate transaction ID
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      // Get transaction with contacts
      const transactionDetails = await transactionService.getTransactionWithContacts(
        validatedTransactionId,
      );

      if (!transactionDetails) {
        return {
          success: false,
          error: "Transaction not found",
        };
      }

      const contactAssignments = transactionDetails.contact_assignments || [];

      if (contactAssignments.length === 0) {
        return {
          success: true,
          message: "No contacts to sync",
          totalEmailsLinked: 0,
          totalMessagesLinked: 0,
          totalAlreadyLinked: 0,
        };
      }

      // Auto-link communications for each contact
      const results: Array<{
        contactId: string;
        emailsLinked: number;
        messagesLinked: number;
        alreadyLinked: number;
        errors: number;
      }> = [];

      let totalEmailsLinked = 0;
      let totalMessagesLinked = 0;
      let totalAlreadyLinked = 0;
      let totalErrors = 0;
      // BACKLOG-1364: Collect address filter message from auto-link results
      let addressFilterMessage: string | undefined;

      for (const assignment of contactAssignments) {
        try {
          const result = await autoLinkCommunicationsForContact({
            contactId: assignment.contact_id,
            transactionId: validatedTransactionId,
          });

          results.push({
            contactId: assignment.contact_id,
            ...result,
          });

          totalEmailsLinked += result.emailsLinked;
          totalMessagesLinked += result.messagesLinked;
          totalAlreadyLinked += result.alreadyLinked;
          totalErrors += result.errors;

          // BACKLOG-1364: Capture the address filter message (same for all contacts on a transaction)
          if (result.addressFilterMessage && !addressFilterMessage) {
            addressFilterMessage = result.addressFilterMessage;
          }

          logService.debug(
            "Re-sync auto-link complete for contact",
            "Transactions",
            {
              contactId: assignment.contact_id,
              emailsLinked: result.emailsLinked,
              messagesLinked: result.messagesLinked,
              alreadyLinked: result.alreadyLinked,
            }
          );
        } catch (error) {
          totalErrors++;
          logService.warn(
            `Re-sync auto-link failed for contact ${assignment.contact_id}`,
            "Transactions",
            {
              error: error instanceof Error ? error.message : "Unknown",
            }
          );
        }
      }

      // BACKLOG-2293: After the per-contact auto-link loop, expand attached
      // conversations so backfilled/older messages already sharing an attached
      // thread show up. This is the in-transaction "re-sync" button users click
      // when a conversation looks incomplete — the highest-value expansion site.
      // Idempotent and cheap post-I1 (BACKLOG-2285); awaited so the newly linked
      // messages are present when the handler returns and the UI refreshes.
      let attachedExpansionLinked = 0;
      try {
        const expansion = await expandAttachedThreadsForUser(transactionDetails.user_id);
        attachedExpansionLinked = expansion.messagesLinked;
      } catch (expandError) {
        logService.warn(
          "Re-sync attached-thread expansion failed",
          "Transactions",
          { error: expandError instanceof Error ? expandError.message : "Unknown" },
        );
      }

      logService.info("Re-sync auto-link complete", "Transactions", {
        transactionId: validatedTransactionId,
        contactsProcessed: contactAssignments.length,
        totalEmailsLinked,
        totalMessagesLinked,
        totalAlreadyLinked,
        totalErrors,
        attachedExpansionLinked,
      });

      return {
        success: true,
        contactsProcessed: contactAssignments.length,
        totalEmailsLinked,
        totalMessagesLinked,
        totalAlreadyLinked,
        totalErrors,
        // BACKLOG-2293: surface expansion count so the renderer refreshes and the
        // toast reflects messages linked by attached-thread expansion even when
        // the per-contact auto-link linked 0 (its date floor excludes backfill).
        attachedExpansionLinked,
        addressFilterMessage,
        results,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-1364: Update address filter toggle and re-run auto-link
  ipcMain.handle(
    "transactions:update-address-filter",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
      skipAddressFilter: boolean,
    ): Promise<TransactionResponse> => {
      logService.info("Updating address filter setting", "Transactions", {
        transactionId,
        skipAddressFilter,
      });

      // Validate transaction ID
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      // Update the skip_address_filter column
      await transactionService.updateTransaction(validatedTransactionId, {
        id: validatedTransactionId,
        skip_address_filter: skipAddressFilter ? 1 : 0,
      });

      // Re-run auto-link for all contacts on this transaction with the new setting
      const transactionDetails = await transactionService.getTransactionWithContacts(
        validatedTransactionId,
      );

      if (!transactionDetails) {
        return {
          success: true,
          message: "Address filter updated, but transaction not found for re-link",
        };
      }

      const contactAssignments = transactionDetails.contact_assignments || [];

      let totalEmailsLinked = 0;
      let totalMessagesLinked = 0;
      let totalAlreadyLinked = 0;
      let totalErrors = 0;
      let addressFilterMessage: string | undefined;

      for (const assignment of contactAssignments) {
        try {
          const result = await autoLinkCommunicationsForContact({
            contactId: assignment.contact_id,
            transactionId: validatedTransactionId,
          });

          totalEmailsLinked += result.emailsLinked;
          totalMessagesLinked += result.messagesLinked;
          totalAlreadyLinked += result.alreadyLinked;
          totalErrors += result.errors;

          if (result.addressFilterMessage && !addressFilterMessage) {
            addressFilterMessage = result.addressFilterMessage;
          }
        } catch (error) {
          totalErrors++;
          logService.warn(
            `Re-link after filter toggle failed for contact ${assignment.contact_id}`,
            "Transactions",
            {
              error: error instanceof Error ? error.message : "Unknown",
            }
          );
        }
      }

      logService.info("Address filter update + re-link complete", "Transactions", {
        transactionId: validatedTransactionId,
        skipAddressFilter,
        contactsProcessed: contactAssignments.length,
        totalEmailsLinked,
        totalMessagesLinked,
        totalAlreadyLinked,
        totalErrors,
      });

      return {
        success: true,
        contactsProcessed: contactAssignments.length,
        totalEmailsLinked,
        totalMessagesLinked,
        totalAlreadyLinked,
        totalErrors,
        addressFilterMessage,
      };
    }, { module: "Transactions" }),
  );
}
