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
import {
  holdContactLinking,
  releaseContactLinking,
  requestContactLinking,
} from "./contactLinkingScheduler";
import { iOSMessagesParser } from "./iosMessagesParser";
import { hashSourceFile, isAtRestWriteRefused, sealFileFrom, sourceFileSize } from "./atRest/attachmentWriter";
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
  /** True when contacts were withheld because the iPhone Contacts source is off (BACKLOG-3791). */
  contactsSourceOff?: boolean;
  attachmentsStored: number;
  attachmentsSkipped: number;
  /**
   * BACKLOG-3784: why attachments were skipped, counts only. Sums to
   * `attachmentsSkipped`. Absent on cancelled/failed results.
   */
  attachmentsSkippedByReason?: AttachmentSkipCounts;
  duration: number;
  error?: string;
  /**
   * BACKLOG-3816: attachments were not saved because the file-data key is
   * unavailable (writes fail closed). `error` then carries the user-facing message.
   */
  atRestRefused?: boolean;
}

/**
 * BACKLOG-3784: every reason `storeAttachments` skips an attachment. One counter
 * per reason so a large "skipped" total can be explained. Counts only.
 */
export const ATTACHMENT_SKIP_REASONS = [
  "noMessage",
  "unsupportedType",
  "alreadyStored",
  "rejectedPath",
  "notInBackup",
  "tooLarge",
  "error",
] as const;
export type AttachmentSkipReason = (typeof ATTACHMENT_SKIP_REASONS)[number];
export type AttachmentSkipCounts = Record<AttachmentSkipReason, number>;

export function emptyAttachmentSkipCounts(): AttachmentSkipCounts {
  return {
    noMessage: 0,
    unsupportedType: 0,
    alreadyStored: 0,
    rejectedPath: 0,
    notInBackup: 0,
    tooLarge: 0,
    error: 0,
  };
}

/**
 * BACKLOG-3784: per-reason attachment skip counts as flat timeline fields, e.g.
 * `attachmentsSkipped=64019 attachmentsSkippedAlreadyStored=63990 ...`. Counts only.
 */
