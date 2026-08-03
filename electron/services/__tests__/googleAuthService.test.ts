/**
 * Unit tests for Google Auth Service
 * Tests OAuth authentication flows, token refresh, and authentication methods
 *
 * NOTE: Session-only OAuth - tokens stored directly in encrypted database,
 * no separate tokenEncryptionService encryption needed
 *
 * BACKLOG-733: Updated to reflect PKCE migration (no googleapis OAuth2Client)
 */

import googleAuthService from "../googleAuthService";
import databaseService from "../databaseService";
import type { OAuthToken } from "../../types/models";

// Mock dependencies
jest.mock("../databaseService");
jest.mock("axios");
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// The `mockTokenRecord` fixtures below are deliberately partial OAuthToken rows:
// `token_refresh_failed_count` (and sometimes `mailbox_connected`) are required on
// the model but are not read by googleAuthService, so they are asserted rather than
// invented. Fields that ARE present stay type-checked against the model.
const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;

describe("GoogleAuthService - Token Refresh", () => {
  const mockUserId = "test-user-id";
  // Session-only OAuth: tokens stored directly, not encrypted
  const mockRefreshToken = "test-refresh-token";
  const mockAccessToken = "new-access-token";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("refreshAccessToken", () => {
    it("should successfully refresh an expired token", async () => {
      // Setup mocks - session-only OAuth uses unencrypted tokens
      const mockTokenRecord = {
        id: "token-id",
        user_id: mockUserId,
        provider: "google" as const,
        purpose: "mailbox" as const,
        access_token: "old-access-token",
        refresh_token: mockRefreshToken,
        token_expires_at: "2025-01-01T00:00:00.000Z",
        connected_email_address: "test@gmail.com",
        mailbox_connected: true,
        scopes_granted: "https://www.googleapis.com/auth/gmail.readonly",
        is_active: true,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      } as OAuthToken;

      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      // Mock the refreshToken method
      const mockNewTokens = {
        access_token: mockAccessToken,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
      jest
        .spyOn(googleAuthService, "refreshToken")
        .mockResolvedValue(mockNewTokens);

      // Execute
      const result = await googleAuthService.refreshAccessToken(mockUserId);

      // Verify
      expect(result.success).toBe(true);
      expect(mockDatabaseService.getOAuthToken).toHaveBeenCalledWith(
        mockUserId,
        "google",
        "mailbox",
      );
      // Session-only OAuth: tokens used directly, no encryption/decryption
      expect(mockDatabaseService.saveOAuthToken).toHaveBeenCalled();
    });

    it("should return error when no refresh token exists", async () => {
      // Setup: No token in database
      mockDatabaseService.getOAuthToken.mockResolvedValue(null);

      // Execute
      const result = await googleAuthService.refreshAccessToken(mockUserId);

      // Verify
      expect(result.success).toBe(false);
      expect(result.error).toBe("No refresh token available");
    });

    it("should return error when token record has no refresh token", async () => {
      // Setup: Token record without refresh_token
      const mockTokenRecord = {
        id: "token-id",
        user_id: mockUserId,
        provider: "google" as const,
        purpose: "mailbox" as const,
        access_token: "old-access-token",
        refresh_token: undefined,
        token_expires_at: "2025-01-01T00:00:00.000Z",
        connected_email_address: "test@gmail.com",
        is_active: true,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      } as OAuthToken;

      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      // Execute
      const result = await googleAuthService.refreshAccessToken(mockUserId);

      // Verify
      expect(result.success).toBe(false);
      expect(result.error).toBe("No refresh token available");
    });

    it("should handle Google OAuth refresh failures", async () => {
      // Setup mocks
      const mockTokenRecord = {
        id: "token-id",
        user_id: mockUserId,
        provider: "google" as const,
        purpose: "mailbox" as const,
        access_token: "old-access-token",
        refresh_token: mockRefreshToken,
        token_expires_at: "2025-01-01T00:00:00.000Z",
        connected_email_address: "test@gmail.com",
        is_active: true,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      } as OAuthToken;

      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      // Mock refreshToken to throw error
      jest
        .spyOn(googleAuthService, "refreshToken")
        .mockRejectedValue(new Error("Invalid refresh token"));

      // Execute
      const result = await googleAuthService.refreshAccessToken(mockUserId);

      // Verify
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid refresh token");
      expect(mockDatabaseService.saveOAuthToken).not.toHaveBeenCalled();
    });

    it("should preserve email address and scopes when refreshing", async () => {
      // Setup mocks
      const mockTokenRecord = {
        id: "token-id",
        user_id: mockUserId,
        provider: "google" as const,
        purpose: "mailbox" as const,
        access_token: "old-access-token",
        refresh_token: mockRefreshToken,
        token_expires_at: "2025-01-01T00:00:00.000Z",
        connected_email_address: "user@company.com",
        mailbox_connected: true,
        scopes_granted: "https://www.googleapis.com/auth/gmail.readonly",
        is_active: true,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      } as OAuthToken;

      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      const mockNewTokens = {
        access_token: mockAccessToken,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
      jest
        .spyOn(googleAuthService, "refreshToken")
        .mockResolvedValue(mockNewTokens);

      // Execute
      await googleAuthService.refreshAccessToken(mockUserId);

      // Verify saveOAuthToken was called with preserved data
      expect(mockDatabaseService.saveOAuthToken).toHaveBeenCalledWith(
        mockUserId,
        "google",
        "mailbox",
        expect.objectContaining({
          connected_email_address: "user@company.com",
          mailbox_connected: true,
          scopes_granted: "https://www.googleapis.com/auth/gmail.readonly",
        }),
      );
    });

    it("should keep existing refresh token when Google does not return a new one", async () => {
      // Setup mocks - session-only OAuth: refresh token stored directly
      const existingRefreshToken = "existing-refresh-token";
      const mockTokenRecord = {
        id: "token-id",
        user_id: mockUserId,
        provider: "google" as const,
        purpose: "mailbox" as const,
        access_token: "old-access-token",
        refresh_token: existingRefreshToken,
        token_expires_at: "2025-01-01T00:00:00.000Z",
        connected_email_address: "test@gmail.com",
        is_active: true,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      } as OAuthToken;

      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      const mockNewTokens = {
        access_token: mockAccessToken,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
      jest
        .spyOn(googleAuthService, "refreshToken")
        .mockResolvedValue(mockNewTokens);

      // Execute
      await googleAuthService.refreshAccessToken(mockUserId);

      // Verify the existing refresh token is preserved
      expect(mockDatabaseService.saveOAuthToken).toHaveBeenCalledWith(
        mockUserId,
        "google",
        "mailbox",
        expect.objectContaining({
          refresh_token: existingRefreshToken, // Should keep the old one
        }),
      );
    });
  });
});

describe("GoogleAuthService - Direct Code Resolution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("resolveCodeDirectly", () => {
    it("should resolve the code promise when resolver is set", async () => {
      // Start local server to set up the resolver
      const { codePromise } = googleAuthService.startLocalServer();

      // Resolve directly
      googleAuthService.resolveCodeDirectly("test-auth-code");

      // The promise should resolve with the code
      const code = await codePromise;
      expect(code).toBe("test-auth-code");
    });

    it("should stop local server after resolving", () => {
      const stopSpy = jest.spyOn(googleAuthService, "stopLocalServer");

      // Start and then resolve
      googleAuthService.startLocalServer();
      googleAuthService.resolveCodeDirectly("test-code");

      expect(stopSpy).toHaveBeenCalled();
      stopSpy.mockRestore();
    });
  });

  describe("rejectCodeDirectly", () => {
    it("should reject the code promise when rejecter is set", async () => {
      // Start local server to set up the rejecter
      const { codePromise } = googleAuthService.startLocalServer();

      // Reject directly
      googleAuthService.rejectCodeDirectly("Auth error");

      // The promise should reject with the error
      await expect(codePromise).rejects.toThrow("Auth error");
    });

    it("should stop local server after rejecting", async () => {
      const stopSpy = jest.spyOn(googleAuthService, "stopLocalServer");

      // Start and then reject - must catch the rejected promise
      const { codePromise } = googleAuthService.startLocalServer();
      googleAuthService.rejectCodeDirectly("error");

      // Await the rejection to prevent unhandled promise rejection
      await expect(codePromise).rejects.toThrow("error");
      expect(stopSpy).toHaveBeenCalled();
      stopSpy.mockRestore();
    });
  });
});

