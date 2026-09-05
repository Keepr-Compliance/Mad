// ============================================
// ATTACHMENT IPC HANDLERS
// Handles: get attachments, open, get data, get buffer,
//          get counts, and backfill
// ============================================

import { ipcMain, app, shell, net } from "electron";
import {
  EMAILS_MISSING_ATTACHMENTS_FOR_USER_SQL,
  prepareEmailAttachmentCount,
  prepareEmailAttachmentSize,
  prepareTextAttachmentCount,
  prepareTextAttachmentSize,
} from "../services/db/attachmentAuditStatsSql";
import type { BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import path from "path";
import fs from "fs";
import logService from "../services/logService";
import auditService from "../services/auditService";
import emailAttachmentService from "../services/emailAttachmentService";
import { backfillAttachmentMetadata } from "../services/emailAttachmentBackfillService";
import { backfillAttachmentTextContent } from "../services/attachmentTextExtractionBackfillService";
import databaseService from "../services/databaseService";
import gmailFetchService from "../services/gmailFetchService";
import outlookFetchService from "../services/outlookFetchService";
import featureGateService from "../services/featureGateService";
import supabaseService from "../services/supabaseService";
import { getEmailById } from "../services/db/emailDbService";
// BACKLOG-2781: this handler's counts are meant to match what the submission
// service uploads, so it must use the SAME closing-day bound the export
// resolver defines rather than a local end-of-day.
import { auditWindowEnd } from "../services/exportPlan";
import { wrapHandler } from "../utils/wrapHandler";
import type { Transaction } from "../types/models";
import {
  ValidationError,
  validateUserId,
  validateTransactionId,
} from "../utils/validation";

// Type definitions
interface TransactionResponse {
  success: boolean;
  error?: string;
  transaction?: Transaction | any;
  [key: string]: unknown;
}

/**
 * Backfill missing email attachments for a user.
 * Finds emails with has_attachments=true but no records in attachments table,
 * then downloads them from the provider.
 *
 * Exported for use by emailSyncHandlers (sync-and-fetch-emails).
 */
export async function backfillMissingAttachments(userId: string): Promise<{ processed: number; downloaded: number; errors: number }> {
  const result = { processed: 0, downloaded: 0, errors: 0 };

  try {
    const db = databaseService.getRawDatabase();
    const emailsMissingAttachments = db
      .prepare(EMAILS_MISSING_ATTACHMENTS_FOR_USER_SQL)
      .all(userId) as { id: string; external_id: string; source: string; user_id: string }[];

    if (emailsMissingAttachments.length === 0) return result;

    logService.info(`Backfilling attachments for ${emailsMissingAttachments.length} emails`, "Transactions", { userId });

    // Group by source for efficient provider initialization
    const outlookEmails = emailsMissingAttachments.filter(e => e.source === "outlook");
    const gmailEmails = emailsMissingAttachments.filter(e => e.source === "gmail");

    // Backfill Outlook attachments
    if (outlookEmails.length > 0) {
      try {
        const isReady = await outlookFetchService.initialize(userId);
        if (isReady) {
          for (const email of outlookEmails) {
            result.processed++;
            try {
              const graphAttachments = await outlookFetchService.getAttachments(email.external_id);
              if (graphAttachments.length > 0) {
                await emailAttachmentService.downloadEmailAttachments(
                  userId, email.id, email.external_id, "outlook",
                  graphAttachments.map((att: { id: string; name: string; contentType: string; size: number }) => ({
                    filename: att.name || "attachment",
                    mimeType: att.contentType || "application/octet-stream",
                    size: att.size || 0,
                    attachmentId: att.id,
                  })),
                );
                result.downloaded++;
              }
            } catch (err) {
              result.errors++;
              logService.warn("Backfill: failed to download Outlook attachment", "Transactions", {
                emailId: email.id, error: err instanceof Error ? err.message : "Unknown",
              });
            }
          }
        }
      } catch (err) {
        logService.warn("Backfill: Outlook init failed", "Transactions", {
          error: err instanceof Error ? err.message : "Unknown",
        });
      }
    }

    // Backfill Gmail attachments
    if (gmailEmails.length > 0) {
      try {
        const isReady = await gmailFetchService.initialize(userId);
        if (isReady) {
          for (const email of gmailEmails) {
            result.processed++;
            try {
              const fullEmail = await gmailFetchService.getEmailById(email.external_id);
              if (fullEmail.attachments && fullEmail.attachments.length > 0) {
                await emailAttachmentService.downloadEmailAttachments(
                  userId, email.id, email.external_id, "gmail",
                  fullEmail.attachments.map((att: { filename?: string; name?: string; mimeType?: string; contentType?: string; size?: number; attachmentId?: string; id?: string }) => ({
                    filename: att.filename || att.name || "attachment",
                    mimeType: att.mimeType || att.contentType || "application/octet-stream",
                    size: att.size || 0,
                    attachmentId: att.attachmentId || att.id || "",
                  })),
                );
                result.downloaded++;
              }
            } catch (err) {
              result.errors++;
              logService.warn("Backfill: failed to download Gmail attachment", "Transactions", {
                emailId: email.id, error: err instanceof Error ? err.message : "Unknown",
              });
            }
          }
        }
      } catch (err) {
        logService.warn("Backfill: Gmail init failed", "Transactions", {
          error: err instanceof Error ? err.message : "Unknown",
        });
      }
    }

    logService.info(`Attachment backfill complete`, "Transactions", result);
  } catch (err) {
    logService.error("Attachment backfill failed", "Transactions", {
      error: err instanceof Error ? err.message : "Unknown",
    });
  }

  return result;
}

/**
 * Result of an on-demand email-attachment download attempt.
 * Empty object = attempted (or nothing to do); caller re-fetches the DB rows.
 */
interface OnDemandDownloadResult {
  downloadBlocked?: boolean;
  offline?: boolean;
  reason?: string;
}

/**
 * BACKLOG-1369 / BACKLOG-322: Download an email's attachments from the provider
 * on demand and persist them (reconciling metadata-only rows in place per
 * BACKLOG-1870). Shared by:
 *   - `emails:get-attachments` (triggered only when the DB has ZERO rows), and
 *   - `emails:ensure-attachment-downloaded` (force path — triggered when a
 *     metadata-only row exists but its bytes are missing).
 *
 * Does NOT re-fetch rows; the caller re-reads the DB after this resolves so both
 * the 0-row and the has-metadata cases share one download implementation.
 */
async function downloadEmailAttachmentsOnDemand(
  emailId: string,
): Promise<OnDemandDownloadResult> {
  const email = await getEmailById(emailId);
  if (!(email && email.has_attachments && email.external_id && email.source)) {
    return {};
  }

  // License gate: check desktop_email_attachments before downloading
  let gateAllowed = true;
  try {
    const client = supabaseService.getClient();
    const { data: { session } } = await client.auth.getSession();
    if (session?.user?.id) {
      const membership = await supabaseService.getActiveOrganizationMembership(session.user.id);
      if (membership?.organization_id) {
        const access = await featureGateService.checkFeature(membership.organization_id, "desktop_email_attachments");
        gateAllowed = access.allowed;
      }
    }
  } catch (gateError) {
    // Fail-open: if gate check fails, allow download
    logService.warn("Feature gate check failed for attachment download, allowing (fail-open)", "Transactions", {
      error: gateError instanceof Error ? gateError.message : "Unknown",
    });
  }

  if (!gateAllowed) {
    return {
      downloadBlocked: true,
      reason: "Email attachment downloads are not available on your current plan.",
    };
  }

  // Offline check: if no internet, return helpful error instead of failing
  try {
    if (!net.isOnline()) {
      return {
        offline: true,
        reason: "Attachments cannot be downloaded while offline. Please connect to the internet and try again.",
      };
    }
  } catch {
    // net.isOnline() may throw in some contexts; proceed with download attempt
  }

  logService.info("On-demand attachment download triggered", "Transactions", {
    emailId, source: email.source, externalId: email.external_id,
  });

  try {
    if (email.source === "outlook") {
      const isReady = await outlookFetchService.initialize(email.user_id);
      if (isReady) {
        const graphAttachments = await outlookFetchService.getAttachments(email.external_id);
        if (graphAttachments.length > 0) {
          await emailAttachmentService.downloadEmailAttachments(
            email.user_id, emailId, email.external_id, "outlook",
            graphAttachments.map((att: { id: string; name: string; contentType: string; size: number }) => ({
              filename: att.name || "attachment",
              mimeType: att.contentType || "application/octet-stream",
              size: att.size || 0,
              attachmentId: att.id,
            })),
          );
        }
      }
    } else if (email.source === "gmail") {
      const isReady = await gmailFetchService.initialize(email.user_id);
      if (isReady) {
        const fullEmail = await gmailFetchService.getEmailById(email.external_id);
        if (fullEmail.attachments && fullEmail.attachments.length > 0) {
          await emailAttachmentService.downloadEmailAttachments(
            email.user_id, emailId, email.external_id, "gmail",
            fullEmail.attachments.map((att: { filename?: string; name?: string; mimeType?: string; contentType?: string; size?: number; attachmentId?: string; id?: string }) => ({
              filename: att.filename || att.name || "attachment",
              mimeType: att.mimeType || att.contentType || "application/octet-stream",
              size: att.size || 0,
              attachmentId: att.attachmentId || att.id || "",
            })),
          );
        }
      }
    }
  } catch (downloadError) {
    logService.warn("On-demand attachment download failed", "Transactions", {
      emailId,
      error: downloadError instanceof Error ? downloadError.message : "Unknown",
    });
  }

  return {};
}

/**
 * Register attachment IPC handlers
 * @param _mainWindow - Main window instance (unused in attachment handlers)
 */
export function registerAttachmentHandlers(
  _mainWindow: BrowserWindow | null,
): void {
  // TASK-1776: Get attachments for a specific email (with on-demand download)
  ipcMain.handle(
    "emails:get-attachments",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      emailId: string,
    ): Promise<TransactionResponse> => {
      if (!emailId || typeof emailId !== "string") {
        throw new ValidationError("Email ID is required", "emailId");
      }

      let attachments = await emailAttachmentService.getAttachmentsForEmail(emailId);

      // BACKLOG-1369: On-demand download -- if DB has no records but email says it has attachments,
      // fetch them now from the provider. This is the primary download path (no eager sync).
      if (attachments.length === 0) {
        const outcome = await downloadEmailAttachmentsOnDemand(emailId);
        if (outcome.downloadBlocked) {
          return { success: true, data: [], downloadBlocked: true, reason: outcome.reason };
        }
        if (outcome.offline) {
          return { success: true, data: [], downloadRequired: true, offline: true, reason: outcome.reason };
        }
        // Re-fetch from DB after (attempted) download
        attachments = await emailAttachmentService.getAttachmentsForEmail(emailId);
      }

      return {
        success: true,
        data: attachments,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-322 Phase A: Force an on-demand download for an email whose attachment
  // rows exist as metadata-only (storage_path NULL). The `emails:get-attachments`
  // handler only downloads when the DB has ZERO rows, so after a normal sync
  // (which persists metadata rows — BACKLOG-1870) the bytes are never fetched.
  // The unified Attachments tab calls this before previewing such a row.
  ipcMain.handle(
    "emails:ensure-attachment-downloaded",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      emailId: string,
    ): Promise<TransactionResponse> => {
      if (!emailId || typeof emailId !== "string") {
        throw new ValidationError("Email ID is required", "emailId");
      }

      let attachments = await emailAttachmentService.getAttachmentsForEmail(emailId);
      const needsDownload =
        attachments.length === 0 || attachments.some((a) => !a.storage_path);

      if (needsDownload) {
        const outcome = await downloadEmailAttachmentsOnDemand(emailId);
        // Re-read regardless: metadata-only rows should still be returned so the
        // caller can show them alongside a blocked/offline message.
        attachments = await emailAttachmentService.getAttachmentsForEmail(emailId);
        if (outcome.downloadBlocked) {
          return { success: true, data: attachments, downloadBlocked: true, reason: outcome.reason };
        }
        if (outcome.offline) {
          return { success: true, data: attachments, offline: true, reason: outcome.reason };
        }
      }

      return { success: true, data: attachments };
    }, { module: "Transactions" }),
  );

  // BACKLOG-322 Phase A: Unified list of ALL attachments linked to a transaction —
  // email AND text/iMessage — including metadata-only rows (not yet downloaded).
  ipcMain.handle(
    "transactions:get-all-attachments",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      transactionId: string,
      auditStart?: string,
      auditEnd?: string,
    ): Promise<TransactionResponse> => {
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError("Transaction ID validation failed", "transactionId");
      }

      const startDate = auditStart ? new Date(auditStart) : null;
      const endDate = auditEnd ? new Date(auditEnd) : null;

      const data = databaseService.getTransactionAllAttachments(
        validatedTransactionId,
        startDate,
        endDate,
      );

      return { success: true, data };
    }, { module: "Transactions" }),
  );

  // TASK-1776: Open attachment with system viewer
  ipcMain.handle(
    "attachments:open",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      storagePath: string,
    ): Promise<TransactionResponse> => {
      if (!storagePath || typeof storagePath !== "string") {
        throw new ValidationError("Storage path is required", "storagePath");
      }

      // Security: Validate path is within app data directory
      const appDataPath = app.getPath("userData");
      const normalizedPath = path.normalize(storagePath);
      if (!normalizedPath.startsWith(appDataPath)) {
        throw new ValidationError("Invalid attachment path", "storagePath");
      }

      const result = await shell.openPath(normalizedPath);

      if (result) {
        // shell.openPath returns empty string on success, error message on failure
        return {
          success: false,
          error: result,
        };
      }

      // Audit log attachment open
      try {
        await auditService.log({
          userId: "system",
          action: "DATA_ACCESS",
          resourceType: "COMMUNICATION",
          resourceId: path.basename(normalizedPath),
          success: true,
          metadata: { operation: "attachment_open", fileName: path.basename(normalizedPath) },
        });
      } catch (auditError) {
        logService.warn("[Audit] Failed to log attachment open", "Transactions", { auditError });
      }

      return { success: true };
    }, { module: "Transactions" }),
  );

  // Fix for TASK-1778: Get attachment data as base64 for CSP-safe image preview
  // CSP blocks file:// URLs, so we read the file and return as data: URL
  ipcMain.handle(
    "attachments:get-data",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      storagePath: string,
      mimeType: string,
    ): Promise<TransactionResponse> => {
      if (!storagePath || typeof storagePath !== "string") {
        throw new ValidationError("Storage path is required", "storagePath");
      }

      // Security: Validate path is within app data directory
      const appDataPath = app.getPath("userData");
      const normalizedPath = path.normalize(storagePath);
      if (!normalizedPath.startsWith(appDataPath)) {
        throw new ValidationError("Invalid attachment path", "storagePath");
      }

      // Read file as buffer and convert to base64
      const buffer = fs.readFileSync(normalizedPath);
      const base64 = buffer.toString("base64");
      const dataUrl = `data:${mimeType || "application/octet-stream"};base64,${base64}`;

      // Audit log attachment data access
      try {
        await auditService.log({
          userId: "system",
          action: "DATA_ACCESS",
          resourceType: "COMMUNICATION",
          resourceId: path.basename(normalizedPath),
          success: true,
          metadata: { operation: "attachment_get_data", fileName: path.basename(normalizedPath), mimeType },
        });
      } catch (auditError) {
        logService.warn("[Audit] Failed to log attachment data access", "Transactions", { auditError });
      }

      return {
        success: true,
        data: dataUrl,
      };
    }, { module: "Transactions" }),
  );

  // TASK-1781: Get attachment counts for transaction (from actual downloaded files)
  // Returns counts from the attachments table, matching what submission service uploads
  ipcMain.handle(
    "transactions:get-attachment-counts",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      transactionId: string,
      auditStart?: string,
      auditEnd?: string,
    ): Promise<TransactionResponse> => {
      // Validate transaction ID
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      const t0 = Date.now();
      const db = databaseService.getRawDatabase();

      // Build date filter params
      const textDateParams: string[] = [validatedTransactionId];
      const emailDateParams: string[] = [validatedTransactionId];

      // The window is described to db/, never spelled: `{ hasStart, hasEnd }`.
      // A filter STRING crossing this boundary would put SQL composition back
      // outside the layer while appearing to respect the rule.
      let hasStart = false;
      let hasEnd = false;

      if (auditStart) {
        hasStart = true;
        textDateParams.push(auditStart);
        emailDateParams.push(auditStart);
      }

      // BACKLOG-2781: `auditEnd` arrives as the caller sent it and is passed
      // through unchanged, so the same input yields the same bound the export
      // path computes. NOTE: the only renderer caller today
      // (TransactionDetails.tsx via useAttachmentCounts) passes `undefined`, so
      // this branch is currently unreached in the shipping app — it is fixed
      // because the channel's stated contract is parity with the submission
      // path, and the next caller that supplies a window would inherit the bug.
      const auditEndBound = auditWindowEnd(auditEnd);
      if (auditEndBound) {
        const endDateStr = auditEndBound.toISOString();
        hasEnd = true;
        textDateParams.push(endDateStr);
        emailDateParams.push(endDateStr);
      }

      const auditWindow = { hasStart, hasEnd };

      // The four counters' SQL lives in db/attachmentAuditStatsSql.ts. Only the
      // window SHAPE crosses the boundary; the bound values still travel as
      // ordinary parameters in textDateParams / emailDateParams.
      const textResult = prepareTextAttachmentCount(db, auditWindow).get(
        ...textDateParams,
      ) as { count: number };

      const emailResult = prepareEmailAttachmentCount(db, auditWindow).get(
        ...emailDateParams,
      ) as { count: number };

      const textSizeResult = prepareTextAttachmentSize(db, auditWindow).get(
        ...textDateParams,
      ) as { total_size: number };

      const emailSizeResult = prepareEmailAttachmentSize(db, auditWindow).get(
        ...emailDateParams,
      ) as { total_size: number };

      const textAttachments = textResult?.count || 0;
      const emailAttachments = emailResult?.count || 0;
      const totalSizeBytes = (textSizeResult?.total_size || 0) + (emailSizeResult?.total_size || 0);

      logService.debug(
        `[PERF] getAttachmentCounts: ${Date.now() - t0}ms, ${textAttachments} text + ${emailAttachments} email`,
        "Transactions",
      );

      return {
        success: true,
        data: {
          textAttachments,
          emailAttachments,
          total: textAttachments + emailAttachments,
          totalSizeBytes,
        },
      };
    }, { module: "Transactions" }),
  );

  // TASK-1783: Get attachment buffer as base64 (for DOCX conversion with mammoth)
  // Unlike get-data, this returns raw base64 without data: URL prefix
  ipcMain.handle(
    "attachments:get-buffer",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      storagePath: string,
    ): Promise<TransactionResponse> => {
      if (!storagePath || typeof storagePath !== "string") {
        throw new ValidationError("Storage path is required", "storagePath");
      }

      // Security: Validate path is within app data directory
      const appDataPath = app.getPath("userData");
      const normalizedPath = path.normalize(storagePath);
      if (!normalizedPath.startsWith(appDataPath)) {
        throw new ValidationError("Invalid attachment path", "storagePath");
      }

      // Read file as buffer and convert to base64
      const buffer = fs.readFileSync(normalizedPath);
      const base64 = buffer.toString("base64");

      return {
        success: true,
        data: base64,
      };
    }, { module: "Transactions" }),
  );

  // Backfill missing email attachments (runs in background after login)
  ipcMain.handle(
    "emails:backfill-attachments",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<TransactionResponse> => {
      if (!userId || typeof userId !== "string") {
        return { success: true }; // Silently skip if no user
      }
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        return { success: true };
      }

      const result = await backfillMissingAttachments(validatedUserId);
      return {
        success: true,
        ...result,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-2250: One-time, metadata-ONLY attachment backfill (no bytes downloaded).
  // Indexes attachment filenames for emails synced BEFORE BACKLOG-1870 so filename
  // search finds them. Idempotent and bounded — safe to invoke repeatedly.
  ipcMain.handle(
    "emails:backfill-attachment-metadata",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<TransactionResponse> => {
      if (!userId || typeof userId !== "string") {
        return { success: true }; // Silently skip if no user
      }
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        return { success: true };
      }

      const result = await backfillAttachmentMetadata(validatedUserId);
      return {
        success: true,
        ...result,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-2257: Manual/dev-only LOCAL text-extraction backfill. Populates
  // attachments.text_content for already-downloaded PDF/text rows (no network, no
  // OCR). Idempotent and bounded — safe to invoke repeatedly. NOT wired into
  // startup/login/sync.
  ipcMain.handle(
    "attachments:extract-text-backfill",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      options?: { maxAttachments?: number },
    ): Promise<TransactionResponse> => {
      const maxAttachments =
        options && typeof options.maxAttachments === "number"
          ? options.maxAttachments
          : undefined;

      const result = await backfillAttachmentTextContent(
        maxAttachments !== undefined ? { maxAttachments } : {},
      );
      return {
        success: true,
        ...result,
      };
    }, { module: "Transactions" }),
  );
}
