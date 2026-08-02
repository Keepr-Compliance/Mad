/**
 * iPhone Sync Storage Service
 *
 * Persists extracted iPhone messages and contacts to the local database.
 * Called automatically after a successful iPhone sync completes.
 *
 * Uses async yielding to prevent blocking the main Electron process.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { app } from "electron";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import databaseService from "./databaseService";
import * as externalContactDb from "./db/externalContactDbService";
import { iOSMessagesParser } from "./iosMessagesParser";
import { detectMessageType } from "../utils/messageTypeDetector";
import { isContactSourceEnabled } from "../utils/preferenceHelper";
import type { iOSMessage, iOSConversation, iOSAttachment } from "../types/iosMessages";
import type { iOSContact } from "../types/iosContacts";
import type { SyncResult } from "./deviceSyncOrchestrator";

// Attachment storage constants
const ATTACHMENTS_DIR = "message-attachments";
const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024; // 50MB max

// Supported media types for import
const SUPPORTED_EXTENSIONS = new Set([
  // Images
  ".jpg", ".jpeg", ".png", ".gif", ".heic", ".heif", ".webp", ".bmp", ".tiff", ".tif",
  // Videos
  ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm",
  // Audio
  ".mp3", ".m4a", ".aac", ".wav", ".ogg",
  // Documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".rtf",
]);

/**
 * Result of persisting sync data
 */
export interface PersistResult {
  success: boolean;
  messagesStored: number;
  messagesSkipped: number;
  contactsStored: number;
  contactsSkipped: number;
  attachmentsStored: number;
  attachmentsSkipped: number;
  duration: number;
  error?: string;
}

/**
 * Progress callback for storage operations
 */
export type StorageProgressCallback = (progress: {
  phase: "messages" | "contacts" | "attachments";
  current: number;
  total: number;
  percent: number;
}) => void;

/**
 * Yield to event loop - allows UI to remain responsive
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Input validation constants
const MAX_MESSAGE_TEXT_LENGTH = 100000; // 100KB - truncate extremely long messages
const MAX_HANDLE_LENGTH = 500; // Phone numbers, emails, etc.
const MAX_GUID_LENGTH = 100; // Message GUID format

/**
 * Sanitize and validate a string field
 * @param value - The value to sanitize
 * @param maxLength - Maximum allowed length
 * @param defaultValue - Default if null/undefined
 * @returns Sanitized string
 */
function sanitizeString(value: string | null | undefined, maxLength: number, defaultValue = ""): string {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  const str = String(value);
  return str.length > maxLength ? str.substring(0, maxLength) : str;
}

/**
 * Validate a GUID/external ID format
 * @param guid - The GUID to validate
 * @returns true if valid format
 */
function isValidGuid(guid: string | null | undefined): boolean {
  if (!guid || typeof guid !== "string") return false;
  // Allow alphanumeric, hyphens, underscores, and common GUID characters
  // iOS message GUIDs can be various formats
  return guid.length > 0 && guid.length <= MAX_GUID_LENGTH && /^[\w\-:.]+$/.test(guid);
}

/**
 * iPhone Sync Storage Service
 * Handles persistence of iPhone sync data to the local database
 */
class IPhoneSyncStorageService {
  private static readonly SERVICE_NAME = "IPhoneSyncStorageService";
  // Smaller batch size for better responsiveness
  private static readonly BATCH_SIZE = 500;
  // Yield every N batches to let event loop breathe
  private static readonly YIELD_INTERVAL = 2;

