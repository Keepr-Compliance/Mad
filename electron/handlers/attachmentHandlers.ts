// ============================================
// ATTACHMENT IPC HANDLERS
// Handles: get attachments, open, get data, get buffer,
//          get counts, and backfill
// ============================================

import { ipcMain, app, shell, net } from "electron";
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
    const emailsMissingAttachments = db.prepare(`
      SELECT e.id, e.external_id, e.source, e.user_id
      FROM emails e
      WHERE e.user_id = ?
        AND e.has_attachments = 1
        AND e.external_id IS NOT NULL
        AND e.source IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id)
    `).all(userId) as { id: string; external_id: string; source: string; user_id: string }[];

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
        const email = await getEmailById(emailId);
        if (email && email.has_attachments && email.external_id && email.source) {
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
              success: true,
              data: [],
              downloadBlocked: true,
              reason: "Email attachment downloads are not available on your current plan.",
            };
          }

          // Offline check: if no internet, return helpful error instead of failing
          try {
            if (!net.isOnline()) {
              return {
                success: true,
                data: [],
                downloadRequired: true,
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

            // Re-fetch from DB after download
            attachments = await emailAttachmentService.getAttachmentsForEmail(emailId);
          } catch (downloadError) {
            logService.warn("On-demand attachment download failed", "Transactions", {
              emailId,
              error: downloadError instanceof Error ? downloadError.message : "Unknown",
            });
          }
        }
      }

      return {
        success: true,
        data: attachments,
      };
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

      let textDateFilter = "";
      let emailDateFilter = "";

      if (auditStart) {
        textDateFilter += " AND m.sent_at >= ?";
        textDateParams.push(auditStart);
        emailDateFilter += " AND e.sent_at >= ?";
        emailDateParams.push(auditStart);
      }

      if (auditEnd) {
        // Add end of day to include all messages on the end date
        const endDate = new Date(auditEnd);
        endDate.setHours(23, 59, 59, 999);
        const endDateStr = endDate.toISOString();
        textDateFilter += " AND m.sent_at <= ?";
        textDateParams.push(endDateStr);
        emailDateFilter += " AND e.sent_at <= ?";
        emailDateParams.push(endDateStr);
      }

      // Count text message attachments (via message_id -> messages -> communications)
      // Mirrors the query in submissionService.loadTransactionAttachments
      const textCountSql = `
        SELECT COUNT(DISTINCT a.id) as count
        FROM attachments a
        INNER JOIN messages m ON a.message_id = m.id
        INNER JOIN communications c ON (
          (c.message_id IS NOT NULL AND c.message_id = m.id)
          OR
          (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
        )
        WHERE c.transaction_id = ?
        AND a.message_id IS NOT NULL
        AND a.storage_path IS NOT NULL
        ${textDateFilter}
      `;

      const textResult = db.prepare(textCountSql).get(...textDateParams) as { count: number };

      // Count email attachments (via email_id -> communications -> emails)
      const emailCountSql = `
        SELECT COUNT(DISTINCT a.id) as count
        FROM attachments a
        INNER JOIN emails e ON a.email_id = e.id
        INNER JOIN communications c ON c.email_id = e.id
        WHERE c.transaction_id = ?
        AND a.email_id IS NOT NULL
        AND a.storage_path IS NOT NULL
        ${emailDateFilter}
      `;

      const emailResult = db.prepare(emailCountSql).get(...emailDateParams) as { count: number };

      // Calculate total size of all attachments (text + email)
      const textSizeSql = `
        SELECT COALESCE(SUM(a.file_size_bytes), 0) as total_size
        FROM attachments a
        INNER JOIN messages m ON a.message_id = m.id
        INNER JOIN communications c ON (
          (c.message_id IS NOT NULL AND c.message_id = m.id)
          OR
          (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
        )
        WHERE c.transaction_id = ?
        AND a.message_id IS NOT NULL
        AND a.storage_path IS NOT NULL
        ${textDateFilter}
      `;

      const emailSizeSql = `
        SELECT COALESCE(SUM(a.file_size_bytes), 0) as total_size
        FROM attachments a
        INNER JOIN emails e ON a.email_id = e.id
        INNER JOIN communications c ON c.email_id = e.id
        WHERE c.transaction_id = ?
        AND a.email_id IS NOT NULL
        AND a.storage_path IS NOT NULL
        ${emailDateFilter}
      `;

      const textSizeResult = db.prepare(textSizeSql).get(...textDateParams) as { total_size: number };
      const emailSizeResult = db.prepare(emailSizeSql).get(...emailDateParams) as { total_size: number };

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
