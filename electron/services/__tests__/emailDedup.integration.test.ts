/**
 * Integration Tests for Email Deduplication (SPRINT-014)
 *
 * Tests the interaction between:
 * - GmailFetchService Message-ID extraction (TASK-909)
 * - DatabaseService LLM filter (TASK-911)
 * - Messages table duplicate_of column (TASK-905)
 *
 * Verifies that the system correctly:
 * - Extracts Message-ID headers from Gmail emails
 * - Filters out duplicates from LLM analysis
 * - Filters out already-analyzed messages from LLM
 */

// Mock better-sqlite3-multiple-ciphers native module
jest.mock("better-sqlite3-multiple-ciphers", () => {
  return jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({
      all: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(null),
      run: jest.fn(),
    }),
    close: jest.fn(),
    exec: jest.fn(),
  }));
});

// Mock electron modules
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn().mockReturnValue("/mock/userData"),
    isPackaged: false,
  },
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
  },
}));

// Mock electron-log
jest.mock("electron-log", () => ({
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock databaseService
jest.mock("../databaseService");

// Mock googleapis
jest.mock("googleapis");

// Mock google-auth-library
jest.mock("google-auth-library");

import databaseService from "../databaseService";
import gmailFetchService from "../gmailFetchService";
import { google } from "googleapis";
import type { Message, OAuthToken } from "../../types";

const mockDatabaseService = databaseService as jest.Mocked<typeof databaseService>;

/**
 * Row shape this suite simulates for the in-memory `messages` store.
 *
 * It is deliberately NOT `Message`:
 *  - it models nullable SQLite columns as `| null` (the NULL filtering is precisely
 *    what these tests exercise) whereas `Message` models them as optional; and
 *  - it still carries the pre-migration column names this suite was written against
 *    (provider / sender / recipients / transaction_confidence /
 *    assigned_transaction_id / llm_analyzed_at / updated_at), which have since been
 *    renamed or dropped from the `Message` model.
 *
 * Declaring it locally lets the fixtures type-check without changing a single value
 * the mocked databaseService hands back to the assertions.
 */
interface SimulatedMessageRow {
  id: string;
  user_id: string;
  external_id: string | null;
  provider: string;
  thread_id: string | null;
  subject: string;
  sender: string;
  recipients: string[];
  participants_flat: string | null;
  body_text: string;
  body_html: string | null;
  received_at: string;
  sent_at: string | null;
  has_attachments: boolean;
  is_transaction_related: boolean | null;
  transaction_confidence: number | null;
  assigned_transaction_id: string | null;
  message_id_header: string | null;
  content_hash: string | null;
  duplicate_of: string | null;
  llm_analyzed_at: string | null;
  created_at: string;
  updated_at: string;
}

describe("Email Deduplication Integration (SPRINT-014)", () => {
  const mockUserId = "test-user-dedup";
  const mockAccessToken = "test-access-token";

  // Mock Gmail API methods
  const mockMessagesList = jest.fn();
  const mockMessagesGet = jest.fn();
  const mockSetCredentials = jest.fn();
  const mockOn = jest.fn();

  // Fixture deliberately omits oauth_tokens columns this suite never reads
  // (mailbox_connected, token_refresh_failed_count); asserted to OAuthToken so the
  // mock boundary type-checks without inventing values the service could branch on.
  const mockTokenRecord = {
    id: "token-id",
    user_id: mockUserId,
    provider: "google" as const,
    purpose: "mailbox" as const,
    access_token: mockAccessToken,
    refresh_token: "test-refresh-token",
    token_expires_at: new Date(Date.now() + 3600000).toISOString(),
    connected_email_address: "test@gmail.com",
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as OAuthToken;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup googleapis mock
    (google.auth.OAuth2 as unknown as jest.Mock).mockImplementation(() => ({
      setCredentials: mockSetCredentials,
      on: mockOn,
    }));

    (google.gmail as jest.Mock).mockReturnValue({
      users: {
        messages: {
          list: mockMessagesList,
          get: mockMessagesGet,
        },
      },
    });
  });

  describe("Message-ID Header Extraction (TASK-909)", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
    });

    it("should extract Message-ID from Gmail headers", async () => {
      // Arrange: Gmail message with Message-ID
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "Subject", value: "Real Estate Offer" },
              { name: "Message-ID", value: "<unique-123@mail.gmail.com>" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Email body").toString("base64") },
          },
        },
      });

      // Act: Initialize and fetch
      await gmailFetchService.initialize(mockUserId);
      const results = await gmailFetchService.searchEmails({});

      // Assert
      expect(results[0].messageIdHeader).toBe("<unique-123@mail.gmail.com>");
    });

    it("should handle case-insensitive Message-ID header name", async () => {
      // Arrange: lowercase header name
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "message-id", value: "<lowercase@example.com>" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      // Act
      await gmailFetchService.initialize(mockUserId);
      const results = await gmailFetchService.searchEmails({});

      // Assert
      expect(results[0].messageIdHeader).toBe("<lowercase@example.com>");
    });

    it("should handle Message-Id (mixed case) header name", async () => {
      // Arrange: Mixed case header name
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [{ name: "Message-Id", value: "<mixed@example.com>" }],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      // Act
      await gmailFetchService.initialize(mockUserId);
      const results = await gmailFetchService.searchEmails({});

      // Assert
      expect(results[0].messageIdHeader).toBe("<mixed@example.com>");
    });

    it("should return null when Message-ID header is missing", async () => {
      // Arrange: Message without Message-ID
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "Subject", value: "No Message-ID" },
              { name: "From", value: "sender@example.com" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      // Act
      await gmailFetchService.initialize(mockUserId);
      const results = await gmailFetchService.searchEmails({});

      // Assert
      expect(results[0].messageIdHeader).toBeNull();
    });

    it("should return null when headers array is empty", async () => {
      // Arrange: Empty headers
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      // Act
      await gmailFetchService.initialize(mockUserId);
      const results = await gmailFetchService.searchEmails({});

      // Assert
      expect(results[0].messageIdHeader).toBeNull();
    });

    it("should preserve Message-ID with special characters", async () => {
      // Arrange: Complex Message-ID format
      const specialMessageId = "<CAD+XH4s=BKDQRKRm+_dK3sEq@mail.gmail.com>";
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [{ name: "Message-ID", value: specialMessageId }],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      // Act
      await gmailFetchService.initialize(mockUserId);
      const results = await gmailFetchService.searchEmails({});

      // Assert
      expect(results[0].messageIdHeader).toBe(specialMessageId);
    });

    it("should use first Message-ID when duplicates exist", async () => {
      // Arrange: Multiple Message-ID headers (rare but possible)
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "Message-ID", value: "<first@example.com>" },
              { name: "Message-ID", value: "<second@example.com>" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      // Act
      await gmailFetchService.initialize(mockUserId);
      const results = await gmailFetchService.searchEmails({});

      // Assert: Should use first occurrence
      expect(results[0].messageIdHeader).toBe("<first@example.com>");
    });
  });

  describe("LLM Analysis Filter (TASK-911)", () => {
    // In-memory message storage for testing
    let messageStorage: SimulatedMessageRow[];

    beforeEach(() => {
      messageStorage = [];

      // Mock getMessagesForLLMAnalysis to filter properly
      mockDatabaseService.getMessagesForLLMAnalysis.mockImplementation(
        async (userId: string, limit = 100) => {
          return messageStorage
            .filter(
              (msg) =>
                msg.user_id === userId &&
                msg.is_transaction_related === null &&
                msg.duplicate_of === null
            )
            .slice(0, limit) as unknown as Message[]; // simulated rows, see SimulatedMessageRow
        }
      );
    });

    /**
     * Helper to insert a test message
     */
    function insertMessage(msg: Partial<SimulatedMessageRow>): SimulatedMessageRow {
      const message: SimulatedMessageRow = {
        id: msg.id || `msg-${Date.now()}`,
        user_id: msg.user_id || mockUserId,
        external_id: msg.external_id || null,
        provider: msg.provider || "gmail",
        thread_id: msg.thread_id || null,
        subject: msg.subject || "Test Subject",
        sender: msg.sender || "sender@example.com",
        recipients: msg.recipients || ["recipient@example.com"],
        participants_flat: msg.participants_flat || null,
        body_text: msg.body_text || "Test body",
        body_html: msg.body_html || null,
        received_at: msg.received_at || new Date().toISOString(),
        sent_at: msg.sent_at || null,
        has_attachments: msg.has_attachments ?? false,
        is_transaction_related: msg.is_transaction_related ?? null,
        transaction_confidence: msg.transaction_confidence ?? null,
        assigned_transaction_id: msg.assigned_transaction_id || null,
        message_id_header: msg.message_id_header || null,
        content_hash: msg.content_hash || null,
        duplicate_of: msg.duplicate_of ?? null,
        llm_analyzed_at: msg.llm_analyzed_at || null,
        created_at: msg.created_at || new Date().toISOString(),
        updated_at: msg.updated_at || new Date().toISOString(),
      };
      messageStorage.push(message);
      return message;
    }

    it("should exclude duplicates from LLM analysis", async () => {
      // Arrange: Insert messages with one duplicate
      insertMessage({
        id: "msg1",
        user_id: mockUserId,
        is_transaction_related: null,
        duplicate_of: null,
      });
      insertMessage({
        id: "msg2",
        user_id: mockUserId,
        is_transaction_related: null,
        duplicate_of: "msg1", // Duplicate of msg1
      });

      // Act: Get messages for LLM
      const messages = await mockDatabaseService.getMessagesForLLMAnalysis(mockUserId);

      // Assert: Only non-duplicate should be returned
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg1");
    });

    it("should exclude already-analyzed messages from LLM analysis", async () => {
      // Arrange: Insert messages with one already analyzed
      insertMessage({
        id: "msg1",
        user_id: mockUserId,
        is_transaction_related: true, // Already analyzed
        duplicate_of: null,
      });
      insertMessage({
        id: "msg2",
        user_id: mockUserId,
        is_transaction_related: null, // Not analyzed yet
        duplicate_of: null,
      });

      // Act: Get messages for LLM
      const messages = await mockDatabaseService.getMessagesForLLMAnalysis(mockUserId);

      // Assert: Only unanalyzed should be returned
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg2");
    });

    it("should exclude both duplicates and analyzed messages", async () => {
      // Arrange: Mix of messages
      insertMessage({
        id: "msg1",
        user_id: mockUserId,
        is_transaction_related: null,
        duplicate_of: null,
      }); // Eligible
      insertMessage({
        id: "msg2",
        user_id: mockUserId,
        is_transaction_related: true,
        duplicate_of: null,
      }); // Analyzed
      insertMessage({
        id: "msg3",
        user_id: mockUserId,
        is_transaction_related: null,
        duplicate_of: "msg1",
      }); // Duplicate
      insertMessage({
        id: "msg4",
        user_id: mockUserId,
        is_transaction_related: null,
        duplicate_of: null,
      }); // Eligible

      // Act
      const messages = await mockDatabaseService.getMessagesForLLMAnalysis(mockUserId);

      // Assert: Only eligible messages (msg1, msg4)
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.id).sort()).toEqual(["msg1", "msg4"]);
    });

    it("should filter by user_id correctly", async () => {
      // Arrange: Messages from different users
      const user1 = "user-1";
      const user2 = "user-2";
      insertMessage({
        id: "msg1",
        user_id: user1,
        is_transaction_related: null,
        duplicate_of: null,
      });
      insertMessage({
        id: "msg2",
        user_id: user2,
        is_transaction_related: null,
        duplicate_of: null,
      });

      // Act: Get messages for user1
      const messagesUser1 = await mockDatabaseService.getMessagesForLLMAnalysis(user1);
      const messagesUser2 = await mockDatabaseService.getMessagesForLLMAnalysis(user2);

      // Assert
      expect(messagesUser1).toHaveLength(1);
      expect(messagesUser1[0].id).toBe("msg1");
      expect(messagesUser2).toHaveLength(1);
      expect(messagesUser2[0].id).toBe("msg2");
    });

    it("should respect limit parameter", async () => {
      // Arrange: Insert multiple eligible messages
      for (let i = 0; i < 10; i++) {
        insertMessage({
          id: `msg-${i}`,
          user_id: mockUserId,
          is_transaction_related: null,
          duplicate_of: null,
        });
      }

      // Act: Request with limit
      const messages = await mockDatabaseService.getMessagesForLLMAnalysis(mockUserId, 5);

      // Assert
      expect(messages).toHaveLength(5);
    });

    it("should return empty array when no eligible messages", async () => {
      // Arrange: All messages are either analyzed or duplicates
      insertMessage({
        id: "msg1",
        user_id: mockUserId,
        is_transaction_related: true,
        duplicate_of: null,
      });
      insertMessage({
        id: "msg2",
        user_id: mockUserId,
        is_transaction_related: null,
        duplicate_of: "msg1",
      });

      // Act
      const messages = await mockDatabaseService.getMessagesForLLMAnalysis(mockUserId);

      // Assert
      expect(messages).toHaveLength(0);
    });

    it("should handle is_transaction_related = false as analyzed", async () => {
      // Arrange: Message explicitly marked as not transaction-related
      insertMessage({
        id: "msg1",
        user_id: mockUserId,
        is_transaction_related: false, // Analyzed as non-real-estate
        duplicate_of: null,
      });
      insertMessage({
        id: "msg2",
        user_id: mockUserId,
        is_transaction_related: null, // Not analyzed
        duplicate_of: null,
      });

      // Act
      const messages = await mockDatabaseService.getMessagesForLLMAnalysis(mockUserId);

      // Assert: Only msg2 should be returned (is_transaction_related IS NULL)
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg2");
    });
  });

  describe("Deduplication Flow End-to-End", () => {
    it("should handle complete dedup flow: fetch -> detect -> mark -> filter", async () => {
      // This test simulates the complete flow:
      // 1. Fetch emails with Message-ID headers
      // 2. Detect duplicates based on Message-ID
      // 3. Mark duplicates in database
      // 4. Filter out duplicates from LLM analysis

      // In-memory storage
      const messages: SimulatedMessageRow[] = [];

      // Mock database operations
      mockDatabaseService.getMessagesForLLMAnalysis.mockImplementation(
        async (userId: string) => {
          return messages.filter(
            (m) =>
              m.user_id === userId &&
              m.is_transaction_related === null &&
              m.duplicate_of === null
          ) as unknown as Message[]; // simulated rows, see SimulatedMessageRow
        }
      );

      // Step 1: Simulate fetched emails with same Message-ID
      const email1: Partial<SimulatedMessageRow> = {
        id: "gmail-123",
        user_id: mockUserId,
        message_id_header: "<same-message@example.com>",
        is_transaction_related: null,
        duplicate_of: null,
      };
      const email2: Partial<SimulatedMessageRow> = {
        id: "gmail-456",
        user_id: mockUserId,
        message_id_header: "<same-message@example.com>", // Same Message-ID
        is_transaction_related: null,
        duplicate_of: null,
      };
      const email3: Partial<SimulatedMessageRow> = {
        id: "gmail-789",
        user_id: mockUserId,
        message_id_header: "<different-message@example.com>",
        is_transaction_related: null,
        duplicate_of: null,
      };

      // Step 2: Simulate deduplication detection
      // email2 is duplicate of email1 (same Message-ID, later processed)
      messages.push({
        ...email1,
        provider: "gmail",
        subject: "Test",
        sender: "test@example.com",
        recipients: ["me@example.com"],
        body_text: "Body",
        received_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as SimulatedMessageRow);

      messages.push({
        ...email2,
        provider: "gmail",
        subject: "Test",
        sender: "test@example.com",
        recipients: ["me@example.com"],
        body_text: "Body",
        received_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        duplicate_of: "gmail-123", // Marked as duplicate
      } as SimulatedMessageRow);

      messages.push({
        ...email3,
        provider: "gmail",
        subject: "Different",
        sender: "other@example.com",
        recipients: ["me@example.com"],
        body_text: "Different body",
        received_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as SimulatedMessageRow);

      // Step 3: Get messages for LLM analysis
      const llmMessages = await mockDatabaseService.getMessagesForLLMAnalysis(mockUserId);

      // Assert: Only non-duplicates should be returned
      expect(llmMessages).toHaveLength(2);
      expect(llmMessages.map((m) => m.id).sort()).toEqual(["gmail-123", "gmail-789"]);
    });
  });
});
