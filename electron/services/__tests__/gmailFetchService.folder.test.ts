/**
 * Unit tests for Gmail Fetch Service - Folder/Label Discovery (TASK-2046)
 * Tests label discovery, multi-label fetch, and deduplication
 */

import gmailFetchService from "../gmailFetchService";
import databaseService from "../databaseService";
import { google } from "googleapis";
import type { OAuthToken } from "../../types";

// Mock dependencies
jest.mock("../databaseService");
jest.mock("googleapis");
jest.mock("google-auth-library");

const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;

describe("GmailFetchService - Label Discovery (TASK-2046)", () => {
  const mockUserId = "test-user-id";
  const mockAccessToken = "test-access-token";
  const mockRefreshToken = "test-refresh-token";

  // Mock Gmail API methods
  const mockMessagesList = jest.fn();
  const mockMessagesGet = jest.fn();
  const mockAttachmentsGet = jest.fn();
  const mockGetProfile = jest.fn();
  const mockLabelsList = jest.fn();
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
    refresh_token: mockRefreshToken,
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
          attachments: {
            get: mockAttachmentsGet,
          },
        },
        getProfile: mockGetProfile,
        labels: {
          list: mockLabelsList,
        },
      },
    });
  });

  describe("discoverLabels", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await gmailFetchService.initialize(mockUserId);
    });

    it("should discover user labels and filter system labels", async () => {
      mockLabelsList.mockResolvedValue({
        data: {
          labels: [
            { id: "INBOX", name: "INBOX" },
            { id: "SENT", name: "SENT" },
            { id: "SPAM", name: "SPAM" },
            { id: "TRASH", name: "TRASH" },
            { id: "DRAFT", name: "DRAFT" },
            { id: "UNREAD", name: "UNREAD" },
            { id: "STARRED", name: "STARRED" },
            { id: "IMPORTANT", name: "IMPORTANT" },
            { id: "CATEGORY_PERSONAL", name: "CATEGORY_PERSONAL" },
            { id: "CATEGORY_SOCIAL", name: "CATEGORY_SOCIAL" },
            { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS" },
            { id: "Label_1", name: "Work" },
            { id: "Label_2", name: "Personal" },
            { id: "Label_3", name: "Projects/Active" },
          ],
        },
      });

      const labels = await gmailFetchService.discoverLabels();

      // Should include INBOX, SENT, and user labels but NOT SPAM, TRASH, DRAFT, etc.
      expect(labels).toEqual(
        expect.arrayContaining([
          { id: "INBOX", name: "INBOX" },
          { id: "SENT", name: "SENT" },
          { id: "Label_1", name: "Work" },
          { id: "Label_2", name: "Personal" },
          { id: "Label_3", name: "Projects/Active" },
        ])
      );

      // Should NOT include excluded labels
      const labelIds = labels.map((l) => l.id);
      expect(labelIds).not.toContain("SPAM");
      expect(labelIds).not.toContain("TRASH");
      expect(labelIds).not.toContain("DRAFT");
      expect(labelIds).not.toContain("UNREAD");
      expect(labelIds).not.toContain("STARRED");
      expect(labelIds).not.toContain("IMPORTANT");
      expect(labelIds).not.toContain("CATEGORY_PERSONAL");
      expect(labelIds).not.toContain("CATEGORY_SOCIAL");
      expect(labelIds).not.toContain("CATEGORY_PROMOTIONS");
    });

    it("should handle empty label list", async () => {
      mockLabelsList.mockResolvedValue({
        data: { labels: [] },
      });

      const labels = await gmailFetchService.discoverLabels();

      expect(labels).toHaveLength(0);
    });

    it("should handle missing labels in response", async () => {
      mockLabelsList.mockResolvedValue({
        data: {},
      });

      const labels = await gmailFetchService.discoverLabels();

      expect(labels).toHaveLength(0);
    });

    it("should skip labels without an id", async () => {
      mockLabelsList.mockResolvedValue({
        data: {
          labels: [
            { id: null, name: "No ID" },
            { id: "Label_1", name: "Has ID" },
          ],
        },
      });

      const labels = await gmailFetchService.discoverLabels();

      expect(labels).toHaveLength(1);
      expect(labels[0].id).toBe("Label_1");
    });

    it("should use label id as name when name is missing", async () => {
      mockLabelsList.mockResolvedValue({
        data: {
          labels: [{ id: "Label_1", name: null }],
        },
      });

      const labels = await gmailFetchService.discoverLabels();

      expect(labels[0]).toEqual({ id: "Label_1", name: "Label_1" });
    });

    it("should throw when not initialized", async () => {
      const uninitializedService = Object.create(
        Object.getPrototypeOf(gmailFetchService)
      );
      uninitializedService.gmail = null;

      await expect(uninitializedService.discoverLabels()).rejects.toThrow(
        "Gmail API not initialized"
      );
    });

    it("should throw on API error", async () => {
      mockLabelsList.mockRejectedValue(new Error("Labels API error"));

      await expect(gmailFetchService.discoverLabels()).rejects.toThrow(
        "Labels API error"
      );
    });
  });

  describe("searchEmailsByLabel", () => {
    const mockFullMessage = {
      data: {
        id: "msg-1",
        threadId: "thread-1",
        internalDate: "1700000000000",
        snippet: "Email snippet",
        labelIds: ["Label_1"],
        payload: {
          headers: [
            { name: "Subject", value: "Test Subject" },
            { name: "From", value: "sender@example.com" },
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
      await gmailFetchService.initialize(mockUserId);
    });

    it("should fetch messages for a specific label", async () => {
      mockMessagesList.mockResolvedValue({
        data: {
          messages: [{ id: "msg-1" }],
        },
      });
      mockMessagesGet.mockResolvedValue(mockFullMessage);

      const emails = await gmailFetchService.searchEmailsByLabel("Label_1");

      expect(mockMessagesList).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "me",
          labelIds: ["Label_1"],
        }),
        { signal: undefined },
      );
      expect(emails).toHaveLength(1);
      expect(emails[0].id).toBe("msg-1");
    });

    it("should apply date filter when provided", async () => {
      mockMessagesList.mockResolvedValue({
        data: { messages: [] },
      });

      const after = new Date("2024-06-01");
      await gmailFetchService.searchEmailsByLabel("Label_1", { after });

      expect(mockMessagesList).toHaveBeenCalledWith(
        expect.objectContaining({
          q: expect.stringContaining("after:"),
        }),
        { signal: undefined },
      );
    });

    it("should paginate through all results", async () => {
      // First page
      mockMessagesList
        .mockResolvedValueOnce({
          data: {
            messages: [{ id: "msg-1" }, { id: "msg-2" }],
            nextPageToken: "page2",
          },
        })
        // Second page (no nextPageToken = last page)
        .mockResolvedValueOnce({
          data: {
            messages: [{ id: "msg-3" }],
          },
        });

      mockMessagesGet.mockResolvedValue(mockFullMessage);

      const emails = await gmailFetchService.searchEmailsByLabel("Label_1");

      expect(mockMessagesList).toHaveBeenCalledTimes(2);
      expect(emails).toHaveLength(3);
    });

    it("should respect maxResults", async () => {
      mockMessagesList.mockResolvedValue({
        data: {
          messages: [{ id: "msg-1" }],
        },
      });
      mockMessagesGet.mockResolvedValue(mockFullMessage);

      await gmailFetchService.searchEmailsByLabel("Label_1", {
        maxResults: 50,
      });

      expect(mockMessagesList).toHaveBeenCalledWith(
        expect.objectContaining({
          maxResults: 50,
        }),
        { signal: undefined },
      );
    });

    it("should handle empty label", async () => {
      mockMessagesList.mockResolvedValue({
        data: { messages: [] },
      });

      const emails = await gmailFetchService.searchEmailsByLabel("Label_1");

      expect(emails).toHaveLength(0);
    });

    it("should call onProgress callback", async () => {
      mockMessagesList.mockResolvedValue({
        data: {
          messages: [{ id: "msg-1" }],
        },
      });
      mockMessagesGet.mockResolvedValue(mockFullMessage);

      const onProgress = jest.fn();
      await gmailFetchService.searchEmailsByLabel("Label_1", { onProgress });

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          fetched: 1,
          total: 1,
          label: "Label_1",
        })
      );
    });

    it("should throw when not initialized", async () => {
      const uninitializedService = Object.create(
        Object.getPrototypeOf(gmailFetchService)
      );
      uninitializedService.gmail = null;

      await expect(
        uninitializedService.searchEmailsByLabel("Label_1")
      ).rejects.toThrow("Gmail API not initialized");
    });
  });

  describe("searchAllLabels", () => {
    const createMockMessage = (id: string) => ({
      data: {
        id,
        threadId: `thread-${id}`,
        internalDate: "1700000000000",
        snippet: "Snippet",
        labelIds: ["Label_1"],
        payload: {
          headers: [{ name: "Subject", value: `Subject ${id}` }],
          mimeType: "text/plain",
          body: {
            data: Buffer.from("Body").toString("base64"),
          },
        },
      },
    });

    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await gmailFetchService.initialize(mockUserId);
    });

    it("should fetch emails from all discovered labels", async () => {
      // Mock label discovery
      mockLabelsList.mockResolvedValue({
        data: {
          labels: [
            { id: "INBOX", name: "INBOX" },
            { id: "Label_1", name: "Work" },
            { id: "Label_2", name: "Personal" },
          ],
        },
      });

      // Mock messages in each label
      let listCallCount = 0;
      mockMessagesList.mockImplementation(() => {
        listCallCount++;
        if (listCallCount === 1) {
          return Promise.resolve({
            data: { messages: [{ id: "msg-1" }, { id: "msg-2" }] },
          });
        } else if (listCallCount === 2) {
          return Promise.resolve({
            data: { messages: [{ id: "msg-3" }] },
          });
        } else {
          return Promise.resolve({
            data: { messages: [{ id: "msg-4" }] },
          });
        }
      });

      mockMessagesGet.mockImplementation(({ id }: { id: string }) => {
        return Promise.resolve(createMockMessage(id));
      });

      const emails = await gmailFetchService.searchAllLabels();

      expect(emails).toHaveLength(4);
    });

    it("should deduplicate emails across labels", async () => {
      // Mock label discovery
      mockLabelsList.mockResolvedValue({
        data: {
          labels: [
            { id: "INBOX", name: "INBOX" },
            { id: "Label_1", name: "Work" },
          ],
        },
      });

      // Same message appears in both labels
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }, { id: "msg-2" }] },
      });

      mockMessagesGet.mockImplementation(({ id }: { id: string }) => {
        return Promise.resolve(createMockMessage(id));
      });

      const emails = await gmailFetchService.searchAllLabels();

      // msg-1 and msg-2 appear in both labels, should be deduplicated
      expect(emails).toHaveLength(2);
      expect(emails[0].id).toBe("msg-1");
      expect(emails[1].id).toBe("msg-2");
    });

    it("should handle per-label errors gracefully", async () => {
      // Mock label discovery
      mockLabelsList.mockResolvedValue({
        data: {
          labels: [
            { id: "INBOX", name: "INBOX" },
            { id: "Label_bad", name: "Bad Label" },
            { id: "Label_good", name: "Good Label" },
          ],
        },
      });

      let listCallCount = 0;
      mockMessagesList.mockImplementation(() => {
        listCallCount++;
        if (listCallCount === 1) {
          // INBOX succeeds
          return Promise.resolve({
            data: { messages: [{ id: "msg-1" }] },
          });
        } else if (listCallCount === 2) {
          // Bad Label fails
          return Promise.reject(new Error("Label access denied"));
        } else {
          // Good Label succeeds
          return Promise.resolve({
            data: { messages: [{ id: "msg-2" }] },
          });
        }
      });

      mockMessagesGet.mockImplementation(({ id }: { id: string }) => {
        return Promise.resolve(createMockMessage(id));
      });

      // Should NOT throw -- should skip the bad label and continue
      const emails = await gmailFetchService.searchAllLabels();

      // Should have emails from INBOX and Good Label, but not Bad Label
      expect(emails).toHaveLength(2);
    });

    it("should handle empty label discovery", async () => {
      mockLabelsList.mockResolvedValue({
        data: { labels: [] },
      });

      const emails = await gmailFetchService.searchAllLabels();

      expect(emails).toHaveLength(0);
    });

    it("should pass date filter to each label fetch", async () => {
      mockLabelsList.mockResolvedValue({
        data: {
          labels: [{ id: "INBOX", name: "INBOX" }],
        },
      });

      mockMessagesList.mockResolvedValue({
        data: { messages: [] },
      });

      const after = new Date("2024-06-01");
      await gmailFetchService.searchAllLabels({ after });

      expect(mockMessagesList).toHaveBeenCalledWith(
        expect.objectContaining({
          q: expect.stringContaining("after:"),
        }),
        { signal: undefined },
      );
    });

    it("should call onProgress with label information", async () => {
      mockLabelsList.mockResolvedValue({
        data: {
          labels: [{ id: "Label_1", name: "Work" }],
        },
      });

      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });

      mockMessagesGet.mockResolvedValue(createMockMessage("msg-1"));

      const onProgress = jest.fn();
      await gmailFetchService.searchAllLabels({ onProgress });

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          currentLabel: "Work",
        })
      );
    });

    it("should throw when not initialized", async () => {
      const uninitializedService = Object.create(
        Object.getPrototypeOf(gmailFetchService)
      );
      uninitializedService.gmail = null;

      await expect(
        uninitializedService.searchAllLabels()
      ).rejects.toThrow("Gmail API not initialized");
    });
  });
});
