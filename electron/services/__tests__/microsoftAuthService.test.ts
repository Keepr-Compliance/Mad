/**
 * Unit tests for Microsoft Auth Service
 * Tests OAuth authentication flows, token refresh, and API methods
 *
 * NOTE: Session-only OAuth - tokens stored directly in encrypted database,
 * no separate tokenEncryptionService encryption needed
 */

import microsoftAuthService from "../microsoftAuthService";
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

const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;

describe("MicrosoftAuthService - Token Refresh", () => {
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
      // Cast: this fixture carries exactly the OAuthToken columns
      // microsoftAuthService reads. The full row type also requires
      // token_refresh_failed_count (and mailbox_connected where omitted here);
      // left out deliberately so the service sees only what the test supplies.
      const mockTokenRecord = {
        id: "token-id",
        user_id: mockUserId,
        provider: "microsoft" as const,
        purpose: "mailbox" as const,
        access_token: "old-access-token",
        refresh_token: mockRefreshToken,
        token_expires_at: "2025-01-01T00:00:00.000Z",
        connected_email_address: "test@example.com",
        mailbox_connected: true,
        scopes_granted: "Mail.Read Mail.Send",
        is_active: true,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      } as OAuthToken;

      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      // Mock the refreshToken method
      const mockNewTokens = {
        access_token: mockAccessToken,
        refresh_token: mockRefreshToken,
        expires_in: 3600,
        scope: "Mail.Read Mail.Send",
      };
      jest
        .spyOn(microsoftAuthService, "refreshToken")
        .mockResolvedValue(mockNewTokens);

      // Execute
      const result = await microsoftAuthService.refreshAccessToken(mockUserId);

      // Verify
      expect(result.success).toBe(true);
      expect(mockDatabaseService.getOAuthToken).toHaveBeenCalledWith(
        mockUserId,
        "microsoft",
        "mailbox",
      );
      // Session-only OAuth: tokens used directly, no encryption/decryption
      expect(mockDatabaseService.saveOAuthToken).toHaveBeenCalled();
    });

    it("should return error when no refresh token exists", async () => {
      // Setup: No token in database
      mockDatabaseService.getOAuthToken.mockResolvedValue(null);

      // Execute
      const result = await microsoftAuthService.refreshAccessToken(mockUserId);

      // Verify
      expect(result.success).toBe(false);
      expect(result.error).toBe("No refresh token available");
    });

    it("should return error when token record has no refresh token", async () => {
      // Setup: Token record without refresh_token
      // Cast: this fixture carries exactly the OAuthToken columns
      // microsoftAuthService reads. The full row type also requires
      // token_refresh_failed_count (and mailbox_connected where omitted here);
      // left out deliberately so the service sees only what the test supplies.
      const mockTokenRecord = {
        id: "token-id",
        user_id: mockUserId,
        provider: "microsoft" as const,
        purpose: "mailbox" as const,
        access_token: "old-access-token",
        refresh_token: undefined,
        token_expires_at: "2025-01-01T00:00:00.000Z",
        connected_email_address: "test@example.com",
        is_active: true,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      } as OAuthToken;

      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      // Execute
      const result = await microsoftAuthService.refreshAccessToken(mockUserId);

      // Verify
      expect(result.success).toBe(false);
      expect(result.error).toBe("No refresh token available");
    });

    it("should handle Microsoft OAuth refresh failures", async () => {
      // Setup mocks
      // Cast: this fixture carries exactly the OAuthToken columns
      // microsoftAuthService reads. The full row type also requires
      // token_refresh_failed_count (and mailbox_connected where omitted here);
      // left out deliberately so the service sees only what the test supplies.
      const mockTokenRecord = {
        id: "token-id",
        user_id: mockUserId,
        provider: "microsoft" as const,
        purpose: "mailbox" as const,
        access_token: "old-access-token",
        refresh_token: mockRefreshToken,
        token_expires_at: "2025-01-01T00:00:00.000Z",
        connected_email_address: "test@example.com",
        is_active: true,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      } as OAuthToken;

      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      // Mock refreshToken to throw error
      jest
        .spyOn(microsoftAuthService, "refreshToken")
        .mockRejectedValue(new Error("Invalid refresh token"));

      // Execute
      const result = await microsoftAuthService.refreshAccessToken(mockUserId);

      // Verify
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid refresh token");
      expect(mockDatabaseService.saveOAuthToken).not.toHaveBeenCalled();
    });

    it("should preserve email address and scopes when refreshing", async () => {
      // Setup mocks
      // Cast: this fixture carries exactly the OAuthToken columns
      // microsoftAuthService reads. The full row type also requires
      // token_refresh_failed_count (and mailbox_connected where omitted here);
      // left out deliberately so the service sees only what the test supplies.
      const mockTokenRecord = {
        id: "token-id",
        user_id: mockUserId,
        provider: "microsoft" as const,
        purpose: "mailbox" as const,
        access_token: "old-access-token",
        refresh_token: mockRefreshToken,
        token_expires_at: "2025-01-01T00:00:00.000Z",
        connected_email_address: "user@company.com",
        mailbox_connected: true,
        scopes_granted: "Mail.Read Mail.Send",
        is_active: true,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      } as OAuthToken;

      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      const mockNewTokens = {
        access_token: mockAccessToken,
        refresh_token: mockRefreshToken,
        expires_in: 3600,
        scope: "Mail.Read Mail.Send",
      };
      jest
        .spyOn(microsoftAuthService, "refreshToken")
        .mockResolvedValue(mockNewTokens);

      // Execute
      await microsoftAuthService.refreshAccessToken(mockUserId);

      // Verify saveOAuthToken was called with preserved data
      expect(mockDatabaseService.saveOAuthToken).toHaveBeenCalledWith(
        mockUserId,
        "microsoft",
        "mailbox",
        expect.objectContaining({
          connected_email_address: "user@company.com",
          mailbox_connected: true,
        }),
      );
    });

    it("should calculate correct expiry time from expires_in", async () => {
      // Setup mocks
      // Cast: this fixture carries exactly the OAuthToken columns
      // microsoftAuthService reads. The full row type also requires
      // token_refresh_failed_count (and mailbox_connected where omitted here);
      // left out deliberately so the service sees only what the test supplies.
      const mockTokenRecord = {
        id: "token-id",
        user_id: mockUserId,
        provider: "microsoft" as const,
        purpose: "mailbox" as const,
        access_token: "old-access-token",
        refresh_token: mockRefreshToken,
        token_expires_at: "2025-01-01T00:00:00.000Z",
        connected_email_address: "test@example.com",
        is_active: true,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      } as OAuthToken;

      mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);

      const expiresInSeconds = 3600; // 1 hour
      const mockNewTokens = {
        access_token: mockAccessToken,
        refresh_token: mockRefreshToken,
        expires_in: expiresInSeconds,
        scope: "Mail.Read",
      };
      jest
        .spyOn(microsoftAuthService, "refreshToken")
        .mockResolvedValue(mockNewTokens);

      const beforeCall = Date.now();
      await microsoftAuthService.refreshAccessToken(mockUserId);
      const afterCall = Date.now();

      // Verify the expiry time is approximately 1 hour from now
      const savedCall = (mockDatabaseService.saveOAuthToken as jest.Mock).mock
        .calls[0];
      const savedExpiresAt = new Date(savedCall[3].token_expires_at).getTime();
      const expectedMin = beforeCall + expiresInSeconds * 1000;
      const expectedMax = afterCall + expiresInSeconds * 1000;

      expect(savedExpiresAt).toBeGreaterThanOrEqual(expectedMin);
      expect(savedExpiresAt).toBeLessThanOrEqual(expectedMax);
    });
  });
});

