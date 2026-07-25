/**
 * Email Attachment Service
 *
 * Downloads and stores email attachments from Gmail/Outlook APIs.
 * Follows the same pattern as macOSMessagesImportService for consistency.
 *
 * TASK-1775: Foundation service for email attachment handling
 *
 * Features:
 * - Download attachments from Gmail API
 * - Download attachments from Outlook/Graph API
 * - Content hash deduplication (same file = one copy)
 * - Storage in ~/Library/Application Support/Keepr/attachments/
 * - Database records in attachments table with email_id FK
 * - Path traversal protection via filename sanitization
 * - Per-attachment timeout (30s) to prevent hangs
 * - Non-blocking: failed downloads don't break email linking flow
 */

import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { app } from "electron";
import * as Sentry from "@sentry/electron/main";
import databaseService from "./databaseService";
import gmailFetchService from "./gmailFetchService";
import outlookFetchService from "./outlookFetchService";
import logService from "./logService";
import { sanitizeFileSystemName } from "../utils/fileUtils";

// Constants
const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024; // 50MB max per attachment
const ATTACHMENTS_DIR = "attachments"; // Directory name in app data (separate from message-attachments)
const DOWNLOAD_TIMEOUT_MS = 30000; // 30 second timeout per attachment

/**
 * Email attachment metadata from Gmail/Outlook APIs
 */
export interface EmailAttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string; // Gmail attachment ID or Outlook attachment ID
}

/**
 * Result of downloading attachments for an email
 */
export interface DownloadResult {
  success: boolean;
  stored: number;
  skipped: number;
  errors: number;
  details: {
    filename: string;
    status: "stored" | "skipped" | "error";
    reason?: string;
  }[];
}



/**
 * Generate content hash for deduplication
 * Uses SHA-256 for consistency with macOS messages import
 */
function generateContentHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Guess file extension from MIME type
 */
function guessExtensionFromMimeType(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      ".pptx",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "text/plain": ".txt",
    "text/html": ".html",
    "text/csv": ".csv",
    "application/zip": ".zip",
    "application/x-zip-compressed": ".zip",
    "application/octet-stream": ".bin",
  };
  return mimeToExt[mimeType] || ".bin";
}

/**
 * Download with timeout using AbortController
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

/**
 * Email Attachment Service
 * Downloads and stores email attachments from Gmail/Outlook
 */
class EmailAttachmentService {
  private static readonly SERVICE_NAME = "EmailAttachmentService";

  /**
   * Download and store attachments for an email
   *
   * @param userId - User ID for database records
   * @param emailId - Internal email ID (from emails table)
   * @param externalEmailId - External email ID (Gmail/Outlook message ID)
   * @param source - Email source ("gmail" or "outlook")
   * @param attachments - Array of attachment metadata from the email
   * @returns Download result with counts and details
   */
  async downloadEmailAttachments(
    userId: string,
    emailId: string,
    externalEmailId: string,
    source: "gmail" | "outlook",
    attachments: EmailAttachmentMeta[]
  ): Promise<DownloadResult> {
    const result: DownloadResult = {
      success: true,
      stored: 0,
      skipped: 0,
      errors: 0,
      details: [],
    };

    if (!attachments || attachments.length === 0) {
      return result;
    }

    await logService.info(
      `Downloading ${attachments.length} attachments for email ${emailId}`,
      EmailAttachmentService.SERVICE_NAME,
      { source, externalEmailId }
    );

    // Ensure attachments directory exists
    const attachmentsDir = path.join(app.getPath("userData"), ATTACHMENTS_DIR);
    await fs.mkdir(attachmentsDir, { recursive: true });

    // Load existing content hashes for deduplication
    const existingHashes = await this.loadExistingHashes();

    for (const attachment of attachments) {
      try {
        const downloadResult = await this.processAttachment(
          userId,
          emailId,
          externalEmailId,
          source,
          attachment,
          attachmentsDir,
          existingHashes
        );

        result.details.push(downloadResult);

        if (downloadResult.status === "stored") {
          result.stored++;
        } else if (downloadResult.status === "skipped") {
          result.skipped++;
        } else {
          result.errors++;
        }
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : "Unknown error";
        await logService.warn(
          `Failed to process attachment: ${attachment.filename}`,
          EmailAttachmentService.SERVICE_NAME,
          { error: errorMsg, emailId }
        );
        Sentry.captureException(error, {
          tags: { service: "email-attachment", operation: "downloadEmailAttachments" },
        });
        result.errors++;
        result.details.push({
          filename: attachment.filename,
          status: "error",
          reason: errorMsg,
        });
      }
    }

    await logService.info(
      `Attachment download complete: ${result.stored} stored, ${result.skipped} skipped, ${result.errors} errors`,
      EmailAttachmentService.SERVICE_NAME,
      { emailId }
    );

    return result;
  }

