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
import { performance } from "perf_hooks";
import log from "electron-log";
import { extractTextFromAttributedBody } from "../utils/messageParser";

/**
 * Yield to event loop - allows UI to remain responsive during long operations
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * BACKLOG-3785: longest stretch of parsing work (ms) between two event-loop yields.
 *
 * The yield used to be counted: every 50 chats and every 500 messages INSIDE one
 * chat. The sync loads chats one after another, and a chat with fewer than 500
 * messages never yielded, so a run of small chats was one continuous block of the
 * main thread (generated 668k-message sms.db: 2,866 small chats in a row = 4.3 s
 * on an arm64 Mac; the PC logged 15.7 s). The budget is now time-based and spans
 * chats: whichever call is running yields once this much time has passed since
 * the last yield.
 */
export const PARSE_YIELD_BUDGET_MS = 25;
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
  CHAT_SENDER_HANDLES_SQL,
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
  /** BACKLOG-3785: when this parser last let the event loop run (performance.now()). */
  private lastYieldAt = performance.now();
  /**
   * BACKLOG-3892 S1 (SR D5): reads that failed since open(). Every read below
   * returns [] on failure, which looks like an empty chat; this count is how a
   * run tells "nothing there" from "could not read it".
   */
  private failedReads = 0;

  /** BACKLOG-3892 S1 (D5): reads that failed since the database was opened. */
  get readFailures(): number {
    return this.failedReads;
  }

  /**
   * BACKLOG-3785: true once PARSE_YIELD_BUDGET_MS have passed since the last yield
   * (then the caller awaits yieldNow()). Shared by every async read of this parser, so the budget holds
   * across chats, not just inside one.
   */
  private yieldDue(): boolean {
    return performance.now() - this.lastYieldAt >= PARSE_YIELD_BUDGET_MS;
  }

  private async yieldNow(): Promise<void> {
    await yieldToEventLoop();
    this.lastYieldAt = performance.now();
  }

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

  /** Path prefixes iOS writes for Messages attachments, mapped onto MediaDomain. */
  private static readonly ATTACHMENT_PATH_PREFIXES: readonly string[] = [
    "~/",
    "/var/mobile/",
  ];

  /**
   * The MediaDomain subtrees an attachment path may point into: message
   * attachments and sticker images. Both are backed up in MediaDomain with the
   * same relative path sms.db records.
   */
  private static readonly ATTACHMENT_ROOTS: readonly string[] = [
    "Library/SMS/Attachments/",
    "Library/SMS/StickerCache/",
  ];

  /**
   * Rules that mean the path tried to leave the attachment roots. Each one is
   * logged individually (sanitized, up to ATTACK_LOG_LIMIT per summary window);
   * every other rule is only counted in the summary.
   */
  private static readonly ATTACK_RULES: ReadonlySet<string> = new Set([
    "backslash",
    "nul",
    "dot-segment",
    "absolute",
  ]);

  /** Individually logged attack-class rejections per summary window. */
  static readonly ATTACK_LOG_LIMIT = 5;

  /** Rejected attachment paths since the last summary, counted by rule. */
  private static rejectedPathCounts = new Map<string, number>();
  private static attackLinesLogged = 0;
  private static attackLinesSuppressed = 0;

  /**
   * Describe a rejected path without exposing names: up to the first two
   * segments (never the last one), the segment count, and the index of the
   * segment that failed.
   */
  private static sanitizePath(
    originalPath: string,
    failedSegment: number,
  ): { head: string; segments: number; failedSegment: number } {
    const parts = originalPath.split("/");
    const shown = parts
      .slice(0, Math.min(2, parts.length - 1))
      // eslint-disable-next-line no-control-regex
      .map((part) => part.replace(/[\x00-\x1f\\]/g, "?").slice(0, 32));
    return { head: shown.join("/"), segments: parts.length, failedSegment };
  }

  /**
   * Log one summary line of attachment paths rejected since the last call,
   * counted by rule (plus how many attack-class lines were logged and
   * suppressed), then reset. No-op when nothing was rejected.
   * @returns the counts that were logged
   */
  static flushRejectedPathSummary(): Record<string, number> {
    const counts: Record<string, number> = Object.fromEntries(
      iOSMessagesParser.rejectedPathCounts,
    );
    const hadRejections = Object.keys(counts).length > 0;
    if (iOSMessagesParser.attackLinesSuppressed > 0) {
      counts.attackLinesSuppressed = iOSMessagesParser.attackLinesSuppressed;
    }
    iOSMessagesParser.rejectedPathCounts = new Map();
    iOSMessagesParser.attackLinesLogged = 0;
    iOSMessagesParser.attackLinesSuppressed = 0;
    if (hadRejections) {
      log.warn("iOSMessagesParser: Rejected attachment paths", counts);
    }
    return counts;
  }

  /** Index of the first `/`-separated segment matching the predicate, or -1. */
  private static findSegment(p: string, test: (segment: string) => boolean): number {
    return p.split("/").findIndex(test);
  }

  /**
   * Convert an attachment path from sms.db into its MediaDomain relative path.
   * Accepts only `~/` or `/var/mobile/` followed by `Library/SMS/Attachments/...`
   * or `Library/SMS/StickerCache/...`. Dots inside a name (`Offer...pdf`) are
   * allowed; `.`/`..` segments, backslashes, NUL and absolute paths elsewhere
   * are attack-class rejections and are logged individually (sanitized,
   * throttled). Other rejections (unknown prefix or root, empty segment) are
   * only counted; flushRejectedPathSummary() logs the per-sync totals.
   * @returns the relative path (e.g. `Library/SMS/Attachments/ab/01/x.jpg`), or null
   */
  static toMediaDomainRelativePath(originalPath: string): string | null {
    const reject = (rule: string, failedSegment = -1): null => {
      const counts = iOSMessagesParser.rejectedPathCounts;
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
      if (iOSMessagesParser.ATTACK_RULES.has(rule)) {
        if (iOSMessagesParser.attackLinesLogged < iOSMessagesParser.ATTACK_LOG_LIMIT) {
          iOSMessagesParser.attackLinesLogged++;
          log.warn("iOSMessagesParser: Rejected attachment path", {
            rule,
            ...iOSMessagesParser.sanitizePath(originalPath, failedSegment),
          });
        } else {
          iOSMessagesParser.attackLinesSuppressed++;
        }
      }
      return null;
    };

    const backslashAt = iOSMessagesParser.findSegment(originalPath, (seg) => seg.includes("\\"));
    if (backslashAt !== -1) return reject("backslash", backslashAt);
    const nulAt = iOSMessagesParser.findSegment(originalPath, (seg) => seg.includes("\0"));
    if (nulAt !== -1) return reject("nul", nulAt);
    const dotAt = iOSMessagesParser.findSegment(originalPath, (seg) => seg === "." || seg === "..");
    if (dotAt !== -1) return reject("dot-segment", dotAt);

    const prefix = iOSMessagesParser.ATTACHMENT_PATH_PREFIXES.find((p) =>
      originalPath.startsWith(p),
    );
    if (prefix === undefined) {
      return originalPath.startsWith("/") ? reject("absolute", 0) : reject("prefix");
    }
    const relativePath = originalPath.slice(prefix.length);

    if (!iOSMessagesParser.ATTACHMENT_ROOTS.some((root) => relativePath.startsWith(root))) {
      return reject("root");
    }
    if (relativePath.split("/").includes("")) return reject("empty-segment");

    return relativePath;
  }

  /**
   * Resolve an attachment's original path to its location in the iOS backup.
   * @param backupPath Path to the iOS backup directory
   * @param originalPath The original iOS path (e.g., ~/Library/SMS/Attachments/...)
   * @returns Full path to the file in the backup, or null if not found/invalid
   */
  static resolveAttachmentPath(backupPath: string, originalPath: string): string | null {
    if (!originalPath) return null;

    const relativePath = iOSMessagesParser.toMediaDomainRelativePath(originalPath);
    if (relativePath === null) {
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
      this.failedReads = 0;
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

      const lastDateStmt = this.db!.prepare(CHAT_LAST_MESSAGE_DATE_SQL);
      lastDateStmt.safeIntegers(true);

      const conversations: iOSConversation[] = [];

      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];

        try {
          // Get participants for this chat (null = the read failed, D5)
          const read = this.readParticipants(chat.ROWID);
          const participants = read ?? [];

          // Get last message date, read as a BigInt (BACKLOG-3892 S1): the parse
          // floor compares it exactly, in the unit it is stored in.
          const lastMessageRow = lastDateStmt.get(chat.ROWID) as
            | { last_date: bigint | number | null }
            | undefined;
          const lastDate = lastMessageRow?.last_date ?? null;
          const lastDateRaw = lastDate === null ? null : String(lastDate);

          const lastMessageDate = convertAppleTimestamp(
            lastDate === null ? null : Number(lastDate) || null,
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
            lastDateRaw,
            ...(read === null ? { participantsReadFailed: true } : {}),
          });
        } catch (chatError) {
          this.failedReads++;
          log.error("iOSMessagesParser: Error processing chat", {
            chatId: chat.ROWID,
            error:
              chatError instanceof Error
                ? chatError.message
                : String(chatError),
          });
          // Continue with next chat
        }

        // Progress every 50 chats; yield whenever the time budget is spent (BACKLOG-3785).
        if ((i + 1) % 50 === 0) onProgress?.(i + 1, chats.length);
        if (this.yieldDue()) await this.yieldNow();
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
      this.failedReads++;
      log.error("iOSMessagesParser: Error getting conversations async", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * BACKLOG-3892 S1: participants of a chat, or null when the read failed
   * (counted in readFailures).
   */
  private readParticipants(chatId: number): string[] | null {
    this.ensureOpen();
    try {
      const rows = this.db!.prepare(CHAT_PARTICIPANT_HANDLES_SQL).all(chatId) as Array<{ id: string }>;
      return rows.map((row) => row.id);
    } catch (error) {
      this.failedReads++;
      log.error("iOSMessagesParser: Error getting participants", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * BACKLOG-3892 S1 (SR D7d): every handle that sent a message in a chat — this
   * includes members who have since left a group. null when the read failed
   * (counted in readFailures).
   */
  getChatSenderHandles(chatId: number): string[] | null {
    this.ensureOpen();
    try {
      const rows = this.db!.prepare(CHAT_SENDER_HANDLES_SQL).all(chatId) as Array<{ id: string }>;
      return rows.map((row) => row.id);
    } catch (error) {
      this.failedReads++;
      log.error("iOSMessagesParser: Error getting chat senders", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
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
   * Messages in one chat, oldest first.
   *
   * BACKLOG-2960: `async` because `db/appleSmsDbSql.selectChatMessages` returns a
   * promise at the export.
   *
   * @param chatId The chat ID to get messages for
   * @param limit Optional limit on number of messages (for pagination)
   * @param offset Optional offset for pagination
   * @deprecated Prefer `getMessagesAsync`.
   */
  async getMessages(
    chatId: number,
    limit?: number,
    offset?: number,
  ): Promise<iOSMessage[]> {
    this.ensureOpen();

    try {
      // Page bounds BIND as clamped integers; the clamp and the bind are
      // computed together in db/ so they cannot drift apart.
      const rows = await selectChatMessages<RawMessageRow>(
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
   * Messages in one chat, oldest first, pre-parsing `attributedBody` where the
   * text column is empty and yielding to the event loop between batches.
   *
   * Already `async` before BACKLOG-2960 — this method is edited, not flipped:
   * the seam call below gained an `await`.
   *
   * @param chatId The chat ID to get messages for
   * @param limit Optional limit on number of messages (for pagination)
   * @param offset Optional offset for pagination
   * @param sinceMs BACKLOG-3892 S1: only messages dated at or after this (epoch ms,
   *   inclusive; undated rows kept). Absent = every message.
   *
   * A failed read still returns [] (callers rely on it) but is counted in
   * readFailures (D5).
   */
  async getMessagesAsync(
    chatId: number,
    limit?: number,
    offset?: number,
    sinceMs?: number,
  ): Promise<iOSMessage[]> {
    this.ensureOpen();

    try {
      // BACKLOG-3785: callers load chat after chat; the budget carries over from the
      // previous chat, so a run of small chats yields too.
      if (this.yieldDue()) await this.yieldNow();

      // Page bounds BIND as clamped integers; the clamp and the bind are
      // computed together in db/ so they cannot drift apart.
      const rows = await selectChatMessages<RawMessageRow>(
        this.db!,
        this.checkAudioTranscriptColumn(),
        chatId,
        sinceMs === undefined ? { limit, offset } : { limit, offset, sinceMs },
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

        // Yield whenever the time budget is spent (BACKLOG-3785).
        if (this.yieldDue()) await this.yieldNow();
      }

      return messages;
    } catch (error) {
      this.failedReads++;
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
   * Messages whose text matches a query, newest first, across every conversation.
   *
   * BACKLOG-2960: `async` because `db/appleSmsDbSql.searchMessagesByText` returns
   * a promise at the export.
   *
   * @param query The search query string
   * @param limit Optional limit on results
   */
  async searchMessages(query: string, limit?: number): Promise<iOSMessage[]> {
    this.ensureOpen();

    if (!query || query.trim().length === 0) {
      return [];
    }

    try {
      const searchPattern = `%${query}%`;
      const rows = await searchMessagesByText<RawMessageRow>(
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
   * One conversation with its messages populated.
   *
   * BACKLOG-2960: `async` because it reads through `getMessages`, which the
   * conversion made promise-returning.
   */
  async getConversationWithMessages(
    chatId: number,
    limit?: number,
    offset?: number,
  ): Promise<iOSConversation | null> {
    this.ensureOpen();

    try {
      const chat = this.db!.prepare(
        CHAT_BY_ROWID_SQL,
      ).get(chatId) as RawChatRow | undefined;

      if (!chat) {
        return null;
      }

      const participants = this.getParticipants(chatId);
      const messages = await this.getMessages(chatId, limit, offset);

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