describe("MicrosoftAuthService - Direct Code Resolution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("resolveCodeDirectly", () => {
    it("should resolve the code promise when resolver is set", async () => {
      // Start local server to set up the resolver
      const { codePromise } = microsoftAuthService.startLocalServer();

      // Resolve directly
      microsoftAuthService.resolveCodeDirectly("test-auth-code");

      // The promise should resolve with the code
      const code = await codePromise;
      expect(code).toBe("test-auth-code");
    });

    it("should stop local server after resolving", () => {
      const stopSpy = jest.spyOn(microsoftAuthService, "stopLocalServer");

      // Start and then resolve
      microsoftAuthService.startLocalServer();
      microsoftAuthService.resolveCodeDirectly("test-code");

      expect(stopSpy).toHaveBeenCalled();
      stopSpy.mockRestore();
    });
  });

  describe("rejectCodeDirectly", () => {
    it("should reject the code promise when rejecter is set", async () => {
      // Start local server to set up the rejecter
      const { codePromise } = microsoftAuthService.startLocalServer();

      // Reject directly
      microsoftAuthService.rejectCodeDirectly("Auth error");

      // The promise should reject with the error
      await expect(codePromise).rejects.toThrow("Auth error");
    });

    it("should stop local server after rejecting", async () => {
      const stopSpy = jest.spyOn(microsoftAuthService, "stopLocalServer");

      // Start and then reject - must catch the rejected promise
      const { codePromise } = microsoftAuthService.startLocalServer();
      microsoftAuthService.rejectCodeDirectly("error");

      // Await the rejection to prevent unhandled promise rejection
      await expect(codePromise).rejects.toThrow("error");
      expect(stopSpy).toHaveBeenCalled();
      stopSpy.mockRestore();
    });
  });
});