  /**
   * Process a single attachment: download, deduplicate, store
   */
  private async processAttachment(
    userId: string,
    emailId: string,
    externalEmailId: string,
    source: "gmail" | "outlook",
    attachment: EmailAttachmentMeta,
    attachmentsDir: string,
    existingHashes: Set<string>
  ): Promise<{ filename: string; status: "stored" | "skipped" | "error"; reason?: string }> {
    // BACKLOG-1870: `sanitizedFilename` is ONLY for deriving the on-disk file's
    // extension (the file itself is named by content hash — see below), NOT for the
    // DB key. The DB `attachments.filename` column stores the RAW (trimmed) display
    // name so it MATCHES what the sync path persisted (emailSyncService
    // normalizeAttachmentMeta also uses `.trim()`). Using the sanitized name as the
    // DB key caused a lookup miss (e.g. "Purchase Agreement (final).pdf" vs
    // "Purchase_Agreement_final_.pdf") → a duplicate row + orphaned sync row.
    const sanitizedFilename = sanitizeFileSystemName(attachment.filename, "attachment");
    const displayFilename = (attachment.filename ?? "").trim() || sanitizedFilename;

    // Skip oversized attachments
    if (attachment.size > MAX_ATTACHMENT_SIZE) {
      await logService.warn(
        `Skipping oversized attachment: ${displayFilename} (${Math.round(attachment.size / 1024 / 1024)}MB)`,
        EmailAttachmentService.SERVICE_NAME
      );
      return {
        filename: displayFilename,
        status: "skipped",
        reason: `Size ${Math.round(attachment.size / 1024 / 1024)}MB exceeds ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB limit`,
      };
    }

    // BACKLOG-1870: an attachment row may already exist for two reasons:
    //   - a previous download stored the bytes (storage_path set) → skip; or
    //   - a sync persisted METADATA ONLY (storage_path NULL) → download the bytes
    //     now and backfill storage on THAT SAME row (no duplicate).
    // Keyed by the RAW display filename so it reconciles with the sync-created row.
    const existingRow = this.getExistingAttachmentRow(emailId, displayFilename);
    if (existingRow && existingRow.storage_path) {
      return {
        filename: displayFilename,
        status: "skipped",
        reason: "Attachment already downloaded for this email",
      };
    }

    // Download attachment with timeout
    let data: Buffer;
    try {
      const result = await withTimeout(
        this.downloadAttachment(source, externalEmailId, attachment.attachmentId),
        DOWNLOAD_TIMEOUT_MS,
        `Download ${displayFilename}`
      );
      // Handle null return (Outlook graceful skip for unavailable attachments)
      if (result === null) {
        return {
          filename: displayFilename,
          status: "error",
          reason: "Attachment data unavailable (skipped by provider)",
        };
      }
      data = result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Download failed";
      return {
        filename: displayFilename,
        status: "error",
        reason: errorMsg,
      };
    }

    // Generate content hash for deduplication
    const contentHash = generateContentHash(data);

    // Determine storage path. The on-disk file is named by content hash; the
    // extension is derived from the sanitized name (this is the ONLY remaining
    // filesystem-safety use of sanitizeFileSystemName in this path).
    const ext =
      path.extname(sanitizedFilename) ||
      guessExtensionFromMimeType(attachment.mimeType);
    const storagePath = path.join(attachmentsDir, `${contentHash}${ext}`);

    // Validate storage path stays within attachmentsDir (prevent path traversal)
    const resolvedStoragePath = path.resolve(storagePath);
    const resolvedAttachmentsDir = path.resolve(attachmentsDir);
    if (!resolvedStoragePath.startsWith(resolvedAttachmentsDir + path.sep)) {
      throw new Error(`Storage path escapes attachments directory: ${resolvedStoragePath}`);
    }

    // Check if file already exists (deduplication)
    const fileExists = existingHashes.has(contentHash);

    if (!fileExists) {
      // CodeQL: js/http-to-file-access — This service intentionally downloads email
      // attachments to local storage. Mitigations: path traversal validation (line 301-306),
      // content-hash-based filenames, filename sanitization, deduplication.
      await fs.writeFile(resolvedStoragePath, data);
      existingHashes.add(contentHash);
    }

    // BACKLOG-1870: reconcile with a sync-created metadata row. If a row already
    // exists (storage_path was NULL — otherwise we'd have skipped above), fill in
    // storage on THAT row by id instead of inserting a duplicate. Otherwise create
    // a fresh record (the pre-BACKLOG-1870 behavior).
    if (existingRow) {
      databaseService.setEmailAttachmentStorage(
        existingRow.id,
        storagePath,
        data.length
      );
    } else {
      await this.createAttachmentRecord(
        userId,
        emailId,
        externalEmailId,
        displayFilename,
        attachment.mimeType,
        data.length,
        storagePath
      );
    }

    return {
      filename: displayFilename,
      status: "stored",
      reason: fileExists ? "File deduplicated, record created" : undefined,
    };
  }

