/**
 * Attachment Handling Helpers
 * Functions for querying and managing attachments during export.
 * Extracted from folderExportService.ts for maintainability.
 *
 * TASK-2050: Added email attachment export to thread directories
 */

import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import { net } from "electron";
import databaseService from "../databaseService";
import logService from "../logService";
import emailAttachmentService from "../emailAttachmentService";
import gmailFetchService from "../gmailFetchService";
import outlookFetchService from "../outlookFetchService";
import type { Communication } from "../../types/models";
import { isEmailMessage } from "../../utils/channelHelpers";
import { getEmailIndexThreadKey } from "./emailIndexHelpers";

/**
 * Get attachments for a specific message
 * Used for embedding images inline in text thread PDFs
 *
 * Includes external_message_id fallback for when message_id is stale after re-import
 * @param messageId - Internal message UUID
 * @param externalId - Optional macOS GUID for fallback lookup
 */
export function getAttachmentsForMessage(messageId: string, externalId?: string): {
  id: string;
  filename: string;
  mime_type: string | null;
  storage_path: string | null;
  file_size_bytes: number | null;
}[] {
  try {
    return databaseService.getAttachmentsForMessageWithFallback(messageId, externalId);
  } catch (error) {
    logService.warn("[Folder Export] Failed to get attachments for message", "FolderExport", {
      messageId,
      error,
    });
    return [];
  }
}

/**
 * TASK-1780: Get attachments for an email by email_id
 * @param emailId - Email UUID
 */
export function getAttachmentsForEmail(emailId: string): {
  id: string;
  filename: string;
  mime_type: string | null;
  storage_path: string | null;
  file_size_bytes: number | null;
}[] {
  try {
    return databaseService.getAttachmentsForEmailExport(emailId);
  } catch (error) {
    logService.warn("[Folder Export] Failed to get attachments for email", "FolderExport", {
      emailId,
      error,
    });
    return [];
  }
}

/**
 * Sanitize filename to remove invalid characters
 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[^a-z0-9_\-\.]/gi, "_")
    .replace(/_+/g, "_")
    .substring(0, 100);
}

/**
 * TASK-2050: Resolve filename conflicts within a directory.
 * If a file with the same name already exists, append a counter:
 * report.pdf -> report (1).pdf -> report (2).pdf
 */
export function resolveFilenameConflict(dir: string, filename: string): string {
  let candidate = sanitizeFileName(filename);
  let counter = 1;

  while (fsSync.existsSync(path.join(dir, candidate))) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    candidate = sanitizeFileName(`${base} (${counter})${ext}`);
    counter++;
  }

  return candidate;
}

/**
 * TASK-2050: Result of exporting email attachments to thread directories
 */
export interface AttachmentExportResult {
  exported: number;
  skipped: number;
  totalSizeBytes: number;
  errors: string[];
  items: Array<{
    emailId: string;
    threadId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    exportPath: string;
    status: "exported" | "skipped" | "error";
  }>;
}

/**
 * BACKLOG-1369: Download missing email attachments on-demand before export.
 * Finds emails with has_attachments flag but no local attachment records,
 * then fetches them from the provider.
 */
