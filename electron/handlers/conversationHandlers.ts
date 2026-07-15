// ============================================
// CONVERSATION & MESSAGE IPC HANDLERS
// Extracted from main.ts for modularity
// Handles: get-conversations, get-messages, open-folder, export-conversations
// ============================================

import { ipcMain, shell, BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import path from "path";
import sqlite3 from "sqlite3";
import { promisify } from "util";

// Import services and utilities
import {
  getContactNames,
  resolveContactName,
} from "../services/contactsService";
import logService from "../services/logService";
import { getConversationsFromMessages } from "../services/db/messageDbService";
import { wrapHandler } from "../utils/wrapHandler";
import { getYearsAgoTimestamp } from "../utils/dateUtils";
import { MAC_EPOCH } from "../constants";

// Import handler types
import type {
  ConversationRow,
  MessageRow,
  ParticipantRow,
  ContactInfoData,
  ProcessedConversation,
} from "../types/handlerTypes";

// Track registration to prevent duplicate handlers
let handlersRegistered = false;

/**
 * Register conversation and message export IPC handlers
 */
export function registerConversationHandlers(_mainWindow: BrowserWindow): void {
  // Prevent double registration
  if (handlersRegistered) {
    logService.warn(
      "Handlers already registered, skipping duplicate registration",
      "ConversationHandlers"
    );
    return;
  }
  handlersRegistered = true;

  // Get conversations — unified to read from local messages table (mad.db)
  // for ALL sources (macOS, iPhone, Android).
  // BACKLOG-1481: All sources now import into the messages table, so we
  // read from a single code path. chat.db is kept as a fallback for
  // macOS users who haven't imported yet.
  ipcMain.handle("get-conversations", wrapHandler(async (_event: IpcMainInvokeEvent, userId?: string) => {
    if (!userId) {
      return { success: true, conversations: [] };
    }

    // Primary path: read from local messages table (works for all sources)
    const conversations = getConversationsFromMessages(userId);

    if (conversations.length > 0) {
      logService.info(
        `Loading conversations from messages table (${conversations.length} conversations)`,
        "ConversationHandlers"
      );
      return {
        success: true,
        conversations,
      };
    }

    // Fallback: if messages table is empty and we're on macOS, try chat.db
    // This handles the case where a macOS user hasn't imported messages yet.
    if (process.platform !== "darwin") {
      return { success: true, conversations: [] };
    }

    logService.info(
      "No messages in local DB, falling back to macOS chat.db",
      "ConversationHandlers"
    );

    const messagesDbPath = path.join(
      process.env.HOME!,
      "Library/Messages/chat.db"
    );

    const db = new sqlite3.Database(messagesDbPath, sqlite3.OPEN_READONLY);
    const dbAll = promisify(db.all.bind(db)) as <T>(
      sql: string,
      params?: unknown
    ) => Promise<T[]>;
    const dbClose = promisify(db.close.bind(db));

    let db2: sqlite3.Database | null = null;
    let dbClose2: (() => Promise<void>) | null = null;

    try {
        // Get contact names from Contacts database
        const { contactMap, phoneToContactInfo } = await getContactNames();

        // Get all chats with their latest message
        // Filter to only show chats with at least 1 message
        const chatDbConversations = await dbAll<ConversationRow>(`
          SELECT
            chat.ROWID as chat_id,
            chat.chat_identifier,
            chat.display_name,
            handle.id as contact_id,
            MAX(message.date) as last_message_date,
            COUNT(message.ROWID) as message_count
          FROM chat
          LEFT JOIN chat_handle_join ON chat.ROWID = chat_handle_join.chat_id
          LEFT JOIN handle ON chat_handle_join.handle_id = handle.ROWID
          LEFT JOIN chat_message_join ON chat.ROWID = chat_message_join.chat_id
          LEFT JOIN message ON chat_message_join.message_id = message.ROWID
          GROUP BY chat.ROWID
          HAVING message_count > 0 AND last_message_date IS NOT NULL
          ORDER BY last_message_date DESC
        `);

        // Close first database connection - we're done with it
        await dbClose();

        // Re-open database to query group chat participants
        db2 = new sqlite3.Database(messagesDbPath, sqlite3.OPEN_READONLY);
        const dbAll2 = promisify(db2.all.bind(db2)) as <T>(
          sql: string,
          params?: unknown
        ) => Promise<T[]>;
        dbClose2 = promisify(db2.close.bind(db2));

        // Map conversations and deduplicate by contact NAME
        // This ensures that if a contact has multiple phone numbers or emails,
        // they appear as ONE contact with all their info
        const conversationMap = new Map<string, ProcessedConversation>();

        // Process conversations - track direct chats and group chats separately
        for (const conv of chatDbConversations) {
          const rawContactId = conv.contact_id || conv.chat_identifier;
          const displayName = resolveContactName(
            conv.contact_id || "",
            conv.chat_identifier,
            conv.display_name ?? undefined,
            contactMap
          );

          // Detect group chats - they have chat_identifier like "chat123456789"
          // Individual chats have phone numbers or emails as identifiers
          const isGroupChat =
            conv.chat_identifier &&
            conv.chat_identifier.startsWith("chat") &&
            !conv.chat_identifier.includes("@");

          if (isGroupChat) {
            // For group chats, we need to attribute the chat to all participants

            try {
              // Get all participants in this group chat
              const participants = await dbAll2<ParticipantRow>(
                `
                SELECT DISTINCT handle.id as contact_id
                FROM chat_handle_join
                JOIN handle ON chat_handle_join.handle_id = handle.ROWID
                WHERE chat_handle_join.chat_id = ?
              `,
                [conv.chat_id]
              );

              // Add this group chat to each participant's statistics
              for (const participant of participants) {
                const participantName = resolveContactName(
                  participant.contact_id,
                  participant.contact_id,
                  undefined,
                  contactMap
                );
                const normalizedKey = participantName.toLowerCase().trim();

                // Get or create contact entry
                if (!conversationMap.has(normalizedKey)) {
                  // Create new contact entry for this participant
                  let contactInfo: ContactInfoData | null = null;
                  let phones: string[] = [];
                  let emails: string[] = [];

                  if (
                    participant.contact_id &&
                    participant.contact_id.includes("@")
                  ) {
                    const emailLower = participant.contact_id.toLowerCase();
                    for (const info of Object.values(phoneToContactInfo)) {
                      const contactInfoTyped = info as ContactInfoData;
                      if (
                        contactInfoTyped.emails &&
                        contactInfoTyped.emails.some(
                          (e: string) => e.toLowerCase() === emailLower
                        )
                      ) {
                        contactInfo = contactInfoTyped;
                        break;
                      }
                    }
                    if (contactInfo) {
                      phones = contactInfo.phones || [];
                      emails = contactInfo.emails || [];
                    } else {
                      emails = [participant.contact_id];
                    }
                  } else if (participant.contact_id) {
                    const normalized = participant.contact_id.replace(/\D/g, "");
                    contactInfo =
                      phoneToContactInfo[normalized] ||
                      phoneToContactInfo[participant.contact_id];
                    if (contactInfo) {
                      phones = contactInfo.phones || [];
                      emails = contactInfo.emails || [];
                    } else {
                      phones = [participant.contact_id];
                    }
                  }

                  conversationMap.set(normalizedKey, {
                    id: `group-contact-${normalizedKey}`, // Generate unique ID for group-only contacts
                    name: participantName,
                    contactId: participant.contact_id,
                    phones: phones,
                    emails: emails,
                    showBothNameAndNumber:
                      participantName !== participant.contact_id,
                    messageCount: 0,
                    lastMessageDate: 0,
                    directChatCount: 0,
                    directMessageCount: 0,
                    groupChatCount: 0,
                    groupMessageCount: 0,
                  });
                }

                // Add group chat stats to this participant
                const existing = conversationMap.get(normalizedKey);
                if (existing) {
                  existing.groupChatCount += 1;
                  existing.groupMessageCount += conv.message_count;
                  existing.messageCount += conv.message_count;

                  // Update last message date if this group chat is more recent
                  if (conv.last_message_date > existing.lastMessageDate) {
                    existing.lastMessageDate = conv.last_message_date;
                  }
                }
              }
            } catch (err) {
              logService.error(
                `Error processing group chat ${conv.chat_identifier}`,
                "ConversationHandlers",
                { error: err }
              );
            }

            continue; // Skip to next conversation (don't add group chat as its own contact)
          }

          // Get full contact info (all phones and emails)
          let contactInfo: ContactInfoData | null = null;
          let phones: string[] = [];
          let emails: string[] = [];

          if (rawContactId && rawContactId.includes("@")) {
            // contactId is an email - look up contact info by email
            const emailLower = rawContactId.toLowerCase();
            // Try to find this email in phoneToContactInfo
            for (const info of Object.values(phoneToContactInfo)) {
              const contactInfoTyped = info as ContactInfoData;
              if (
                contactInfoTyped.emails &&
                contactInfoTyped.emails.some(
                  (e: string) => e.toLowerCase() === emailLower
                )
              ) {
                contactInfo = contactInfoTyped;
                break;
              }
            }

            if (contactInfo) {
              phones = contactInfo.phones || [];
              emails = contactInfo.emails || [];
            } else {
              emails = [rawContactId];
            }
          } else if (rawContactId) {
            // contactId is a phone - look up full contact info
            const normalized = rawContactId.replace(/\D/g, "");
            contactInfo =
              phoneToContactInfo[normalized] || phoneToContactInfo[rawContactId];

            // If not found and number has country code 1 (11 digits starting with 1), try without it
            if (
              !contactInfo &&
              normalized.startsWith("1") &&
              normalized.length === 11
            ) {
              const withoutCountryCode = normalized.substring(1);
              contactInfo = phoneToContactInfo[withoutCountryCode];
            }

            if (contactInfo) {
              phones = contactInfo.phones || [];
              emails = contactInfo.emails || [];
            } else {
              // No contact info found, just use the raw phone number
              phones = [rawContactId];
            }
          }

          // Use contact name as the deduplication key
          // This ensures all chats with the same person are merged
          const normalizedKey = displayName.toLowerCase().trim();

          const conversationData = {
            id: conv.chat_id,
            chatId: conv.chat_id, // CRITICAL: Set chatId field for exports
            name: displayName,
            contactId: rawContactId,
            phones: phones,
            emails: emails,
            showBothNameAndNumber: displayName !== rawContactId,
            messageCount: conv.message_count,
            lastMessageDate: conv.last_message_date,
            directChatCount: 1, // This is a direct chat
            directMessageCount: conv.message_count,
            groupChatCount: 0,
            groupMessageCount: 0,
          };

          // If we already have this contact, merge the data
          if (conversationMap.has(normalizedKey)) {
            const existing = conversationMap.get(normalizedKey)!;

            // Merge phones (unique)
            const allPhones = [...new Set([...existing.phones, ...phones])];
            // Merge emails (unique)
            const allEmails = [...new Set([...existing.emails, ...emails])];

            // CRITICAL FIX: Always prefer a real chat ID over a generated group-contact-* ID
            // This ensures we can export 1:1 messages even if group chat is more recent
            const wasGeneratedId =
              typeof existing.id === "string" &&
              existing.id.startsWith("group-contact-");
            if (!existing.id || wasGeneratedId) {
              // Current ID is fake, use the real chat ID from this 1:1 conversation
              existing.id = conv.chat_id;
              existing.chatId = conv.chat_id; // Also set chatId field
            }

            // Update last message date if this chat is more recent
            if (conv.last_message_date > existing.lastMessageDate) {
              existing.lastMessageDate = conv.last_message_date;
            }

            // Add up message counts and direct chat counts
            existing.messageCount += conv.message_count;
            existing.directChatCount += 1;
            existing.directMessageCount += conv.message_count;
            existing.phones = allPhones;
            existing.emails = allEmails;
          } else {
            conversationMap.set(normalizedKey, conversationData);
          }
        }

        // Close the second database connection
        await dbClose2();

        // Convert map back to array
        const deduplicatedConversations = Array.from(
          conversationMap.values()
        ).sort((a, b) => b.lastMessageDate - a.lastMessageDate);

        // Filter out contacts with no messages in the last 5 years
        const fiveYearsAgo = getYearsAgoTimestamp(5);
        const macEpoch = MAC_EPOCH;
        const fiveYearsAgoMacTime = (fiveYearsAgo - macEpoch) * 1000000; // Convert to Mac timestamp (nanoseconds)

        const recentConversations = deduplicatedConversations.filter((conv) => {
          return conv.lastMessageDate > fiveYearsAgoMacTime;
        });

        return {
          success: true,
          conversations: recentConversations,
        };
      } catch (error) {
        // Clean up db2 if it was opened
        if (dbClose2) {
          try {
            await dbClose2();
          } catch (closeError) {
            logService.error("Error closing db2", "ConversationHandlers", { error: closeError });
          }
        }
        throw error;
      }
  }, { module: "ConversationHandlers" }));

  // Get messages for a specific conversation
  ipcMain.handle(
    "get-messages",
    wrapHandler(async (event: IpcMainInvokeEvent, chatId: number) => {
      const messagesDbPath = path.join(
        process.env.HOME!,
        "Library/Messages/chat.db"
      );

      const db = new sqlite3.Database(messagesDbPath, sqlite3.OPEN_READONLY);
      const dbAll = promisify(db.all.bind(db)) as <T>(
        sql: string,
        params?: unknown
      ) => Promise<T[]>;
      const dbClose = promisify(db.close.bind(db));

      try {
        const messages = await dbAll<MessageRow>(
          `
        SELECT
          message.ROWID as id,
          message.text,
          message.date,
          message.is_from_me,
          handle.id as sender
        FROM message
        JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
        LEFT JOIN handle ON message.handle_id = handle.ROWID
        WHERE chat_message_join.chat_id = ?
        ORDER BY message.date ASC
      `,
          [chatId]
        );

        await dbClose();

        return {
          success: true,
          messages: messages.map((msg) => ({
            id: msg.id,
            text: msg.text || "",
            date: msg.date,
            isFromMe: msg.is_from_me === 1,
            sender: msg.sender,
          })),
        };
      } catch (error) {
        await dbClose();
        throw error;
      }
    }, { module: "ConversationHandlers" }),
  );

  // Open folder in Finder
  ipcMain.handle(
    "open-folder",
    wrapHandler(async (event: IpcMainInvokeEvent, folderPath: string) => {
      await shell.openPath(folderPath);
      return { success: true };
    }, { module: "ConversationHandlers" }),
  );
}