  /**
   * Download attachment from Gmail or Outlook API
   * Returns null if the attachment could not be fetched (Outlook graceful skip)
   */
  private async downloadAttachment(
    source: "gmail" | "outlook",
    messageId: string,
    attachmentId: string
  ): Promise<Buffer | null> {
    if (source === "gmail") {
      return gmailFetchService.getAttachment(messageId, attachmentId);
    } else {
      return outlookFetchService.getAttachment(messageId, attachmentId);
    }
  }

  /**
   * Load existing content hashes for deduplication
   */
  private async loadExistingHashes(): Promise<Set<string>> {
    const existingHashes = new Set<string>();

    try {
      const rows = databaseService.getAttachmentStoragePaths();

      for (const row of rows) {
        // Extract hash from storage path (filename is the hash)
        const filename = path.basename(
          row.storage_path,
          path.extname(row.storage_path)
        );
        existingHashes.add(filename);
      }
    } catch (error) {
      await logService.warn(
        "Failed to load existing hashes, deduplication may create duplicates",
        EmailAttachmentService.SERVICE_NAME,
        { error }
      );
      Sentry.captureException(error, {
        tags: { service: "email-attachment", operation: "loadExistingHashes" },
      });
    }

    return existingHashes;
  }

  /**
   * BACKLOG-1870: Look up the existing attachment row (id + storage_path) for this
   * email/filename. Returns undefined when no row exists (or the column is missing
   * on an old schema). storage_path is NULL for a sync-persisted metadata row that
   * has not been downloaded yet.
   */
  private getExistingAttachmentRow(
    emailId: string,
    filename: string
  ): { id: string; storage_path: string | null } | undefined {
    try {
      return databaseService.getEmailAttachmentByFilename(emailId, filename);
    } catch {
      // If the email_id column doesn't exist yet, treat as no existing row.
      return undefined;
    }
  }

  /**
   * Create attachment record in database
   */
  private async createAttachmentRecord(
    userId: string,
    emailId: string,
    externalEmailId: string,
    filename: string,
    mimeType: string,
    fileSize: number,
    storagePath: string
  ): Promise<void> {
    const attachmentId = crypto.randomUUID();

    // Insert with email_id (new column for email attachments)
    // message_id is NULL for email attachments per SR Engineer migration clarification
    databaseService.createAttachmentRecord({
      id: attachmentId,
      emailId,
      externalEmailId,
      filename,
      mimeType,
      fileSizeBytes: fileSize,
      storagePath,
    });

    await logService.debug(
      `Created attachment record: ${filename}`,
      EmailAttachmentService.SERVICE_NAME,
      { attachmentId, emailId, storagePath }
    );
  }

  /**
   * Get attachments for an email
   */
  async getAttachmentsForEmail(
    emailId: string
  ): Promise<
    {
      id: string;
      filename: string;
      mime_type: string | null;
      file_size_bytes: number | null;
      storage_path: string | null;
    }[]
  > {
    try {
      return databaseService.getAttachmentsByEmailId(emailId);
    } catch (error) {
      await logService.warn(
        `Failed to get attachments for email ${emailId}`,
        EmailAttachmentService.SERVICE_NAME,
        { error }
      );
      Sentry.captureException(error, {
        tags: { service: "email-attachment", operation: "getAttachmentsForEmail" },
      });
      return [];
    }
  }

  /**
   * Get the attachments directory path
   */
  getAttachmentsDirectory(): string {
    return path.join(app.getPath("userData"), ATTACHMENTS_DIR);
  }
}

// Export singleton instance
export const emailAttachmentService = new EmailAttachmentService();
export default emailAttachmentService;