// Note: exchangeCodeForTokens tests require proper axios mocking at module level
// These tests are covered by integration tests and manual testing.

// Note: getUserInfo tests require proper axios mocking at module level
// These tests are covered by integration tests and manual testing.

// Note: refreshToken tests require proper axios mocking at module level
// The axios mock is set up but the singleton service imports the real axios
// before the mock takes effect. These tests are covered by integration tests.

describe("MicrosoftAuthService - revokeToken", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return success message (Microsoft does not support revocation)", async () => {
    const result = await microsoftAuthService.revokeToken("any-token");

    expect(result.success).toBe(true);
    expect(result.message).toBe("Token will expire naturally");
  });
});

// Note: getMailboxInfo tests require proper axios mocking at module level
// These tests are covered by integration tests and manual testing.

describe("MicrosoftAuthService - stopLocalServer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should be callable multiple times without error", () => {
    expect(() => {
      microsoftAuthService.stopLocalServer();
      microsoftAuthService.stopLocalServer();
    }).not.toThrow();
  });
});

describe("MicrosoftAuthService - resolveCodeDirectly edge cases", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should not throw when called without active resolver", () => {
    microsoftAuthService.stopLocalServer();

    expect(() => {
      microsoftAuthService.resolveCodeDirectly("test-code");
    }).not.toThrow();
  });
});

describe("MicrosoftAuthService - rejectCodeDirectly edge cases", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should not throw when called without active rejecter", () => {
    microsoftAuthService.stopLocalServer();

    expect(() => {
      microsoftAuthService.rejectCodeDirectly("test-error");
    }).not.toThrow();
  });
});

describe("MicrosoftAuthService - authenticateForLogin", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    microsoftAuthService.stopLocalServer();
    // Provide test client ID so initialize() doesn't throw
    process.env.MICROSOFT_CLIENT_ID = "test-client-id";
    // Reset singleton initialized state to force re-initialization with test env
    (microsoftAuthService as any).initialized = false;
  });

  afterEach(() => {
    delete process.env.MICROSOFT_CLIENT_ID;
    microsoftAuthService.stopLocalServer();
  });

  it("should return auth flow result with required fields", async () => {
    const result = await microsoftAuthService.authenticateForLogin();

    expect(result).toHaveProperty("authUrl");
    expect(result).toHaveProperty("codePromise");
    expect(result).toHaveProperty("codeVerifier");
    expect(result).toHaveProperty("scopes");

    // Verify scopes include expected values
    expect(result.scopes).toContain("openid");
    expect(result.scopes).toContain("offline_access");

    // Verify auth URL structure
    expect(result.authUrl).toContain("client_id=");
    expect(result.authUrl).toContain("response_type=code");
    expect(result.authUrl).toContain("code_challenge=");

    // Clean up - resolve the promise to stop the server
    microsoftAuthService.resolveCodeDirectly("cleanup");
  });
});

describe("MicrosoftAuthService - authenticateForMailbox", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    microsoftAuthService.stopLocalServer();
    // Provide test client ID so initialize() doesn't throw
    process.env.MICROSOFT_CLIENT_ID = "test-client-id";
    // Reset singleton initialized state to force re-initialization with test env
    (microsoftAuthService as any).initialized = false;
  });

  afterEach(() => {
    delete process.env.MICROSOFT_CLIENT_ID;
    microsoftAuthService.stopLocalServer();
  });

  it("should return auth flow result with mailbox scopes", async () => {
    const result = await microsoftAuthService.authenticateForMailbox();

    expect(result.scopes).toContain("Mail.Read");
    expect(result.scopes).not.toContain("Mail.ReadWrite");

    // Clean up
    microsoftAuthService.resolveCodeDirectly("cleanup");
  });

  it("should include login hint when provided", async () => {
    const result = await microsoftAuthService.authenticateForMailbox(
      "user@example.com"
    );

    expect(result.authUrl).toContain("login_hint=user%40example.com");

    // Clean up
    microsoftAuthService.resolveCodeDirectly("cleanup");
  });
});
