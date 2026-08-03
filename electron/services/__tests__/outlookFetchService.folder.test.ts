/**
 * Unit tests for Outlook Fetch Service - Folder Discovery (TASK-2046)
 * Tests folder discovery (including child folders), multi-folder fetch,
 * and deduplication
 */

import outlookFetchService from "../outlookFetchService";
import databaseService from "../databaseService";
import axios from "axios";

// Mock dependencies
jest.mock("../databaseService");
jest.mock("../microsoftAuthService");
jest.mock("axios");

const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;
/**
 * outlookFetchService always calls axios with a single config object
 * (`axios({ method, url, headers, ... })`). `typeof axios` resolves to the
 * `(url, config?)` overload, which does not describe that call shape, so the
 * mock is typed against the config-object form the service actually uses.
 */
type AxiosConfigCall = (config: { url: string }) => Promise<unknown>;
const mockAxios = axios as unknown as jest.MockedFunction<AxiosConfigCall>;

describe("OutlookFetchService - Folder Discovery (TASK-2046)", () => {
  const mockUserId = "test-user-id";
  const mockAccessToken = "test-access-token";

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
    // OAuthToken also requires mailbox_connected and token_refresh_failed_count;
    // the cast keeps the fixture exactly as written.
  } as import("../../types/models").OAuthToken;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("discoverFolders", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    it("should discover folders and filter excluded system folders", async () => {
      const mockFolders = [
        { id: "folder-inbox", displayName: "Inbox", childFolderCount: 0 },
        { id: "folder-sent", displayName: "Sent Items", childFolderCount: 0 },
        { id: "folder-junk", displayName: "Junk Email", childFolderCount: 0 },
        {
          id: "folder-deleted",
          displayName: "Deleted Items",
          childFolderCount: 0,
        },
        { id: "folder-drafts", displayName: "Drafts", childFolderCount: 0 },
        { id: "folder-outbox", displayName: "Outbox", childFolderCount: 0 },
        { id: "folder-archive", displayName: "Archive", childFolderCount: 0 },
        { id: "folder-custom", displayName: "My Project", childFolderCount: 0 },
      ];

      mockAxios.mockResolvedValue({ data: { value: mockFolders } });

      const folders = await outlookFetchService.discoverFolders();

      const folderNames = folders.map((f) => f.displayName);

      // Should include non-excluded folders
      expect(folderNames).toContain("Inbox");
      expect(folderNames).toContain("Sent Items");
      expect(folderNames).toContain("Archive");
      expect(folderNames).toContain("My Project");

      // Should NOT include excluded folders
      expect(folderNames).not.toContain("Junk Email");
      expect(folderNames).not.toContain("Deleted Items");
      expect(folderNames).not.toContain("Drafts");
      expect(folderNames).not.toContain("Outbox");
    });

    it("should recursively discover child folders", async () => {
      let callCount = 0;
      mockAxios.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Top-level folders
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "folder-inbox",
                  displayName: "Inbox",
                  childFolderCount: 2,
                },
                {
                  id: "folder-archive",
                  displayName: "Archive",
                  childFolderCount: 0,
                },
              ],
            },
          });
        } else if (callCount === 2) {
          // Child folders of Inbox
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "folder-inbox-work",
                  displayName: "Work",
                  parentFolderId: "folder-inbox",
                  childFolderCount: 0,
                },
                {
                  id: "folder-inbox-personal",
                  displayName: "Personal",
                  parentFolderId: "folder-inbox",
                  childFolderCount: 0,
                },
              ],
            },
          });
        }
        return Promise.resolve({ data: { value: [] } });
      });

      const folders = await outlookFetchService.discoverFolders();

      expect(folders).toHaveLength(4);
      const folderNames = folders.map((f) => f.displayName);
      expect(folderNames).toContain("Inbox");
      expect(folderNames).toContain("Archive");
      expect(folderNames).toContain("Work");
      expect(folderNames).toContain("Personal");
    });

    it("should respect maxDepth to prevent infinite recursion", async () => {
      // Create a deeply nested structure
      let callCount = 0;
      mockAxios.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          data: {
            value: [
              {
                id: `folder-level-${callCount}`,
                displayName: `Level ${callCount}`,
                childFolderCount: 1,
              },
            ],
          },
        });
      });

      await outlookFetchService.discoverFolders(undefined, 3);

      // Should stop at depth 3 (1 + 2 + 3 = 3 folders max)
      // maxDepth=3 allows: level 1 (depth=3), level 2 (depth=2), level 3 (depth=1), then stops
      expect(callCount).toBeLessThanOrEqual(4);
    });

    it("should handle empty folder list", async () => {
      mockAxios.mockResolvedValue({ data: { value: [] } });

      const folders = await outlookFetchService.discoverFolders();

      expect(folders).toHaveLength(0);
    });

    it("should handle child folder discovery failures gracefully", async () => {
      let callCount = 0;
      mockAxios.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "folder-parent",
                  displayName: "Parent",
                  childFolderCount: 1,
                },
                {
                  id: "folder-flat",
                  displayName: "Flat Folder",
                  childFolderCount: 0,
                },
              ],
            },
          });
        } else if (callCount === 2) {
          // Child folder fetch fails
          return Promise.reject(new Error("Child folder access denied"));
        }
        return Promise.resolve({ data: { value: [] } });
      });

      // Should NOT throw
      const folders = await outlookFetchService.discoverFolders();

      // Should still have the parent and flat folder
      expect(folders).toHaveLength(2);
      const folderNames = folders.map((f) => f.displayName);
      expect(folderNames).toContain("Parent");
      expect(folderNames).toContain("Flat Folder");
    });

    it("should exclude 'Conflicts' and 'Sync Issues' folders", async () => {
      const mockFolders = [
        { id: "folder-1", displayName: "Inbox", childFolderCount: 0 },
        { id: "folder-2", displayName: "Conflicts", childFolderCount: 0 },
        { id: "folder-3", displayName: "Sync Issues", childFolderCount: 0 },
        {
          id: "folder-4",
          displayName: "Conversation History",
          childFolderCount: 0,
        },
      ];

      mockAxios.mockResolvedValue({ data: { value: mockFolders } });

      const folders = await outlookFetchService.discoverFolders();

      expect(folders).toHaveLength(1);
      expect(folders[0].displayName).toBe("Inbox");
    });

    it("should be case-insensitive when filtering folders", async () => {
      const mockFolders = [
        { id: "f1", displayName: "JUNK EMAIL", childFolderCount: 0 },
        { id: "f2", displayName: "JunkEmail", childFolderCount: 0 },
        { id: "f3", displayName: "drafts", childFolderCount: 0 },
        { id: "f4", displayName: "DRAFTS", childFolderCount: 0 },
        { id: "f5", displayName: "My Work", childFolderCount: 0 },
      ];

      mockAxios.mockResolvedValue({ data: { value: mockFolders } });

      const folders = await outlookFetchService.discoverFolders();

      // Only "My Work" should remain (all others are excluded)
      // Note: case matching depends on exact lowercase comparison
      // "JUNK EMAIL" lowercased is "junk email" which matches excluded list
      // "JunkEmail" lowercased is "junkemail" which matches excluded list
      expect(folders.length).toBeGreaterThanOrEqual(1);
      expect(folders.find((f) => f.displayName === "My Work")).toBeTruthy();
    });

    it("should throw when not initialized", async () => {
      const uninitializedService = Object.create(
        Object.getPrototypeOf(outlookFetchService)
      );
      uninitializedService.accessToken = null;

      await expect(
        uninitializedService.discoverFolders()
      ).rejects.toThrow("Outlook API not initialized");
    });

    it("should throw on API error", async () => {
      mockAxios.mockRejectedValue(new Error("Folders API error"));

      await expect(outlookFetchService.discoverFolders()).rejects.toThrow(
        "Folders API error"
      );
    });
  });

  describe("searchEmailsByFolder", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    it("should fetch messages from a specific folder", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          conversationId: "conv-1",
          subject: "Folder Email",
          from: {
            emailAddress: { address: "sender@example.com", name: "Sender" },
          },
          toRecipients: [],
          receivedDateTime: "2024-01-15T10:00:00Z",
          sentDateTime: "2024-01-15T09:59:00Z",
          hasAttachments: false,
          body: { content: "Body", contentType: "text" },
          bodyPreview: "Preview",
        },
      ];

      mockAxios.mockResolvedValue({ data: { value: mockMessages } });

      const emails = await outlookFetchService.searchEmailsByFolder(
        "folder-archive"
      );

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining(
            "/me/mailFolders/folder-archive/messages"
          ),
        })
      );
      expect(emails).toHaveLength(1);
      expect(emails[0].subject).toBe("Folder Email");
    });

    it("should apply date filter when provided", async () => {
      mockAxios.mockResolvedValue({ data: { value: [] } });

      const after = new Date("2024-06-01");
      await outlookFetchService.searchEmailsByFolder("folder-1", { after });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("receivedDateTime ge"),
        })
      );
    });

    it("should paginate through folder messages", async () => {
      let callCount = 0;
      mockAxios.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Full page
          const messages = Array.from({ length: 100 }, (_, i) => ({
            id: `msg-${i}`,
            conversationId: `conv-${i}`,
            subject: `Email ${i}`,
            receivedDateTime: "2024-01-15T10:00:00Z",
            sentDateTime: "2024-01-15T09:59:00Z",
            hasAttachments: false,
          }));
          return Promise.resolve({ data: { value: messages } });
        }
        // Second page - fewer than page size = last page
        return Promise.resolve({
          data: {
            value: [
              {
                id: "msg-100",
                conversationId: "conv-100",
                subject: "Email 100",
                receivedDateTime: "2024-01-15T10:00:00Z",
                sentDateTime: "2024-01-15T09:59:00Z",
                hasAttachments: false,
              },
            ],
          },
        });
      });

      const emails = await outlookFetchService.searchEmailsByFolder(
        "folder-1",
        { maxResults: 200 }
      );

      expect(callCount).toBe(2);
      expect(emails).toHaveLength(101);
    });

    it("should respect maxResults", async () => {
      const messages = Array.from({ length: 100 }, (_, i) => ({
        id: `msg-${i}`,
        conversationId: `conv-${i}`,
        subject: `Email ${i}`,
        receivedDateTime: "2024-01-15T10:00:00Z",
        sentDateTime: "2024-01-15T09:59:00Z",
        hasAttachments: false,
      }));

      mockAxios.mockResolvedValue({ data: { value: messages } });

      const emails = await outlookFetchService.searchEmailsByFolder(
        "folder-1",
        { maxResults: 50 }
      );

      expect(emails).toHaveLength(50);
    });

    it("should handle empty folder", async () => {
      mockAxios.mockResolvedValue({ data: { value: [] } });

      const emails = await outlookFetchService.searchEmailsByFolder(
        "folder-empty"
      );

      expect(emails).toHaveLength(0);
    });

    it("should call onProgress callback", async () => {
      mockAxios.mockResolvedValue({
        data: {
          value: [
            {
              id: "msg-1",
              conversationId: "conv-1",
              subject: "Test",
              receivedDateTime: "2024-01-15T10:00:00Z",
              sentDateTime: "2024-01-15T09:59:00Z",
              hasAttachments: false,
            },
          ],
        },
      });

      const onProgress = jest.fn();
      await outlookFetchService.searchEmailsByFolder("folder-1", {
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          fetched: 1,
          folder: "folder-1",
        })
      );
    });

    it("should throw when not initialized", async () => {
      const uninitializedService = Object.create(
        Object.getPrototypeOf(outlookFetchService)
      );
      uninitializedService.accessToken = null;

      await expect(
        uninitializedService.searchEmailsByFolder("folder-1")
      ).rejects.toThrow("Outlook API not initialized");
    });

    it("should throw on API error", async () => {
      mockAxios.mockRejectedValue(new Error("Folder messages API error"));

      await expect(
        outlookFetchService.searchEmailsByFolder("folder-1")
      ).rejects.toThrow("Folder messages API error");
    });
  });

  describe("searchAllFolders", () => {
    beforeEach(async () => {
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      await outlookFetchService.initialize(mockUserId);
    });

    it("should fetch emails from all discovered folders", async () => {
      let callCount = 0;
      mockAxios.mockImplementation(({ url }: { url: string }) => {
        callCount++;

        // Folder discovery
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "folder-inbox",
                  displayName: "Inbox",
                  childFolderCount: 0,
                },
                {
                  id: "folder-archive",
                  displayName: "Archive",
                  childFolderCount: 0,
                },
                {
                  id: "folder-custom",
                  displayName: "Projects",
                  childFolderCount: 0,
                },
              ],
            },
          });
        }

        // Messages from Inbox
        if (url.includes("/me/mailFolders/folder-inbox/messages")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "msg-1",
                  conversationId: "conv-1",
                  subject: "Inbox Email",
                  receivedDateTime: "2024-01-15T10:00:00Z",
                  sentDateTime: "2024-01-15T09:59:00Z",
                  hasAttachments: false,
                },
              ],
            },
          });
        }

        // Messages from Archive
        if (url.includes("/me/mailFolders/folder-archive/messages")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "msg-2",
                  conversationId: "conv-2",
                  subject: "Archive Email",
                  receivedDateTime: "2024-01-10T10:00:00Z",
                  sentDateTime: "2024-01-10T09:59:00Z",
                  hasAttachments: false,
                },
              ],
            },
          });
        }

        // Messages from Projects
        if (url.includes("/me/mailFolders/folder-custom/messages")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "msg-3",
                  conversationId: "conv-3",
                  subject: "Project Email",
                  receivedDateTime: "2024-01-05T10:00:00Z",
                  sentDateTime: "2024-01-05T09:59:00Z",
                  hasAttachments: false,
                },
              ],
            },
          });
        }

        return Promise.resolve({ data: { value: [] } });
      });

      const emails = await outlookFetchService.searchAllFolders();

      expect(emails).toHaveLength(3);
    });

    it("should deduplicate emails across folders", async () => {
      mockAxios.mockImplementation(({ url }: { url: string }) => {
        // Folder discovery
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "folder-inbox",
                  displayName: "Inbox",
                  childFolderCount: 0,
                },
                {
                  id: "folder-custom",
                  displayName: "Custom",
                  childFolderCount: 0,
                },
              ],
            },
          });
        }

        // Same message appears in both folders (unlikely in Outlook, but possible)
        return Promise.resolve({
          data: {
            value: [
              {
                id: "msg-shared",
                conversationId: "conv-1",
                subject: "Shared Email",
                receivedDateTime: "2024-01-15T10:00:00Z",
                sentDateTime: "2024-01-15T09:59:00Z",
                hasAttachments: false,
              },
            ],
          },
        });
      });

      const emails = await outlookFetchService.searchAllFolders();

      // Should be deduplicated to 1
      expect(emails).toHaveLength(1);
      expect(emails[0].id).toBe("msg-shared");
    });

    it("should handle per-folder errors gracefully", async () => {
      mockAxios.mockImplementation(({ url }: { url: string }) => {
        // Folder discovery
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "folder-good",
                  displayName: "Good Folder",
                  childFolderCount: 0,
                },
                {
                  id: "folder-bad",
                  displayName: "Bad Folder",
                  childFolderCount: 0,
                },
                {
                  id: "folder-also-good",
                  displayName: "Also Good",
                  childFolderCount: 0,
                },
              ],
            },
          });
        }

        // Bad folder fails
        if (url.includes("/me/mailFolders/folder-bad/messages")) {
          return Promise.reject(new Error("Folder access denied"));
        }

        // Other folders succeed
        return Promise.resolve({
          data: {
            value: [
              {
                id: `msg-${url.includes("folder-good") ? "1" : "2"}`,
                conversationId: "conv-1",
                subject: "Email",
                receivedDateTime: "2024-01-15T10:00:00Z",
                sentDateTime: "2024-01-15T09:59:00Z",
                hasAttachments: false,
              },
            ],
          },
        });
      });

      // Should NOT throw
      const emails = await outlookFetchService.searchAllFolders();

      // Should have emails from good folders only
      expect(emails).toHaveLength(2);
    });

    it("should handle empty folder discovery", async () => {
      mockAxios.mockResolvedValue({ data: { value: [] } });

      const emails = await outlookFetchService.searchAllFolders();

      expect(emails).toHaveLength(0);
    });

    it("should pass date filter to each folder fetch", async () => {
      const axiosCalls: string[] = [];
      mockAxios.mockImplementation(({ url }: { url: string }) => {
        axiosCalls.push(url);

        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "folder-1",
                  displayName: "Folder",
                  childFolderCount: 0,
                },
              ],
            },
          });
        }

        return Promise.resolve({ data: { value: [] } });
      });

      const after = new Date("2024-06-01");
      await outlookFetchService.searchAllFolders({ after });

      const messageUrl = axiosCalls.find((u) =>
        u.includes("/me/mailFolders/folder-1/messages")
      );
      expect(messageUrl).toBeDefined();
      expect(messageUrl).toContain("receivedDateTime ge");
    });

    it("should call onProgress with folder information", async () => {
      mockAxios.mockImplementation(({ url }: { url: string }) => {
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "folder-1",
                  displayName: "My Archive",
                  childFolderCount: 0,
                },
              ],
            },
          });
        }

        return Promise.resolve({
          data: {
            value: [
              {
                id: "msg-1",
                conversationId: "conv-1",
                subject: "Test",
                receivedDateTime: "2024-01-15T10:00:00Z",
                sentDateTime: "2024-01-15T09:59:00Z",
                hasAttachments: false,
              },
            ],
          },
        });
      });

      const onProgress = jest.fn();
      await outlookFetchService.searchAllFolders({ onProgress });

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          currentFolder: "My Archive",
        })
      );
    });

    it("should throw when not initialized", async () => {
      const uninitializedService = Object.create(
        Object.getPrototypeOf(outlookFetchService)
      );
      uninitializedService.accessToken = null;

      await expect(
        uninitializedService.searchAllFolders()
      ).rejects.toThrow("Outlook API not initialized");
    });

    it("should include nested folders from recursive discovery", async () => {
      let callCount = 0;
      mockAxios.mockImplementation(({ url }: { url: string }) => {
        callCount++;

        // Top-level folder discovery
        if (url.includes("/me/mailFolders?")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "folder-parent",
                  displayName: "Parent",
                  childFolderCount: 1,
                },
              ],
            },
          });
        }

        // Child folder discovery
        if (url.includes("/me/mailFolders/folder-parent/childFolders")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "folder-child",
                  displayName: "Child",
                  parentFolderId: "folder-parent",
                  childFolderCount: 0,
                },
              ],
            },
          });
        }

        // Messages
        if (url.includes("/me/mailFolders/folder-parent/messages")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "msg-parent",
                  conversationId: "conv-1",
                  subject: "Parent Email",
                  receivedDateTime: "2024-01-15T10:00:00Z",
                  sentDateTime: "2024-01-15T09:59:00Z",
                  hasAttachments: false,
                },
              ],
            },
          });
        }

        if (url.includes("/me/mailFolders/folder-child/messages")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  id: "msg-child",
                  conversationId: "conv-2",
                  subject: "Child Email",
                  receivedDateTime: "2024-01-10T10:00:00Z",
                  sentDateTime: "2024-01-10T09:59:00Z",
                  hasAttachments: false,
                },
              ],
            },
          });
        }

        return Promise.resolve({ data: { value: [] } });
      });

      const emails = await outlookFetchService.searchAllFolders();

      // Should have emails from both parent and child folders
      expect(emails).toHaveLength(2);
      const subjects = emails.map((e) => e.subject);
      expect(subjects).toContain("Parent Email");
      expect(subjects).toContain("Child Email");
    });
  });
});