async function downloadMissingAttachmentsForExport(
  emails: Communication[],
): Promise<void> {
  // Check network connectivity
  let isOnline = true;
  try {
    isOnline = net.isOnline();
  } catch {
    // net.isOnline() may not be available in all contexts
  }

  if (!isOnline) {
    logService.warn(
      "[Folder Export] Cannot download missing attachments: device is offline",
      "FolderExport"
    );
    return;
  }

  const db = databaseService.getRawDatabase();
  const emailsNeedingDownload: { id: string; external_id: string; source: string; user_id: string }[] = [];

  for (const email of emails) {
    if (!isEmailMessage(email) || !email.id) continue;
    // Check if this email has attachments but no records downloaded yet
    if (!email.has_attachments) continue;

    const existingCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM attachments WHERE email_id = ?"
    ).get(email.id) as { cnt: number };

    if (existingCount.cnt === 0) {
      // Need to look up the email record for external_id and source
      const emailRecord = db.prepare(
        "SELECT id, external_id, source, user_id FROM emails WHERE id = ?"
      ).get(email.id) as { id: string; external_id: string; source: string; user_id: string } | undefined;

      if (emailRecord?.external_id && emailRecord?.source) {
        emailsNeedingDownload.push(emailRecord);
      }
    }
  }

  if (emailsNeedingDownload.length === 0) return;

  logService.info(
    `[Folder Export] Downloading attachments for ${emailsNeedingDownload.length} emails before export`,
    "FolderExport"
  );

  // Group by source for efficient provider initialization
  const outlookEmails = emailsNeedingDownload.filter(e => e.source === "outlook");
  const gmailEmails = emailsNeedingDownload.filter(e => e.source === "gmail");

  if (outlookEmails.length > 0) {
    try {
      const isReady = await outlookFetchService.initialize(outlookEmails[0].user_id);
      if (isReady) {
        for (const email of outlookEmails) {
          try {
            const graphAttachments = await outlookFetchService.getAttachments(email.external_id);
            if (graphAttachments.length > 0) {
              await emailAttachmentService.downloadEmailAttachments(
                email.user_id, email.id, email.external_id, "outlook",
                graphAttachments.map((att: { id: string; name: string; contentType: string; size: number }) => ({
                  filename: att.name || "attachment",
                  mimeType: att.contentType || "application/octet-stream",
                  size: att.size || 0,
                  attachmentId: att.id,
                })),
              );
            }
          } catch (err) {
            logService.warn("[Folder Export] Failed to download Outlook attachment for export", "FolderExport", {
              emailId: email.id, error: err instanceof Error ? err.message : "Unknown",
            });
          }
        }
      }
    } catch (err) {
      logService.warn("[Folder Export] Outlook init failed for attachment download", "FolderExport", {
        error: err instanceof Error ? err.message : "Unknown",
      });
    }
  }

  if (gmailEmails.length > 0) {
    try {
      const isReady = await gmailFetchService.initialize(gmailEmails[0].user_id);
      if (isReady) {
        for (const email of gmailEmails) {
          try {
            const fullEmail = await gmailFetchService.getEmailById(email.external_id);
            if (fullEmail.attachments && fullEmail.attachments.length > 0) {
              await emailAttachmentService.downloadEmailAttachments(
                email.user_id, email.id, email.external_id, "gmail",
                fullEmail.attachments.map((att: { filename?: string; name?: string; mimeType?: string; contentType?: string; size?: number; attachmentId?: string; id?: string }) => ({
                  filename: att.filename || att.name || "attachment",
                  mimeType: att.mimeType || att.contentType || "application/octet-stream",
                  size: att.size || 0,
                  attachmentId: att.attachmentId || att.id || "",
                })),
              );
            }
          } catch (err) {
            logService.warn("[Folder Export] Failed to download Gmail attachment for export", "FolderExport", {
              emailId: email.id, error: err instanceof Error ? err.message : "Unknown",
            });
          }
        }
      }
    } catch (err) {
      logService.warn("[Folder Export] Gmail init failed for attachment download", "FolderExport", {
        error: err instanceof Error ? err.message : "Unknown",
      });
    }
  }
}

/**
 * TASK-2050: Export email attachments into per-thread subdirectories.
 *
 * Creates structure:
 *   emails/<thread-dir>/attachments/<filename>
 *
 * For each email in the provided communications:
 * 1. Download any missing attachments on-demand (BACKLOG-1369)
 * 2. Look up attachments in the local database via email_id
 * 3. Copy attachment files from local cache to the export directory
 * 4. Handle filename conflicts for duplicates within the same thread
 * 5. Skip missing/inaccessible attachments gracefully
 * 6. Log warning if total size exceeds 50MB
 */
