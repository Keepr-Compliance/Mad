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
// BACKLOG-2292: EXPORT is also the awaited completeness backstop for TEXTS
// (Layer 3). Non-throwing; the renderer ExportModal is the primary prompt.
import { ensureTransactionMessagesSynced } from "../services/messagesSyncTrigger";
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
// BACKLOG-2771: ONE resolver decides what every format includes. The date and
// content filters that used to be written out inline in this file (once here,
// once again inside enhancedExportService) now live in exportPlan.ts.
import {
  resolveExportPlan,
  normalizeAttachmentType,
  normalizeContentType,
  normalizeEmailMode,
  type ExportPlanRequest,
} from "../services/exportPlan";

interface ExportOptions {
  exportFormat?: string;
  [key: string]: unknown;
}

/**
 * BACKLOG-2013 — stamp the freeze boundary on the FIRST successful export.
 *
 * Write-once: the marker is only set when it is currently NULL, so re-exports
 * never move the boundary (the exported PDF is a snapshot; the freeze anchors
 * to the first extraction). Enforcement lives in SQL — `stampFirstExportedAt`
 * runs `UPDATE ... WHERE first_exported_at IS NULL` — so the write-once rule
 * holds even against a racing export, not just by caller convention. The
 * in-memory `currentFirstExportedAt` short-circuit is a cheap fast-path only.
 * Non-throwing — a failure to stamp must never fail the export the user just
 * performed; it is logged and the next export retries. Kept in the export
 * handler (the completion path) rather than the export services so all three
 * formats funnel through one place.
 */