export function attachmentSkipFields(
  total: number,
  byReason: AttachmentSkipCounts | undefined,
): Record<string, number> {
  const fields: Record<string, number> = { attachmentsSkipped: total };
  if (!byReason) return fields;
  for (const reason of ATTACHMENT_SKIP_REASONS) {
    fields[`attachmentsSkipped${reason.charAt(0).toUpperCase()}${reason.slice(1)}`] = byReason[reason];
  }
  return fields;
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

/**
 * BACKLOG-3785: ids per lookup query in the attachment setup. Bounded so one query
 * (and the main-thread time it takes) stays small; the caller yields between them.
 * Well under SQLite's host-parameter limit.
 */
const LOOKUP_CHUNK = 500;

/**
 * BACKLOG-3868: ids per page of the message duplicate check, and messages per
 * slice of the pre-filter loop; the caller yields between them.
 */
const DEDUPE_PAGE = 5000;
/** BACKLOG-3868: contacts per upsert transaction in storeContacts. */
const CONTACT_UPSERT_SLICE = 500;

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
  /**
   * BACKLOG-3868: rows per insert transaction in storeMessages (was 500). A
   * 500-row batch took 12 ms at the start of a 100k insert into an encrypted
   * store and up to 250 ms by the end (the messages indexes outgrow the page
   * cache), so the transaction/yield granularity is 100.
   */
  private static readonly INSERT_SLICE = 100;
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

    // BACKLOG-2474 — NO CONTACT MATCHING WHILE THIS SESSION CAN STILL ROLL BACK.
    //
    // `storeContacts` below writes rows stamped with `sessionId`, and every
    // cancel/failure branch after it calls `rollbackSession` -> `deleteBySessionId`,
    // which deletes exactly those rows. Between the two sits `storeAttachments`,
    // which copies files and can run for minutes.
    //
    // Suppressing this path's OWN linking signal is not enough: the pass reads
    // the whole table, so a macOS or Outlook sync completing inside that window
    // would run a pass that links records this sync is about to delete. The hold
    // makes "provisional" a property of the data rather than of who signalled.
    //
    // Only for session-scoped calls — a call with no session is not rollback-
    // eligible and must not have its matching suspended.
    const holdsLinking = sessionId !== undefined;
    if (holdsLinking) holdContactLinking(userId);

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
      let attachmentResult: { stored: number; skipped: number; skippedByReason?: AttachmentSkipCounts } = {
        stored: 0,
        skipped: 0,
      };
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

      // BACKLOG-2474 — THE COMMIT POINT for the iPhone path.
      //
      // `upsertFromiPhone` deliberately does not signal when a sessionId is
      // open, because everything above this line is still rollback-eligible
      // (TASK-2110) and linking provisional rows would leave the crosswalk
      // pointing at records `deleteBySessionId` is about to remove. Past this
      // point every cancel and failure branch has already returned, so the rows
      // are permanent and Phase 2 may safely consider them.
      if (contactResult.stored > 0) {
        requestContactLinking(userId);
      }

      log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Persistence complete`, {
        messagesStored: messageResult.stored,
        messagesSkipped: messageResult.skipped,
        contactsStored: contactResult.stored,
        contactsSkipped: contactResult.skipped,
        attachmentsStored: attachmentResult.stored,
        attachmentsSkipped: attachmentResult.skipped,
        attachmentsSkippedByReason: attachmentResult.skippedByReason,
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
        contactsSourceOff: contactResult.sourceOff === true,
        attachmentsStored: attachmentResult.stored,
        attachmentsSkipped: attachmentResult.skipped,
        ...(attachmentResult.skippedByReason
          ? { attachmentsSkippedByReason: attachmentResult.skippedByReason }
          : {}),
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const refused = isAtRestWriteRefused(error);
      const errorMessage = refused
        ? error.userMessage
        : error instanceof Error
          ? error.message
          : "Unknown error";

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
        ...(refused ? { atRestRefused: true } : {}),
      };
    } finally {
      // BACKLOG-2474: release on EVERY exit — success, cancel and throw alike.
      // A hold that is never lifted silently disables contact matching for this
      // user until the app restarts, which would be a worse bug than the one
      // the hold prevents.
      if (holdsLinking) releaseContactLinking(userId);
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
   * Duplicate check: the user's stored external_ids are read into a Set in
   * bounded pages, yielding between them (BACKLOG-3868), then looked up per message.
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

    // BACKLOG-3868: the user's stored external_ids, read in keyset pages with a
    // yield between them. This used to be one synchronous read of every id —
    // ~0.5-0.8 s of blocked main on a ~670k-message store, several times that on a
    // low-end PC. Same set of ids; a per-guid lookup instead (IN chunks) was
    // measured at ~8x the wall time on 671k rows, because every sync carries the
    // phone's whole history.
    log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Loading existing message IDs for deduplication...`);
    const existingIds = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const page: string[] = databaseService.getMessageExternalIdsPage(userId, after, DEDUPE_PAGE) ?? [];
      for (const id of page) existingIds.add(id);
      await yieldToEventLoop();
      if (page.length < DEDUPE_PAGE) break;
      after = page[page.length - 1];
    }
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

    for (let index = 0; index < messages.length; index++) {
      const msg = messages[index];
      // BACKLOG-3868: every sync carries the phone's whole history; yield so this
      // loop is not one long block on a large one.
      if (index > 0 && index % DEDUPE_PAGE === 0) await yieldToEventLoop();
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

    // Batch insert all prepared messages through the service layer.
    // BACKLOG-3868: one INSERT_SLICE slice per call (each its own transaction, as
    // before) with a yield to the event loop between slices. The db function ran
    // every slice back to back: 10k new messages blocked main ~0.4 s, 100k ~15 s.
    // Cancel: checked before every slice; slices already committed stay, and the
    // caller's rollbackSession(sessionId) removes them (unchanged).
    const batchSize = IPhoneSyncStorageService.INSERT_SLICE;
    for (let start = 0; start < messagesToInsert.length; start += batchSize) {
      if (cancelSignal?.cancelled) break;
      const result = databaseService.batchInsertMessages(
        messagesToInsert.slice(start, start + batchSize),
        batchSize,
        sessionId,
        cancelSignal
      );
      stored += result.stored;
      // Add DB-level skips (UNIQUE constraint) to our pre-filter skips
      skipped += result.skipped;
      await yieldToEventLoop();
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
  ): Promise<{ stored: number; skipped: number; sourceOff?: boolean }> {
    if (contacts.length === 0) {
      return { stored: 0, skipped: 0 };
    }

    // BACKLOG-2486: iPhone contacts answer to `iphoneContacts` and NOTHING else.
    //
    // This read `!iphoneEnabled && !macosEnabled` — "check both keys for
    // compatibility". On a Mac `macosContacts` is on for essentially every user,
    // so the second clause was always false and turning iPhone Contacts off
    // stored the contacts anyway. The SR review of PR #2201 drove this exact
    // function and got byte-identical output for stored `iphone:true` and stored
    // `iphone:false`.
    //
    // The "compatibility" being referred to was Windows (commit `c774e198`),
    // where `macosContacts` is never written and the original macOS-only gate
    // dropped every iPhone record. That is now handled by the derived default —
    // `iphoneContacts` absent resolves to `!isMacOS`, i.e. TRUE on Windows
    // (`contactSourceDefaults.ts:140-152`) — so no borrowed preference is needed.
    //
    // NOTE THE ASYMMETRY WITH `macosContacts`, which is deliberate: an ABSENT
    // `iphoneContacts` is DERIVED (false on macOS, true on Windows), not
    // fail-open. On macOS that means a user who never completed the
    // contact-source step will not have iPhone contacts stored — which is the
    // BACKLOG-2479 rule, because the Mac address book already carries them via
    // iCloud. Logged at info with the reason so it is diagnosable in the field
    // rather than looking like a failed sync.
    const iphoneEnabled = await isContactSourceEnabled(userId, "direct", "iphoneContacts", true);
    if (!iphoneEnabled) {
      log.info(
        `[${IPhoneSyncStorageService.SERVICE_NAME}] iPhone contacts storage skipped: ` +
          `the iPhone Contacts source is off for this user (${contacts.length} contacts not stored). ` +
          // BACKLOG-3791: the iCloud explanation only holds on macOS.
          (process.platform === "darwin"
            ? `On macOS this is the default — the Mac address book already carries iPhone contacts via iCloud.`
            : `Turn it on in Settings to import iPhone contacts.`)
      );
      return { stored: 0, skipped: contacts.length, sourceOff: true };
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
    // BACKLOG-3868: in CONTACT_UPSERT_SLICE-sized calls (each its own transaction)
    // with a yield between them; one call for every contact blocked main ~0.5 s per
    // 10k contacts on an encrypted store. Same rows: the upsert is keyed on
    // (user_id, source, external_record_id), and the sessionId rollback is unchanged.
    let stored = 0;
    for (let start = 0; start < iPhoneContacts.length; start += CONTACT_UPSERT_SLICE) {
      stored += externalContactDb.upsertFromiPhone(
        userId,
        iPhoneContacts.slice(start, start + CONTACT_UPSERT_SLICE),
        sessionId,
      );
      if (start + CONTACT_UPSERT_SLICE < iPhoneContacts.length) await yieldToEventLoop();
    }

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
  ): Promise<{ stored: number; skipped: number; skippedByReason: AttachmentSkipCounts }> {
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
      return { stored: 0, skipped: 0, skippedByReason: emptyAttachmentSkipCounts() };
    }

    log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Processing ${attachmentsToStore.length} attachments`);

    const attachmentsDir = path.join(app.getPath("userData"), ATTACHMENTS_DIR);

    // Create attachments directory if it doesn't exist
    await fs.promises.mkdir(attachmentsDir, { recursive: true });

    // BACKLOG-3785: resolve internal ids for THIS sync's attachment-bearing messages
    // only, in bounded chunks, yielding between chunks. This used to load every
    // message row of the user (getMessageIdMap) and every attachment record in one
    // synchronous pass — ~33-40 s of blocked main on a ~670k-message store.
    const messageIdMap = new Map<string, string>();
    const guids = [...new Set(attachmentsToStore.map((a) => a.messageGuid))];
    for (let start = 0; start < guids.length; start += LOOKUP_CHUNK) {
      const chunk = databaseService.getMessageIdsByExternalIds(userId, guids.slice(start, start + LOOKUP_CHUNK));
      for (const [guid, id] of chunk ?? []) messageIdMap.set(guid, id);
      await yieldToEventLoop();
    }

    // Load existing attachment hashes for deduplication
    const existingHashes = new Set<string>();
    const hashRows = databaseService.getAttachmentStoragePaths();
    for (const row of hashRows) {
      const filename = path.basename(row.storage_path, path.extname(row.storage_path));
      existingHashes.add(filename);
    }
    await yieldToEventLoop();

    // Existing attachment records (message_id + filename) for the resolved messages
    // only — same chunk-and-yield as above (BACKLOG-3785).
    const existingRecords = new Set<string>();
    const resolvedIds = [...new Set(messageIdMap.values())];
    for (let start = 0; start < resolvedIds.length; start += LOOKUP_CHUNK) {
      const chunk = databaseService.getExistingAttachmentRecordsForMessages(resolvedIds.slice(start, start + LOOKUP_CHUNK));
      for (const record of chunk ?? []) existingRecords.add(record);
      await yieldToEventLoop();
    }

    // BACKLOG-3785: progress cadence — ~2% of the run, rounded up to a multiple of 100.
    const progressEvery = Math.max(1, Math.ceil(attachmentsToStore.length / 50 / 100)) * 100;

    let stored = 0;
    // BACKLOG-3784: one counter per reason; `skipped` is their sum.
    const skippedBy = emptyAttachmentSkipCounts();

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
          skippedBy.noMessage++;
          continue;
        }

        // Get filename
        const filename = attachment.transferName || attachment.filename || `attachment_${attachment.id}`;

        // Check file extension
        const ext = path.extname(filename).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          skippedBy.unsupportedType++;
          continue;
        }

        // Check if already exists
        if (existingRecords.has(`${internalMessageId}:${filename}`)) {
          skippedBy.alreadyStored++;
          continue;
        }

        // Resolve source file path in backup
        const sourcePath = iOSMessagesParser.resolveAttachmentPath(backupPath, attachment.filename);
        if (!sourcePath) {
          skippedBy.rejectedPath++;
          continue;
        }

        // Check if source file exists. BACKLOG-3816: the backup file is read RAW —
        // it is Apple's plaintext (an Apple-encrypted backup arrives here already
        // decrypted), never classified by its first bytes (attachmentWriter.ts).
        let sourceSize: number;
        try {
          sourceSize = await sourceFileSize(sourcePath);
          if (sourceSize > MAX_ATTACHMENT_SIZE) {
            log.debug(`[${IPhoneSyncStorageService.SERVICE_NAME}] Skipping oversized attachment: ${sourceSize} bytes`);
            skippedBy.tooLarge++;
            continue;
          }
        } catch {
          // File not found in backup
          skippedBy.notInBackup++;
          continue;
        }

        // TASK-1790: streaming hash of the (plaintext) source: the dedupe key and the
        // stored file name are the SHA-256 of the plaintext (BACKLOG-3816).
        const contentHash = (await hashSourceFile(sourcePath)).sha256;

        // Determine destination path
        const destPath = path.join(attachmentsDir, `${contentHash}${ext}`);

        // BACKLOG-3816: store the KEPRENC ciphertext, never a plaintext copy.
        if (!existingHashes.has(contentHash)) {
          const sealed = await sealFileFrom(sourcePath, destPath);
          if (sealed.sha256 !== contentHash) {
            // The source changed between the hash and the copy: the name would lie.
            await fs.promises.unlink(destPath).catch(() => undefined);
            throw new Error("attachment source changed while it was being stored");
          }
          existingHashes.add(contentHash);
        }

        // Create attachment record
        databaseService.insertAttachment({
          id: crypto.randomUUID(),
          messageId: internalMessageId,
          externalMessageId: messageGuid,
          filename,
          mimeType: attachment.mimeType || this.getMimeType(ext),
          fileSizeBytes: sourceSize,
          storagePath: destPath,
          sessionId,
        });

        existingRecords.add(`${internalMessageId}:${filename}`);
        stored++;
      } catch (error) {
        // BACKLOG-3816: a refused write (no file-data key) stops the whole run —
        // swallowing it here would report success with every attachment "skipped".
        if (isAtRestWriteRefused(error)) throw error;
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
        skippedBy.error++;
      } finally {
        // Report progress. BACKLOG-3784: in `finally` so it also runs for SKIPPED
        // attachments — every skip above `continue`s, and before this a run of
        // already-stored attachments (an incremental sync) never reported progress
        // and never yielded the event loop. Same throttle as before.
        //
        // BACKLOG-3785: still YIELD every 100th item, but REPORT only every ~2%
        // (a multiple of 100, at least 100) and the last — ~50 events per run
        // instead of one per 100 items.
        const isLast = i === attachmentsToStore.length - 1;
        if ((i + 1) % 100 === 0 || isLast) {
          if ((i + 1) % progressEvery === 0 || isLast) {
            onProgress?.(i + 1, attachmentsToStore.length);
          }
          await yieldToEventLoop();
        }
      }
    }

    iOSMessagesParser.flushRejectedPathSummary();

    const skipped = ATTACHMENT_SKIP_REASONS.reduce((sum, r) => sum + skippedBy[r], 0);
    log.info(`[${IPhoneSyncStorageService.SERVICE_NAME}] Attachments complete`, {
      stored,
      skipped,
      skippedByReason: skippedBy,
    });

    return { stored, skipped, skippedByReason: skippedBy };
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