export async function exportEmailAttachmentsToThreadDirs(
  emails: Communication[],
  emailsExportPath: string,
  threadNameMap?: Map<string, string>,
): Promise<AttachmentExportResult> {
  const result: AttachmentExportResult = {
    exported: 0,
    skipped: 0,
    totalSizeBytes: 0,
    errors: [],
    items: [],
  };

  // BACKLOG-1369: Download any missing email attachments before export
  try {
    await downloadMissingAttachmentsForExport(emails);
  } catch (err) {
    logService.warn("[Folder Export] Pre-export attachment download failed", "FolderExport", {
      error: err instanceof Error ? err.message : "Unknown",
    });
  }

  // Group emails by thread for directory structure.
  // BACKLOG-2161: use getEmailIndexThreadKey() — the canonical email key — for
  // alignment with exportEmailThreads()/threadNameMap in folderExportService.
  // (threadNameMap is keyed by this same function, so the lookup below matches.)
  const threadMap = new Map<string, Communication[]>();
  for (const email of emails) {
    if (!isEmailMessage(email)) continue;
    const threadKey = getEmailIndexThreadKey(email);
    const thread = threadMap.get(threadKey) || [];
    thread.push(email);
    threadMap.set(threadKey, thread);
  }

  // Track filenames per thread directory to avoid conflicts
  const usedFilenamesPerThread = new Map<string, Set<string>>();

  for (const [threadKey, threadEmails] of threadMap) {
    // Use mapped human-readable name if available, fallback to sanitized raw key
    const threadDirName = threadNameMap?.get(threadKey) || sanitizeFileName(threadKey);

    for (const email of threadEmails) {
      if (!email.id) continue;

      // Get attachments for this email from database
      const attachments = getAttachmentsForEmail(email.id);
      if (attachments.length === 0) continue;

      // Create attachments subdirectory inside the thread directory
      const attachDir = path.join(emailsExportPath, threadDirName, "attachments");
      await fs.mkdir(attachDir, { recursive: true });

      // Get or create used filenames set for this thread
      if (!usedFilenamesPerThread.has(threadDirName)) {
        usedFilenamesPerThread.set(threadDirName, new Set<string>());
      }
      const usedFilenames = usedFilenamesPerThread.get(threadDirName)!;

      for (const att of attachments) {
        const originalFilename = att.filename || `attachment_${result.items.length + 1}`;

        try {
          if (!att.storage_path) {
            result.skipped++;
            const errorMsg = `Missing storage path: ${originalFilename} (email ${email.id})`;
            result.errors.push(errorMsg);
            result.items.push({
              emailId: email.id,
              threadId: threadKey,
              filename: originalFilename,
              contentType: att.mime_type || "application/octet-stream",
              sizeBytes: att.file_size_bytes || 0,
              exportPath: "",
              status: "skipped",
            });
            continue;
          }

          // Check if source file exists
          try {
            await fs.access(att.storage_path);
          } catch {
            result.skipped++;
            const errorMsg = `File not found: ${originalFilename} at ${att.storage_path}`;
            result.errors.push(errorMsg);
            result.items.push({
              emailId: email.id,
              threadId: threadKey,
              filename: originalFilename,
              contentType: att.mime_type || "application/octet-stream",
              sizeBytes: att.file_size_bytes || 0,
              exportPath: "",
              status: "skipped",
            });
            continue;
          }

          // Resolve filename conflicts within this thread's attachments dir
          let exportFilename = sanitizeFileName(originalFilename);
          let counter = 1;
          const baseName = exportFilename.replace(/\.[^.]+$/, "");
          const extension = exportFilename.includes(".")
            ? exportFilename.slice(exportFilename.lastIndexOf("."))
            : "";

          while (usedFilenames.has(exportFilename)) {
            exportFilename = sanitizeFileName(`${baseName} (${counter})${extension}`);
            counter++;
          }
          usedFilenames.add(exportFilename);

          const destPath = path.join(attachDir, exportFilename);
          const relativePath = path.join(threadDirName, "attachments", exportFilename);

          // Copy file (streaming via fs.copyFile -- no buffering in memory)
          await fs.copyFile(att.storage_path, destPath);

          const fileSize = att.file_size_bytes || 0;
          result.exported++;
          result.totalSizeBytes += fileSize;
          result.items.push({
            emailId: email.id,
            threadId: threadKey,
            filename: exportFilename,
            contentType: att.mime_type || "application/octet-stream",
            sizeBytes: fileSize,
            exportPath: relativePath,
            status: "exported",
          });
        } catch (error) {
          result.skipped++;
          const errorMsg = `Failed: ${originalFilename} - ${error instanceof Error ? error.message : String(error)}`;
          result.errors.push(errorMsg);
          result.items.push({
            emailId: email.id,
            threadId: threadKey,
            filename: originalFilename,
            contentType: att.mime_type || "application/octet-stream",
            sizeBytes: att.file_size_bytes || 0,
            exportPath: "",
            status: "error",
          });
        }
      }
    }
  }

  // Size warning
  const SIZE_WARNING_THRESHOLD = 50 * 1024 * 1024; // 50MB
  if (result.totalSizeBytes > SIZE_WARNING_THRESHOLD) {
    logService.warn(
      `[Folder Export] Email attachments total ${(result.totalSizeBytes / 1024 / 1024).toFixed(1)}MB -- export may be large`,
      "FolderExport"
    );
  }

  logService.info(
    `[Folder Export] Email attachments export: ${result.exported} exported, ${result.skipped} skipped`,
    "FolderExport",
    {
      exported: result.exported,
      skipped: result.skipped,
      totalSizeBytes: result.totalSizeBytes,
      errorCount: result.errors.length,
    }
  );

  return result;
}
