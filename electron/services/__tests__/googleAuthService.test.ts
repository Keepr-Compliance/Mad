/**
 * Unit tests for Google Auth Service
 * Tests OAuth authentication flows, token refresh, and authentication methods
 *
 * NOTE: Session-only OAuth - tokens stored directly in encrypted database,
 * no separate tokenEncryptionService encryption needed
 *
 * BACKLOG-733: Updated to reflect PKCE migration (no googleapis OAuth2Client)
 */

import axios from "axios";
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


/**
 * BACKLOG-3206 — the revoke call, at the level where the HTTP response exists.
 *
 * These live here rather than in the handler suite for one reason: the handler
 * suite mocks `googleAuthService` wholesale, so a mutation anywhere inside this
 * file changes nothing it can observe and every control would pass with the
 * feature removed. The classification and the timeout are decided from the
 * response, so they are asserted where the response is.
 *
 * FIXTURES ARE TRANSCRIBED, NOT INVENTED. Every error below is built by axios's
 * own `AxiosError` constructor with the argument list axios itself passes,
 * pulled out of the installed copy (axios 1.18.1 in `node_modules`):
 *
 *   - an HTTP error answer: `lib/core/settle.js:19-25` —
 *     `new AxiosError("Request failed with status code " + status,
 *      status >= 400 && status < 500 ? ERR_BAD_REQUEST : ERR_BAD_RESPONSE,
 *      config, request, response)`. The response is attached.
 *
 *   - a timeout: `lib/adapters/http.js:599-613` —
 *     `new AxiosError("timeout of " + timeout + "ms exceeded",
 *      transitional.clarifyTimeoutError ? ETIMEDOUT : ECONNABORTED,
 *      config, req)`, and `clarifyTimeoutError` defaults to false
 *     (`lib/defaults/transitional.js:6`), so the code is ECONNABORTED. NO
 *     response is attached — which is the property the classification reads,
 *     rather than the message text.
 *
 * A hand-written `new Error("timeout")` would have described a state axios
 * cannot produce, and the control built on it would have proved nothing.
 */
const { AxiosError } = jest.requireActual<typeof import("axios")>("axios");

const mockAxios = axios as jest.Mocked<typeof axios>;

/** An answer from the server. Shaped by `lib/core/settle.js`. */
const httpErrorResponse = (status: number, data: unknown) =>
  new AxiosError(
    `Request failed with status code ${status}`,
    status >= 400 && status < 500 ? "ERR_BAD_REQUEST" : "ERR_BAD_RESPONSE",
    {} as never,
    {},
    {
      status,
      statusText: "",
      data,
      headers: {},
      config: {} as never,
    },
  );

/** No answer at all. Shaped by `lib/adapters/http.js` `createTimeoutError`. */
const timeoutError = () =>
  new AxiosError("timeout of 5000ms exceeded", "ECONNABORTED", {} as never, {});

describe("GoogleAuthService - revokeToken (BACKLOG-3206)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // S1
  it("posts the token, form-encoded, to Google's revocation endpoint", async () => {
    mockAxios.post.mockResolvedValue({ status: 200, data: "" });

    const result = await googleAuthService.revokeToken("the-refresh-token");

    expect(mockAxios.post).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      "token=the-refresh-token",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      }),
    );
    expect(result).toEqual({ outcome: "revoked" });
  });

  /**
   * S2 — the bound on how long a Disconnect can hang.
   *
   * STATED LIMIT: this proves the option is PASSED, not that a hang is bounded
   * in wall-clock time. The bound itself is axios's documented contract, and
   * testing a maintained dependency's own contract from inside this repo would
   * need a real socket. The compensating control is at the handler level: when
   * the revoke rejects for any reason, the disconnect still resolves.
   */
  // S2
  it("bounds the request with an explicit timeout", async () => {
    mockAxios.post.mockResolvedValue({ status: 200, data: "" });

    await googleAuthService.revokeToken("the-refresh-token");

    expect(mockAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  // S3 — the grant is already gone, which is the state we were asking for.
  it("classifies 400 invalid_token as already-invalid, not a failure", async () => {
    mockAxios.post.mockRejectedValue(
      httpErrorResponse(400, { error: "invalid_token" }),
    );

    const result = await googleAuthService.revokeToken("dead-token");

    expect(result.outcome).toBe("already-invalid");
    expect(result.status).toBe(400);
  });

  /**
   * S4 — the reason the classification reads the error BODY and not the status.
   *
   * `invalid_request` is also a 400, and it means our request was malformed
   * while the grant is fully alive. Classifying by status alone would tell the
   * user their access had been withdrawn when it had not.
   */
  // S4
  it("classifies 400 invalid_request as failed", async () => {
    mockAxios.post.mockRejectedValue(
      httpErrorResponse(400, { error: "invalid_request" }),
    );

    const result = await googleAuthService.revokeToken("the-refresh-token");

    expect(result.outcome).toBe("failed");
    expect(result.outcome).not.toBe("already-invalid");
    expect(result.reason).toBe("rejected");
  });

  /**
   * S5 — a 429 is a 4xx with a completely live grant.
   *
   * This is here because "a 4xx means the grant is gone" is the plausible
   * shortcut, and under it the user would be told nothing while Keepr's access
   * remained intact.
   */
  // S5
  it("classifies 429 as failed, so the user is told", async () => {
    mockAxios.post.mockRejectedValue(
      httpErrorResponse(429, { error: "rate_limit_exceeded" }),
    );

    const result = await googleAuthService.revokeToken("the-refresh-token");

    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("rejected");
    expect(result.status).toBe(429);
  });

  it("classifies a 5xx as failed", async () => {
    mockAxios.post.mockRejectedValue(httpErrorResponse(503, ""));

    const result = await googleAuthService.revokeToken("the-refresh-token");

    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("rejected");
  });

  // S6 — nothing came back at all.
  it("classifies a timeout as failed for a network reason, and does not throw", async () => {
    mockAxios.post.mockRejectedValue(timeoutError());

    const result = await googleAuthService.revokeToken("the-refresh-token");

    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("network");
    // `network` is what separates "Google refused us" from "we never reached
    // Google", and it keys on the ABSENCE of a response rather than on the
    // message text, which is configurable.
    expect(result.reason).not.toBe("rejected");
  });
});
