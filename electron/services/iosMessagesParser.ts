/**
 * iOS Messages Parser Service
 * Parses sms.db from iOS backups to extract conversations and messages
 *
 * Uses async yielding to prevent blocking the main Electron process
 * when processing large databases (627k+ messages).
 */

import crypto from "crypto";
import Database from "better-sqlite3-multiple-ciphers";
import path from "path";
import log from "electron-log";
import { extractTextFromAttributedBody } from "../utils/messageParser";

/**
 * Yield to event loop - allows UI to remain responsive during long operations
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Async processing constants
const CHAT_YIELD_INTERVAL = 50; // Yield every N chats processed
const MESSAGE_YIELD_INTERVAL = 500; // Yield every N messages processed
import {
  iOSMessage,
  iOSAttachment,
  iOSConversation,
  RawMessageRow,
  RawAttachmentRow,
  RawChatRow,
  RawHandleRow,
} from "../types/iosMessages";
import {
  ALL_CHATS_SQL,
  AUDIO_TRANSCRIPT_COLUMN_PROBE_SQL,
  CHAT_BY_ROWID_SQL,
  CHAT_LAST_MESSAGE_DATE_SQL,
  CHAT_MESSAGE_COUNT_SQL,
  CHAT_PARTICIPANT_HANDLES_SQL,
  HANDLE_ID_BY_ROWID_SQL,
  MESSAGE_ATTACHMENTS_SQL,
  searchMessagesByText,
  selectChatMessages,
} from "./db/appleSmsDbSql";

/**
 * Convert Apple Cocoa Core Data timestamp to JavaScript Date
 * iOS uses nanoseconds since 2001-01-01 00:00:00 UTC
 */
export function convertAppleTimestamp(timestamp: number | null): Date | null {
  if (timestamp === null || timestamp === undefined || timestamp === 0) {
    return null;
  }

  // Apple epoch is 2001-01-01 00:00:00 UTC in milliseconds since Unix epoch
  const APPLE_EPOCH_MS = 978307200000;

  // iOS stores in nanoseconds, need to convert to milliseconds
  const milliseconds = timestamp / 1000000;

  return new Date(APPLE_EPOCH_MS + milliseconds);
}

/**
 * iOS Messages Parser
 * Reads sms.db from an iTunes-style backup and extracts conversations and messages
 */
export class iOSMessagesParser {
  private db: Database.Database | null = null;
  private backupPath: string = "";
  private hasAudioTranscriptColumn: boolean | null = null;

  // The sms.db hash in iOS backups (SHA-1 of domain + path)
  static readonly SMS_DB_HASH = "3d0d7e5fb2ce288813306e4d4636395e047a3d28";

  /**
   * Compute the SHA1 hash for an iOS backup file path.
   * iOS backups store files with SHA1(domain-relativePath) as the filename.
   * @param domain The iOS domain (e.g., "MediaDomain", "HomeDomain")
   * @param relativePath The path relative to the domain (without leading ~/)
   */
  static computeBackupFileHash(domain: string, relativePath: string): string {
    const fullPath = `${domain}-${relativePath}`;
    return crypto.createHash("sha1").update(fullPath).digest("hex");
  }

  /**
   * Resolve an attachment's original path to its location in the iOS backup.
   * @param backupPath Path to the iOS backup directory
   * @param originalPath The original iOS path (e.g., ~/Library/SMS/Attachments/...)
   * @returns Full path to the file in the backup, or null if not found/invalid
   */
  static resolveAttachmentPath(backupPath: string, originalPath: string): string | null {
    if (!originalPath) return null;

    // iOS attachment paths are like ~/Library/SMS/Attachments/...
    // Remove the ~/ prefix to get the relative path
    let relativePath = originalPath;
    if (relativePath.startsWith("~/")) {
      relativePath = relativePath.slice(2);
    } else if (relativePath.startsWith("/var/mobile/")) {
      // Some paths may be absolute /var/mobile/Library/...
      relativePath = relativePath.replace("/var/mobile/", "");
    }

    // Security: Validate path doesn't contain traversal sequences
    // This prevents malicious paths like "../../etc/passwd" from escaping the backup
    if (relativePath.includes("..") || relativePath.includes("\\")) {
      log.warn("iOSMessagesParser: Rejected potentially malicious path", {
        originalPath: originalPath.substring(0, 50),
      });
      return null;
    }

    // SMS attachments are in MediaDomain
    const hash = iOSMessagesParser.computeBackupFileHash("MediaDomain", relativePath);
    const filePath = iOSMessagesParser.getBackupFilePath(backupPath, hash);

    // Additional security: Verify resolved path is within backup directory
    const resolvedBackup = path.resolve(backupPath);
    const resolvedFile = path.resolve(filePath);
    if (!resolvedFile.startsWith(resolvedBackup)) {
      log.warn("iOSMessagesParser: Path traversal detected", {
        backupPath: resolvedBackup.substring(0, 30),
      });
      return null;
    }

    return filePath;
  }

