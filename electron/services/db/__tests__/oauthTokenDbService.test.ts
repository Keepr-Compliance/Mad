/**
 * @jest-environment node
 */

/**
 * Unit tests for OAuth Token Database Service
 * Tests the sync time helper functions for incremental email fetching
 */


// Mock the core database connection
const mockDbGet = jest.fn();
const mockDbRun = jest.fn();

jest.mock("../core/dbConnection", () => ({
  dbGet: mockDbGet,
  dbRun: mockDbRun,
}));

// Mock logService - must return both default and named exports
const mockLogService = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.mock("../../logService", () => mockLogService);

// Import after mocks are set up
import {
  getOAuthTokenSyncTime,
  updateOAuthTokenSyncTime,
} from "../oauthTokenDbService";

describe("oauthTokenDbService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getOAuthTokenSyncTime", () => {
    it("should return null when no token exists", async () => {
      mockDbGet.mockReturnValue(null);

      const result = await getOAuthTokenSyncTime("user-123", "google");

      expect(result).toBeNull();
      expect(mockDbGet).toHaveBeenCalledWith(
        expect.stringContaining("SELECT last_sync_at FROM oauth_tokens"),
        ["user-123", "google"]
      );
    });

    it("should return null when token exists but last_sync_at is null", async () => {
      mockDbGet.mockReturnValue({ last_sync_at: null });

      const result = await getOAuthTokenSyncTime("user-123", "google");

      expect(result).toBeNull();
    });

    it("should return null when token exists but last_sync_at is undefined", async () => {
      mockDbGet.mockReturnValue({});

      const result = await getOAuthTokenSyncTime("user-123", "google");

      expect(result).toBeNull();
    });

    it("should return Date when last_sync_at exists", async () => {
      const testDate = "2024-01-15T10:30:00.000Z";
      mockDbGet.mockReturnValue({ last_sync_at: testDate });

      const result = await getOAuthTokenSyncTime("user-123", "google");

      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe(testDate);
    });

    it("should query for mailbox purpose only", async () => {
      mockDbGet.mockReturnValue(null);

      await getOAuthTokenSyncTime("user-456", "microsoft");

      expect(mockDbGet).toHaveBeenCalledWith(
        expect.stringContaining("purpose = 'mailbox'"),
        ["user-456", "microsoft"]
      );
    });

    it("should query for active tokens only", async () => {
      mockDbGet.mockReturnValue(null);

      await getOAuthTokenSyncTime("user-789", "google");

      expect(mockDbGet).toHaveBeenCalledWith(
        expect.stringContaining("is_active = 1"),
        ["user-789", "google"]
      );
    });
  });

  describe("updateOAuthTokenSyncTime", () => {
    it("should update last_sync_at with ISO string format", async () => {
      const syncTime = new Date("2024-01-15T10:30:00.000Z");

      await updateOAuthTokenSyncTime("user-123", "google", syncTime);

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE oauth_tokens"),
        ["2024-01-15T10:30:00.000Z", "user-123", "google"]
      );
    });

    it("should update only mailbox tokens", async () => {
      const syncTime = new Date();

      await updateOAuthTokenSyncTime("user-456", "microsoft", syncTime);

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("purpose = 'mailbox'"),
        expect.any(Array)
      );
    });

    it("should update only active tokens", async () => {
      const syncTime = new Date();

      await updateOAuthTokenSyncTime("user-789", "google", syncTime);

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("is_active = 1"),
        expect.any(Array)
      );
    });

    it("should pass correct parameters in order", async () => {
      const syncTime = new Date("2024-06-01T12:00:00.000Z");

      await updateOAuthTokenSyncTime("test-user", "google", syncTime);

      const [, params] = mockDbRun.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([
        "2024-06-01T12:00:00.000Z",
        "test-user",
        "google",
      ]);
    });
  });
});
