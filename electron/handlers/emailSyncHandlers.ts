// ============================================
// EMAIL SYNC IPC HANDLERS
// Handles: cancel-scan, scan, sync-and-fetch-emails
//
// TASK-2065: Linking handlers extracted to emailLinkingHandlers.ts
// TASK-2065: Auto-link handlers extracted to emailAutoLinkHandlers.ts
// TASK-2066: Sync orchestration extracted to emailSyncService.ts
//            Handler is now a thin wrapper (validation + rate limit + delegate)
// ============================================

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import * as Sentry from "@sentry/electron/main";
import transactionService from "../services/transactionService";
import logService from "../services/logService";
import {
  getEmailsByContactId,
} from "../services/db/contactDbService";
import emailSyncService from "../services/emailSyncService";
// BACKLOG-1802: after detection, auto-fetch each transaction's full audit window.
import { triggerBatchTransactionSyncInBackground } from "../services/transactionSyncTrigger";
import { wrapHandler } from "../utils/wrapHandler";
import type { TransactionResponse } from "../types/handlerTypes";
import {
  ValidationError,
  validateUserId,
  validateTransactionId,
  sanitizeObject,
} from "../utils/validation";
import { rateLimiters } from "../utils/rateLimit";

interface ScanOptions {
  onProgress?: (progress: unknown) => void;
  [key: string]: unknown;
}

// TASK-2066: Re-export constants and helpers from service for backwards compatibility.
// Other files (e.g., tests) may import these from this module.
export { EMAIL_FETCH_SAFETY_CAP, SENT_ITEMS_SAFETY_CAP } from "../services/emailSyncService";

// TASK-2068: Re-export from canonical utility for backwards compatibility.
// The implementation now lives in electron/utils/emailDateRange.ts.
export { computeEmailFetchSinceDate } from "../utils/emailDateRange";

/**
 * Register email sync IPC handlers (scan + sync-and-fetch)
 * @param mainWindow - Main window instance
 */