  /**
   * Get the full path to a file in an iOS backup.
   * iOS backups store files in subdirectories based on the first 2 characters of the hash.
   * e.g., hash "3d0d7e5f..." is stored at "3d/3d0d7e5f..."
   */
  private static getBackupFilePath(backupPath: string, hash: string): string {
    return path.join(backupPath, hash.substring(0, 2), hash);
  }

  /**
   * Open the sms.db database from a backup
   * @param backupPath Path to the iOS backup directory
   */
  open(backupPath: string): void {
    const dbPath = iOSMessagesParser.getBackupFilePath(
      backupPath,
      iOSMessagesParser.SMS_DB_HASH,
    );

    try {
      this.db = new Database(dbPath, { readonly: true });
      this.backupPath = backupPath;
      log.info("iOSMessagesParser: Opened database", { backupPath });
    } catch (error) {
      log.error("iOSMessagesParser: Failed to open database", {
        backupPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
        log.info("iOSMessagesParser: Closed database");
      } catch (error) {
        log.error("iOSMessagesParser: Error closing database", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.db = null;
      this.backupPath = "";
      this.hasAudioTranscriptColumn = null; // Reset cache
    }
  }

  /**
   * Check if database is open
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Ensure database is open before operations
   */
  private ensureOpen(): void {
    if (!this.db) {
      throw new Error("Database not open. Call open() first.");
    }
  }

  /**
   * Check if the audio_transcript column exists in the message table
   * (Not all iOS versions have this column)
   */
  private checkAudioTranscriptColumn(): boolean {
    if (this.hasAudioTranscriptColumn !== null) {
      return this.hasAudioTranscriptColumn;
    }

    try {
      const info = this.db!.prepare(
        AUDIO_TRANSCRIPT_COLUMN_PROBE_SQL
      ).get() as { name: string } | undefined;
      this.hasAudioTranscriptColumn = !!info;
    } catch {
      this.hasAudioTranscriptColumn = false;
    }

    log.debug("iOSMessagesParser: audio_transcript column available", {
      available: this.hasAudioTranscriptColumn,
    });

    return this.hasAudioTranscriptColumn;
  }

    /**
   * Get a handle (contact identifier) by ID
   */
  private getHandle(handleId: number): string {
    this.ensureOpen();

    try {
      const row = this.db!.prepare(
        HANDLE_ID_BY_ROWID_SQL,
      ).get(handleId) as RawHandleRow | undefined;

      return row?.id || "";
    } catch (error) {
      log.error("iOSMessagesParser: Error getting handle", {
        handleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "";
    }
  }

  /**
   * Get all conversations from the database (sync version - may block UI)
   * @deprecated Use getConversationsAsync() for large databases
   */
  getConversations(): iOSConversation[] {
    this.ensureOpen();

    try {
      const chats = this.db!.prepare(
        ALL_CHATS_SQL,
      ).all() as RawChatRow[];

      const conversations: iOSConversation[] = [];

      for (const chat of chats) {
        try {
          // Get participants for this chat
          const participants = this.getParticipants(chat.ROWID);

          // Get last message date
          const lastMessageRow = this.db!.prepare(
            CHAT_LAST_MESSAGE_DATE_SQL,
          ).get(chat.ROWID) as { last_date: number | null } | undefined;

          const lastMessageDate = convertAppleTimestamp(
            lastMessageRow?.last_date || null,
          );

          // Skip chats with no messages
          if (!lastMessageDate) {
            continue;
          }

          // Determine if group chat (more than 1 participant or starts with 'chat')
          const isGroupChat =
            participants.length > 1 ||
            (chat.chat_identifier?.startsWith("chat") &&
              !chat.chat_identifier.includes("@"));

          conversations.push({
            chatId: chat.ROWID,
            chatIdentifier: chat.chat_identifier || chat.display_name || "",
            participants,
            messages: [], // Messages loaded separately via getMessages()
            lastMessage: lastMessageDate,
            isGroupChat,
          });
        } catch (chatError) {
          log.error("iOSMessagesParser: Error processing chat", {
            chatId: chat.ROWID,
            error:
              chatError instanceof Error
                ? chatError.message
                : String(chatError),
          });
          // Continue with next chat
        }
      }

      // Sort by last message date descending
      conversations.sort(
        (a, b) => b.lastMessage.getTime() - a.lastMessage.getTime(),
      );

      return conversations;
    } catch (error) {
      log.error("iOSMessagesParser: Error getting conversations", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get all conversations from the database (async version with yielding)
   * Yields to event loop periodically to prevent blocking the UI
   * @param onProgress Optional callback for progress updates (current, total)
   */
  async getConversationsAsync(
    onProgress?: (current: number, total: number) => void,
  ): Promise<iOSConversation[]> {
    this.ensureOpen();

    try {
      const chats = this.db!.prepare(
        ALL_CHATS_SQL,
      ).all() as RawChatRow[];

      log.info(`iOSMessagesParser: Processing ${chats.length} chats async`);

      const conversations: iOSConversation[] = [];

      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];

        try {
          // Get participants for this chat
          const participants = this.getParticipants(chat.ROWID);

          // Get last message date
          const lastMessageRow = this.db!.prepare(
            CHAT_LAST_MESSAGE_DATE_SQL,
          ).get(chat.ROWID) as { last_date: number | null } | undefined;

          const lastMessageDate = convertAppleTimestamp(
            lastMessageRow?.last_date || null,
          );

          // Skip chats with no messages
          if (!lastMessageDate) {
            continue;
          }

          // Determine if group chat (more than 1 participant or starts with 'chat')
          const isGroupChat =
            participants.length > 1 ||
            (chat.chat_identifier?.startsWith("chat") &&
              !chat.chat_identifier.includes("@"));

          conversations.push({
            chatId: chat.ROWID,
            chatIdentifier: chat.chat_identifier || chat.display_name || "",
            participants,
            messages: [], // Messages loaded separately via getMessagesAsync()
            lastMessage: lastMessageDate,
            isGroupChat,
          });
        } catch (chatError) {
          log.error("iOSMessagesParser: Error processing chat", {
            chatId: chat.ROWID,
            error:
              chatError instanceof Error
                ? chatError.message
                : String(chatError),
          });
          // Continue with next chat
        }

        // Yield to event loop periodically
        if ((i + 1) % CHAT_YIELD_INTERVAL === 0) {
          onProgress?.(i + 1, chats.length);
          await yieldToEventLoop();
        }
      }

      // Final progress callback
      onProgress?.(chats.length, chats.length);

      // Sort by last message date descending
      conversations.sort(
        (a, b) => b.lastMessage.getTime() - a.lastMessage.getTime(),
      );

      log.info(
        `iOSMessagesParser: Found ${conversations.length} conversations with messages`,
      );

      return conversations;
    } catch (error) {
      log.error("iOSMessagesParser: Error getting conversations async", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get participants for a chat
   */
  private getParticipants(chatId: number): string[] {
    this.ensureOpen();

    try {
      const rows = this.db!.prepare(
        CHAT_PARTICIPANT_HANDLES_SQL,
      ).all(chatId) as Array<{ id: string }>;

      return rows.map((row) => row.id);
    } catch (error) {
      log.error("iOSMessagesParser: Error getting participants", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get messages for a specific chat (sync version - may block UI for large chats)
   * @param chatId The chat ID to get messages for
   * @param limit Optional limit on number of messages (for pagination)
   * @param offset Optional offset for pagination
   * @deprecated Use getMessagesAsync() for large message counts
   * @note This sync version does NOT parse attributedBody (async operation)
   */
  getMessages(chatId: number, limit?: number, offset?: number): iOSMessage[] {
    this.ensureOpen();

    try {
      // Page bounds BIND as clamped integers; the clamp and the bind are
      // computed together in db/ so they cannot drift apart.
      const rows = selectChatMessages<RawMessageRow>(
        this.db!,
        this.checkAudioTranscriptColumn(),
        chatId,
        { limit, offset },
      );

      return rows.map((row) => this.mapMessage(row));
    } catch (error) {
      log.error("iOSMessagesParser: Error getting messages", {
        chatId,
        limit,
        offset,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get messages for a specific chat (async version with yielding)
   * Yields to event loop periodically to prevent blocking the UI
   * Parses attributedBody when text field is empty
   * @param chatId The chat ID to get messages for
   * @param limit Optional limit on number of messages (for pagination)
   * @param offset Optional offset for pagination
   */
  async getMessagesAsync(
    chatId: number,
    limit?: number,
    offset?: number,
  ): Promise<iOSMessage[]> {
    this.ensureOpen();

    try {
      // Page bounds BIND as clamped integers; the clamp and the bind are
      // computed together in db/ so they cannot drift apart.
      const rows = selectChatMessages<RawMessageRow>(
        this.db!,
        this.checkAudioTranscriptColumn(),
        chatId,
        { limit, offset },
      );

      const messages: iOSMessage[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        // Pre-parse attributedBody if text is empty
        let parsedText: string | null = null;
        if ((!row.text || row.text.trim() === "") && row.attributedBody) {
          try {
            const extracted = await extractTextFromAttributedBody(row.attributedBody);
            // Only use if it's meaningful (not a fallback message starting with '[')
            if (extracted && !extracted.startsWith("[")) {
              parsedText = extracted;
            }
          } catch (e) {
            log.debug("iOSMessagesParser: Failed to parse attributedBody", {
              messageId: row.ROWID,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        messages.push(this.mapMessage(row, parsedText));

        // Yield to event loop periodically
        if ((i + 1) % MESSAGE_YIELD_INTERVAL === 0) {
          await yieldToEventLoop();
        }
      }

      return messages;
    } catch (error) {
      log.error("iOSMessagesParser: Error getting messages async", {
        chatId,
        limit,
        offset,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Map a raw message row to iOSMessage
   * @param row The raw database row
   * @param parsedAttributedText Optional pre-parsed text from attributedBody (async callers only)
   */
  private mapMessage(row: RawMessageRow, parsedAttributedText?: string | null): iOSMessage {
    // Use parsedAttributedText if text is empty/null
    let finalText = row.text;
    if ((!finalText || finalText.trim() === "") && parsedAttributedText) {
      finalText = parsedAttributedText;
    }

    return {
      id: row.ROWID,
      guid: row.guid || "",
      text: finalText,
      audioTranscript: row.audio_transcript || null,
      handle: row.handle_id ? this.getHandle(row.handle_id) : "",
      isFromMe: row.is_from_me === 1,
      date: convertAppleTimestamp(row.date) || new Date(0),
      dateRead: convertAppleTimestamp(row.date_read),
      dateDelivered: convertAppleTimestamp(row.date_delivered),
      service: row.service === "iMessage" ? "iMessage" : "SMS",
      attachments: this.getAttachments(row.ROWID),
    };
  }

  /**
   * Get attachments for a specific message
   * @param messageId The message ID to get attachments for
   */
  getAttachments(messageId: number): iOSAttachment[] {
    this.ensureOpen();

    try {
      const rows = this.db!.prepare(
        MESSAGE_ATTACHMENTS_SQL,
      ).all(messageId) as RawAttachmentRow[];

      return rows.map((row) => ({
        id: row.ROWID,
        guid: row.guid || "",
        filename: row.filename || "",
        mimeType: row.mime_type || "",
        transferName: row.transfer_name || "",
      }));
    } catch (error) {
      log.error("iOSMessagesParser: Error getting attachments", {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Search messages across all conversations
   * @param query The search query string
   * @param limit Optional limit on results
   * @note This sync version does NOT parse attributedBody (async operation)
   */
  searchMessages(query: string, limit?: number): iOSMessage[] {
    this.ensureOpen();

    if (!query || query.trim().length === 0) {
      return [];
    }

    try {
      const searchPattern = `%${query}%`;
      const rows = searchMessagesByText<RawMessageRow>(
        this.db!,
        this.checkAudioTranscriptColumn(),
        searchPattern,
        limit,
      );

      return rows.map((row) => this.mapMessage(row));
    } catch (error) {
      log.error("iOSMessagesParser: Error searching messages", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get total message count for a chat
   */
  getMessageCount(chatId: number): number {
    this.ensureOpen();

    try {
      const row = this.db!.prepare(
        CHAT_MESSAGE_COUNT_SQL,
      ).get(chatId) as { count: number } | undefined;

      return row?.count || 0;
    } catch (error) {
      log.error("iOSMessagesParser: Error getting message count", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Get conversation with messages populated
   */
  getConversationWithMessages(
    chatId: number,
    limit?: number,
    offset?: number,
  ): iOSConversation | null {
    this.ensureOpen();

    try {
      const chat = this.db!.prepare(
        CHAT_BY_ROWID_SQL,
      ).get(chatId) as RawChatRow | undefined;

      if (!chat) {
        return null;
      }

      const participants = this.getParticipants(chatId);
      const messages = this.getMessages(chatId, limit, offset);

      const lastMessageDate =
        messages.length > 0 ? messages[messages.length - 1].date : new Date(0);

      const isGroupChat =
        participants.length > 1 ||
        (chat.chat_identifier?.startsWith("chat") &&
          !chat.chat_identifier.includes("@"));

      return {
        chatId: chat.ROWID,
        chatIdentifier: chat.chat_identifier || chat.display_name || "",
        participants,
        messages,
        lastMessage: lastMessageDate,
        isGroupChat,
      };
    } catch (error) {
      log.error("iOSMessagesParser: Error getting conversation with messages", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export default iOSMessagesParser;
