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
// BACKLOG-2313: authoritative auto-detect gate dependencies.
import featureGateService from "../services/featureGateService";
import llmConfigService from "../services/llm/llmConfigService";
import { resolveOrgId } from "./featureGateHandlers";
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
import {
  EMAIL_PRECACHE_PROGRESS_CHANNEL,
  type EmailPrecacheProgressCallback,
} from "../services/emailPrecacheProgress";

interface ScanOptions {
  onProgress?: (progress: unknown) => void;
  [key: string]: unknown;
}

/**
 * BACKLOG-2313: Authoritative main-process gate for the automatic transaction
 * auto-detect scan.
 *
 * The scan (`transactions:scan` → transactionService.scanAndExtractTransactions)
 * creates "pending" transactions from an email address/pattern sweep. It must run
 * ONLY when BOTH are true:
 *   1. Local opt-in — the user's `enable_auto_detect` toggle is ON.
 *   2. Entitlement — the user's org is entitled to `ai_detection` (admin/plan
 *      controlled). No-org (individual) users are DENIED, mirroring the
 *      TEAM_ONLY_FEATURES deny in featureGateHandlers.
 *
 * This lives in the MAIN process because the same `transactions:scan` handler
 * serves BOTH the automatic dashboard sync path and the manual "Scan" button, and
 * the renderer is spoofable — so this check is the source of truth. The email
 * PRECACHE (`emails:precache`) is intentionally NOT gated and keeps running for
 * every user.
 *
 * Fail-CLOSED: if entitlement/opt-in cannot be positively confirmed (e.g. a DB
 * error), deny the scan so no unwanted transactions are created. (Precache is
 * unaffected by this gate.)
 */