async function markFirstExport(
  transactionId: string,
  currentFirstExportedAt: string | null | undefined,
): Promise<void> {
  if (currentFirstExportedAt && String(currentFirstExportedAt).trim().length > 0) {
    return; // Already frozen — boundary is immutable except via admin unfreeze.
  }
  try {
    databaseService.stampFirstExportedAt(
      transactionId,
      new Date().toISOString(),
    );
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
      // BACKLOG-2292 (Layer 3 backstop): also awaited + non-throwing for TEXTS.
      // Imports older messages when the audit start predates the imported floor,
      // then expands attached threads. The single getTransactionDetails re-fetch
      // below picks up both freshly-linked emails AND texts. This is the last
      // line of defense — the renderer ExportModal gate is the primary prompt.
      await ensureTransactionMessagesSynced({
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

      // BACKLOG-2771: this channel goes through the SAME resolver as the other
      // two. It has no renderer caller (`window.api.transactions.exportPDF` is
      // referenced nowhere in src/) and takes no options, so it requests no
      // audit window and no attachments — the resolver returns the full record,
      // which is exactly what this channel produced when it had no filtering of
      // its own. Its include set is now stated rather than merely absent.
      const pdfPlan = resolveExportPlan(
        {
          format: "pdf",
          contentType: "both",
          attachmentType: "none",
          emailMode: "thread",
        },
        pdfGate.communications,
      );

      // Use provided output path or generate default one
      const pdfPath =
        validatedPath || folderExportService.getDefaultExportPath(details).replace(/\/$/, "") + ".pdf";

      // Generate combined PDF using folder export service
      const generatedPath = await folderExportService.exportTransactionToCombinedPDF(
        details,
        pdfPlan.communications,
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
      // BACKLOG-2292 (Layer 3 backstop): also awaited + non-throwing for TEXTS.
      // Imports older messages when the audit start predates the imported floor,
      // then expands attached threads. The single getTransactionDetails re-fetch
      // below picks up both freshly-linked emails AND texts. This is the last
      // line of defense — the renderer ExportModal gate is the primary prompt.
      await ensureTransactionMessagesSynced({
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

      // BACKLOG-2771: the SAME resolver the folder handler uses. The audit
      // window prefers the explicit option dates and falls back to the
      // transaction's — that per-entry-point difference lives in the REQUEST,
      // not in a second copy of the filter.
      const enhancedFormat = sanitizedOptions.exportFormat;
      const enhancedPlan = resolveExportPlan(
        {
          format:
            enhancedFormat === "csv" ||
            enhancedFormat === "excel" ||
            enhancedFormat === "json" ||
            enhancedFormat === "txt_eml"
              ? enhancedFormat
              : "pdf",
          contentType: normalizeContentType(sanitizedOptions.contentType),
          attachmentType: normalizeAttachmentType(sanitizedOptions.attachmentType, "none"),
          emailMode: normalizeEmailMode(sanitizedOptions.emailExportMode),
          startDate:
            (sanitizedOptions.startDate as string | undefined) ||
            (details.started_at as string | undefined),
          endDate:
            (sanitizedOptions.endDate as string | undefined) ||
            (details.closed_at as string | undefined),
          summaryOnly: sanitizedOptions.summaryOnly === true,
        },
        enhancedGate.communications,
      );

      // Export with options (full record — no sample reduction under Option A)
      const exportPath = await enhancedExportService.exportTransaction(
        details,
        enhancedPlan,
        {
          exportFormat: enhancedFormat as
            | "pdf"
            | "excel"
            | "csv"
            | "json"
            | "txt_eml"
            | undefined,
          summaryOnly: sanitizedOptions.summaryOnly === true,
        },
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
      const sanitizedOptions = sanitizeObject(options || {}) as Record<string, unknown>;

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
      // BACKLOG-2292 (Layer 3 backstop): also awaited + non-throwing for TEXTS.
      // Imports older messages when the audit start predates the imported floor,
      // then expands attached threads. The single getTransactionDetails re-fetch
      // below picks up both freshly-linked emails AND texts. This is the last
      // line of defense — the renderer ExportModal gate is the primary prompt.
      await ensureTransactionMessagesSynced({
        transactionId: validatedTransactionId,
        userId: details.user_id,
        reason: "export",
      });
      details = (await transactionService.getTransactionDetails(validatedTransactionId)) ?? details;

      // BACKLOG-2771: ONE resolver decides the include set. The audit window is
      // the transaction's own dates (the ExportModal saves them immediately
      // before invoking this channel); the folder wire carries no explicit
      // window.
      const folderContentType = normalizeContentType(sanitizedOptions.contentType);
      const folderRequest: ExportPlanRequest = {
        format: "folder",
        contentType: folderContentType,
        attachmentType: normalizeAttachmentType(sanitizedOptions.attachmentType, "all"),
        emailMode: normalizeEmailMode(sanitizedOptions.emailExportMode),
        startDate: details.started_at as string | null | undefined,
        endDate: details.closed_at as string | null | undefined,
      };
      let folderPlan = resolveExportPlan(folderRequest, details.communications || []);
      const communications = folderPlan.communications;

      logService.info("Resolved folder export include set", "Transactions", {
        original: (details.communications || []).length,
        included: communications.length,
        contentType: folderContentType,
        startDate: details.started_at,
        endDate: details.closed_at,
        writesAttachmentsToDisk: folderPlan.writesAttachmentsToDisk,
      });

      // Return early with a helpful message if a narrowed content selection
      // matched nothing. Unchanged: fires only for a narrowed selection, and
      // only after the date window has been applied.
      if (folderContentType !== "both" && communications.length === 0) {
        const typeLabel = folderContentType === "emails" ? "email" : "text";
        return {
          success: false,
          error: `No ${typeLabel} communications found for this transaction in the selected date range.`,
        };
      }

      // BACKLOG-2006a / 2075 — AUTHORITATIVE PAYWALL GATE (fail-closed, Option A).
      // Applied to the already date/content-filtered set. A locked tx is blocked
      // outright; an unlocked one exports the full (filtered) record.
      const folderGate = await enforceExportGate({
        transactionId: validatedTransactionId,
        userId: details.user_id,
        communications,
      });
      // Re-resolve over whatever the gate permitted, so `attachmentComms` can
      // never reference a communication the gate removed. Filtering is
      // idempotent — over an already-resolved set this is a no-op today (Option
      // A returns the input unchanged) and stays correct if that ever changes.
      folderPlan = resolveExportPlan(folderRequest, folderGate.communications);

      // Export to folder structure
      const exportPath = await folderExportService.exportTransactionToFolder(
        details,
        folderPlan,
        {
          transactionId: validatedTransactionId,
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
        // BACKLOG-2563: audit the resubmission, mirroring `transactions:submit`
        // above. This handler already wrote a `logService.info` line, which is
        // why the omission survived review — that goes to the APPLICATION log,
        // never to `audit_logs`, so it reaches neither the CCPA/SOC2 export nor
        // the Supabase sync. The trail recorded the first submission to the
        // broker and silently dropped every resubmission of the same package.
        //
        // ## Why TRANSACTION_SUBMIT and not a new RESUBMIT verb
        //
        // `audit_logs.action` carries a CHECK listing the permitted verbs
        // (schema.sql) and no RESUBMIT verb is among them. SQLite cannot ALTER
        // a CHECK, so adding one means rebuilding an append-only compliance
        // table — and getting it wrong is SILENT: `auditService.log` swallows
        // write failures by design, so an unpermitted verb would throw inside
        // the catch, write nothing, and still return success. The resubmit
        // would look audited and the trail would be empty, which is the very
        // defect this change closes.
        //
        // So the verb stays inside the permitted set and `metadata.reason`
        // names the specific act — the idiom BACKLOG-2365 established for
        // contact removal and the contact-restore audit reuses.
        const transaction = await transactionService.getTransactionDetails(
          validatedTransactionId
        );
        await auditService.log({
          userId: transaction?.user_id || "unknown",
          action: "TRANSACTION_SUBMIT",
          resourceType: "SUBMISSION",
          resourceId: result.submissionId || validatedTransactionId,
          metadata: {
            reason: "resubmit",
            // `resourceId` above is the SUBMISSION id, and a resubmission gets a
            // NEW one — so without this the row cannot be joined back to the
            // deal it concerns. `propertyAddress` is a display string, not a key.
            transactionId: validatedTransactionId,
            propertyAddress: transaction?.property_address,
            messagesCount: result.messagesCount,
            attachmentsCount: result.attachmentsCount,
          },
          success: true,
        });

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