  /**
   * Persist all data from a sync result to the database
   * @param userId User ID for data ownership
   * @param result Sync result containing messages, contacts, and conversations
   * @param backupPath Path to iOS backup for attachment extraction (SPRINT-068)
   * @param onProgress Progress callback
   * @param sessionId TASK-2110: Sync session ID for ACID rollback
   * @param cancelSignal TASK-2110: Cancel signal ref checked between phases/batches
   */
  async persistSyncResult(
    userId: string,
    result: SyncResult,
    backupPath?: string,
    onProgress?: StorageProgressCallback,
    sessionId?: string,
    cancelSignal?: { cancelled: boolean }
  ): Promise<PersistResult> {
    const startTime = Date.now();

    try {
      // Count total attachments for progress tracking
      const totalAttachments = result.messages.reduce(
        (count, msg) => count + msg.attachments.length,
        0
      );

      log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Starting persistence`, {
        messages: result.messages.length,
        contacts: result.contacts.length,
        conversations: result.conversations.length,
        attachments: totalAttachments,
        hasBackupPath: !!backupPath,
        sessionId: sessionId || "none",
      });

      // BACKLOG-1631: Breadcrumb when persistence starts
      Sentry.addBreadcrumb({
        category: "iphone.sync.storage",
        message: "Starting message persistence",
        data: { messageCount: result.messages.length, contactCount: result.contacts.length },
      });

      // TASK-2110: Check cancel signal before messages phase
      if (cancelSignal?.cancelled) {
        log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Cancelled before messages phase`);
        return this.cancelledResult(Date.now() - startTime);
      }

      // Store messages first (larger dataset)
      const messageResult = await this.storeMessages(
        userId,
        result.messages,
        result.conversations,
        (current, total) => {
          onProgress?.({
            phase: "messages",
            current,
            total,
            percent: Math.round((current / total) * 100),
          });
        },
        sessionId,
        cancelSignal
      );

