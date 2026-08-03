/**
 * @jest-environment node
 */

/**
 * Unit tests for iOSMessagesParser
 * Tests iOS backup sms.db parsing functionality
 *
 * IMPORTANT: This test requires the REAL better-sqlite3-multiple-ciphers module,
 * not the mock in tests/__mocks__/. The global mock returns empty arrays from all
 * queries, which would cause all conversation/message tests to fail.
 *
 * We override the moduleNameMapper by using jest.mock with the actual module path.
 */


// Force Jest to use the real better-sqlite3-multiple-ciphers module
// This must be done before any imports that depend on it.
// We load it directly from node_modules to bypass moduleNameMapper.
const actualModulePath = require.resolve("better-sqlite3-multiple-ciphers", {
  paths: [require("path").join(__dirname, "../../../node_modules")],
});

jest.mock("better-sqlite3-multiple-ciphers", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(actualModulePath);
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(actualModulePath);
import path from "path";
import fs from "fs";
import os from "os";
import { iOSMessagesParser, convertAppleTimestamp } from "../iosMessagesParser";

describe("iOSMessagesParser", () => {
  let parser: iOSMessagesParser;
  let testDir: string;
  let testDbPath: string;

  // Helper to create a test sms.db
  const createTestDatabase = (): void => {
    const db = new Database(testDbPath);

    // Create tables matching iOS sms.db schema
    db.exec(`
      CREATE TABLE handle (
        ROWID INTEGER PRIMARY KEY,
        id TEXT,
        service TEXT
      );

      CREATE TABLE chat (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        chat_identifier TEXT,
        display_name TEXT
      );

      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        text TEXT,
        attributedBody BLOB,
        audio_transcript TEXT,
        handle_id INTEGER,
        is_from_me INTEGER,
        date INTEGER,
        date_read INTEGER,
        date_delivered INTEGER,
        service TEXT
      );

      CREATE TABLE attachment (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        filename TEXT,
        mime_type TEXT,
        transfer_name TEXT
      );

      CREATE TABLE chat_handle_join (
        chat_id INTEGER,
        handle_id INTEGER
      );

      CREATE TABLE chat_message_join (
        chat_id INTEGER,
        message_id INTEGER
      );

      CREATE TABLE message_attachment_join (
        message_id INTEGER,
        attachment_id INTEGER
      );
    `);

    // Insert test handles (contacts)
    db.exec(`
      INSERT INTO handle (ROWID, id, service) VALUES
        (1, '+14155551234', 'iMessage'),
        (2, '+14155555678', 'SMS'),
        (3, 'user@example.com', 'iMessage'),
        (4, '+14155559999', 'iMessage');
    `);

    // Insert test chats
    // Individual chat, group chat
    db.exec(`
      INSERT INTO chat (ROWID, guid, chat_identifier, display_name) VALUES
        (1, 'chat-guid-1', '+14155551234', NULL),
        (2, 'chat-guid-2', 'chat123456789', 'Family Group'),
        (3, 'chat-guid-3', 'user@example.com', NULL);
    `);

    // Link handles to chats
    db.exec(`
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES
        (1, 1),
        (2, 1),
        (2, 2),
        (2, 4),
        (3, 3);
    `);

    // Apple epoch test timestamp: 2023-06-15 12:00:00 UTC
    // Nanoseconds since 2001-01-01 = (seconds since 2001-01-01) * 1,000,000,000
    // 2023-06-15 12:00:00 UTC - 2001-01-01 00:00:00 UTC = 708696000 seconds
    const baseTimestamp = 708696000000000000; // nanoseconds

    // Insert test messages
    // Message 7: voice message with audio_transcript
    // Message 8: message with null text but attributedBody (will be tested async)
    db.exec(`
      INSERT INTO message (ROWID, guid, text, attributedBody, audio_transcript, handle_id, is_from_me, date, date_read, date_delivered, service) VALUES
        (1, 'msg-guid-1', 'Hello there!', NULL, NULL, 1, 0, ${baseTimestamp}, ${baseTimestamp + 1000000000}, NULL, 'iMessage'),
        (2, 'msg-guid-2', 'Hi! How are you?', NULL, NULL, NULL, 1, ${baseTimestamp + 60000000000}, NULL, ${baseTimestamp + 60000000000}, 'iMessage'),
        (3, 'msg-guid-3', 'Group message 1', NULL, NULL, 2, 0, ${baseTimestamp + 120000000000}, NULL, NULL, 'SMS'),
        (4, 'msg-guid-4', 'Group message 2', NULL, NULL, 1, 0, ${baseTimestamp + 180000000000}, NULL, NULL, 'iMessage'),
        (5, 'msg-guid-5', 'Email chat message', NULL, NULL, 3, 0, ${baseTimestamp + 240000000000}, NULL, NULL, 'iMessage'),
        (6, 'msg-guid-6', NULL, NULL, NULL, 1, 0, ${baseTimestamp + 300000000000}, NULL, NULL, 'iMessage'),
        (7, 'msg-guid-7', NULL, NULL, 'This is a voice message transcript', 1, 0, ${baseTimestamp + 360000000000}, NULL, NULL, 'iMessage'),
        (8, 'msg-guid-8', 'Regular message', NULL, 'Transcript should be ignored when text exists', 1, 0, ${baseTimestamp + 420000000000}, NULL, NULL, 'iMessage');
    `);

    // Link messages to chats
    db.exec(`
      INSERT INTO chat_message_join (chat_id, message_id) VALUES
        (1, 1),
        (1, 2),
        (2, 3),
        (2, 4),
        (3, 5),
        (1, 6),
        (1, 7),
        (1, 8);
    `);

    // Insert test attachments
    db.exec(`
      INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name) VALUES
        (1, 'attach-guid-1', '~/Library/SMS/Attachments/photo.jpg', 'image/jpeg', 'photo.jpg'),
        (2, 'attach-guid-2', '~/Library/SMS/Attachments/video.mp4', 'video/mp4', 'video.mp4');
    `);

    // Link attachments to messages
    db.exec(`
      INSERT INTO message_attachment_join (message_id, attachment_id) VALUES
        (1, 1),
        (3, 2);
    `);

    db.close();
  };

  beforeAll(() => {
    // Create temp directory for test database
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-parser-test-"));
    // iOS backups store files in subdirectories based on first 2 chars of hash
    // e.g., hash "3d0d7e5f..." is stored at "3d/3d0d7e5f..."
    const hashSubdir = iOSMessagesParser.SMS_DB_HASH.substring(0, 2);
    const subDir = path.join(testDir, hashSubdir);
    fs.mkdirSync(subDir, { recursive: true });
    testDbPath = path.join(subDir, iOSMessagesParser.SMS_DB_HASH);
    createTestDatabase();
  });

  afterAll(() => {
    // Cleanup test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    parser = new iOSMessagesParser();
  });

  afterEach(() => {
    if (parser.isOpen()) {
      parser.close();
    }
  });

  describe("convertAppleTimestamp", () => {
    it("should convert Apple timestamp to JavaScript Date", () => {
      // 2023-06-15 12:00:00 UTC in nanoseconds since 2001-01-01
      const timestamp = 708523200000000000;
      const date = convertAppleTimestamp(timestamp);

      expect(date).not.toBeNull();
      expect(date!.toISOString()).toBe("2023-06-15T12:00:00.000Z");
    });

    it("should return null for null timestamp", () => {
      expect(convertAppleTimestamp(null)).toBeNull();
    });

    it("should return null for zero timestamp", () => {
      expect(convertAppleTimestamp(0)).toBeNull();
    });

    it("should return null for undefined timestamp", () => {
      expect(convertAppleTimestamp(undefined as unknown as number)).toBeNull();
    });

    it("should handle timestamp for 2001-01-01 00:00:00 UTC (Apple epoch)", () => {
      const date = convertAppleTimestamp(1); // 1 nanosecond after epoch
      expect(date).not.toBeNull();
      expect(date!.getUTCFullYear()).toBe(2001);
    });
  });

  describe("open and close", () => {
    it("should open database successfully", () => {
      expect(parser.isOpen()).toBe(false);
      parser.open(testDir);
      expect(parser.isOpen()).toBe(true);
    });

    it("should close database successfully", () => {
      parser.open(testDir);
      expect(parser.isOpen()).toBe(true);
      parser.close();
      expect(parser.isOpen()).toBe(false);
    });

    it("should throw error when opening non-existent database", () => {
      expect(() => parser.open("/non/existent/path")).toThrow();
    });

    it("should handle closing already closed database", () => {
      // Should not throw
      expect(() => parser.close()).not.toThrow();
    });
  });

  describe("getConversations", () => {
    beforeEach(() => {
      parser.open(testDir);
    });

    it("should return all conversations", () => {
      const conversations = parser.getConversations();

      expect(conversations.length).toBe(3);
    });

    it("should sort conversations by last message date descending", () => {
      const conversations = parser.getConversations();

      // Verify descending order
      for (let i = 0; i < conversations.length - 1; i++) {
        expect(conversations[i].lastMessage.getTime()).toBeGreaterThanOrEqual(
          conversations[i + 1].lastMessage.getTime(),
        );
      }
    });

    it("should identify group chats correctly", () => {
      const conversations = parser.getConversations();
      const groupChat = conversations.find(
        (c) => c.chatIdentifier === "chat123456789",
      );

      expect(groupChat).toBeDefined();
      expect(groupChat!.isGroupChat).toBe(true);
      expect(groupChat!.participants.length).toBeGreaterThan(1);
    });

    it("should identify individual chats correctly", () => {
      const conversations = parser.getConversations();
      const individualChat = conversations.find(
        (c) => c.chatIdentifier === "+14155551234",
      );

      expect(individualChat).toBeDefined();
      expect(individualChat!.isGroupChat).toBe(false);
    });

    it("should not include messages in conversation list", () => {
      const conversations = parser.getConversations();

      conversations.forEach((conv) => {
        expect(conv.messages).toEqual([]);
      });
    });

    it("should throw error when database not open", () => {
      parser.close();
      expect(() => parser.getConversations()).toThrow("Database not open");
    });
  });

  describe("getMessages", () => {
    beforeEach(() => {
      parser.open(testDir);
    });

    it("should return messages for a chat", () => {
      const messages = parser.getMessages(1); // Individual chat with person 1

      expect(messages.length).toBe(5); // 5 messages in chat 1
    });

    it("should return messages in chronological order", () => {
      const messages = parser.getMessages(1);

      for (let i = 0; i < messages.length - 1; i++) {
        expect(messages[i].date.getTime()).toBeLessThanOrEqual(
          messages[i + 1].date.getTime(),
        );
      }
    });

    it("should correctly identify messages from me", () => {
      const messages = parser.getMessages(1);
      const myMessage = messages.find((m) => m.text === "Hi! How are you?");

      expect(myMessage).toBeDefined();
      expect(myMessage!.isFromMe).toBe(true);
    });

    it("should correctly identify messages from others", () => {
      const messages = parser.getMessages(1);
      const theirMessage = messages.find((m) => m.text === "Hello there!");

      expect(theirMessage).toBeDefined();
      expect(theirMessage!.isFromMe).toBe(false);
    });

    it("should handle messages with null text", () => {
      const messages = parser.getMessages(1);
      const nullTextMessage = messages.find((m) => m.text === null);

      expect(nullTextMessage).toBeDefined();
      expect(nullTextMessage!.text).toBeNull();
    });

    it("should distinguish iMessage from SMS", () => {
      const smsMessages = parser.getMessages(2); // Group chat has SMS message
      const smsMessage = smsMessages.find((m) => m.service === "SMS");

      expect(smsMessage).toBeDefined();
    });

    it("should support pagination with limit", () => {
      const allMessages = parser.getMessages(1);
      const limitedMessages = parser.getMessages(1, 2);

      expect(limitedMessages.length).toBe(2);
      expect(limitedMessages[0].id).toBe(allMessages[0].id);
    });

    it("should support pagination with limit and offset", () => {
      const allMessages = parser.getMessages(1);
      const offsetMessages = parser.getMessages(1, 2, 1);

      expect(offsetMessages.length).toBe(2);
      expect(offsetMessages[0].id).toBe(allMessages[1].id);
    });

    it("should return empty array for non-existent chat", () => {
      const messages = parser.getMessages(999);
      expect(messages).toEqual([]);
    });

    it("should throw error when database not open", () => {
      parser.close();
      expect(() => parser.getMessages(1)).toThrow("Database not open");
    });
  });

  describe("getAttachments", () => {
    beforeEach(() => {
      parser.open(testDir);
    });

    it("should return attachments for a message", () => {
      const attachments = parser.getAttachments(1); // Message with photo attachment

      expect(attachments.length).toBe(1);
      expect(attachments[0].mimeType).toBe("image/jpeg");
      expect(attachments[0].transferName).toBe("photo.jpg");
    });

    it("should return empty array for message without attachments", () => {
      const attachments = parser.getAttachments(2);
      expect(attachments).toEqual([]);
    });

    it("should return empty array for non-existent message", () => {
      const attachments = parser.getAttachments(999);
      expect(attachments).toEqual([]);
    });

    it("should include attachments in message objects", () => {
      const messages = parser.getMessages(1);
      const messageWithAttachment = messages.find(
        (m) => m.text === "Hello there!",
      );

      expect(messageWithAttachment).toBeDefined();
      expect(messageWithAttachment!.attachments.length).toBe(1);
    });
  });

  describe("searchMessages", () => {
    beforeEach(() => {
      parser.open(testDir);
    });

    it("should find messages matching query", () => {
      const results = parser.searchMessages("Hello");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].text).toContain("Hello");
    });

    it("should be case-insensitive", () => {
      const results = parser.searchMessages("hello");

      expect(results.length).toBeGreaterThan(0);
    });

    it("should return empty array for no matches", () => {
      const results = parser.searchMessages("xyznonexistent");
      expect(results).toEqual([]);
    });

    it("should return empty array for empty query", () => {
      expect(parser.searchMessages("")).toEqual([]);
      expect(parser.searchMessages("   ")).toEqual([]);
    });

    it("should support limit parameter", () => {
      const results = parser.searchMessages("message", 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("should throw error when database not open", () => {
      parser.close();
      expect(() => parser.searchMessages("test")).toThrow("Database not open");
    });
  });

  describe("getMessageCount", () => {
    beforeEach(() => {
      parser.open(testDir);
    });

    it("should return correct message count for chat", () => {
      const count = parser.getMessageCount(1);
      expect(count).toBe(5);
    });

    it("should return 0 for non-existent chat", () => {
      const count = parser.getMessageCount(999);
      expect(count).toBe(0);
    });

    it("should throw error when database not open", () => {
      parser.close();
      expect(() => parser.getMessageCount(1)).toThrow("Database not open");
    });
  });

  describe("getConversationWithMessages", () => {
    beforeEach(() => {
      parser.open(testDir);
    });

    it("should return conversation with messages populated", () => {
      const conversation = parser.getConversationWithMessages(1);

      expect(conversation).not.toBeNull();
      expect(conversation!.chatId).toBe(1);
      expect(conversation!.messages.length).toBe(5);
    });

    it("should support pagination", () => {
      const conversation = parser.getConversationWithMessages(1, 2);

      expect(conversation).not.toBeNull();
      expect(conversation!.messages.length).toBe(2);
    });

    it("should return null for non-existent chat", () => {
      const conversation = parser.getConversationWithMessages(999);
      expect(conversation).toBeNull();
    });

    it("should throw error when database not open", () => {
      parser.close();
      expect(() => parser.getConversationWithMessages(1)).toThrow(
        "Database not open",
      );
    });
  });

  describe("SMS_DB_HASH", () => {
    it("should have correct hash value", () => {
      expect(iOSMessagesParser.SMS_DB_HASH).toBe(
        "3d0d7e5fb2ce288813306e4d4636395e047a3d28",
      );
    });
  });

  describe("handle lookup", () => {
    beforeEach(() => {
      parser.open(testDir);
    });

    it("should resolve handle to phone number", () => {
      const messages = parser.getMessages(1);
      const messageFromContact = messages.find(
        (m) => !m.isFromMe && m.handle !== "",
      );

      expect(messageFromContact).toBeDefined();
      expect(messageFromContact!.handle).toBe("+14155551234");
    });

    it("should handle messages from me (no handle)", () => {
      const messages = parser.getMessages(1);
      const myMessage = messages.find((m) => m.isFromMe);

      expect(myMessage).toBeDefined();
      // Messages from me have empty handle since handle_id is NULL
      expect(myMessage!.handle).toBe("");
    });
  });

  describe("audio_transcript handling", () => {
    beforeEach(() => {
      parser.open(testDir);
    });

    it("should include audioTranscript when present", () => {
      const messages = parser.getMessages(1);
      const voiceMessage = messages.find((m) => m.guid === "msg-guid-7");

      expect(voiceMessage).toBeDefined();
      expect(voiceMessage!.audioTranscript).toBe("This is a voice message transcript");
      expect(voiceMessage!.text).toBeNull(); // Text is null for voice messages
    });

    it("should return audioTranscript alongside text when both present", () => {
      const messages = parser.getMessages(1);
      const messageWithBoth = messages.find((m) => m.guid === "msg-guid-8");

      expect(messageWithBoth).toBeDefined();
      expect(messageWithBoth!.text).toBe("Regular message");
      expect(messageWithBoth!.audioTranscript).toBe("Transcript should be ignored when text exists");
    });

    it("should return null audioTranscript when not present", () => {
      const messages = parser.getMessages(1);
      const regularMessage = messages.find((m) => m.guid === "msg-guid-1");

      expect(regularMessage).toBeDefined();
      expect(regularMessage!.audioTranscript).toBeNull();
    });
  });

  describe("getMessagesAsync", () => {
    beforeEach(() => {
      parser.open(testDir);
    });

    it("should return messages asynchronously", async () => {
      const messages = await parser.getMessagesAsync(1);

      expect(messages.length).toBe(5);
    });

    it("should include audioTranscript in async results", async () => {
      const messages = await parser.getMessagesAsync(1);
      const voiceMessage = messages.find((m) => m.guid === "msg-guid-7");

      expect(voiceMessage).toBeDefined();
      expect(voiceMessage!.audioTranscript).toBe("This is a voice message transcript");
    });

    it("should support pagination", async () => {
      const messages = await parser.getMessagesAsync(1, 2, 1);

      expect(messages.length).toBe(2);
    });

    it("should return empty array for non-existent chat", async () => {
      const messages = await parser.getMessagesAsync(999);
      expect(messages).toEqual([]);
    });

    it("should throw error when database not open", async () => {
      parser.close();
      await expect(parser.getMessagesAsync(1)).rejects.toThrow("Database not open");
    });
  });

  describe("empty database handling", () => {
    let emptyDbDir: string;

    beforeAll(() => {
      emptyDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-parser-empty-"));
      // iOS backups store files in subdirectories based on first 2 chars of hash
      const hashSubdir = iOSMessagesParser.SMS_DB_HASH.substring(0, 2);
      const subDir = path.join(emptyDbDir, hashSubdir);
      fs.mkdirSync(subDir, { recursive: true });
      const emptyDbPath = path.join(subDir, iOSMessagesParser.SMS_DB_HASH);

      // Create empty database with schema only (without audio_transcript column - older iOS)
      const db = new Database(emptyDbPath);
      db.exec(`
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER, date INTEGER, date_read INTEGER, date_delivered INTEGER, service TEXT);
        CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT, transfer_name TEXT);
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      `);
      db.close();
    });

    afterAll(() => {
      if (fs.existsSync(emptyDbDir)) {
        fs.rmSync(emptyDbDir, { recursive: true, force: true });
      }
    });

    it("should handle empty database gracefully", () => {
      const emptyParser = new iOSMessagesParser();
      emptyParser.open(emptyDbDir);

      expect(emptyParser.getConversations()).toEqual([]);
      expect(emptyParser.getMessages(1)).toEqual([]);
      expect(emptyParser.searchMessages("test")).toEqual([]);

      emptyParser.close();
    });

    it("should handle database without audio_transcript column", () => {
      // The empty database was created WITHOUT audio_transcript column
      // Parser should still work gracefully
      const emptyParser = new iOSMessagesParser();
      emptyParser.open(emptyDbDir);

      // Should not throw - gracefully handles missing column
      expect(() => emptyParser.getMessages(1)).not.toThrow();

      emptyParser.close();
    });
  });
});
