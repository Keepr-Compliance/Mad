// ============================================
// TRANSACTION EXPORT & SUBMISSION IPC HANDLERS
// Handles: PDF export, enhanced export, folder export,
//          submission, resubmission, and sync
// ============================================

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import transactionService from "../services/transactionService";
import type { TransactionWithDetails } from "../services/transactionService";
import auditService from "../services/auditService";
import logService from "../services/logService";
import submissionService from "../services/submissionService";
import submissionSyncService from "../services/submissionSyncService";
import supabaseService from "../services/supabaseService";
import databaseService from "../services/databaseService";
import enhancedExportService from "../services/enhancedExportService";
import folderExportService from "../services/folderExportService";
// BACKLOG-1802: EXPORT is the awaited completeness backstop for auto-sync.
import { ensureTransactionEmailsSynced } from "../services/transactionSyncTrigger";
import { wrapHandler } from "../utils/wrapHandler";
import {
  enforceExportGate,
  emitExportCompleted,
} from "../services/exportGate";
import type { SubmissionProgress } from "../services/submissionService";
import type { TransactionResponse } from "../types/handlerTypes";
import type { FolderExportProgress } from "../types/ipc";
import {
  ValidationError,
  validateTransactionId,
  validateFilePath,
  sanitizeObject,
} from "../utils/validation";
import { isEmailMessage, isTextMessage } from "../utils/channelHelpers";

interface ExportOptions {
  exportFormat?: string;
  [key: string]: unknown;
}

/**
 * BACKLOG-2013 — stamp the freeze boundary on the FIRST successful export.
 *
 * Write-once: only sets `first_exported_at` when it is currently NULL, so
 * re-exports never move the boundary (the exported PDF is a snapshot; the
 * freeze anchors to the first extraction). Non-throwing — a failure to stamp
 * must never fail the export the user just performed; it is logged and the
 * next export retries. Kept in the export handler (the completion path) rather
 * than the export services so all three formats funnel through one place.
 */
async function markFirstExport(
  transactionId: string,
  currentFirstExportedAt: string | null | undefined,
): Promise<void> {
  if (currentFirstExportedAt && String(currentFirstExportedAt).trim().length > 0) {
    return; // Already frozen — boundary is immutable except via admin unfreeze.
  }
  try {
    await databaseService.updateTransaction(transactionId, {
      first_exported_at: new Date().toISOString(),
    } as any);
  } catch (err) {
    logService.warn(
      "Failed to stamp first_exported_at freeze marker (BACKLOG-2013)",
      "Transactions",
      { transactionId, error: err instanceof Error ? err.message : String(err) },
    );
  }
}

/**
 * Cleanup transaction export handlers (call on app quit)
 */
export const cleanupTransactionHandlers = (): void => {
  // Stop all submission sync (polling + realtime)
  submissionSyncService.stopAllSync();
};

/**
 * Register transaction export and submission IPC handlers
 * @param mainWindow - Main window instance
 */