      // TASK-2110: Check cancel signal between messages and contacts phases
      if (cancelSignal?.cancelled) {
        log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Cancelled after messages phase, rolling back`);
        await this.rollbackSession(userId, sessionId);
        return this.cancelledResult(Date.now() - startTime);
      }

      // Store contacts
      const contactResult = await this.storeContacts(
        userId,
        result.contacts,
        (current, total) => {
          onProgress?.({
            phase: "contacts",
            current,
            total,
            percent: Math.round((current / total) * 100),
          });
        },
        sessionId
      );

      // TASK-2110: Check cancel signal between contacts and attachments phases
      if (cancelSignal?.cancelled) {
        log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Cancelled after contacts phase, rolling back`);
        await this.rollbackSession(userId, sessionId);
        return this.cancelledResult(Date.now() - startTime);
      }

      // SPRINT-068: Store attachments (if backupPath available)
      let attachmentResult = { stored: 0, skipped: 0 };
      if (backupPath && totalAttachments > 0) {
        attachmentResult = await this.storeAttachments(
          userId,
          result.messages,
          backupPath,
          (current, total) => {
            onProgress?.({
              phase: "attachments",
              current,
              total,
              percent: Math.round((current / total) * 100),
            });
          },
          sessionId,
          cancelSignal
        );

        // TASK-2110: Check cancel signal after attachments phase
        if (cancelSignal?.cancelled) {
          log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Cancelled after attachments phase, rolling back`);
          await this.rollbackSession(userId, sessionId);
          return this.cancelledResult(Date.now() - startTime);
        }
      }

      const duration = Date.now() - startTime;

      log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Persistence complete`, {
        messagesStored: messageResult.stored,
        messagesSkipped: messageResult.skipped,
        contactsStored: contactResult.stored,
        contactsSkipped: contactResult.skipped,
        attachmentsStored: attachmentResult.stored,
        attachmentsSkipped: attachmentResult.skipped,
        duration,
      });

      // BACKLOG-1631: Breadcrumb when persistence completes
      Sentry.addBreadcrumb({
        category: "iphone.sync.storage",
        message: "Persistence complete",
        data: {
          savedMessages: messageResult.stored,
          savedContacts: contactResult.stored,
          skippedMessages: messageResult.skipped,
        },
      });

      return {
        success: true,
        messagesStored: messageResult.stored,
        messagesSkipped: messageResult.skipped,
        contactsStored: contactResult.stored,
        contactsSkipped: contactResult.skipped,
        attachmentsStored: attachmentResult.stored,
        attachmentsSkipped: attachmentResult.skipped,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      log.error(`[${IPhoneSyncStorageService.SERVICE_NAME}] Persistence failed`, {
        error: errorMessage,
        duration,
      });

      return {
        success: false,
        messagesStored: 0,
        messagesSkipped: 0,
        contactsStored: 0,
        contactsSkipped: 0,
        attachmentsStored: 0,
        attachmentsSkipped: 0,
        duration,
        error: errorMessage,
      };
    }
  }

  /**
   * TASK-2110: Roll back all data inserted during a sync session.
   * Deletes messages, attachments (with orphaned file cleanup), and new contacts.
   */
  private async rollbackSession(userId: string, sessionId?: string): Promise<void> {
    if (!sessionId) {
      log.warn(`[${IPhoneSyncStorageService.SERVICE_NAME}] No session ID for rollback, skipping`);
      return;
    }

    log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Rolling back session ${sessionId}`);

    // BACKLOG-1631: Alert Sentry when sync is cancelled and rolling back
    Sentry.captureMessage("iPhone sync cancelled - rolling back", {
      level: "warning",
    });

    try {
      // 1. Delete attachments and get orphaned file paths
      const attachmentResult = databaseService.deleteAttachmentsBySessionId(sessionId);

      // 2. Delete orphaned attachment files from disk
      for (const filePath of attachmentResult.orphanedFiles) {
        try {
          await fs.promises.unlink(filePath);
          log.debug(`[${IPhoneSyncStorageService.SERVICE_NAME}] Deleted orphaned file: ${filePath}`);
        } catch (err) {
          // File may already be deleted or inaccessible
          log.debug(`[${IPhoneSyncStorageService.SERVICE_NAME}] Could not delete file: ${filePath}`);
        }
      }

      // 3. Delete messages
      const messagesDeleted = databaseService.deleteMessagesBySessionId(userId, sessionId);

      // 4. Delete new contacts (only those newly inserted, not updated ones)
      const contactsDeleted = externalContactDb.deleteBySessionId(userId, sessionId);

      log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Rollback complete for session ${sessionId}`, {
        messagesDeleted,
        attachmentsDeleted: attachmentResult.deleted,
        orphanedFilesDeleted: attachmentResult.orphanedFiles.length,
        contactsDeleted,
      });
    } catch (error) {
      log.error(`[${IPhoneSyncStorageService.SERVICE_NAME}] Rollback failed for session ${sessionId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * TASK-2110: Create a cancelled PersistResult
   */
  private cancelledResult(duration: number): PersistResult {
    return {
      success: false,
      messagesStored: 0,
      messagesSkipped: 0,
      contactsStored: 0,
      contactsSkipped: 0,
      attachmentsStored: 0,
      attachmentsSkipped: 0,
      duration,
      error: "Sync cancelled by user",
    };
  }

  /**
   * Store messages to the database with bulk insert
   * Uses async yielding to prevent blocking
   *
   * OPTIMIZED: Pre-loads all existing external_ids into a Set for O(1) lookup
   * instead of O(n) database queries per message
   */
  private async storeMessages(
    userId: string,
    messages: iOSMessage[],
    conversations: iOSConversation[],
    onProgress?: (current: number, total: number) => void,
    sessionId?: string,
    cancelSignal?: { cancelled: boolean }
  ): Promise<{ stored: number; skipped: number }> {
    if (messages.length === 0) {
      return { stored: 0, skipped: 0 };
    }

    // Build a map of message id -> chatId by looking through conversations
    const messageToChat = new Map<number, number>();
    for (const conv of conversations) {
      for (const msg of conv.messages) {
        messageToChat.set(msg.id, conv.chatId);
      }
    }

    let stored = 0;
    let skipped = 0;

    // OPTIMIZATION: Load ALL existing external_ids into a Set (one query instead of 626k)
    // This gives us O(1) lookup instead of O(n) database queries
    log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Loading existing message IDs for deduplication...`);
    const existingIds = databaseService.getExistingMessageExternalIds(userId);
    log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Found ${existingIds.size} existing messages`);

    // Pre-filter and prepare messages for batch insert
    const messagesToInsert: {
      id: string;
      userId: string;
      channel: string;
      externalId: string;
      direction: string;
      bodyText: string | null;
      participants: string;
      participantsFlat: string;
      threadId: string | null;
      sentAt: string;
      hasAttachments: number;
      messageType: string | null;
      metadata: string | null;
    }[] = [];

    log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Processing ${messages.length} messages`);

    for (const msg of messages) {
      // Validate GUID before using it
      if (!isValidGuid(msg.guid)) {
        log.warn(`[${IPhoneSyncStorageService.SERVICE_NAME}] Skipping message with invalid GUID`, {
          guid: msg.guid?.substring(0, 20),
        });
        // BACKLOG-1631: Breadcrumb for invalid GUID skips
        Sentry.addBreadcrumb({
          category: "iphone.sync.storage",
          message: "Skipped invalid message GUID",
          level: "warning",
        });
        skipped++;
        continue;
      }

      // O(1) lookup using Set instead of database query
      if (existingIds.has(msg.guid)) {
        skipped++;
        continue;
      }

      // Add to set so duplicates within same batch are caught
      existingIds.add(msg.guid);

      // Find the conversation/thread for this message
      const chatId = messageToChat.get(msg.id);
      const threadId = chatId ? `ios-chat-${chatId}` : null;

      // Map channel
      const channel = msg.service === "iMessage" ? "imessage" : "sms";

      // Map direction
      const direction = msg.isFromMe ? "outbound" : "inbound";

      // Sanitize user-provided data
      const sanitizedHandle = sanitizeString(msg.handle, MAX_HANDLE_LENGTH, "unknown");
      const sanitizedText = sanitizeString(msg.text, MAX_MESSAGE_TEXT_LENGTH, "");

      // Build participants JSON with sanitized data
      const participants = JSON.stringify({
        from: msg.isFromMe ? "me" : sanitizedHandle,
        to: msg.isFromMe ? [sanitizedHandle] : ["me"],
      });

      // SPRINT-068: Build participants_flat for phone number matching
      // Extract digits from handle for fast LIKE queries (matches macOS import behavior)
      const handleDigits = sanitizedHandle.replace(/\D/g, "");
      const participantsFlat = handleDigits || sanitizedHandle;

      // Build metadata
      const metadata = JSON.stringify({
        source: "iphone_sync",
        originalId: msg.id,
        dateRead: msg.dateRead?.toISOString() || null,
        dateDelivered: msg.dateDelivered?.toISOString() || null,
        attachmentCount: msg.attachments.length,
      });

      // TASK-1799: Detect message type for UI differentiation
      // Get primary attachment MIME type for voice message detection
      const primaryAttachmentMimeType = msg.attachments.length > 0
        ? msg.attachments[0].mimeType
        : null;
      const messageType = detectMessageType({
        text: sanitizedText,
        hasAudioTranscript: !!msg.audioTranscript,
        attachmentMimeType: primaryAttachmentMimeType,
        attachmentCount: msg.attachments.length,
      });

      messagesToInsert.push({
        id: crypto.randomUUID(),
        userId,
        channel,
        externalId: msg.guid,
        direction,
        bodyText: sanitizedText,
        participants,
        participantsFlat,
        threadId: threadId || null,
        sentAt: msg.date.toISOString(),
        hasAttachments: msg.attachments.length > 0 ? 1 : 0,
        messageType,
        metadata,
      });
    }

    // Batch insert all prepared messages through the service layer
    if (messagesToInsert.length > 0) {
      const result = databaseService.batchInsertMessages(
        messagesToInsert,
        IPhoneSyncStorageService.BATCH_SIZE,
        sessionId,
        cancelSignal
      );
      stored = result.stored;
      // Add DB-level skips (UNIQUE constraint) to our pre-filter skips
      skipped += result.skipped;
    }

    // Report final progress
    onProgress?.(messages.length, messages.length);

    return { stored, skipped };
  }

  /**
   * Store contacts to the external_contacts table (SPRINT-068, BACKLOG-585)
   *
   * ARCHITECTURE CHANGE: iPhone contacts now go to external_contacts table
   * (same as macOS contacts) instead of the contacts table. This enables:
   * - Consistent contact name lookup on Windows via external_contacts
   * - Texts auto-attaching correctly by phone number matching
   * - Same UI experience as macOS
   *
   * Uses async yielding to prevent blocking
   */
  private async storeContacts(
    userId: string,
    contacts: iOSContact[],
    onProgress?: (current: number, total: number) => void,
    sessionId?: string
  ): Promise<{ stored: number; skipped: number }> {
    if (contacts.length === 0) {
      return { stored: 0, skipped: 0 };
    }

    // Check if iPhone contacts source is enabled (check both keys for compatibility)
    const iphoneEnabled = await isContactSourceEnabled(userId, "direct", "iphoneContacts", true);
    const macosEnabled = await isContactSourceEnabled(userId, "direct", "macosContacts", true);
    if (!iphoneEnabled && !macosEnabled) {
      log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] iPhone contacts storage skipped (disabled in preferences)`);
      return { stored: 0, skipped: contacts.length };
    }

    log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Storing ${contacts.length} contacts to external_contacts`);

    // Convert iOSContact[] to iPhoneContact[] for externalContactDbService
    const iPhoneContacts: externalContactDb.iPhoneContact[] = contacts.map(contact => {
      const sanitizedDisplayName = sanitizeString(contact.displayName, MAX_HANDLE_LENGTH, "Unknown");
      const sanitizedOrganization = sanitizeString(contact.organization, MAX_HANDLE_LENGTH);

      return {
        name: sanitizedDisplayName,
        phones: contact.phoneNumbers
          .map(p => sanitizeString(p.normalizedNumber, MAX_HANDLE_LENGTH))
          .filter((p): p is string => !!p),
        emails: contact.emails
          .map(e => sanitizeString(e.email, MAX_HANDLE_LENGTH)?.toLowerCase())
          .filter((e): e is string => !!e),
        company: sanitizedOrganization || undefined,
        recordId: String(contact.id),  // iPhone contact ID as string (ABPerson.ROWID)
        // BACKLOG-2407: carry the identifiers that cannot be re-read once this
        // phone is gone. `recordId` above is UNCHANGED and remains the key —
        // these ride alongside it and are matched on by nothing.
        //
        // Sanitized like every other string taken off the backup: it is a
        // user-supplied restored file, and MAX_HANDLE_LENGTH is the existing
        // bound for untrusted text on this path. `?? null` keeps an absent value
        // null rather than undefined so the serializer drops it cleanly.
        externalUuid: sanitizeString(contact.externalUuid, MAX_HANDLE_LENGTH) ?? null,
        sourceIdentity: {
          externalIdentifier:
            sanitizeString(contact.externalIdentifier, MAX_HANDLE_LENGTH) ?? null,
          externalModificationTag:
            sanitizeString(contact.externalModificationTag, MAX_HANDLE_LENGTH) ?? null,
          // Already ISO-8601 or null from the parser's own converter.
          modifiedAt: contact.modifiedAt,
          createdAt: contact.createdAt,
          storeId: contact.storeId,
        },
      };
    });

    // Report initial progress
    onProgress?.(0, contacts.length);
    await yieldToEventLoop();

    // Use the externalContactDbService to upsert contacts
    // This handles deduplication via UNIQUE(user_id, source, external_record_id)
    const stored = externalContactDb.upsertFromiPhone(userId, iPhoneContacts, sessionId);

    // Report completion
    onProgress?.(contacts.length, contacts.length);

    log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Stored ${stored} contacts to external_contacts`);

    return { stored, skipped: contacts.length - stored };
  }

  /**
   * Store attachments from iPhone backup (SPRINT-068)
   * Copies files from backup to app data directory and creates database records
   */
  private async storeAttachments(
    userId: string,
    messages: iOSMessage[],
    backupPath: string,
    onProgress?: (current: number, total: number) => void,
    sessionId?: string,
    cancelSignal?: { cancelled: boolean }
  ): Promise<{ stored: number; skipped: number }> {
    // Collect all attachments with their message info
    const attachmentsToStore: Array<{
      attachment: iOSAttachment;
      messageGuid: string;
    }> = [];

    for (const msg of messages) {
      for (const att of msg.attachments) {
        attachmentsToStore.push({
          attachment: att,
          messageGuid: msg.guid,
        });
      }
    }

    if (attachmentsToStore.length === 0) {
      return { stored: 0, skipped: 0 };
    }

    log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Processing ${attachmentsToStore.length} attachments`);

    const attachmentsDir = path.join(app.getPath("userData"), ATTACHMENTS_DIR);

    // Create attachments directory if it doesn't exist
    await fs.promises.mkdir(attachmentsDir, { recursive: true });

    // Load existing message IDs for linking
    const messageIdMap = databaseService.getMessageIdMap(userId);

    // Load existing attachment hashes for deduplication
    const existingHashes = new Set<string>();
    const hashRows = databaseService.getAttachmentStoragePaths();
    for (const row of hashRows) {
      const filename = path.basename(row.storage_path, path.extname(row.storage_path));
      existingHashes.add(filename);
    }

    // Load existing attachment records (message_id + filename)
    const existingRecords = databaseService.getExistingAttachmentRecords();

    let stored = 0;
    let skipped = 0;

    for (let i = 0; i < attachmentsToStore.length; i++) {
      // TASK-2110: Check cancel signal between attachments
      if (cancelSignal?.cancelled) {
        log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Attachment storage cancelled at ${i}/${attachmentsToStore.length}`);
        break;
      }

      const { attachment, messageGuid } = attachmentsToStore[i];

      try {
        // Get internal message ID
        const internalMessageId = messageIdMap.get(messageGuid);
        if (!internalMessageId) {
          skipped++;
          continue;
        }

        // Get filename
        const filename = attachment.transferName || attachment.filename || `attachment_${attachment.id}`;

        // Check file extension
        const ext = path.extname(filename).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          skipped++;
          continue;
        }

        // Check if already exists
        if (existingRecords.has(`${internalMessageId}:${filename}`)) {
          skipped++;
          continue;
        }

        // Resolve source file path in backup
        const sourcePath = iOSMessagesParser.resolveAttachmentPath(backupPath, attachment.filename);
        if (!sourcePath) {
          skipped++;
          continue;
        }

        // Check if source file exists
        try {
          const stats = await fs.promises.stat(sourcePath);
          if (stats.size > MAX_ATTACHMENT_SIZE) {
            log.debug(`[${IPhoneSyncStorageService.SERVICE_NAME}] Skipping oversized attachment: ${stats.size} bytes`);
            skipped++;
            continue;
          }
        } catch {
          // File not found in backup
          skipped++;
          continue;
        }

        // TASK-1790: Use streaming hash instead of loading entire file into memory
        // This prevents memory issues with large files (up to 50MB)
        const contentHash = await this.computeFileHashStreaming(sourcePath);

        // Determine destination path
        const destPath = path.join(attachmentsDir, `${contentHash}${ext}`);

        // Get file size for record
        const stats = await fs.promises.stat(sourcePath);

        // Copy file if not already stored (use copyFile instead of read/write)
        if (!existingHashes.has(contentHash)) {
          await fs.promises.copyFile(sourcePath, destPath);
          existingHashes.add(contentHash);
        }

        // Create attachment record
        databaseService.insertAttachment({
          id: crypto.randomUUID(),
          messageId: internalMessageId,
          externalMessageId: messageGuid,
          filename,
          mimeType: attachment.mimeType || this.getMimeType(ext),
          fileSizeBytes: stats.size,
          storagePath: destPath,
          sessionId,
        });

        existingRecords.add(`${internalMessageId}:${filename}`);
        stored++;
      } catch (error) {
        log.debug(`[${IPhoneSyncStorageService.SERVICE_NAME}] Failed to store attachment`, {
          filename: attachment.filename,
          error: error instanceof Error ? error.message : String(error),
        });
        // BACKLOG-1631: Breadcrumb for individual attachment failures (expected, not captureException)
        Sentry.addBreadcrumb({
          category: "iphone.sync.storage",
          message: "Attachment storage failed",
          level: "warning",
          data: { error: error instanceof Error ? error.message : String(error) },
        });
        skipped++;
      }

      // Report progress
      if ((i + 1) % 100 === 0 || i === attachmentsToStore.length - 1) {
        onProgress?.(i + 1, attachmentsToStore.length);
        await yieldToEventLoop();
      }
    }

    log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Attachments complete`, {
      stored,
      skipped,
    });

    return { stored, skipped };
  }

  /**
   * Compute SHA-256 hash of a file using streaming (TASK-1790)
   * Prevents loading entire file into memory for large files
   */
  private computeFileHashStreaming(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(ext: string): string {
    const mimeTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".heic": "image/heic",
      ".heif": "image/heif",
      ".webp": "image/webp",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".m4v": "video/x-m4v",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".pdf": "application/pdf",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    return mimeTypes[ext.toLowerCase()] || "application/octet-stream";
  }
}

// Export singleton instance
export const iPhoneSyncStorageService = new IPhoneSyncStorageService();
export default iPhoneSyncStorageService;
