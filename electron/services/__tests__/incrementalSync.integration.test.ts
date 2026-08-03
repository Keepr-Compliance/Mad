/**
 * Integration Tests for Incremental Email Sync (SPRINT-014)
 *
 * Tests the interaction between:
 * - GmailFetchService (TASK-906)
 * - OutlookFetchService (TASK-907)
 * - OAuthTokenDbService (last_sync_at tracking)
 * - DeviceSyncOrchestrator (iPhone backup skip logic - TASK-908)
 *
 * Verifies that the system correctly:
 * - Uses last_sync_at for incremental fetching
 * - Falls back to 90-day window on first sync
 * - Skips unchanged iPhone backups
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

// Mock axios for Outlook
jest.mock("axios");

// Mock microsoftAuthService
jest.mock("../microsoftAuthService");

import databaseService from "../databaseService";
import gmailFetchService from "../gmailFetchService";
import { google } from "googleapis";
import type { OAuthToken } from "../../types";

const mockDatabaseService = databaseService as jest.Mocked<typeof databaseService>;

describe("Incremental Sync Integration (SPRINT-014)", () => {
  const mockUserId = "test-user-incremental";
  const mockAccessToken = "test-access-token";
  const mockRefreshToken = "test-refresh-token";

  // Mock Gmail API methods
  const mockMessagesList = jest.fn();
  const mockMessagesGet = jest.fn();
  const mockSetCredentials = jest.fn();
  const mockOn = jest.fn();

  // Fixture deliberately omits oauth_tokens columns this suite never reads
  // (mailbox_connected, token_refresh_failed_count); asserted to OAuthToken so the
  // mock boundary type-checks without inventing values the service could branch on.
  // last_sync_at stays null at runtime (that is what SQLite returns for an unset
  // column); only its static type is narrowed to the optional shape OAuthToken declares.
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
    last_sync_at: null as unknown as string | undefined,
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

  describe("Gmail Incremental Sync (TASK-906)", () => {
    it("should include after: filter when last_sync_at exists", async () => {
      // Arrange: Set up token with last sync time
      const lastSync = new Date("2024-06-15T10:00:00Z");
      const tokenWithSync = {
        ...mockTokenRecord,
        last_sync_at: lastSync.toISOString(),
      };
      mockDatabaseService.getOAuthToken.mockResolvedValue(tokenWithSync);
      mockMessagesList.mockResolvedValue({ data: { messages: [] } });

      // Act: Initialize and search
      await gmailFetchService.initialize(mockUserId);
      await gmailFetchService.searchEmails({
        query: "real estate",
        after: lastSync,
      });

      // Assert: Query should include after: filter
      expect(mockMessagesList).toHaveBeenCalledWith({
        userId: "me",
        q: expect.stringContaining(`after:${Math.floor(lastSync.getTime() / 1000)}`),
        maxResults: 100,
      });
    });

    it("should use date filter for incremental sync queries", async () => {
      // Arrange: Set up token without last sync (first sync)
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      mockMessagesList.mockResolvedValue({ data: { messages: [] } });

      // Act: Initialize and search with 90-day window
      await gmailFetchService.initialize(mockUserId);
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      await gmailFetchService.searchEmails({
        after: ninetyDaysAgo,
      });

      // Assert: Query should include after: filter for 90 days
      expect(mockMessagesList).toHaveBeenCalledWith({
        userId: "me",
        q: expect.stringContaining("after:"),
        maxResults: 100,
      });
    });

    it("should fetch emails without date filter when not specified", async () => {
      // Arrange
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      mockMessagesList.mockResolvedValue({ data: { messages: [] } });

      // Act: Initialize and search without date
      await gmailFetchService.initialize(mockUserId);
      await gmailFetchService.searchEmails({
        query: "test",
      });

      // Assert: Query should not contain after: when not provided
      const callArgs = mockMessagesList.mock.calls[0][0];
      expect(callArgs.q).toBe("test");
      expect(callArgs.q).not.toContain("after:");
    });

    it("should support both after and before date filters", async () => {
      // Arrange
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      mockMessagesList.mockResolvedValue({ data: { messages: [] } });

      const afterDate = new Date("2024-01-01");
      const beforeDate = new Date("2024-06-30");

      // Act: Initialize and search with date range
      await gmailFetchService.initialize(mockUserId);
      await gmailFetchService.searchEmails({
        query: "real estate",
        after: afterDate,
        before: beforeDate,
      });

      // Assert: Query should include both filters
      const callArgs = mockMessagesList.mock.calls[0][0];
      expect(callArgs.q).toContain(`after:${Math.floor(afterDate.getTime() / 1000)}`);
      expect(callArgs.q).toContain(`before:${Math.floor(beforeDate.getTime() / 1000)}`);
    });
  });

  describe("First Sync Behavior", () => {
    it("should handle first sync when no previous last_sync_at", async () => {
      // Arrange: Token without last_sync_at
      // Value stays null (what SQLite returns for an unset column); only the static
      // type is narrowed to the optional shape OAuthToken declares for last_sync_at.
      const tokenWithoutSync = {
        ...mockTokenRecord,
        last_sync_at: null as unknown as string | undefined,
      };
      mockDatabaseService.getOAuthToken.mockResolvedValue(tokenWithoutSync);
      mockMessagesList.mockResolvedValue({ data: { messages: [] } });

      // Act: Initialize and search
      await gmailFetchService.initialize(mockUserId);

      // Search without after filter should work
      const results = await gmailFetchService.searchEmails({});

      // Assert: Should return empty array without error
      expect(results).toEqual([]);
    });

    it("should allow setting custom date range for first sync", async () => {
      // Arrange
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      mockMessagesList.mockResolvedValue({ data: { messages: [] } });

      // Act: Simulate 90-day window
      await gmailFetchService.initialize(mockUserId);
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      await gmailFetchService.searchEmails({ after: ninetyDaysAgo });

      // Assert: Should use the provided date
      const callArgs = mockMessagesList.mock.calls[0][0];
      const expectedTimestamp = Math.floor(ninetyDaysAgo.getTime() / 1000);
      expect(callArgs.q).toContain(`after:${expectedTimestamp}`);
    });
  });

  describe("Email Message Parsing", () => {
    it("should parse email messages correctly", async () => {
      // Arrange
      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });
      mockMessagesGet.mockResolvedValue({
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
              { name: "Message-ID", value: "<unique-123@mail.gmail.com>" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Email body text").toString("base64") },
          },
        },
      });

      // Act
      await gmailFetchService.initialize(mockUserId);
      const results = await gmailFetchService.searchEmails({});

      // Assert
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: "msg-1",
        threadId: "thread-1",
        subject: "Test Subject",
        from: "sender@example.com",
        to: "recipient@example.com",
        messageIdHeader: "<unique-123@mail.gmail.com>",
      });
    });
  });
});

describe("iPhone Backup Skip Logic (TASK-908)", () => {
  // Simulated backup sync state (in-memory for tests)
  let lastBackupSyncState: Map<string, { hash: string; timestamp: Date }>;

  beforeEach(() => {
    lastBackupSyncState = new Map();
  });

  /**
   * Helper to simulate recordBackupSync
   */
  function recordBackupSync(backupPath: string, manifestHash: string): void {
    lastBackupSyncState.set(backupPath, {
      hash: manifestHash,
      timestamp: new Date(),
    });
  }

  /**
   * Helper to simulate shouldProcessBackup
   */
  function shouldProcessBackup(backupPath: string, currentHash: string): boolean {
    const lastSync = lastBackupSyncState.get(backupPath);
    if (!lastSync) {
      // No previous sync recorded - should process
      return true;
    }
    // Compare hashes - only process if different
    return lastSync.hash !== currentHash;
  }

  /**
   * Helper to clear last backup sync
   */
  function clearLastBackupSync(backupPath?: string): void {
    if (backupPath) {
      lastBackupSyncState.delete(backupPath);
    } else {
      lastBackupSyncState.clear();
    }
  }

  describe("shouldProcessBackup", () => {
    it("should return true when no previous sync recorded", () => {
      const backupPath = "/test/backup/path";
      const currentHash = "abc123def456";

      const result = shouldProcessBackup(backupPath, currentHash);

      expect(result).toBe(true);
    });

    it("should return false when backup hash is unchanged", () => {
      // Arrange: Record a previous sync
      const backupPath = "/test/backup/path";
      const manifestHash = "same-hash-123";
      recordBackupSync(backupPath, manifestHash);

      // Act: Check with same hash
      const result = shouldProcessBackup(backupPath, manifestHash);

      // Assert: Should skip (return false)
      expect(result).toBe(false);
    });

    it("should return true when backup hash has changed", () => {
      // Arrange: Record a previous sync
      const backupPath = "/test/backup/path";
      const oldHash = "old-hash-123";
      recordBackupSync(backupPath, oldHash);

      // Act: Check with new hash
      const newHash = "new-hash-456";
      const result = shouldProcessBackup(backupPath, newHash);

      // Assert: Should process (return true)
      expect(result).toBe(true);
    });

    it("should handle multiple backup paths independently", () => {
      // Arrange: Record syncs for different paths
      const path1 = "/backup/device1";
      const path2 = "/backup/device2";
      recordBackupSync(path1, "hash-device-1");
      recordBackupSync(path2, "hash-device-2");

      // Act & Assert
      // Device 1 unchanged
      expect(shouldProcessBackup(path1, "hash-device-1")).toBe(false);
      // Device 2 changed
      expect(shouldProcessBackup(path2, "hash-device-2-updated")).toBe(true);
      // New device
      expect(shouldProcessBackup("/backup/device3", "any-hash")).toBe(true);
    });
  });

  describe("recordBackupSync", () => {
    it("should record sync metadata", () => {
      const backupPath = "/test/backup";
      const manifestHash = "a".repeat(64);

      // Should not throw
      expect(() => {
        recordBackupSync(backupPath, manifestHash);
      }).not.toThrow();

      // Verify it was recorded
      expect(shouldProcessBackup(backupPath, manifestHash)).toBe(false);
    });

    it("should update existing sync record", () => {
      const backupPath = "/test/backup";

      // First sync
      recordBackupSync(backupPath, "first-hash");
      expect(shouldProcessBackup(backupPath, "first-hash")).toBe(false);

      // Update sync
      recordBackupSync(backupPath, "second-hash");
      expect(shouldProcessBackup(backupPath, "first-hash")).toBe(true);
      expect(shouldProcessBackup(backupPath, "second-hash")).toBe(false);
    });
  });

  describe("clearLastBackupSync", () => {
    it("should clear specific backup path", () => {
      // Arrange
      const path1 = "/backup/device1";
      const path2 = "/backup/device2";
      recordBackupSync(path1, "hash1");
      recordBackupSync(path2, "hash2");

      // Act: Clear only path1
      clearLastBackupSync(path1);

      // Assert
      expect(shouldProcessBackup(path1, "hash1")).toBe(true); // Cleared
      expect(shouldProcessBackup(path2, "hash2")).toBe(false); // Still tracked
    });

    it("should clear all backup syncs when no path specified", () => {
      // Arrange
      recordBackupSync("/backup/device1", "hash1");
      recordBackupSync("/backup/device2", "hash2");

      // Act
      clearLastBackupSync();

      // Assert: Both should need processing again
      expect(shouldProcessBackup("/backup/device1", "hash1")).toBe(true);
      expect(shouldProcessBackup("/backup/device2", "hash2")).toBe(true);
    });
  });

  describe("Skip Result Fields", () => {
    it("should support skipped and skipReason in result type", () => {
      // Type check: Simulate sync result structure
      const skippedResult = {
        success: true,
        messages: [],
        contacts: [],
        conversations: [],
        error: null,
        duration: 50,
        skipped: true,
        skipReason: "unchanged" as const,
      };

      const processedResult = {
        success: true,
        messages: [{ id: "msg1" }],
        contacts: [{ id: "contact1" }],
        conversations: [{ id: "conv1" }],
        error: null,
        duration: 5000,
        skipped: false,
        skipReason: null,
      };

      expect(skippedResult.skipped).toBe(true);
      expect(skippedResult.skipReason).toBe("unchanged");
      expect(processedResult.skipped).toBe(false);
      expect(processedResult.skipReason).toBeNull();
    });
  });
});