export function registerTransactionExportHandlers(
  mainWindow: BrowserWindow | null,
): void {
  // Export transaction to PDF
  ipcMain.handle(
    "transactions:export-pdf",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
      outputPath?: string,
    ): Promise<TransactionResponse> => {
      logService.info("Exporting transaction to PDF", "Transactions", {
        transactionId,
      });

      // Validate inputs
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }
      const validatedPath = outputPath ? validateFilePath(outputPath) : null;

      // Get transaction details with communications
      let details = await transactionService.getTransactionDetails(
        validatedTransactionId,
      );

      if (!details) {
        return {
          success: false,
          error: "Transaction not found",
        };
      }

      // BACKLOG-1802 (founder policy): EXPORT is the AWAITED completeness backstop.
      // Force a stale-check sync of the full audit window (bypasses the freshness
      // throttle) before producing the artifact, then re-fetch so freshly-linked
      // communications are included. Non-throwing — a provider outage degrades to
      // "export what we already have".
      await ensureTransactionEmailsSynced({
        transactionId: validatedTransactionId,
        userId: details.user_id,
        reason: "export",
      });
      details = (await transactionService.getTransactionDetails(validatedTransactionId)) ?? details;

      // BACKLOG-2006a / 2075 — AUTHORITATIVE PAYWALL GATE (fail-closed, Option A).
      // A locked transaction is blocked outright (PAYWALL_LOCKED); an unlocked
      // one exports the full record. Reading is free; only export is gated.
      const pdfGate = await enforceExportGate({
        transactionId: validatedTransactionId,
        userId: details.user_id,
        communications: details.communications || [],
      });

      // Use provided output path or generate default one
      const pdfPath =
        validatedPath || folderExportService.getDefaultExportPath(details).replace(/\/$/, "") + ".pdf";

      // Generate combined PDF using folder export service
      const generatedPath = await folderExportService.exportTransactionToCombinedPDF(
        details,
        pdfGate.communications,
        pdfPath,
      );

      // BACKLOG-2006a — funnel: export-completed (main-side, non-throwing).
      await emitExportCompleted({
        userId: details.user_id,
        transactionId: validatedTransactionId,
        mode: pdfGate.decision.mode,
        format: "pdf",
      });

      // BACKLOG-2013 — stamp the freeze boundary on first successful export.
      await markFirstExport(validatedTransactionId, details.first_exported_at);

      // Audit log data export
      await auditService.log({
        userId: details.user_id,
        action: "DATA_EXPORT",
        resourceType: "EXPORT",
        resourceId: validatedTransactionId,
        metadata: {
          format: "pdf",
          propertyAddress: details.property_address,
        },
        success: true,
      });

      logService.info("PDF exported successfully", "Transactions", {
        transactionId: validatedTransactionId,
        path: generatedPath,
      });

      return {
        success: true,
        path: generatedPath,
      };
    }, { module: "Transactions" }),
  );

  // Enhanced export with options
  ipcMain.handle(
    "transactions:export-enhanced",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
      options?: unknown,
    ): Promise<TransactionResponse> => {
      logService.info("Starting enhanced export", "Transactions", {
        transactionId,
      });

      // Validate inputs
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }
      const sanitizedOptions = sanitizeObject(options || {}) as ExportOptions;

      // Get transaction details with communications
      let details = await transactionService.getTransactionDetails(
        validatedTransactionId,
      );

      if (!details) {
        return {
          success: false,
          error: "Transaction not found",
        };
      }

      // BACKLOG-1802: EXPORT completeness backstop (see export-pdf). Awaited,
      // throttle-bypassing, non-throwing; re-fetch to include freshly-linked comms.
      await ensureTransactionEmailsSynced({
        transactionId: validatedTransactionId,
        userId: details.user_id,
        reason: "export",
      });
      details = (await transactionService.getTransactionDetails(validatedTransactionId)) ?? details;

      // BACKLOG-2006a / 2075 — AUTHORITATIVE PAYWALL GATE (fail-closed, Option A).
      // Bulk export loops per-transaction through THIS handler, so gating here
      // covers bulk with zero extra work. A locked tx is blocked outright.
      const enhancedGate = await enforceExportGate({
        transactionId: validatedTransactionId,
        userId: details.user_id,
        communications: details.communications || [],
      });

      // Export with options (full record — no sample reduction under Option A)
      const exportPath = await enhancedExportService.exportTransaction(
        details,
        enhancedGate.communications,
        sanitizedOptions as any,
      );

      // Update export tracking in database
      // Note: uses `as any` to match original require()-based call that bypassed strict types
      await databaseService.updateTransaction(validatedTransactionId, {
        export_status: "exported",
        export_format: sanitizedOptions.exportFormat || "pdf",
        last_exported_on: new Date().toISOString(),
        export_count: (details.export_count || 0) + 1,
      } as any);

      // BACKLOG-2013 — stamp the freeze boundary on first successful export.
      await markFirstExport(validatedTransactionId, details.first_exported_at);

      // Audit log data export
      await auditService.log({
        userId: details.user_id,
        action: "DATA_EXPORT",
        resourceType: "EXPORT",
        resourceId: validatedTransactionId,
        metadata: {
          format: sanitizedOptions.exportFormat || "pdf",
          propertyAddress: details.property_address,
        },
        success: true,
      });

      // BACKLOG-2006a — funnel: export-completed (main-side, non-throwing).
      await emitExportCompleted({
        userId: details.user_id,
        transactionId: validatedTransactionId,
        mode: enhancedGate.decision.mode,
        format: sanitizedOptions.exportFormat || "pdf",
      });

      logService.info("Enhanced export successful", "Transactions", {
        transactionId: validatedTransactionId,
        format: sanitizedOptions.exportFormat || "pdf",
        path: exportPath,
      });

      return {
        success: true,
        path: exportPath,
      };
    }, { module: "Transactions" }),
  );

  // Export transaction to organized folder structure
  ipcMain.handle(
    "transactions:export-folder",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
      options?: unknown,
    ): Promise<TransactionResponse> => {
      logService.info("Starting folder export", "Transactions", {
        transactionId,
      });

      // Validate inputs
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }
      const sanitizedOptions = sanitizeObject(options || {}) as {
        includeEmails?: boolean;
        includeTexts?: boolean;
        includeAttachments?: boolean;
        emailExportMode?: "thread" | "individual";
        contentType?: "both" | "emails" | "texts";
        attachmentType?: "all" | "email" | "text" | "none";
      };

      // Get transaction details with communications
      let details = await transactionService.getTransactionDetails(
        validatedTransactionId,
      );

      if (!details) {
        return {
          success: false,
          error: "Transaction not found",
        };
      }

      // BACKLOG-1802: EXPORT completeness backstop (see export-pdf). Awaited,
      // throttle-bypassing, non-throwing; re-fetch to include freshly-linked comms.
      await ensureTransactionEmailsSynced({
        transactionId: validatedTransactionId,
        userId: details.user_id,
        reason: "export",
      });
      details = (await transactionService.getTransactionDetails(validatedTransactionId)) ?? details;

      // Filter communications by date range if transaction has dates set
      let communications = details.communications || [];
      const startDate = details.started_at;
      const endDate = details.closed_at;

      if (startDate || endDate) {
        const start = startDate ? new Date(startDate as string) : null;
        const end = endDate ? new Date(endDate as string) : null;
        // Add a day to end date to include messages on the closing day
        if (end) end.setDate(end.getDate() + 1);

        communications = communications.filter((comm: any) => {
          const commDate = new Date(comm.sent_at || comm.received_at);
          if (start && commDate < start) return false;
          if (end && commDate > end) return false;
          return true;
        });

        logService.info("Filtered communications by date range", "Transactions", {
          original: (details.communications || []).length,
          filtered: communications.length,
          startDate: startDate,
          endDate: endDate,
        });
      }

      // Filter communications by content type (emails only / texts only)
      const contentTypeFilter = sanitizedOptions.contentType || "both";
      if (contentTypeFilter !== "both") {
        const beforeFilter = communications.length;
        if (contentTypeFilter === "emails") {
          communications = communications.filter((comm: any) => isEmailMessage(comm));
        } else if (contentTypeFilter === "texts") {
          communications = communications.filter((comm: any) => isTextMessage(comm));
        }
        logService.info("Filtered communications by content type", "Transactions", {
          contentType: contentTypeFilter,
          before: beforeFilter,
          after: communications.length,
        });

        // Return early with a helpful message if no communications match the filter
        if (communications.length === 0) {
          const typeLabel = contentTypeFilter === "emails" ? "email" : "text";
          return {
            success: false,
            error: `No ${typeLabel} communications found for this transaction in the selected date range.`,
          };
        }
      }

      // BACKLOG-2006a / 2075 — AUTHORITATIVE PAYWALL GATE (fail-closed, Option A).
      // Applied to the already date/content-filtered set. A locked tx is blocked
      // outright; an unlocked one exports the full (filtered) record.
      const folderGate = await enforceExportGate({
        transactionId: validatedTransactionId,
        userId: details.user_id,
        communications,
      });
      communications = folderGate.communications as typeof communications;

      // Export to folder structure
      const exportPath = await folderExportService.exportTransactionToFolder(
        details,
        communications,
        {
          transactionId: validatedTransactionId,
          includeEmails: sanitizedOptions.includeEmails ?? true,
          includeTexts: sanitizedOptions.includeTexts ?? true,
          includeAttachments: sanitizedOptions.includeAttachments ?? true,
          attachmentType: sanitizedOptions.attachmentType ?? "all",
          emailExportMode: sanitizedOptions.emailExportMode,
          onProgress: (progress: FolderExportProgress) => {
            // Send progress updates to renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(
                "transactions:export-folder-progress",
                progress,
              );
            }
          },
        },
      );

      // Update export tracking in database
      // Note: export_format constraint doesn't include "folder", so we use NULL
      // Note: uses `as any` to match original require()-based call that bypassed strict types
      await databaseService.updateTransaction(validatedTransactionId, {
        export_status: "exported",
        last_exported_on: new Date().toISOString(),
        export_count: (details.export_count || 0) + 1,
      } as any);

      // BACKLOG-2013 — stamp the freeze boundary on first successful export.
      await markFirstExport(validatedTransactionId, details.first_exported_at);

      // Audit log data export
      await auditService.log({
        userId: details.user_id,
        action: "DATA_EXPORT",
        resourceType: "EXPORT",
        resourceId: validatedTransactionId,
        metadata: {
          format: "folder",
          propertyAddress: details.property_address,
        },
        success: true,
      });

      // BACKLOG-2006a — funnel: export-completed (main-side, non-throwing).
      await emitExportCompleted({
        userId: details.user_id,
        transactionId: validatedTransactionId,
        mode: folderGate.decision.mode,
        format: "folder",
      });

      logService.info("Folder export successful", "Transactions", {
        transactionId: validatedTransactionId,
        path: exportPath,
      });

      return {
        success: true,
        path: exportPath,
      };
    }, { module: "Transactions" }),
  );

  // ============================================
  // SUBMISSION HANDLERS (BACKLOG-391)
  // ============================================

  // Submit transaction to broker portal for review
  ipcMain.handle(
    "transactions:submit",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Submitting transaction for broker review", "Transactions", {
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

      // Track progress via IPC events
      const result = await submissionService.submitTransaction(
        validatedTransactionId,
        (progress: SubmissionProgress) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("transactions:submit-progress", progress);
          }
        }
      );

      if (result.success) {
        // Audit log submission
        const transaction = await transactionService.getTransactionDetails(
          validatedTransactionId
        );
        await auditService.log({
          userId: transaction?.user_id || "unknown",
          action: "TRANSACTION_SUBMIT",
          resourceType: "SUBMISSION",
          resourceId: result.submissionId || validatedTransactionId,
          metadata: {
            propertyAddress: transaction?.property_address,
            messagesCount: result.messagesCount,
            attachmentsCount: result.attachmentsCount,
          },
          success: true,
        });

        logService.info("Transaction submitted successfully", "Transactions", {
          transactionId: validatedTransactionId,
          submissionId: result.submissionId,
          messagesCount: result.messagesCount,
          attachmentsCount: result.attachmentsCount,
        });
      }

      return {
        success: result.success,
        submissionId: result.submissionId,
        messagesCount: result.messagesCount,
        attachmentsCount: result.attachmentsCount,
        attachmentsFailed: result.attachmentsFailed,
        error: result.error,
      };
    }, { module: "Transactions" }),
  );

  // Resubmit transaction (creates new version)
  ipcMain.handle(
    "transactions:resubmit",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Resubmitting transaction for broker review", "Transactions", {
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

      // Track progress via IPC events
      const result = await submissionService.resubmitTransaction(
        validatedTransactionId,
        (progress: SubmissionProgress) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("transactions:submit-progress", progress);
          }
        }
      );

      if (result.success) {
        logService.info("Transaction resubmitted successfully", "Transactions", {
          transactionId: validatedTransactionId,
          submissionId: result.submissionId,
        });
      }

      return {
        success: result.success,
        submissionId: result.submissionId,
        messagesCount: result.messagesCount,
        attachmentsCount: result.attachmentsCount,
        attachmentsFailed: result.attachmentsFailed,
        error: result.error,
      };
    }, { module: "Transactions" }),
  );

  // Get submission status from cloud
  ipcMain.handle(
    "transactions:get-submission-status",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      submissionId: string,
    ): Promise<TransactionResponse> => {
      if (!submissionId || typeof submissionId !== "string") {
        throw new ValidationError(
          "Submission ID is required",
          "submissionId",
        );
      }

      const status = await submissionService.getSubmissionStatus(submissionId);

      if (!status) {
        return {
          success: false,
          error: "Submission not found",
        };
      }

      return {
        success: true,
        status: status.status,
        reviewNotes: status.review_notes,
        reviewedBy: status.reviewed_by,
        reviewedAt: status.reviewed_at,
      };
    }, { module: "Transactions" }),
  );

  // ============================================
  // SYNC HANDLERS (BACKLOG-395)
  // ============================================

  // Set main window reference for sync service and start sync
  if (mainWindow) {
    submissionSyncService.setMainWindow(mainWindow);
    // Start periodic sync with 1 minute interval (fallback for missed realtime events)
    submissionSyncService.startPeriodicSync(60000);
    // Start realtime subscription for instant status change notifications
    supabaseService.getAuthSession().then((session) => {
      if (session?.userId) {
        submissionSyncService.startRealtimeSubscription(session.userId);
      }
    }).catch((err) => {
      logService.error("Failed to start realtime subscription", "SubmissionSync", { error: String(err) });
    });
  }

  // Sync all submission statuses from cloud
  ipcMain.handle(
    "transactions:sync-submissions",
    wrapHandler(async (): Promise<TransactionResponse> => {
      logService.info("Manual sync triggered", "SubmissionSync");

      const result = await submissionSyncService.syncAllSubmissions();

      logService.info("Manual sync complete", "SubmissionSync", {
        updated: result.updated,
        failed: result.failed,
      });

      return {
        success: true,
        updated: result.updated,
        failed: result.failed,
        details: result.details,
      };
    }, { module: "SubmissionSync" }),
  );

  // Sync a specific transaction's submission status
  ipcMain.handle(
    "transactions:sync-submission",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      const wasUpdated = await submissionSyncService.syncSubmission(validatedTransactionId);

      return {
        success: true,
        updated: wasUpdated,
      };
    }, { module: "SubmissionSync" }),
  );
}