export function registerEmailSyncHandlers(
  mainWindow: BrowserWindow | null,
): void {
  // Cancel ongoing scan
  ipcMain.handle(
    "transactions:cancel-scan",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<TransactionResponse> => {
      Sentry.addBreadcrumb({
        category: 'sync',
        message: 'Cancel scan handler invoked',
        level: 'info',
        data: { handler: 'cancel-scan', sync_type: 'email' },
      });

      logService.info("Cancelling transaction scan", "Transactions", {
        userId,
      });

      // Validate input
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }

      const cancelled = transactionService.cancelScan(validatedUserId);

      return {
        success: true,
        cancelled,
      };
    }, { module: "Transactions" }),
  );

  // Scan and extract transactions from emails
  // Rate limited: 5 second cooldown per user to prevent scan spam.
  // Scans hit external email APIs (Gmail, Outlook).
  ipcMain.handle(
    "transactions:scan",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      userId: string,
      options?: unknown,
    ): Promise<TransactionResponse> => {
      Sentry.addBreadcrumb({
        category: 'sync',
        message: 'Transaction scan handler invoked',
        level: 'info',
        data: { handler: 'scan', sync_type: 'email' },
      });

      logService.info("Starting transaction scan", "Transactions", {
        userId,
      });

      // Validate input
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }

      // Rate limit check - 5 second cooldown per user
      const { allowed, remainingMs } = rateLimiters.scan.canExecute(
        "transactions:scan",
        validatedUserId
      );
      if (!allowed && remainingMs !== undefined) {
        const seconds = Math.ceil(remainingMs / 1000);
        logService.warn(
          `Rate limited transactions:scan for user ${validatedUserId}. Retry in ${seconds}s`,
          "Transactions"
        );
        return {
          success: false,
          error: `Please wait ${seconds} seconds before starting another scan.`,
          rateLimited: true,
        };
      }

      const sanitizedOptions = sanitizeObject(options || {}) as ScanOptions;

      const result = await transactionService.scanAndExtractTransactions(
        validatedUserId,
        {
          ...sanitizedOptions,
          onProgress: (progress: unknown) => {
            // Send progress updates to renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(
                "transactions:scan-progress",
                progress,
              );
            }
          },
        },
      );

      logService.info("Transaction scan complete", "Transactions", {
        userId: validatedUserId,
        transactionsFound: result.transactionsFound,
        emailsScanned: result.emailsScanned,
      });

      Sentry.addBreadcrumb({
        category: 'sync',
        message: 'Transaction scan completed',
        level: 'info',
        data: {
          handler: 'scan',
          sync_type: 'email',
          transactionsFound: result.transactionsFound,
          emailsScanned: result.emailsScanned,
        },
      });

      // BACKLOG-1802 (founder policy): the detection scan only caches within the
      // blind 3-month precache window, so a fresh install links a fraction of each
      // transaction's emails (the 18/69 slice). Auto-fetch every detected
      // transaction's FULL audit window in the background — bounded concurrency so
      // many detections don't storm Graph — so the user ends up complete without
      // ever clicking "Sync".
      if (result.transactions && result.transactions.length > 0) {
        triggerBatchTransactionSyncInBackground(
          result.transactions.map((t) => ({ transactionId: t.id, userId: validatedUserId })),
          "scan",
          2,
        );
      }

      return {
        ...result,
      };
    }, { module: "Transactions" }),
  );

  // ============================================
  // SYNC FROM PROVIDER HANDLER (BACKLOG-457)
  // TASK-2066: Thin wrapper -- orchestration in emailSyncService.ts
  // ============================================

  // Sync emails from email provider (Gmail/Outlook) for a transaction
  // This fetches NEW emails from the provider, stores them, then runs auto-link
  // Rate limited: 10 second cooldown per transaction to prevent sync spam.
  ipcMain.handle(
    "transactions:sync-and-fetch-emails",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Sync and fetch emails for transaction", "Transactions", {
        transactionId,
      });

      Sentry.addBreadcrumb({
        category: 'sync',
        message: 'sync-and-fetch-emails started',
        level: 'info',
        data: {
          operation: 'sync-and-fetch-emails',
          transactionId,
        },
      });

      // Validate transaction ID
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      // Rate limit check - 10 second cooldown per transaction
      const { allowed, remainingMs } = rateLimiters.sync.canExecute(
        "transactions:sync-and-fetch-emails",
        validatedTransactionId
      );
      if (!allowed && remainingMs !== undefined) {
        const seconds = Math.ceil(remainingMs / 1000);
        logService.warn(
          `Rate limited transactions:sync-and-fetch-emails for transaction ${validatedTransactionId}. Retry in ${seconds}s`,
          "Transactions"
        );
        return {
          success: false,
          error: `Please wait ${seconds}s before syncing again.`,
          rateLimited: true,
        };
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

      const userId = transactionDetails.user_id;
      const contactAssignments = transactionDetails.contact_assignments || [];

      if (contactAssignments.length === 0) {
        return {
          success: true,
          message: "No contacts to sync",
          emailsFetched: 0,
          emailsStored: 0,
          totalEmailsLinked: 0,
          totalMessagesLinked: 0,
        };
      }

      // Collect all contact emails
      const contactEmails: string[] = [];
      for (const assignment of contactAssignments) {
        const emails = getEmailsByContactId(assignment.contact_id);
        logService.info(`Contact ${assignment.contact_id}: found ${emails.length} emails in contact_emails`, "Transactions", {
          emails,
        });
        for (const email of emails) {
          if (email && !contactEmails.includes(email.toLowerCase())) {
            contactEmails.push(email.toLowerCase());
          }
        }
      }

      logService.info(`Total contact emails for sync: ${contactEmails.length}`, "Transactions", {
        contactEmails,
      });

      Sentry.addBreadcrumb({
        category: 'sync',
        message: 'Delegating to EmailSyncService for sync orchestration',
        level: 'info',
        data: {
          handler: 'sync-and-fetch-emails',
          sync_type: 'email',
          transactionId: validatedTransactionId,
          contactEmailCount: contactEmails.length,
        },
      });

      // TASK-2066: Delegate to EmailSyncService for full orchestration
      // BACKLOG-1802: the user explicitly clicked "Sync Emails" → tag ingest_source='manual'.
      return emailSyncService.syncTransactionEmails({
        transactionId: validatedTransactionId,
        userId,
        contactAssignments,
        contactEmails,
        transactionDetails,
        ingestSourceOverride: "manual",
      });
    }, { module: "Transactions" }),
  );

  // ============================================
  // BACKLOG-1362: Email pre-cache handler
  // Bulk-fetches emails from connected providers into local cache.
  // Rate limited: 30 second cooldown to prevent abuse.
  // ============================================
  ipcMain.handle(
    "emails:precache",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Email pre-cache requested", "Transactions", { userId });

      // Validate input
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }

      // Rate limit check - 30 second cooldown per user
      const { allowed, remainingMs } = rateLimiters.precache.canExecute(
        "emails:precache",
        validatedUserId,
      );
      if (!allowed && remainingMs !== undefined) {
        const seconds = Math.ceil(remainingMs / 1000);
        logService.warn(
          `Rate limited emails:precache for user ${validatedUserId}. Retry in ${seconds}s`,
          "Transactions",
        );
        return {
          success: false,
          error: `Please wait ${seconds} seconds before re-caching.`,
          rateLimited: true,
        };
      }

      const result = await emailSyncService.precacheEmails(validatedUserId);

      return {
        success: true,
        emailsFetched: result.fetched,
        emailsStored: result.stored,
      };
    }, { module: "Transactions" }),
  );
}
