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
import { emitExportCompleted } from "../services/exportGate";
// BACKLOG-3733: load → paywall gate → resolve, in ONE shared function.
import { prepareTransactionCommunications } from "../services/transactionCommunicationSet";
import type {
  SubmissionProgress,
  SubmissionResult,
  SubmitOptions,
} from "../services/submissionService";
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
  normalizeAttachmentType,
  normalizeContentType,
  normalizeEmailMode,
} from "../services/exportPlan";

import { sendToMainWindow } from "../windowRegistry";
import { handleBusy } from "../utils/busyIpc";
import { rememberOpenablePath } from "../services/openablePaths";

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
 * performed; it is logged and the next export retries.
 *
 * BACKLOG-2549 — THIS IS NO LONGER A SHARED FUNNEL, and the sentence that said
 * so has been removed rather than left to read as live. Only
 * `transactions:export-pdf` still calls this. The enhanced and folder paths
 * fold the stamp into their single export-completion UPDATE
 * (`recordExportCompletion`, write-once via `COALESCE`), because writing the
 * marker separately from `export_status` left a window in which a deal was
 * exported and still editable.
 *
 * What the swallow means on the one path that remains: a stamp failure is still
 * silent here. It cannot produce that window, because the PDF path never sets
 * `export_status` at all — it produces the INVERSE state (frozen, artifact on
 * disk, still reading as `not_exported`), which is a separate defect reported
 * out of BACKLOG-2549 and deliberately not changed here.
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
 * @param _mainWindow - Main window instance. No push reads it any more (BACKLOG-3454: pushes resolve the live window via sendToMainWindow), but its truthiness still gates the submission sync pollers below.
 */

/**
 * BACKLOG-3403: the renderer's confirmation of what will be left out. Anything
 * malformed reads as "nothing confirmed", which makes the service ask again
 * rather than send.
 */
function validateSubmitOptions(raw: unknown): SubmitOptions {
  if (!raw || typeof raw !== "object") return {};
  const keys = (raw as { acceptedExclusionKeys?: unknown }).acceptedExclusionKeys;
  if (!Array.isArray(keys) || keys.length > 10000) return {};
  return {
    acceptedExclusionKeys: keys.filter(
      (k): k is string => typeof k === "string" && k.length > 0 && k.length <= 300
    ),
  };
}

/** One response shape for submit and resubmit. */
function toSubmitResponse(result: SubmissionResult): TransactionResponse {
  return {
    success: result.success,
    submissionId: result.submissionId,
    messagesCount: result.messagesCount,
    attachmentsCount: result.attachmentsCount,
    // BACKLOG-3389: in-window items whose attachments are not included.
    flaggedWithoutAttachments: result.flaggedWithoutAttachments,
    // BACKLOG-3681: which ones, and why (display only).
    notIncluded: result.notIncluded,
    // BACKLOG-3600: the checklists did not reach the broker on a submission
    // that otherwise succeeded. Absent when there is nothing to say.
    checklistsNotSent: result.checklistsNotSent,
    // BACKLOG-3764: checklist evidence to confirm again (with
    // preflightChanged), and evidence dropped that was never listed.
    checklistLinkGaps: result.checklistLinkGaps,
    checklistLinksNotAttached: result.checklistLinksNotAttached,
    // BACKLOG-3398 / 3403: the three non-success outcomes that are not errors
    // of the app: cancelled, the list changed, the answer was lost.
    cancelled: result.cancelled,
    preflightChanged: result.preflightChanged,
    unconfirmed: result.unconfirmed,
    error: result.error,
  };
}