describe("GoogleAuthService - isAuthenticated", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return false when no access token provided", async () => {
    const result = await googleAuthService.isAuthenticated("");
    expect(result).toBe(false);
  });

  it("should return true when getUserInfo succeeds", async () => {
    jest.spyOn(googleAuthService, "getUserInfo").mockResolvedValue({
      id: "123",
      email: "test@example.com",
      verified_email: true,
      name: "Test User",
    });

    const result = await googleAuthService.isAuthenticated("valid-token");
    expect(result).toBe(true);
  });

  it("should return false when getUserInfo fails", async () => {
    jest
      .spyOn(googleAuthService, "getUserInfo")
      .mockRejectedValue(new Error("Invalid token"));

    const result = await googleAuthService.isAuthenticated("invalid-token");
    expect(result).toBe(false);
  });
});

describe("GoogleAuthService - stopLocalServer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should be callable multiple times without error", () => {
    // Calling stop when no server is running should not throw
    expect(() => {
      googleAuthService.stopLocalServer();
      googleAuthService.stopLocalServer();
    }).not.toThrow();
  });
});

describe("GoogleAuthService - resolveCodeDirectly edge cases", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should not throw when called without active resolver", () => {
    // Make sure server is stopped
    googleAuthService.stopLocalServer();

    // Should not throw even if no resolver is set
    expect(() => {
      googleAuthService.resolveCodeDirectly("test-code");
    }).not.toThrow();
  });
});

describe("GoogleAuthService - rejectCodeDirectly edge cases", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should not throw when called without active rejecter", () => {
    // Make sure server is stopped
    googleAuthService.stopLocalServer();

    // Should not throw even if no rejecter is set
    expect(() => {
      googleAuthService.rejectCodeDirectly("test-error");
    }).not.toThrow();
  });
});