export async function isAutoDetectAllowed(userId: string): Promise<boolean> {
  try {
    // 1. Local opt-in toggle (cheap, no network) — deny early when off.
    const config = await llmConfigService.getUserConfig(userId);
    if (!config.autoDetectEnabled) {
      return false;
    }

    // 2. Entitlement. No org => individual user => denied (ai_detection is a
    //    team/enterprise feature), mirroring featureGateHandlers.
    const orgId = await resolveOrgId();
    if (!orgId) {
      return false;
    }

    const access = await featureGateService.checkFeature(orgId, "ai_detection");
    return access.allowed === true;
  } catch (error) {
    logService.warn(
      "[BACKLOG-2313] Auto-detect gate check failed — denying scan (fail-closed)",
      "Transactions",
      { error: error instanceof Error ? error.message : "Unknown error" },
    );
    return false;
  }
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

      // BACKLOG-2313: authoritative auto-detect gate. Unless the user is BOTH
      // entitled to ai_detection AND has opted in via enable_auto_detect, do NOT
      // run the scan — return a clean, empty result so ZERO pending transactions
      // are created. This handler backs both the automatic dashboard sync and the
      // manual Scan button; the renderer is spoofable, so this is the source of
      // truth. Email precache (emails:precache) is separate and stays ungated.
      const autoDetectAllowed = await isAutoDetectAllowed(validatedUserId);
      if (!autoDetectAllowed) {
        logService.info(
          "[BACKLOG-2313] Transaction scan skipped — ai_detection not entitled/enabled",
          "Transactions",
          { userId: validatedUserId },
        );
        return {
          success: true,
          transactionsFound: 0,
          emailsScanned: 0,
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
      force?: unknown,
    ): Promise<TransactionResponse> => {
      // BACKLOG-2856: coerced to a STRICT boolean, never passed through as
      // whatever crossed the IPC boundary. This flag is the difference between
      // "fetch new mail" and "delete and rebuild this mailbox", so anything
      // truthy-but-not-true (a stray string, an object) must read as false.
      const forceRecache = force === true;
      logService.info("Email pre-cache requested", "Transactions", { userId, force: forceRecache });

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

      // BACKLOG-2856: forward progress to the renderer, the same shape and the
      // same transport the macOS Messages import uses (messageImportHandlers).
      // Until this callback existed, `precacheEmails` emitted progress into
      // `undefined` from every caller in the tree — the marks have been in the
      // service since BACKLOG-1362 and nothing has ever listened, which is why a
      // re-cache looked hung rather than slow.
      const onProgress: EmailPrecacheProgressCallback = (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(EMAIL_PRECACHE_PROGRESS_CHANNEL, progress);
        }
      };

      const result = await emailSyncService.precacheEmails(validatedUserId, onProgress, {
        force: forceRecache,
      });

      // BACKLOG-2856: a cancelled run is neither a success nor an error.
      //
      // Checked BEFORE `result.error` because the two can never both be set and
      // the ordering makes that explicit: a cancel returns no error, precisely so
      // this branch cannot paint the user's own decision red. `success: false`
      // keeps it off the green path — nothing was re-cached — while `cancelled`
      // lets the panel say so in neutral terms.
      if (result.cancelled) {
        return {
          success: false,
          cancelled: true,
          error: "Re-cache cancelled. Your emails were left unchanged.",
          emailsFetched: result.fetched,
          emailsStored: result.stored,
        };
      }

      // BACKLOG-2856: a run that changed NOTHING must not report success.
      //
      // This return used to be an unconditional `{ success: true, … }`, which was
      // survivable while the only failure signal was `providerError`. It stopped
      // being survivable when the force path gained two paths that decline to
      // swap — no provider rebuilt, and a throw inside the swap. Both leave the
      // user's mail exactly as it was and both set `error`; dropping it here
      // printed a GREEN "Re-cached 47 emails … unlinked from their transactions"
      // over a run that deleted nothing and unlinked nothing, sending the user
      // off to re-attach mail that was never detached. Checked FIRST so the
      // specific message wins over the generic token-expiry branch below, which
      // the no-provider-rebuilt path can also satisfy.
      if (result.error) {
        return {
          success: false,
          error: result.error,
          ...(result.providerError ? { providerError: result.providerError } : {}),
          emailsFetched: result.fetched,
          emailsStored: result.stored,
        };
      }

      // BACKLOG-2127: when a provider's token is dead, do NOT report an
      // unconditional success — forward the structured providerError so the
      // renderer sync flow can raise a reconnect prompt instead of showing a
      // green "0 new messages". Counts are still returned (other provider may
      // have succeeded).
      if (result.providerError?.tokenExpired) {
        return {
          success: false,
          providerError: result.providerError,
          emailsFetched: result.fetched,
          emailsStored: result.stored,
        };
      }

      return {
        success: true,
        emailsFetched: result.fetched,
        emailsStored: result.stored,
        // BACKLOG-2856: forwarded so the renderer can report what actually
        // LANDED. `stored` counts rows written to STAGING, which on a force run
        // is what was fetched — not what survived the swap — and `providers`
        // is how the UI knows a connected mailbox was skipped.
        ...(result.forceSwap ? { forceSwap: result.forceSwap } : {}),
      };
    }, { module: "Transactions" }),
  );

  // ============================================
  // BACKLOG-2856: cancel an in-flight email pre-cache / re-cache.
  //
  // Parity with the macOS Messages import, which has had a cancel since
  // BACKLOG-2775. The email path already handled cancellation safely — staging
  // is dropped on every exit and live is untouched until the swap — but nothing
  // could TRIGGER one, so the safety net existed with no control attached to it.
  //
  // Deliberately NOT rate limited: this is the button a user reaches for when
  // they think the app is stuck, and refusing it for 30 seconds would be the
  // worst possible moment to say no.
  // ============================================
  ipcMain.handle(
    "emails:cancel-precache",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
    ): Promise<TransactionResponse> => {
      const cancelling = emailSyncService.requestPrecacheCancellation();
      logService.info("Email pre-cache cancellation requested via IPC", "Transactions", {
        cancelling,
      });
      // `success` reports whether a run was actually asked to stop. False is not
      // an error — it means the run had already finished, which from the user's
      // point of view is the same outcome they wanted.
      return { success: cancelling };
    }, { module: "Transactions" }),
  );
}
