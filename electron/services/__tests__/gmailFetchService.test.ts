/**
 * Unit tests for Gmail Fetch Service
 * Tests email fetching, parsing, and token handling
 *
 * NOTE: Session-only OAuth - tokens stored directly in encrypted database,
 * no separate tokenEncryptionService encryption needed
 */

import gmailFetchService from "../gmailFetchService";
import databaseService from "../databaseService";
import type { StoreableEmail } from "../emailSyncService";
import { BULK_MAIL_HEADER_JSON_KEYS } from "../../utils/bulkMailHeaders";
import { computeEmailHash } from "../../utils/emailHash";
import type { OAuthToken } from "../../types/models";
import { google } from "googleapis";
import {
  startOfLocalDayISO,
  endOfLocalDayISO,
} from "../../../src/utils/dateRangeUtils";

// Mock dependencies
jest.mock("../databaseService");
jest.mock("googleapis");
jest.mock("google-auth-library");

const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;

describe("GmailFetchService", () => {
  const mockUserId = "test-user-id";
  // Session-only OAuth: tokens stored directly, not encrypted
  const mockAccessToken = "test-access-token";
  const mockRefreshToken = "test-refresh-token";

  // Mock Gmail API methods
  const mockMessagesList = jest.fn();
  const mockMessagesGet = jest.fn();
  const mockAttachmentsGet = jest.fn();
  const mockGetProfile = jest.fn();
  const mockSetCredentials = jest.fn();
  const mockOn = jest.fn();

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
          attachments: {
            get: mockAttachmentsGet,
          },
        },
        getProfile: mockGetProfile,
      },
    });
  });

  describe("initialize", () => {
    // Session-only OAuth: tokens stored directly in encrypted database
    // Cast: this fixture carries exactly the OAuthToken columns
    // gmailFetchService reads. The full row type also requires
    // mailbox_connected and token_refresh_failed_count; they are omitted
    // deliberately so the service sees only the fields the test supplies.
    const mockTokenRecord = {
      id: "token-id",
      user_id: mockUserId,
      provider: "google" as const,
      purpose: "mailbox" as const,
      access_token: mockAccessToken,
      refresh_token: mockRefreshToken,
      token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      connected_email_address: "test@gmail.com",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as OAuthToken;

    it("should initialize successfully with valid tokens", async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      const result = await gmailFetchService.initialize(mockUserId);

      expect(result).toBe(true);
      expect(mockDatabaseService.getOAuthToken).toHaveBeenCalledWith(
        mockUserId,
        "google",
        "mailbox",
      );
      // Session-only OAuth: tokens used directly, no decryption needed
      expect(mockSetCredentials).toHaveBeenCalledWith({
        access_token: mockAccessToken,
        refresh_token: mockRefreshToken,
      });
    });

    it("should throw error when no token found", async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(null);

      await expect(gmailFetchService.initialize(mockUserId)).rejects.toThrow(
        "No Gmail OAuth token found",
      );
    });

    it("should handle token without refresh token", async () => {
      // Cast: OAuthToken.refresh_token is `string | undefined`, but the SQLite
      // row (and this test) uses an explicit null for "no refresh token".
      const tokenWithoutRefresh = {
        ...mockTokenRecord,
        refresh_token: null,
      } as unknown as OAuthToken;
      mockDatabaseService.getOAuthToken.mockResolvedValue(tokenWithoutRefresh);

      const result = await gmailFetchService.initialize(mockUserId);

      expect(result).toBe(true);
      // Session-only OAuth: tokens used directly
      expect(mockSetCredentials).toHaveBeenCalledWith({
        access_token: mockAccessToken,
        refresh_token: null,
      });
    });

    it("should register token refresh handler", async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      await gmailFetchService.initialize(mockUserId);

      expect(mockOn).toHaveBeenCalledWith("tokens", expect.any(Function));
    });

    it("should handle initialization errors", async () => {
      mockDatabaseService.getOAuthToken.mockRejectedValue(
        new Error("Database error"),
      );

      await expect(gmailFetchService.initialize(mockUserId)).rejects.toThrow(
        "Database error",
      );
    });
  });

  describe("searchEmails", () => {
    // Session-only OAuth: tokens stored directly
    // Cast: this fixture carries exactly the OAuthToken columns
    // gmailFetchService reads. The full row type also requires
    // mailbox_connected and token_refresh_failed_count; they are omitted
    // deliberately so the service sees only the fields the test supplies.
    const mockTokenRecord = {
      id: "token-id",
      user_id: mockUserId,
      provider: "google" as const,
      purpose: "mailbox" as const,
      access_token: mockAccessToken,
      refresh_token: mockRefreshToken,
      token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      connected_email_address: "test@gmail.com",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as OAuthToken;

    const mockMessageResponse = {
      data: {
        messages: [{ id: "msg-1" }, { id: "msg-2" }],
      },
    };

    const mockFullMessage = {
      data: {
        id: "msg-1",
        threadId: "thread-1",
        internalDate: "1700000000000",
        snippet: "Email snippet",
        labelIds: ["INBOX"],
        payload: {
          headers: [
            { name: "Subject", value: "Test Subject" },
            { name: "From", value: "sender@example.com" },
            { name: "To", value: "recipient@example.com" },
            { name: "Cc", value: "cc@example.com" },
          ],
          mimeType: "text/plain",
          body: {
            data: Buffer.from("Email body text").toString("base64"),
          },
        },
      },
    };

    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      mockMessagesList.mockResolvedValue(mockMessageResponse);
      mockMessagesGet.mockResolvedValue(mockFullMessage);
      await gmailFetchService.initialize(mockUserId);
    });

    it("should search emails with basic query", async () => {
      const results = await gmailFetchService.searchEmails({ query: "test" });

      expect(mockMessagesList).toHaveBeenCalledWith({
        userId: "me",
        q: "test",
        maxResults: 100,
      }, { signal: undefined });
      expect(results).toHaveLength(2);
    });

    it("should search emails with date filters", async () => {
      const after = new Date("2024-01-01");
      const before = new Date("2024-12-31");

      await gmailFetchService.searchEmails({ query: "test", after, before });

      const expectedAfter = Math.floor(after.getTime() / 1000);

      expect(mockMessagesList).toHaveBeenCalledWith({
        userId: "me",
        q: expect.stringContaining(`after:${expectedAfter}`),
        maxResults: 100,
      }, { signal: undefined });
    });

    // BACKLOG-2252 (SR fast-follow to BACKLOG-2247): the Attach Emails date range
    // is inclusive of the end day because the modal sends end-of-local-day
    // (23:59:59.999) as `before`. This flow feeds Gmail via
    // `before:${Math.floor(before.getTime() / 1000)}`. Lock the semantics the 2247
    // fix depends on: the epoch handed to Gmail must reflect end-of-local-day, i.e.
    // Math.floor(endOfLocalDay / 1000) with sub-day precision -- NOT the day-granular
    // midnight (start-of-day) epoch.
    it("should pass the sub-day end-of-local-day epoch to Gmail before:, not day-granular midnight", async () => {
      // Build both boundaries the same way the real Attach Emails flow does
      // (via dateRangeUtils), so this assertion is timezone-robust: it computes the
      // expected epoch rather than hardcoding one.
      const before = new Date(endOfLocalDayISO("2026-07-25")!);
      const startOfDay = new Date(startOfLocalDayISO("2026-07-25")!);

      await gmailFetchService.searchEmails({ query: "test", before });

      const expectedBefore = Math.floor(before.getTime() / 1000);
      const midnightBefore = Math.floor(startOfDay.getTime() / 1000);

      // Sanity: end-of-day and start-of-day for the same calendar day must yield
      // DIFFERENT epoch-seconds, otherwise the assertion below proves nothing.
      expect(expectedBefore).toBeGreaterThan(midnightBefore);

      // The query handed to Gmail must carry the end-of-local-day epoch...
      expect(mockMessagesList).toHaveBeenCalledWith({
        userId: "me",
        q: expect.stringContaining(`before:${expectedBefore}`),
        maxResults: 100,
      }, { signal: undefined });

      // ...and must NOT collapse to the day-granular midnight epoch (the bug 2247 fixed).
      const actualQuery = mockMessagesList.mock.calls[0][0].q as string;
      expect(actualQuery).not.toContain(`before:${midnightBefore}`);
    });

    it("should respect maxResults parameter", async () => {
      await gmailFetchService.searchEmails({ maxResults: 50 });

      expect(mockMessagesList).toHaveBeenCalledWith({
        userId: "me",
        q: "",
        maxResults: 50,
      }, { signal: undefined });
    });

    it("should handle empty search results", async () => {
      mockMessagesList.mockResolvedValue({ data: { messages: [] } });

      const results = await gmailFetchService.searchEmails({});

      expect(results).toHaveLength(0);
    });

    it("should handle no messages in response", async () => {
      mockMessagesList.mockResolvedValue({ data: {} });

      const results = await gmailFetchService.searchEmails({});

      expect(results).toHaveLength(0);
    });

    it("should throw error when not initialized", async () => {
      // Reset the service (create new instance behavior)
      const uninitializedService = Object.create(
        Object.getPrototypeOf(gmailFetchService),
      );
      uninitializedService.gmail = null;

      await expect(uninitializedService.searchEmails({})).rejects.toThrow(
        "Gmail API not initialized",
      );
    });

    it("should parse email headers correctly", async () => {
      const results = await gmailFetchService.searchEmails({});

      expect(results[0]).toMatchObject({
        id: "msg-1",
        threadId: "thread-1",
        subject: "Test Subject",
        from: "sender@example.com",
        to: "recipient@example.com",
        cc: "cc@example.com",
        snippet: "Email snippet",
      });
    });
  });

  describe("getEmailById", () => {
    // Cast: this fixture carries exactly the OAuthToken columns
    // gmailFetchService reads. The full row type also requires
    // mailbox_connected and token_refresh_failed_count; they are omitted
    // deliberately so the service sees only the fields the test supplies.
    const mockTokenRecord = {
      id: "token-id",
      user_id: mockUserId,
      provider: "google" as const,
      purpose: "mailbox" as const,
      access_token: mockAccessToken,
      refresh_token: mockRefreshToken,
      token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      connected_email_address: "test@gmail.com",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as OAuthToken;

    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await gmailFetchService.initialize(mockUserId);
    });

    it("should fetch single email by ID", async () => {
      const mockMessage = {
        data: {
          id: "msg-123",
          threadId: "thread-123",
          internalDate: "1700000000000",
          snippet: "Test snippet",
          labelIds: ["INBOX"],
          payload: {
            headers: [{ name: "Subject", value: "Test Email" }],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      };
      mockMessagesGet.mockResolvedValue(mockMessage);

      const result = await gmailFetchService.getEmailById("msg-123");

      expect(mockMessagesGet).toHaveBeenCalledWith({
        userId: "me",
        id: "msg-123",
        format: "full",
      }, { signal: undefined });
      expect(result.id).toBe("msg-123");
      expect(result.subject).toBe("Test Email");
    });

    it("should handle API errors", async () => {
      mockMessagesGet.mockRejectedValue(new Error("API Error"));

      await expect(
        gmailFetchService.getEmailById("invalid-id"),
      ).rejects.toThrow("API Error");
    });
  });

  describe("_parseMessage - email body extraction", () => {
    // Cast: this fixture carries exactly the OAuthToken columns
    // gmailFetchService reads. The full row type also requires
    // mailbox_connected and token_refresh_failed_count; they are omitted
    // deliberately so the service sees only the fields the test supplies.
    const mockTokenRecord = {
      id: "token-id",
      user_id: mockUserId,
      provider: "google" as const,
      purpose: "mailbox" as const,
      access_token: mockAccessToken,
      refresh_token: mockRefreshToken,
      token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      connected_email_address: "test@gmail.com",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as OAuthToken;

    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });
      await gmailFetchService.initialize(mockUserId);
    });

    it("should extract plain text body", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            mimeType: "text/plain",
            body: { data: Buffer.from("Plain text body").toString("base64") },
            headers: [],
          },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].bodyPlain).toBe("Plain text body");
    });

    it("should extract HTML body from multipart message", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            mimeType: "multipart/alternative",
            headers: [],
            parts: [
              {
                mimeType: "text/plain",
                body: { data: Buffer.from("Plain version").toString("base64") },
              },
              {
                mimeType: "text/html",
                body: {
                  data: Buffer.from("<p>HTML version</p>").toString("base64"),
                },
              },
            ],
          },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].body).toBe("<p>HTML version</p>");
      expect(results[0].bodyPlain).toBe("Plain version");
    });

    /**
     * BACKLOG-2855 — Gmail's adjacent hole.
     *
     * `bodyPlainForHash` (which is what lands in `emails.body_plain`, despite
     * the name) fell back to the raw HTML body when a message carried no
     * `text/plain` MIME part. Search runs `body_plain LIKE ?` against that
     * column, so the stored value was markup rather than words — a milder form
     * of the Outlook defect, from the opposite direction: too much, not too
     * little.
     *
     * The test above is the regression guard for the unaffected case: when a
     * `text/plain` part EXISTS it is still used verbatim.
     */
    it("derives plain text when a multipart message has no text/plain part", async () => {
      const html =
        '<html><head><style>.x { margin-top: 0; }</style></head><body>' +
        "<p>The inspection is scheduled for Tuesday.</p>" +
        "<p>Parcel ARBOR-CREST-PARCEL-88231 is the one to reference.</p>" +
        "</body></html>";

      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            mimeType: "multipart/alternative",
            headers: [],
            parts: [
              {
                mimeType: "text/html",
                body: { data: Buffer.from(html).toString("base64") },
              },
            ],
          },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      // body_html keeps the markup; body_plain gets words.
      expect(results[0].body).toBe(html);
      expect(results[0].bodyPlain).toContain("The inspection is scheduled for Tuesday.");
      expect(results[0].bodyPlain).toContain("ARBOR-CREST-PARCEL-88231");
      expect(results[0].bodyPlain).not.toContain("<p>");
      expect(results[0].bodyPlain).not.toContain("<html>");
      expect(results[0].bodyPlain).not.toContain("margin-top");
    });

    it("derives plain text for a SINGLE-PART text/html message", async () => {
      // The `message.payload.body.data` branch, which has no `parts` array.
      const html = "<div>Closing moved to <b>Friday</b> &amp; confirmed.</div>";

      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            mimeType: "text/html",
            headers: [],
            body: { data: Buffer.from(html).toString("base64") },
          },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].bodyPlain).toBe("Closing moved to Friday & confirmed.");
      expect(results[0].bodyPlain).not.toContain("<");
    });

    it("leaves bodyPlain empty when a message has no body at all", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: { mimeType: "multipart/alternative", headers: [], parts: [] },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].bodyPlain).toBe("");
    });

    it("should extract attachments from message", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            mimeType: "multipart/mixed",
            headers: [],
            parts: [
              {
                mimeType: "text/plain",
                body: { data: Buffer.from("Email text").toString("base64") },
              },
              {
                filename: "document.pdf",
                mimeType: "application/pdf",
                body: {
                  attachmentId: "att-123",
                  size: 1024,
                },
              },
            ],
          },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].hasAttachments).toBe(true);
      expect(results[0].attachmentCount).toBe(1);
      expect(results[0].attachments[0]).toMatchObject({
        filename: "document.pdf",
        mimeType: "application/pdf",
        attachmentId: "att-123",
        size: 1024,
      });
    });

    it("should handle missing headers gracefully", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [], // No headers
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].subject).toBeNull();
      expect(results[0].from).toBeNull();
      expect(results[0].to).toBeNull();
    });
  });

  describe("getAttachment", () => {
    // Cast: this fixture carries exactly the OAuthToken columns
    // gmailFetchService reads. The full row type also requires
    // mailbox_connected and token_refresh_failed_count; they are omitted
    // deliberately so the service sees only the fields the test supplies.
    const mockTokenRecord = {
      id: "token-id",
      user_id: mockUserId,
      provider: "google" as const,
      purpose: "mailbox" as const,
      access_token: mockAccessToken,
      refresh_token: mockRefreshToken,
      token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      connected_email_address: "test@gmail.com",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as OAuthToken;

    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await gmailFetchService.initialize(mockUserId);
    });

    it("should fetch attachment data", async () => {
      const attachmentData =
        Buffer.from("attachment content").toString("base64");
      mockAttachmentsGet.mockResolvedValue({
        data: { data: attachmentData },
      });

      const result = await gmailFetchService.getAttachment(
        "msg-123",
        "att-456",
      );

      expect(mockAttachmentsGet).toHaveBeenCalledWith({
        userId: "me",
        messageId: "msg-123",
        id: "att-456",
      });
      expect(result.toString()).toBe("attachment content");
    });

    it("should handle attachment fetch errors", async () => {
      mockAttachmentsGet.mockRejectedValue(new Error("Attachment not found"));

      await expect(
        gmailFetchService.getAttachment("msg-123", "invalid"),
      ).rejects.toThrow("Attachment not found");
    });
  });

  describe("getUserEmail", () => {
    // Cast: this fixture carries exactly the OAuthToken columns
    // gmailFetchService reads. The full row type also requires
    // mailbox_connected and token_refresh_failed_count; they are omitted
    // deliberately so the service sees only the fields the test supplies.
    const mockTokenRecord = {
      id: "token-id",
      user_id: mockUserId,
      provider: "google" as const,
      purpose: "mailbox" as const,
      access_token: mockAccessToken,
      refresh_token: mockRefreshToken,
      token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      connected_email_address: "test@gmail.com",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as OAuthToken;

    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await gmailFetchService.initialize(mockUserId);
    });

    it("should return user email address", async () => {
      mockGetProfile.mockResolvedValue({
        data: { emailAddress: "user@gmail.com" },
      });

      const email = await gmailFetchService.getUserEmail();

      expect(email).toBe("user@gmail.com");
      expect(mockGetProfile).toHaveBeenCalledWith({ userId: "me" });
    });

    it("should return empty string if email not found", async () => {
      mockGetProfile.mockResolvedValue({ data: {} });

      const email = await gmailFetchService.getUserEmail();

      expect(email).toBe("");
    });

    it("should handle profile fetch errors", async () => {
      mockGetProfile.mockRejectedValue(new Error("Profile error"));

      await expect(gmailFetchService.getUserEmail()).rejects.toThrow(
        "Profile error",
      );
    });
  });

  describe("Message-ID header extraction", () => {
    // Cast: this fixture carries exactly the OAuthToken columns
    // gmailFetchService reads. The full row type also requires
    // mailbox_connected and token_refresh_failed_count; they are omitted
    // deliberately so the service sees only the fields the test supplies.
    const mockTokenRecord = {
      id: "token-id",
      user_id: mockUserId,
      provider: "google" as const,
      purpose: "mailbox" as const,
      access_token: mockAccessToken,
      refresh_token: mockRefreshToken,
      token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      connected_email_address: "test@gmail.com",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as OAuthToken;

    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });
      await gmailFetchService.initialize(mockUserId);
    });

    it("should extract Message-ID header with angle brackets", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "Subject", value: "Test Subject" },
              { name: "Message-ID", value: "<unique-id-123@mail.gmail.com>" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBe("<unique-id-123@mail.gmail.com>");
    });

    it("should handle case-insensitive Message-ID header name", async () => {
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

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBe("<lowercase@example.com>");
    });

    it("should handle Message-Id mixed case header name", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "Message-Id", value: "<mixed-case@example.com>" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBe("<mixed-case@example.com>");
    });

    it("should return null when Message-ID header is missing", async () => {
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

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBeNull();
    });

    it("should return null when headers array is empty", async () => {
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

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBeNull();
    });

    it("should use first Message-ID when duplicates exist", async () => {
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

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBe("<first@example.com>");
    });

    it("should preserve Message-ID with special characters", async () => {
      const specialMessageId =
        "<CAD+XH4s=BKDQRKRm+_dK3sEq@mail.gmail.com>";
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

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].messageIdHeader).toBe(specialMessageId);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BACKLOG-2512: threading headers + received timestamp
  //
  // These fields were never extracted. They are per-message facts that cannot
  // be reconstructed from anything the app stores, so if the parser drops them
  // the only recovery is re-reading every mailbox.
  //
  // Fixture provenance: the `Schema$Message` shape below (id / threadId /
  // internalDate / payload.headers[] / payload.body.data base64) is transcribed
  // from the fixtures already used throughout this suite, which mirror what
  // `users.messages.get({ format: "full" })` returns. Addresses use RFC 2606
  // reserved domains.
  // ─────────────────────────────────────────────────────────────────────────
  describe("BACKLOG-2512 threading headers and received timestamp", () => {
    const mockTokenRecord = {
      id: "token-id",
      user_id: mockUserId,
      provider: "google" as const,
      purpose: "mailbox" as const,
      access_token: mockAccessToken,
      refresh_token: mockRefreshToken,
      token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      connected_email_address: "test@example.com",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as OAuthToken;

    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });
      await gmailFetchService.initialize(mockUserId);
    });

    /** A reply carrying the full threading header set. */
    function mockReplyMessage(): void {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          labelIds: ["INBOX", "IMPORTANT"],
          payload: {
            headers: [
              { name: "Subject", value: "RE: Closing docs" },
              { name: "From", value: "agent@example.com" },
              { name: "To", value: "me@example.com" },
              { name: "Message-ID", value: "<child-001@mail.example.com>" },
              { name: "In-Reply-To", value: "<parent-000@mail.example.com>" },
              {
                name: "References",
                value:
                  "<root-000@mail.example.com> <parent-000@mail.example.com>",
              },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });
    }

    it("extracts In-Reply-To — the parent pointer that makes a reply edge computable", async () => {
      mockReplyMessage();

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].inReplyTo).toBe("<parent-000@mail.example.com>");
    });

    it("extracts the References ancestor chain verbatim", async () => {
      mockReplyMessage();

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].references).toBe(
        "<root-000@mail.example.com> <parent-000@mail.example.com>",
      );
    });

    it("matches threading header names case-insensitively (Gmail does not normalize casing)", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "in-reply-to", value: "<lower-parent@example.com>" },
              { name: "REFERENCES", value: "<lower-root@example.com>" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].inReplyTo).toBe("<lower-parent@example.com>");
      expect(results[0].references).toBe("<lower-root@example.com>");
    });

    it("returns null threading headers for a thread-root message (not undefined)", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [{ name: "Subject", value: "New listing" }],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].inReplyTo).toBeNull();
      expect(results[0].references).toBeNull();
    });

    it("sets receivedAt from internalDate, which is Gmail's receive timestamp", async () => {
      mockReplyMessage();

      const results = await gmailFetchService.searchEmails({});

      // 1700000000000 ms → 2023-11-14T22:13:20.000Z
      expect(results[0].receivedAt).toEqual(new Date(1700000000000));
      expect(results[0].receivedAt?.toISOString()).toBe(
        "2023-11-14T22:13:20.000Z",
      );
    });

    it("is structurally assignable to the writer's StoreableEmail (guards against a producer-side rename)", async () => {
      mockReplyMessage();

      const results = await gmailFetchService.searchEmails({});
      const parsed = results[0];

      // Compile-time assertion. The writer test builds its own StoreableEmail
      // fixture, so renaming a property here (e.g. inReplyTo → replyTo) would
      // otherwise leave BOTH suites green while the column silently went NULL
      // again — exactly how `labels` and `contentHash` were lost originally.
      const _wireCheck: StoreableEmail = parsed;
      expect(_wireCheck.inReplyTo).toBe("<parent-000@mail.example.com>");
      expect(_wireCheck.references).toBe(
        "<root-000@mail.example.com> <parent-000@mail.example.com>",
      );
      expect(_wireCheck.receivedAt).toEqual(new Date(1700000000000));
      // Already produced before this task, but only now visible to the writer.
      expect(_wireCheck.labels).toEqual(["INBOX", "IMPORTANT"]);
      expect(_wireCheck.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BACKLOG-2513: bulk-mail headers
  //
  // These are the negative-filter stage of auto-detection (BACKLOG-2500 §4.2).
  // Marketing mail announces itself in its headers; without them the only way
  // to tell a newsletter from a person is to guess from content, which is what
  // produced transactions from newsletters and bank mail (BACKLOG-2499).
  //
  // Fixture provenance: the `payload.headers[{name,value}]` container is the
  // same shape used throughout this suite, mirroring
  // `users.messages.get({ format: "full" })`. The Authentication-Results VALUE
  // follows the real header grammar (`authserv-id; method=result
  // reason.property=value`) with every identifier replaced by RFC 2606
  // reserved domains. Values are lowercase, as the real header is.
  // ─────────────────────────────────────────────────────────────────────────
  describe("BACKLOG-2513 bulk-mail header retention", () => {
    const mockTokenRecord = {
      id: "token-id",
      user_id: mockUserId,
      provider: "google" as const,
      purpose: "mailbox" as const,
      access_token: mockAccessToken,
      refresh_token: mockRefreshToken,
      token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      connected_email_address: "test@example.com",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as OAuthToken;

    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });
      await gmailFetchService.initialize(mockUserId);
    });

    /**
     * A commercial newsletter carrying the full bulk-mail header set.
     *
     * TWO Authentication-Results instances, deliberately: a single-instance
     * fixture cannot distinguish `.find()` from `.filter()`, so it could not
     * prove the multi-hop fold does anything.
     */
    function mockBulkMessage(): void {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "Subject", value: "This week at Example" },
              { name: "From", value: "news@example.com" },
              {
                name: "List-Unsubscribe",
                value:
                  "<mailto:unsub@example.com>, <https://example.com/u/abc123>",
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
                  "mx.example.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=example.com",
              },
              {
                name: "Authentication-Results",
                value: "relay.example.net; dmarc=fail header.from=example.com",
              },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Newsletter body").toString("base64") },
          },
        },
      });
    }

    it("retains List-Unsubscribe, List-Unsubscribe-Post, Precedence and Auto-Submitted", async () => {
      mockBulkMessage();

      const results = await gmailFetchService.searchEmails({});
      const headers = results[0].bulkMailHeaders;

      expect(headers).not.toBeNull();
      expect(headers?.list_unsubscribe).toBe(
        "<mailto:unsub@example.com>, <https://example.com/u/abc123>",
      );
      expect(headers?.list_unsubscribe_post).toBe("List-Unsubscribe=One-Click");
      expect(headers?.precedence).toBe("bulk");
      expect(headers?.auto_submitted).toBe("auto-generated");
    });

    it("keeps EVERY Authentication-Results hop, in wire order (not just the first)", async () => {
      mockBulkMessage();

      const results = await gmailFetchService.searchEmails({});

      // The second hop is the one that FAILS dmarc. Keeping only the first would
      // store a pass verdict for a message that failed downstream — worse than
      // storing nothing, because it still looks authoritative.
      expect(results[0].bulkMailHeaders?.authentication_results).toEqual([
        "mx.example.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=example.com",
        "relay.example.net; dmarc=fail header.from=example.com",
      ]);
    });

    it("emits only keys from the declared contract (no ad-hoc key names)", async () => {
      mockBulkMessage();

      const results = await gmailFetchService.searchEmails({});
      const keys = Object.keys(results[0].bulkMailHeaders ?? {});

      // The key set is declared once in electron/utils/bulkMailHeaders.ts. This
      // asserts against that declaration rather than literals repeated here, so
      // a typo'd key cannot be emitted by the builder and then faithfully
      // re-asserted by the test.
      for (const key of keys) {
        expect(BULK_MAIL_HEADER_JSON_KEYS).toContain(key);
      }
      // This fixture carries every header, so the full declared set is expected.
      expect(keys.sort()).toEqual([...BULK_MAIL_HEADER_JSON_KEYS].sort());
    });

    it("returns null for ordinary person-to-person mail carrying none of these headers", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "Subject", value: "Closing on Thursday?" },
              { name: "From", value: "agent@example.com" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      // null, not {} — the column stays NULL for the common case.
      expect(results[0].bulkMailHeaders).toBeNull();
    });

    it("matches header names case-insensitively, and captures before raw is zeroed", async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "list-unsubscribe", value: "<mailto:u@example.com>" },
              { name: "PRECEDENCE", value: "list" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
          },
        },
      });

      const results = await gmailFetchService.searchEmails({});

      expect(results[0].bulkMailHeaders?.list_unsubscribe).toBe(
        "<mailto:u@example.com>",
      );
      expect(results[0].bulkMailHeaders?.precedence).toBe("list");
      // _parseMessage sets parsed.raw = {} after building the literal, so
      // headers surviving here proves extraction happened before that zeroing.
      expect(results[0].raw).toEqual({});
    });

    it("is structurally assignable to the writer's StoreableEmail", async () => {
      mockBulkMessage();

      const results = await gmailFetchService.searchEmails({});
      const _wireCheck: StoreableEmail = results[0];

      expect(_wireCheck.bulkMailHeaders?.precedence).toBe("bulk");
    });
  });

  /**
   * BACKLOG-2571 — the send time, and the fact that Gmail may not have one.
   *
   * `internalDate` is when GMAIL RECEIVED the message. Until this task it was
   * the only timestamp the parser produced, and it was written to
   * `emails.sent_at` — so every date-range query and the UI sort ran on receive
   * time while calling it send time. The sender-asserted send time lives in the
   * RFC 5322 `Date:` header, which is already in the payload because messages
   * are fetched `format: "full"`.
   *
   * Fixture provenance: `internalDate` is a STRING of epoch millis, which is
   * what `parseInt(message.internalDate)` in the parser implies; `Date:` is in
   * RFC 5322 form. Both transcribed from the shapes the parser destructures.
   * RFC 2606 domains throughout.
   */
  describe("_parseMessage - sent_at semantics (BACKLOG-2571)", () => {
    const mockTokenRecord = {
      id: "token-id",
      user_id: mockUserId,
      provider: "google" as const,
      purpose: "mailbox" as const,
      access_token: mockAccessToken,
      refresh_token: mockRefreshToken,
      token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      connected_email_address: "agent@example.com",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as OAuthToken;

    // 2026-08-05T20:22:41.000Z — Gmail's receive time for every case below.
    const INTERNAL_DATE_MS = "1786076561000";
    const RECEIVED_ISO = new Date(parseInt(INTERNAL_DATE_MS)).toISOString();
    // Sent nine minutes before it was received — a realistic delta, and large
    // enough that a test cannot pass by the two coinciding.
    const DATE_HEADER = "Wed, 5 Aug 2026 14:13:41 -0600";
    const SENT_ISO = new Date(DATE_HEADER).toISOString();

    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      mockMessagesList.mockResolvedValue({ data: { messages: [{ id: "msg-1" }] } });
      await gmailFetchService.initialize(mockUserId);
    });

    function respondWith(headers: Array<{ name: string; value: string }>) {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg-1",
          threadId: "thread-1",
          internalDate: INTERNAL_DATE_MS,
          payload: {
            mimeType: "text/plain",
            body: { data: Buffer.from("Body").toString("base64") },
            headers,
          },
        },
      });
    }

    it("T2: takes the send time from the Date: header, keeping internalDate as the receive time", async () => {
      respondWith([
        { name: "Subject", value: "Closing docs" },
        { name: "From", value: "agent@example.com" },
        { name: "Date", value: DATE_HEADER },
      ]);

      const parsed = (await gmailFetchService.searchEmails({}))[0];

      expect(parsed.sentDate.toISOString()).toBe(SENT_ISO);
      expect(parsed.receivedAt?.toISOString()).toBe(RECEIVED_ISO);
      // The two must genuinely differ, or none of the above discriminates.
      // THIS IS THE DISCRIMINATOR for the whole `Date:`-header read: T3 and T4
      // below assert the FALLBACK value, which equals the receive time, so a
      // parser that never read the header at all would keep them green. Only
      // this test separates "read the header" from "never looked".
      expect(SENT_ISO).not.toBe(RECEIVED_ISO);
    });

    it("R2: `date` stays the RECEIVE time — the legacy-row matcher compares it against receive times", async () => {
      respondWith([
        { name: "Subject", value: "Closing docs" },
        { name: "From", value: "agent@example.com" },
        { name: "Date", value: DATE_HEADER },
      ]);

      const parsed = (await gmailFetchService.searchEmails({}))[0];

      // `emailSyncService` compares `candidate.date` against legacy rows'
      // `sent_at` (themselves receive times) on a ±2 SECOND tolerance. The
      // send↔receive delta here is nine minutes, so repointing `date` at the
      // send time would silently break that matcher — this assertion is what
      // stops it.
      expect(parsed.date.toISOString()).toBe(RECEIVED_ISO);
      expect(parsed.date.toISOString()).not.toBe(SENT_ISO);
    });

    it("T3: falls back to the receive time when there is NO Date: header", async () => {
      respondWith([
        { name: "Subject", value: "Closing docs" },
        { name: "From", value: "agent@example.com" },
      ]);

      const parsed = (await gmailFetchService.searchEmails({}))[0];

      // The fallback is NOT recorded anywhere — the marker column was dropped
      // by founder decision (2026-08-09). So this row is indistinguishable from
      // one whose sender stamped send and receive identically, and this test
      // pins the fallback VALUE rather than any claim about its provenance.
      expect(parsed.sentDate.toISOString()).toBe(RECEIVED_ISO);
    });

    it("T4: a malformed Date: header falls back too, rather than producing an Invalid Date", async () => {
      respondWith([
        { name: "Subject", value: "Closing docs" },
        { name: "From", value: "agent@example.com" },
        { name: "Date", value: "not a date" },
      ]);

      const parsed = (await gmailFetchService.searchEmails({}))[0];

      // `new Date("not a date").toISOString()` THROWS. Without the validity
      // guard this line does not merely fail — the whole email is discarded by
      // the per-email catch in the sync writer.
      expect(parsed.sentDate.toISOString()).toBe(RECEIVED_ISO);
      expect(Number.isNaN(parsed.sentDate.getTime())).toBe(false);
    });

    it("the content hash still reads the RECEIVE time — the hash change is BACKLOG-2572, not this task", async () => {
      respondWith([
        { name: "Subject", value: "Closing docs" },
        { name: "From", value: "agent@example.com" },
        { name: "Date", value: DATE_HEADER },
      ]);

      const parsed = (await gmailFetchService.searchEmails({}))[0];

      // Renaming the internalDate variable from `sentDate` to `receivedDate`
      // would have silently moved every Gmail hash onto the send time if the
      // computeEmailHash call had been left reading `sentDate`. This pins the
      // hash to the receive time so that a hash change is reviewed as one.
      const expected = computeEmailHash({
        subject: "Closing docs",
        from: "agent@example.com",
        sentDate: new Date(parseInt(INTERNAL_DATE_MS)),
        bodyPlain: "Body",
      });
      expect(parsed.contentHash).toBe(expected);
    });
  });
});