export function registerTransactionExportHandlers(
  _mainWindow: BrowserWindow | null,
): void {
  // Export transaction to PDF
  handleBusy(
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
      // then expands attached threads. The shared prep's re-fetch (BACKLOG-3733)
      // below picks up both freshly-linked emails AND texts. This is the last
      // line of defense — the renderer ExportModal gate is the primary prompt.
      await ensureTransactionMessagesSynced({
        transactionId: validatedTransactionId,
        userId: details.user_id,
        reason: "export",
      });
      // BACKLOG-3733: re-fetch (picks up what the sync linked) → paywall gate
      // (BACKLOG-2006a / 2075, fail-closed: a locked transaction throws
      // PAYWALL_LOCKED) → resolve, in the shared prep every channel uses.
      //
      // BACKLOG-2771: this channel has no renderer caller
      // (`window.api.transactions.exportPDF` is referenced nowhere in src/) and
      // takes no options, so it requests no audit window and no attachments —
      // the resolver returns the full record, which is exactly what this channel
      // produced when it had no filtering of its own.
      const pdfPrep = await prepareTransactionCommunications({
        transactionId: validatedTransactionId,
        fallback: details,
        request: () => ({
          format: "pdf",
          contentType: "both",
          attachmentType: "none",
          emailMode: "thread",
        }),
      });
      if (!pdfPrep) return { success: false, error: "Transaction not found" };
      details = pdfPrep.details;
      const pdfPlan = pdfPrep.plan;

      // Use provided output path or generate default one
      const pdfPath =
        validatedPath || folderExportService.getDefaultExportPath(details).replace(/\/$/, "") + ".pdf";

      // Generate combined PDF using folder export service
      // BACKLOG-3367: the hidden-text filter reaches this channel for free —
      // it goes through the same resolver — so the count it passes is correct.
      // Nothing was BUILT for this channel: it has no renderer caller and the
      // founder ruled it deleted on 2026-09-12 (BACKLOG-3234 → BACKLOG-3302).
      // This argument exists only because the signature now requires it.
      const generatedPath = await folderExportService.exportTransactionToCombinedPDF(
        details,
        pdfPlan.communications,
        pdfPath,
        // BACKLOG-3683: `attachmentType: "none"` — this channel writes no
        // attachment files, so none can be left out.
        { hiddenTextCount: pdfPlan.hiddenTextCount, hiddenTexts: pdfPlan.hiddenTexts, filesNotIncluded: [] },
      );

      // BACKLOG-2006a — funnel: export-completed (main-side, non-throwing).
      await emitExportCompleted({
        userId: details.user_id,
        transactionId: validatedTransactionId,
        mode: pdfPrep.decision.mode,
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

      // BACKLOG-3808: deliberately NOT recorded as openable (see pm_comments).

      return {
        success: true,
        path: generatedPath,
      };
    }, { module: "Transactions" }),
  );

  // Enhanced export with options
  handleBusy(
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
      // then expands attached threads. The shared prep's re-fetch (BACKLOG-3733)
      // below picks up both freshly-linked emails AND texts. This is the last
      // line of defense — the renderer ExportModal gate is the primary prompt.
      await ensureTransactionMessagesSynced({
        transactionId: validatedTransactionId,
        userId: details.user_id,
        reason: "export",
      });
      // BACKLOG-3733: re-fetch → paywall gate → resolve, in the shared prep.
      // BACKLOG-2006a / 2075 — the gate is fail-closed: a locked tx throws.
      // Bulk export loops per-transaction through THIS handler, so gating here
      // covers bulk with zero extra work.
      //
      // BACKLOG-2771: the SAME resolver the folder handler uses. The audit
      // window prefers the explicit option dates and falls back to the
      // transaction's — that per-entry-point difference lives in the REQUEST,
      // not in a second copy of the filter.
      const enhancedFormat = sanitizedOptions.exportFormat;
      const enhancedPrep = await prepareTransactionCommunications({
        transactionId: validatedTransactionId,
        fallback: details,
        request: (loaded) => ({
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
            (loaded.started_at as string | undefined),
          endDate:
            (sanitizedOptions.endDate as string | undefined) ||
            (loaded.closed_at as string | undefined),
          summaryOnly: sanitizedOptions.summaryOnly === true,
        }),
      });
      if (!enhancedPrep) return { success: false, error: "Transaction not found" };
      details = enhancedPrep.details;
      const enhancedPlan = enhancedPrep.plan;

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

      // BACKLOG-2549 — export tracking AND the BACKLOG-2013 freeze boundary in
      // ONE statement, so a deal can never be `exported` while still editable.
      // Write-once on the marker is enforced in SQL by COALESCE.
      const enhancedExportedAt = new Date().toISOString();
      databaseService.recordExportCompletion(validatedTransactionId, {
        exportFormat: sanitizedOptions.exportFormat || "pdf",
        exportedAt: enhancedExportedAt,
        exportCount: (details.export_count || 0) + 1,
        firstExportedAt: enhancedExportedAt,
      });

      // Audit log data export
      await auditService.log({
        userId: details.user_id,
        action: "DATA_EXPORT",
        resourceType: "EXPORT",
        resourceId: validatedTransactionId,
        metadata: {
          format: sanitizedOptions.exportFormat || "pdf",
          propertyAddress: details.property_address,
          // BACKLOG-3367: the audit trail records what the artifact left out,
          // not only that an export happened.
          hiddenTextCount: enhancedPlan.hiddenTextCount,
        },
        success: true,
      });

      // BACKLOG-2006a — funnel: export-completed (main-side, non-throwing).
      await emitExportCompleted({
        userId: details.user_id,
        transactionId: validatedTransactionId,
        mode: enhancedPrep.decision.mode,
        format: sanitizedOptions.exportFormat || "pdf",
      });

      logService.info("Enhanced export successful", "Transactions", {
        transactionId: validatedTransactionId,
        format: sanitizedOptions.exportFormat || "pdf",
        path: exportPath,
      });

      // BACKLOG-3808: the renderer may later ask to open this export.
      await rememberOpenablePath(exportPath);

      return {
        success: true,
        path: exportPath,
      };
    }, { module: "Transactions" }),
  );

  // Export transaction to organized folder structure
  handleBusy(
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
      // then expands attached threads. The shared prep's re-fetch (BACKLOG-3733)
      // below picks up both freshly-linked emails AND texts. This is the last
      // line of defense — the renderer ExportModal gate is the primary prompt.
      await ensureTransactionMessagesSynced({
        transactionId: validatedTransactionId,
        userId: details.user_id,
        reason: "export",
      });
      // BACKLOG-2771: ONE resolver decides the include set. The audit window is
      // the transaction's own dates (the ExportModal saves them immediately
      // before invoking this channel); the folder wire carries no explicit
      // window.
      const folderContentType = normalizeContentType(sanitizedOptions.contentType);
      // BACKLOG-3733: re-fetch → paywall gate → resolve, in the shared prep.
      //
      // BACKLOG-2006a / 2075 — AUTHORITATIVE PAYWALL GATE (fail-closed, Option A).
      // A locked tx is blocked outright; an unlocked one exports the full
      // (filtered) record.
      //
      // BACKLOG-3367 — GATE FIRST, THEN RESOLVE ONCE. This handler used to
      // resolve, gate, then resolve AGAIN over the gate's output, which is the
      // already-resolved list (Option A returns its input unchanged). That is
      // harmless while a plan holds only membership, and silently wrong the
      // moment it holds a COUNT OF WHAT WAS REMOVED: the second pass sees a set
      // with no hidden texts left in it and reports `hiddenTextCount: 0`, and
      // the second plan is the one the renderer receives. Measured at plan
      // review: folder 0 vs enhanced 1 for the same transaction (pm_comments
      // d590f7c6, mutation M1). Resolving once, after the gate, is also the
      // order the other two export channels already use.
      //
      // BEHAVIOUR CHANGE, deliberate: a LOCKED transaction whose narrowed
      // content selection matches nothing now returns PAYWALL_LOCKED instead of
      // "No text communications found...". The paywall is the truer answer, and
      // it is what export-pdf and export-enhanced have always returned.
      const folderPrep = await prepareTransactionCommunications({
        transactionId: validatedTransactionId,
        fallback: details,
        request: (loaded) => ({
          format: "folder",
          contentType: folderContentType,
          attachmentType: normalizeAttachmentType(sanitizedOptions.attachmentType, "all"),
          emailMode: normalizeEmailMode(sanitizedOptions.emailExportMode),
          startDate: loaded.started_at as string | null | undefined,
          endDate: loaded.closed_at as string | null | undefined,
        }),
      });
      if (!folderPrep) return { success: false, error: "Transaction not found" };
      details = folderPrep.details;
      const folderPlan = folderPrep.plan;
      const communications = folderPlan.communications;

      logService.info("Resolved folder export include set", "Transactions", {
        original: (details.communications || []).length,
        included: communications.length,
        hiddenTexts: folderPlan.hiddenTextCount,
        contentType: folderContentType,
        startDate: details.started_at,
        endDate: details.closed_at,
        writesAttachmentsToDisk: folderPlan.writesAttachmentsToDisk,
      });

      // Return early with a helpful message if a narrowed content selection
      // matched nothing. Unchanged: fires only for a narrowed selection, and
      // only after the date window has been applied.
      if (folderContentType !== "both" && communications.length === 0) {
        // BACKLOG-3367: when the selection is empty because every in-window text
        // was HIDDEN, "no text communications found" is false — they were found,
        // and the user removed them. Say which it was.
        if (folderPlan.hiddenTextCount > 0) {
          return {
            success: false,
            error:
              folderPlan.hiddenTextCount === 1
                ? "The only text in the selected date range is hidden from export."
                : `All ${folderPlan.hiddenTextCount} texts in the selected date range are hidden from export.`,
          };
        }
        const typeLabel = folderContentType === "emails" ? "email" : "text";
        return {
          success: false,
          error: `No ${typeLabel} communications found for this transaction in the selected date range.`,
        };
      }

      // Export to folder structure
      const exportPath = await folderExportService.exportTransactionToFolder(
        details,
        folderPlan,
        {
          transactionId: validatedTransactionId,
          onProgress: (progress: FolderExportProgress) => {
            // Send progress updates to renderer
            sendToMainWindow(
              "transactions:export-folder-progress",
              progress,
            );
          },
        },
      );

      // BACKLOG-2549 — export tracking AND the BACKLOG-2013 freeze boundary in
      // ONE statement (see the enhanced path above).
      //
      // `export_format` is OMITTED, not set to NULL: this path has never
      // written the column, so whatever a previous export recorded survives.
      // (The old comment here said the constraint excludes "folder" — it does
      // not, schema.sql permits it. Recording "folder" would change what that
      // column means to every reader of it, which is a product decision and not
      // part of an atomicity fix.)
      const folderExportedAt = new Date().toISOString();
      databaseService.recordExportCompletion(validatedTransactionId, {
        exportedAt: folderExportedAt,
        exportCount: (details.export_count || 0) + 1,
        firstExportedAt: folderExportedAt,
      });

      // Audit log data export
      await auditService.log({
        userId: details.user_id,
        action: "DATA_EXPORT",
        resourceType: "EXPORT",
        resourceId: validatedTransactionId,
        metadata: {
          format: "folder",
          propertyAddress: details.property_address,
          // BACKLOG-3367: see the enhanced handler above.
          hiddenTextCount: folderPlan.hiddenTextCount,
        },
        success: true,
      });

      // BACKLOG-2006a — funnel: export-completed (main-side, non-throwing).
      await emitExportCompleted({
        userId: details.user_id,
        transactionId: validatedTransactionId,
        mode: folderPrep.decision.mode,
        format: "folder",
      });

      logService.info("Folder export successful", "Transactions", {
        transactionId: validatedTransactionId,
        path: exportPath,
      });

      // BACKLOG-3808: the renderer may later ask to open this export.
      await rememberOpenablePath(exportPath);

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
      rawOptions?: unknown,
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
          sendToMainWindow("transactions:submit-progress", progress);
        },
        validateSubmitOptions(rawOptions)
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

      return toSubmitResponse(result);
    }, { module: "Transactions" }),
  );

  // Resubmit transaction (creates new version)
  ipcMain.handle(
    "transactions:resubmit",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
      rawOptions?: unknown,
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
          sendToMainWindow("transactions:submit-progress", progress);
        },
        validateSubmitOptions(rawOptions)
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

      return toSubmitResponse(result);
    }, { module: "Transactions" }),
  );

  // BACKLOG-3403: what cannot be sent, decided before anything is sent. Runs
  // the on-demand email attachment download first.
  ipcMain.handle(
    "transactions:submit-preflight",
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
      const result = await submissionService.preflightSubmission(validatedTransactionId);
      return {
        success: result.success,
        notIncluded: result.notIncluded,
        checklistLinkGaps: result.checklistLinkGaps ?? [],
        error: result.error,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-3683: what a submission with the dates on the date step would
  // send. Read-only; downloads nothing.
  ipcMain.handle(
    "transactions:submission-scope",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
      candidate: { started_at?: unknown; closed_at?: unknown },
    ): Promise<TransactionResponse> => {
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }
      const asDate = (v: unknown): string | null =>
        typeof v === "string" && v.length > 0 && v.length <= 40 ? v : null;
      const result = await submissionService.getSubmissionScope(validatedTransactionId, {
        started_at: asDate(candidate?.started_at),
        closed_at: asDate(candidate?.closed_at),
      });
      return {
        success: result.success,
        inWindow: result.inWindow,
        error: result.error,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-3398: Cancel really cancels — refused once the final step began.
  ipcMain.handle(
    "transactions:cancel-submit",
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
      const result = submissionService.cancelSubmission(validatedTransactionId);
      return { success: true, cancelled: result.cancelled, reason: result.reason };
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

  // BACKLOG-3454: nothing is handed to the sync service any more -- it resolves
  // the live window itself. Handing it the window captured at registration is
  // what killed its status pushes after a macOS Dock reopen. The truthiness gate
  // below is unchanged: it also gates the pollers, and suites that pass null
  // rely on those staying off.
  if (_mainWindow) {
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
