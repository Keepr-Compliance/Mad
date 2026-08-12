/**
 * Unit tests for Outlook Fetch Service
 * Tests email fetching from Microsoft Graph API
 *
 * NOTE: Session-only OAuth - tokens stored directly in encrypted database,
 * no separate tokenEncryptionService encryption needed
 */

import outlookFetchService from "../outlookFetchService";
import databaseService from "../databaseService";
import microsoftAuthService from "../microsoftAuthService";
import axios from "axios";
import type { StoreableEmail } from "../emailSyncService";
import { BULK_MAIL_HEADER_JSON_KEYS } from "../../utils/bulkMailHeaders";
import type { OAuthToken } from "../../types/models";

// Mock dependencies
jest.mock("../databaseService");
jest.mock("../microsoftAuthService");
jest.mock("axios");

const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;
const mockMicrosoftAuthService = microsoftAuthService as jest.Mocked<
  typeof microsoftAuthService
>;
const mockAxios = axios as jest.MockedFunction<typeof axios>;

describe("OutlookFetchService", () => {
  const mockUserId = "test-user-id";
  // Session-only OAuth: tokens stored directly, not encrypted
  const mockAccessToken = "test-access-token";

  // Deliberately partial OAuthToken row: `mailbox_connected` and
  // `token_refresh_failed_count` are required on the model but never read by
  // outlookFetchService, so they are omitted rather than invented here. The
  // assertion keeps the fields that ARE present type-checked against the model.
  const mockTokenRecord = {
    id: "token-id",
    user_id: mockUserId,
    provider: "microsoft" as const,
    purpose: "mailbox" as const,
    access_token: mockAccessToken,
    refresh_token: "test-refresh-token",
    token_expires_at: new Date(Date.now() + 3600000).toISOString(),
    connected_email_address: "test@outlook.com",
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as OAuthToken;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("initialize", () => {
    it("should initialize successfully with valid tokens", async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      const result = await outlookFetchService.initialize(mockUserId);

      expect(result).toBe(true);
      expect(mockDatabaseService.getOAuthToken).toHaveBeenCalledWith(
        mockUserId,
        "microsoft",
        "mailbox",
      );
      // Session-only OAuth: tokens used directly, no decryption needed
    });

    it("should throw error when no token found", async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(null);

      await expect(outlookFetchService.initialize(mockUserId)).rejects.toThrow(
        "No Outlook OAuth token found",
      );
    });

    it("should handle database errors", async () => {
      mockDatabaseService.getOAuthToken.mockRejectedValue(
        new Error("Database error"),
      );

      await expect(outlookFetchService.initialize(mockUserId)).rejects.toThrow(
        "Database error",
      );
    });
  });

  describe("searchEmails", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    it("should search emails with basic query", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          conversationId: "conv-1",
          subject: "Test Email 1",
          from: {
            emailAddress: { address: "sender@example.com", name: "Sender" },
          },
          toRecipients: [
            { emailAddress: { address: "recipient@example.com" } },
          ],
          receivedDateTime: "2024-01-15T10:00:00Z",
          sentDateTime: "2024-01-15T09:59:00Z",
          hasAttachments: false,
          body: { content: "Email body", contentType: "text" },
          bodyPreview: "Email body preview",
        },
      ];

      mockAxios.mockResolvedValue({ data: { value: mockMessages } });

      const results = await outlookFetchService.searchEmails({ query: "test" });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockAccessToken}`,
          }),
        }),
      );
      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe("Test Email 1");
    });

    it("should search emails with date filters", async () => {
      mockAxios.mockResolvedValue({ data: { value: [] } });

      const after = new Date("2024-01-01");
      const before = new Date("2024-12-31");

      await outlookFetchService.searchEmails({ after, before });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("receivedDateTime ge"),
        }),
      );
      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("receivedDateTime le"),
        }),
      );
    });

    it("should filter by from address when contactEmails provided", async () => {
      mockAxios.mockResolvedValue({ data: { value: [] } });

      await outlookFetchService.searchEmails({
        contactEmails: ["user@example.com"],
      });

      // Verify the from/emailAddress/address filter is applied (server-side)
      // Note: any() lambdas on toRecipients/ccRecipients/bccRecipients return 400
      // from Graph API, so only from direction is filtered server-side
      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining(
            "from/emailAddress/address eq 'user@example.com'",
          ),
        }),
      );
    });

    it("should respect maxResults parameter", async () => {
      // Create mock messages
      const mockMessages = Array.from({ length: 100 }, (_, i) => ({
        id: `msg-${i}`,
        subject: `Test ${i}`,
        conversationId: `conv-${i}`,
        from: { emailAddress: { address: "test@example.com" } },
        toRecipients: [],
        receivedDateTime: "2024-01-01T00:00:00Z",
        sentDateTime: "2024-01-01T00:00:00Z",
        hasAttachments: false,
      }));
      mockAxios.mockResolvedValue({ data: { value: mockMessages } });

      // Request only 50 results
      const results = await outlookFetchService.searchEmails({
        maxResults: 50,
      });

      // Should return only 50 results even though 100 were fetched
      expect(results).toHaveLength(50);
    });

    it("should handle empty search results", async () => {
      mockAxios.mockResolvedValue({ data: { value: [] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results).toHaveLength(0);
    });

    it("should handle missing value in response", async () => {
      mockAxios.mockResolvedValue({ data: {} });

      const results = await outlookFetchService.searchEmails({});

      expect(results).toHaveLength(0);
    });

    it("should throw error when not initialized", async () => {
      // Create uninitialized service state
      const uninitializedService = Object.create(
        Object.getPrototypeOf(outlookFetchService),
      );
      uninitializedService.accessToken = null;

      await expect(uninitializedService.searchEmails({})).rejects.toThrow(
        "Outlook API not initialized",
      );
    });

    it("should handle API errors", async () => {
      mockAxios.mockRejectedValue(new Error("API Error"));

      await expect(outlookFetchService.searchEmails({})).rejects.toThrow(
        "API Error",
      );
    });

    it("should handle 401 unauthorized errors with token refresh failure", async () => {
      const error = {
        response: { status: 401 },
        message: "Unauthorized",
      };
      mockAxios.mockRejectedValue(error);
      // Mock token refresh to fail
      mockMicrosoftAuthService.refreshToken.mockRejectedValue(
        new Error("Token refresh failed"),
      );

      await expect(outlookFetchService.searchEmails({})).rejects.toThrow(
        "Microsoft access token expired and refresh failed. Please reconnect Outlook.",
      );
    });

    it("should retry request after successful token refresh", async () => {
      const error401 = {
        response: { status: 401 },
        message: "Unauthorized",
      };
      // searchEmails makes multiple requests: first for count, then for data
      // All requests initially fail with 401, then succeed after refresh
      let callCount = 0;
      mockAxios.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          // First two calls fail (count + data request)
          return Promise.reject(error401);
        }
        // After refresh, return empty results
        return Promise.resolve({ data: { value: [], "@odata.count": 0 } });
      });

      // Mock successful token refresh
      mockMicrosoftAuthService.refreshToken.mockResolvedValue({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        scope: "Mail.Read",
      });
      mockDatabaseService.saveOAuthToken.mockResolvedValue("token-id");

      const results = await outlookFetchService.searchEmails({});

      expect(results).toHaveLength(0);
      expect(mockMicrosoftAuthService.refreshToken).toHaveBeenCalled();
      expect(mockDatabaseService.saveOAuthToken).toHaveBeenCalled();
    });
  });

  describe("_parseMessage - email parsing", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    it("should parse email with all recipients", async () => {
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Test Subject",
        from: { emailAddress: { address: "sender@example.com" } },
        toRecipients: [
          { emailAddress: { address: "to1@example.com" } },
          { emailAddress: { address: "to2@example.com" } },
        ],
        ccRecipients: [{ emailAddress: { address: "cc@example.com" } }],
        bccRecipients: [{ emailAddress: { address: "bcc@example.com" } }],
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: true,
        body: { content: "<p>HTML body</p>", contentType: "html" },
        bodyPreview: "Preview text",
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].from).toBe("sender@example.com");
      expect(results[0].to).toBe("to1@example.com, to2@example.com");
      expect(results[0].cc).toBe("cc@example.com");
      expect(results[0].bcc).toBe("bcc@example.com");
    });

    it("should handle missing sender", async () => {
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Test",
        from: null,
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].from).toBeNull();
    });

    it("should handle plain text body", async () => {
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Test",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        body: { content: "Plain text content", contentType: "text" },
        bodyPreview: "Preview",
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].bodyPlain).toBe("Plain text content");
    });

    it("should use bodyPreview for HTML emails", async () => {
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Test",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        body: { content: "<p>HTML</p>", contentType: "html" },
        bodyPreview: "Preview text for plain",
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].bodyPlain).toBe("Preview text for plain");
    });

    it("should handle missing body", async () => {
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Test",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        body: null,
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].body).toBe("");
      expect(results[0].bodyPlain).toBe("");
    });
  });

  describe("getEmailById", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    it("should fetch single email by ID", async () => {
      const mockMessage = {
        id: "msg-123",
        conversationId: "conv-123",
        subject: "Specific Email",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
      };

      mockAxios.mockResolvedValue({ data: mockMessage });

      const result = await outlookFetchService.getEmailById("msg-123");

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("/me/messages/msg-123"),
        }),
      );
      expect(result.id).toBe("msg-123");
      expect(result.subject).toBe("Specific Email");
    });

    it("should handle fetch errors", async () => {
      mockAxios.mockRejectedValue(new Error("Message not found"));

      await expect(
        outlookFetchService.getEmailById("invalid-id"),
      ).rejects.toThrow("Message not found");
    });
  });

  describe("getAttachments", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    it("should fetch all attachments for a message", async () => {
      const mockAttachments = [
        {
          id: "att-1",
          name: "doc.pdf",
          contentType: "application/pdf",
          size: 1024,
        },
        {
          id: "att-2",
          name: "image.jpg",
          contentType: "image/jpeg",
          size: 2048,
        },
      ];

      mockAxios.mockResolvedValue({ data: { value: mockAttachments } });

      const result = await outlookFetchService.getAttachments("msg-123");

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("/me/messages/msg-123/attachments"),
        }),
      );
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("doc.pdf");
    });

    it("should handle empty attachments", async () => {
      mockAxios.mockResolvedValue({ data: { value: [] } });

      const result = await outlookFetchService.getAttachments("msg-123");

      expect(result).toHaveLength(0);
    });

    it("should handle missing value in response", async () => {
      mockAxios.mockResolvedValue({ data: {} });

      const result = await outlookFetchService.getAttachments("msg-123");

      expect(result).toHaveLength(0);
    });
  });

  describe("getAttachment", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/electron/main");

    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
      jest.clearAllMocks();
    });

    it("should fetch specific attachment data", async () => {
      const attachmentContent =
        Buffer.from("attachment data").toString("base64");
      mockAxios.mockResolvedValue({
        data: {
          id: "att-456",
          name: "file.pdf",
          contentBytes: attachmentContent,
        },
      });

      const result = await outlookFetchService.getAttachment(
        "msg-123",
        "att-456",
      );

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining(
            "/me/messages/msg-123/attachments/att-456",
          ),
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.toString()).toBe("attachment data");
    });

    it("should return null when no contentBytes (ELECTRON-16)", async () => {
      mockAxios.mockResolvedValue({
        data: { id: "att-456", name: "file.pdf", contentType: "application/pdf", size: 1024 },
      });

      const result = await outlookFetchService.getAttachment(
        "msg-123",
        "att-456",
      );

      expect(result).toBeNull();
    });

    it("should log to Sentry with context when no contentBytes", async () => {
      mockAxios.mockResolvedValue({
        data: { id: "att-456", name: "file.pdf", contentType: "application/pdf", size: 2048 },
      });

      await outlookFetchService.getAttachment("msg-123", "att-456");

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        "Outlook attachment: no data returned",
        expect.objectContaining({
          level: "warning",
          tags: { service: "outlook-fetch", operation: "getAttachment" },
          extra: expect.objectContaining({
            messageId: "msg-123",
            attachmentId: "att-456",
            contentType: "application/pdf",
            size: 2048,
          }),
        }),
      );
    });

    it("should add Sentry breadcrumb when no contentBytes", async () => {
      mockAxios.mockResolvedValue({
        data: { id: "att-456", name: "file.pdf", contentType: "image/png", size: 512 },
      });

      await outlookFetchService.getAttachment("msg-123", "att-456");

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "email_sync.attachment",
          message: "Outlook attachment: no data returned",
          level: "warning",
          data: expect.objectContaining({
            provider: "outlook",
            messageId: "msg-123",
            attachmentId: "att-456",
          }),
        }),
      );
    });

    it("should return null on fetch error instead of throwing", async () => {
      mockAxios.mockRejectedValue(new Error("Attachment error"));

      const result = await outlookFetchService.getAttachment(
        "msg-123",
        "invalid",
      );

      expect(result).toBeNull();
    });

    it("should report fetch errors to Sentry with enriched context", async () => {
      const error = new Error("Network timeout");
      mockAxios.mockRejectedValue(error);

      await outlookFetchService.getAttachment("msg-123", "att-789");

      expect(Sentry.captureException).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          tags: { service: "outlook-fetch", operation: "getAttachment" },
          extra: { messageId: "msg-123", attachmentId: "att-789" },
        }),
      );
    });

    it("should add Sentry breadcrumb on fetch error", async () => {
      mockAxios.mockRejectedValue(new Error("Server error"));

      await outlookFetchService.getAttachment("msg-123", "att-789");

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "email_sync.attachment",
          message: "Outlook attachment fetch failed",
          level: "error",
          data: expect.objectContaining({
            provider: "outlook",
            messageId: "msg-123",
            attachmentId: "att-789",
            errorType: "Error",
          }),
        }),
      );
    });
  });

  describe("getUserEmail", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    it("should return mail property", async () => {
      mockAxios.mockResolvedValue({
        data: {
          mail: "user@outlook.com",
          userPrincipalName: "user@company.onmicrosoft.com",
        },
      });

      const email = await outlookFetchService.getUserEmail();

      expect(email).toBe("user@outlook.com");
    });

    it("should fall back to userPrincipalName", async () => {
      mockAxios.mockResolvedValue({
        data: { userPrincipalName: "user@company.onmicrosoft.com" },
      });

      const email = await outlookFetchService.getUserEmail();

      expect(email).toBe("user@company.onmicrosoft.com");
    });

    it("should return empty string if neither found", async () => {
      mockAxios.mockResolvedValue({ data: {} });

      const email = await outlookFetchService.getUserEmail();

      expect(email).toBe("");
    });

    it("should handle errors", async () => {
      mockAxios.mockRejectedValue(new Error("Profile error"));

      await expect(outlookFetchService.getUserEmail()).rejects.toThrow(
        "Profile error",
      );
    });
  });

  describe("getFolders", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    it("should fetch mail folders", async () => {
      const mockFolders = [
        { id: "folder-1", displayName: "Inbox" },
        { id: "folder-2", displayName: "Sent Items" },
      ];

      mockAxios.mockResolvedValue({ data: { value: mockFolders } });

      const result = await outlookFetchService.getFolders();

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("/me/mailFolders"),
        }),
      );
      expect(result).toHaveLength(2);
      expect(result[0].displayName).toBe("Inbox");
    });

    it("should handle empty folders", async () => {
      mockAxios.mockResolvedValue({ data: { value: [] } });

      const result = await outlookFetchService.getFolders();

      expect(result).toHaveLength(0);
    });

    it("should handle errors", async () => {
      mockAxios.mockRejectedValue(new Error("Folders error"));

      await expect(outlookFetchService.getFolders()).rejects.toThrow(
        "Folders error",
      );
    });
  });

  describe("Message-ID header extraction (TASK-917)", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    it("should extract Message-ID from internetMessageId property", async () => {
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Test",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        internetMessageId: "<unique-id-123@outlook.com>",
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBe("<unique-id-123@outlook.com>");
    });

    it("should fall back to internetMessageHeaders when internetMessageId is missing", async () => {
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Test",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        internetMessageHeaders: [
          { name: "Message-ID", value: "<fallback-id@example.com>" },
          { name: "From", value: "sender@example.com" },
        ],
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBe("<fallback-id@example.com>");
    });

    it("should handle case-insensitive Message-ID header name in internetMessageHeaders", async () => {
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Test",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        internetMessageHeaders: [
          { name: "message-id", value: "<lowercase@example.com>" },
        ],
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBe("<lowercase@example.com>");
    });

    it("should prefer internetMessageId over internetMessageHeaders", async () => {
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Test",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        internetMessageId: "<preferred@outlook.com>",
        internetMessageHeaders: [
          { name: "Message-ID", value: "<fallback@example.com>" },
        ],
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBe("<preferred@outlook.com>");
    });

    it("should return null when Message-ID is missing from both sources", async () => {
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "No Message-ID",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        // No internetMessageId
        // No internetMessageHeaders
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBeNull();
    });

    it("should return null when internetMessageHeaders is empty array", async () => {
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Empty Headers",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        internetMessageHeaders: [],
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBeNull();
    });

    it("should return null when internetMessageHeaders has no Message-ID header", async () => {
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Test",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        internetMessageHeaders: [
          { name: "From", value: "sender@example.com" },
          { name: "To", value: "recipient@example.com" },
        ],
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBeNull();
    });

    it("should preserve Message-ID with special characters", async () => {
      const specialMessageId =
        "<CAD+XH4s=BKDQRKRm+_dK3sEq@mail.outlook.com>";
      const mockMessage = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Special chars",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        internetMessageId: specialMessageId,
      };

      mockAxios.mockResolvedValue({ data: { value: [mockMessage] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBe(specialMessageId);
    });
  });

  describe("fetchContacts (TASK-1920)", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue({
        ...mockTokenRecord,
        scopes_granted: "openid profile email User.Read Mail.Read Contacts.Read offline_access",
      });
      await outlookFetchService.initialize(mockUserId);
    });

    it("should fetch and map contacts successfully", async () => {
      const mockContacts = [
        {
          id: "contact-1",
          displayName: "John Doe",
          emailAddresses: [
            { address: "john@example.com", name: "John Doe" },
            { address: "john.doe@work.com", name: "John D" },
          ],
          mobilePhone: "+1-555-0101",
          homePhones: ["+1-555-0102"],
          businessPhones: ["+1-555-0103"],
          companyName: "Acme Corp",
        },
        {
          id: "contact-2",
          displayName: "Jane Smith",
          emailAddresses: [{ address: "jane@example.com" }],
          mobilePhone: null,
          homePhones: [],
          businessPhones: [],
          companyName: null,
        },
      ];

      mockAxios.mockResolvedValue({
        data: { value: mockContacts },
      });

      const result = await outlookFetchService.fetchContacts(mockUserId);

      expect(result.success).toBe(true);
      expect(result.contacts).toHaveLength(2);

      // Verify first contact mapping
      expect(result.contacts[0]).toEqual({
        external_record_id: "contact-1",
        name: "John Doe",
        emails: ["john@example.com", "john.doe@work.com"],
        phones: ["+1-555-0101", "+1-555-0102", "+1-555-0103"],
        company: "Acme Corp",
      });

      // Verify second contact mapping (minimal fields)
      expect(result.contacts[1]).toEqual({
        external_record_id: "contact-2",
        name: "Jane Smith",
        emails: ["jane@example.com"],
        phones: [],
        company: null,
      });
    });

    it("should handle pagination via @odata.nextLink", async () => {
      const page1Contacts = Array.from({ length: 250 }, (_, i) => ({
        id: `contact-${i}`,
        displayName: `Contact ${i}`,
        emailAddresses: [],
        mobilePhone: null,
        homePhones: [],
        businessPhones: [],
        companyName: null,
      }));

      const page2Contacts = [
        {
          id: "contact-250",
          displayName: "Contact 250",
          emailAddresses: [],
          mobilePhone: null,
          homePhones: [],
          businessPhones: [],
          companyName: null,
        },
      ];

      let callCount = 0;
      mockAxios.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            data: {
              value: page1Contacts,
              "@odata.nextLink":
                "https://graph.microsoft.com/v1.0/me/contacts?$top=250&$skip=250",
            },
          });
        }
        return Promise.resolve({
          data: { value: page2Contacts },
        });
      });

      const result = await outlookFetchService.fetchContacts(mockUserId);

      expect(result.success).toBe(true);
      expect(result.contacts).toHaveLength(251);
      expect(callCount).toBe(2);
    });

    it("should return empty array for empty contact list", async () => {
      mockAxios.mockResolvedValue({
        data: { value: [] },
      });

      const result = await outlookFetchService.fetchContacts(mockUserId);

      expect(result.success).toBe(true);
      expect(result.contacts).toHaveLength(0);
    });

    it("should return reconnect-required error when Contacts.Read scope is missing", async () => {
      // Override with token that lacks Contacts.Read
      mockDatabaseService.getOAuthToken.mockResolvedValue({
        ...mockTokenRecord,
        scopes_granted: "openid profile email User.Read Mail.Read offline_access",
      });
      await outlookFetchService.initialize(mockUserId);

      const result = await outlookFetchService.fetchContacts(mockUserId);

      expect(result.success).toBe(false);
      expect(result.reconnectRequired).toBe(true);
      expect(result.error).toContain("Contacts.Read");
      expect(result.contacts).toHaveLength(0);
      // Should NOT have made any API calls
      expect(mockAxios).not.toHaveBeenCalled();
    });

    it("should handle 403 Forbidden gracefully", async () => {
      const error403 = {
        response: { status: 403 },
        message: "Forbidden",
      };
      mockAxios.mockRejectedValue(error403);

      const result = await outlookFetchService.fetchContacts(mockUserId);

      expect(result.success).toBe(false);
      expect(result.reconnectRequired).toBe(true);
      expect(result.error).toContain("Access denied");
      expect(result.contacts).toHaveLength(0);
    });

    it("should throw on non-403 errors", async () => {
      mockAxios.mockRejectedValue(new Error("Network error"));

      await expect(
        outlookFetchService.fetchContacts(mockUserId),
      ).rejects.toThrow("Network error");
    });

    it("should handle contacts with missing optional fields", async () => {
      const mockContacts = [
        {
          id: "contact-minimal",
          // No displayName, no emailAddresses, no phones, no company
        },
      ];

      mockAxios.mockResolvedValue({
        data: { value: mockContacts },
      });

      const result = await outlookFetchService.fetchContacts(mockUserId);

      expect(result.success).toBe(true);
      expect(result.contacts[0]).toEqual({
        external_record_id: "contact-minimal",
        name: null,
        emails: [],
        phones: [],
        company: null,
      });
    });

    it("should filter out empty email addresses", async () => {
      const mockContacts = [
        {
          id: "contact-bad-emails",
          displayName: "Bad Emails",
          emailAddresses: [
            { address: "valid@example.com" },
            { address: "" },
            { name: "No Address" }, // missing address field
          ],
        },
      ];

      mockAxios.mockResolvedValue({
        data: { value: mockContacts },
      });

      const result = await outlookFetchService.fetchContacts(mockUserId);

      expect(result.contacts[0].emails).toEqual(["valid@example.com"]);
    });

    it("should throw error when not initialized", async () => {
      const uninitializedService = Object.create(
        Object.getPrototypeOf(outlookFetchService),
      );
      uninitializedService.accessToken = null;

      await expect(
        uninitializedService.fetchContacts(mockUserId),
      ).rejects.toThrow("Outlook API not initialized");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BACKLOG-2512: threading headers, received timestamp, categories
  //
  // Graph supplies all of these and `internetMessageHeaders` was already in
  // every $select — they were simply never read. A test that only exercises
  // Gmail proves nothing about Graph, hence this mirror of the Gmail block.
  //
  // Fixture provenance: the GraphMessage shape below (id / conversationId /
  // subject / receivedDateTime / sentDateTime / hasAttachments /
  // internetMessageHeaders[{name,value}] / categories[]) is transcribed from
  // the fixtures already used in the TASK-917 Message-ID block above, which
  // mirror a real `/messages` $select response. RFC 2606 domains only.
  // ─────────────────────────────────────────────────────────────────────────
  describe("BACKLOG-2512 threading headers, received timestamp and categories", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    /** A reply carrying the full threading header set plus categories. */
    function mockReplyMessage() {
      return {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "RE: Disclosure package",
        from: { emailAddress: { name: "Broker", address: "broker@example.net" } },
        toRecipients: [{ emailAddress: { name: "Me", address: "me@example.com" } }],
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        bodyPreview: "Signed and returned.",
        internetMessageId: "<child-001@example.net>",
        internetMessageHeaders: [
          { name: "Message-ID", value: "<child-001@example.net>" },
          { name: "In-Reply-To", value: "<parent-000@example.net>" },
          {
            name: "References",
            value: "<root-000@example.net> <parent-000@example.net>",
          },
        ],
        categories: ["Closing", "Urgent"],
      };
    }

    it("extracts In-Reply-To from internetMessageHeaders", async () => {
      mockAxios.mockResolvedValue({ data: { value: [mockReplyMessage()] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].inReplyTo).toBe("<parent-000@example.net>");
    });

    it("extracts the References ancestor chain verbatim", async () => {
      mockAxios.mockResolvedValue({ data: { value: [mockReplyMessage()] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].references).toBe(
        "<root-000@example.net> <parent-000@example.net>",
      );
    });

    it("matches threading header names case-insensitively (Graph does not normalize casing)", async () => {
      const msg = {
        ...mockReplyMessage(),
        internetMessageHeaders: [
          { name: "in-reply-to", value: "<lower-parent@example.net>" },
          { name: "REFERENCES", value: "<lower-root@example.net>" },
        ],
      };
      mockAxios.mockResolvedValue({ data: { value: [msg] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].inReplyTo).toBe("<lower-parent@example.net>");
      expect(results[0].references).toBe("<lower-root@example.net>");
    });

    it("returns null threading headers when internetMessageHeaders is absent", async () => {
      const msg = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "New listing",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
      };
      mockAxios.mockResolvedValue({ data: { value: [msg] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].inReplyTo).toBeNull();
      expect(results[0].references).toBeNull();
    });

    it("sets receivedAt from receivedDateTime, NOT sentDateTime", async () => {
      mockAxios.mockResolvedValue({ data: { value: [mockReplyMessage()] } });

      const results = await outlookFetchService.searchEmails({});

      // The two differ by a minute in the fixture, so this cannot pass by accident.
      expect(results[0].receivedAt).toEqual(new Date("2024-01-15T10:00:00Z"));
      expect(results[0].receivedAt).not.toEqual(
        new Date("2024-01-15T09:59:00Z"),
      );
    });

    it("maps Graph categories onto labels, and an absent categories array to []", async () => {
      mockAxios.mockResolvedValue({ data: { value: [mockReplyMessage()] } });
      let results = await outlookFetchService.searchEmails({});
      expect(results[0].labels).toEqual(["Closing", "Urgent"]);

      // Most mailboxes assign no categories; Graph then omits the property.
      const { categories: _omitted, ...noCategories } = mockReplyMessage();
      mockAxios.mockResolvedValue({ data: { value: [noCategories] } });
      results = await outlookFetchService.searchEmails({});
      expect(results[0].labels).toEqual([]);
    });

    it("requests categories in $select (without it Graph never returns the field)", async () => {
      mockAxios.mockResolvedValue({ data: { value: [mockReplyMessage()] } });

      await outlookFetchService.searchEmails({});

      // searchEmails issues a $count probe before the message fetch, so this
      // asserts that SOME call carried the $select, using the
      // `toHaveBeenCalledWith(objectContaining({ url }))` idiom already used
      // throughout this suite rather than indexing into mock.calls. (Indexing
      // also mistypes: axios's (url, config) overload types mock.calls[n][0]
      // as `string`.)
      //
      // Both field names must appear in the SAME $select value — the two
      // lookaheads are anchored inside one `[^&]*` run — so this cannot pass by
      // finding them in two different requests. internetMessageHeaders must
      // survive too: it feeds the threading headers.
      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringMatching(
            /\$select=(?=[^&]*categories)(?=[^&]*internetMessageHeaders)/,
          ),
        }),
      );
    });

    it("is structurally assignable to the writer's StoreableEmail (guards against a producer-side rename)", async () => {
      mockAxios.mockResolvedValue({ data: { value: [mockReplyMessage()] } });

      const results = await outlookFetchService.searchEmails({});
      const parsed = results[0];

      // Compile-time assertion — see the matching check in gmailFetchService.test.ts.
      const _wireCheck: StoreableEmail = parsed;
      expect(_wireCheck.inReplyTo).toBe("<parent-000@example.net>");
      expect(_wireCheck.references).toBe(
        "<root-000@example.net> <parent-000@example.net>",
      );
      expect(_wireCheck.receivedAt).toEqual(new Date("2024-01-15T10:00:00Z"));
      expect(_wireCheck.labels).toEqual(["Closing", "Urgent"]);
      expect(_wireCheck.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BACKLOG-2513: bulk-mail headers
  //
  // Mirrors the Gmail block — a test covering one provider proves nothing about
  // the other. Graph supplies these through `internetMessageHeaders`, already in
  // every $select, so no request or scope change is involved.
  //
  // Fixture provenance: the `internetMessageHeaders[{name,value}]` container is
  // the same shape used in the TASK-917 Message-ID block above. The
  // Authentication-Results VALUE follows the real header grammar with every
  // identifier replaced by RFC 2606 reserved domains; values are lowercase, as
  // the real header is.
  // ─────────────────────────────────────────────────────────────────────────
  describe("BACKLOG-2513 bulk-mail header retention", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    /**
     * A commercial newsletter with the full header set. TWO
     * Authentication-Results instances, so the fixture can distinguish
     * `.find()` from `.filter()`.
     */
    function mockBulkMessage() {
      return {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "This week at Example",
        // Address-only sender: the PII guard flags two capitalised words on a
        // line that also carries an address (the identity-row shape from
        // BACKLOG-2542), and this fixture needs no display name to make its
        // point. Fixed by removing the value, not by baselining it.
        from: { emailAddress: { address: "news@example.net" } },
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        bodyPreview: "Newsletter body",
        internetMessageId: "<bulk-001@example.net>",
        internetMessageHeaders: [
          { name: "Message-ID", value: "<bulk-001@example.net>" },
          {
            name: "List-Unsubscribe",
            value: "<mailto:unsub@example.net>, <https://example.net/u/xyz789>",
          },
          {
            name: "List-Unsubscribe-Post",
            value: "List-Unsubscribe=One-Click",
          },
          { name: "Precedence", value: "bulk" },
          { name: "Auto-Submitted", value: "auto-generated" },
          {
            name: "Authentication-Results",
            value:
              "mx.example.net; dkim=pass header.i=@example.net; spf=pass smtp.mailfrom=example.net",
          },
          {
            name: "Authentication-Results",
            value: "relay.example.com; dmarc=fail header.from=example.net",
          },
        ],
      };
    }

    it("retains List-Unsubscribe, List-Unsubscribe-Post, Precedence and Auto-Submitted", async () => {
      mockAxios.mockResolvedValue({ data: { value: [mockBulkMessage()] } });

      const results = await outlookFetchService.searchEmails({});
      const headers = results[0].bulkMailHeaders;

      expect(headers).not.toBeNull();
      expect(headers?.list_unsubscribe).toBe(
        "<mailto:unsub@example.net>, <https://example.net/u/xyz789>",
      );
      expect(headers?.list_unsubscribe_post).toBe("List-Unsubscribe=One-Click");
      expect(headers?.precedence).toBe("bulk");
      expect(headers?.auto_submitted).toBe("auto-generated");
    });

    it("keeps EVERY Authentication-Results hop, in wire order (not just the first)", async () => {
      mockAxios.mockResolvedValue({ data: { value: [mockBulkMessage()] } });

      const results = await outlookFetchService.searchEmails({});

      // The second hop FAILS dmarc — the one a first-match fold would discard.
      expect(results[0].bulkMailHeaders?.authentication_results).toEqual([
        "mx.example.net; dkim=pass header.i=@example.net; spf=pass smtp.mailfrom=example.net",
        "relay.example.com; dmarc=fail header.from=example.net",
      ]);
    });

    it("emits only keys from the declared contract, identical to Gmail's", async () => {
      mockAxios.mockResolvedValue({ data: { value: [mockBulkMessage()] } });

      const results = await outlookFetchService.searchEmails({});
      const keys = Object.keys(results[0].bulkMailHeaders ?? {});

      for (const key of keys) {
        expect(BULK_MAIL_HEADER_JSON_KEYS).toContain(key);
      }
      // Same declared set the Gmail suite asserts — the shared builder is what
      // keeps the two providers from drifting in key naming.
      expect(keys.sort()).toEqual([...BULK_MAIL_HEADER_JSON_KEYS].sort());
    });

    it("returns null when internetMessageHeaders carries none of these headers", async () => {
      const msg = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "Closing on Thursday?",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
        internetMessageHeaders: [
          { name: "Message-ID", value: "<person-001@example.net>" },
        ],
      };
      mockAxios.mockResolvedValue({ data: { value: [msg] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].bulkMailHeaders).toBeNull();
    });

    it("returns null when internetMessageHeaders is absent entirely", async () => {
      const msg = {
        id: "msg-1",
        conversationId: "conv-1",
        subject: "No headers projected",
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
      };
      mockAxios.mockResolvedValue({ data: { value: [msg] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].bulkMailHeaders).toBeNull();
    });

    it("matches header names case-insensitively, and captures before raw is zeroed", async () => {
      const msg = {
        ...mockBulkMessage(),
        internetMessageHeaders: [
          { name: "list-unsubscribe", value: "<mailto:u@example.net>" },
          { name: "PRECEDENCE", value: "list" },
        ],
      };
      mockAxios.mockResolvedValue({ data: { value: [msg] } });

      const results = await outlookFetchService.searchEmails({});

      expect(results[0].bulkMailHeaders?.list_unsubscribe).toBe(
        "<mailto:u@example.net>",
      );
      expect(results[0].bulkMailHeaders?.precedence).toBe("list");
      // Proves capture preceded `parsed.raw = {}`.
      expect(results[0].raw).toEqual({});
    });

    it("is structurally assignable to the writer's StoreableEmail", async () => {
      mockAxios.mockResolvedValue({ data: { value: [mockBulkMessage()] } });

      const results = await outlookFetchService.searchEmails({});
      const _wireCheck: StoreableEmail = results[0];

      expect(_wireCheck.bulkMailHeaders?.precedence).toBe("bulk");
    });
  });

  /**
   * BACKLOG-2571 — the send time on the Graph side.
   *
   * Graph has supplied `sentDateTime` all along and the parser has parsed it all
   * along — it just never reached a column, because `sent_at` was bound from
   * `receivedDateTime`. Unlike Gmail there is no header to be missing, so this
   * side has no fallback path at all: `sent_at` is a real send time on every row
   * Graph produces.
   *
   * Fixture provenance: ISO-8601 with `Z`, the shape Graph returns and the
   * parser hands to `new Date(...)`. RFC 2606 domains.
   */
  describe("_parseMessage - sent_at semantics (BACKLOG-2571)", () => {
    const RECEIVED = "2026-08-05T20:22:41Z";
    const SENT = "2026-08-05T20:13:41Z"; // nine minutes earlier

    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    async function parseOne() {
      mockAxios.mockResolvedValue({
        data: {
          value: [
            {
              id: "msg-1",
              conversationId: "conv-1",
              subject: "Closing docs",
              from: { emailAddress: { address: "agent@example.com", name: "Agent" } },
              toRecipients: [{ emailAddress: { address: "client@example.com" } }],
              receivedDateTime: RECEIVED,
              sentDateTime: SENT,
              hasAttachments: false,
              body: { content: "Body", contentType: "text" },
              bodyPreview: "Body",
            },
          ],
        },
      });
      return (await outlookFetchService.searchEmails({}))[0];
    }

    it("T1: sentDate is sentDateTime and receivedAt is receivedDateTime — two distinct values", async () => {
      const parsed = await parseOne();

      expect(parsed.sentDate.toISOString()).toBe(new Date(SENT).toISOString());
      expect(parsed.receivedAt?.toISOString()).toBe(new Date(RECEIVED).toISOString());
      // They must genuinely differ, or nothing above discriminates.
      expect(new Date(SENT).toISOString()).not.toBe(new Date(RECEIVED).toISOString());
    });

    it("R2: `date` stays receivedDateTime — the legacy-row matcher depends on it", async () => {
      const parsed = await parseOne();

      // ±2 second tolerance against legacy rows' `sent_at`, which are receive
      // times. The delta here is nine minutes, so a repointed `date` would
      // silently stop matching.
      expect(parsed.date.toISOString()).toBe(new Date(RECEIVED).toISOString());
      expect(parsed.date.toISOString()).not.toBe(new Date(SENT).toISOString());
    });
  });
});
