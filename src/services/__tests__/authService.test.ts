/**
 * AuthService Tests
 *
 * TASK-1017: Comprehensive unit tests for authService.ts
 *
 * Mock Pattern for Service Layer Tests:
 * =====================================
 * 1. Mock window.api at module level using Object.defineProperty
 * 2. Create individual mock functions for each API method
 * 3. Reset all mocks in beforeEach with jest.clearAllMocks()
 * 4. Configure mock return values per test case
 * 5. Test both success and error paths for each method
 *
 * This pattern should be reused for:
 * - transactionService.test.ts (TASK-1018)
 * - systemService.test.ts (TASK-1019)
 * - deviceService.test.ts (TASK-1020)
 *
 * Key Testing Strategies:
 * - Each authService method wraps window.api.auth calls with try/catch
 * - Success cases: mock returns { success: true, ...data }
 * - Failure cases: mock returns { success: false, error: "message" }
 * - Exception cases: mock throws an Error
 */

import { authService } from "../authService";
import type { User, Subscription } from "@/types";

// ============================================
// MOCK SETUP
// ============================================

// Mock functions for window.api.auth methods
const mockGoogleLogin = jest.fn();
const mockGoogleCompleteLogin = jest.fn();
const mockMicrosoftLogin = jest.fn();
const mockMicrosoftCompleteLogin = jest.fn();
const mockCompletePendingLogin = jest.fn();
const mockLogout = jest.fn();
const mockValidateSession = jest.fn();
const mockGetCurrentUser = jest.fn();
const mockAcceptTerms = jest.fn();
const mockGoogleConnectMailbox = jest.fn();
const mockMicrosoftConnectMailbox = jest.fn();
const mockGoogleDisconnectMailbox = jest.fn();
const mockMicrosoftDisconnectMailbox = jest.fn();
const mockGoogleConnectMailboxPending = jest.fn();
const mockMicrosoftConnectMailboxPending = jest.fn();
const mockSavePendingMailboxTokens = jest.fn();

// Setup window.api mock before tests
beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      auth: {
        googleLogin: mockGoogleLogin,
        googleCompleteLogin: mockGoogleCompleteLogin,
        microsoftLogin: mockMicrosoftLogin,
        microsoftCompleteLogin: mockMicrosoftCompleteLogin,
        completePendingLogin: mockCompletePendingLogin,
        logout: mockLogout,
        validateSession: mockValidateSession,
        getCurrentUser: mockGetCurrentUser,
        acceptTerms: mockAcceptTerms,
        googleConnectMailbox: mockGoogleConnectMailbox,
        microsoftConnectMailbox: mockMicrosoftConnectMailbox,
        googleDisconnectMailbox: mockGoogleDisconnectMailbox,
        microsoftDisconnectMailbox: mockMicrosoftDisconnectMailbox,
        googleConnectMailboxPending: mockGoogleConnectMailboxPending,
        microsoftConnectMailboxPending: mockMicrosoftConnectMailboxPending,
        savePendingMailboxTokens: mockSavePendingMailboxTokens,
      },
    },
    writable: true,
    configurable: true,
  });
});

// Reset all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================
// TEST FIXTURES
// ============================================

// These fixtures are opaque round-trip payloads: they go into the IPC mock and
// come straight back out via toEqual, so no assertion depends on their shape.
// They are modelled on a camelCase API that does not match the snake_case
// `User` row type, nor the computed `Subscription` shape (tier/isActive/...),
// hence the double assertions rather than annotations.
const mockUser = {
  id: "user-123",
  email: "test@example.com",
  name: "Test User",
  avatarUrl: "https://example.com/avatar.png",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  termsAcceptedAt: "2024-01-01T00:00:00Z",
} as unknown as User;

const mockSubscription = {
  id: "sub-123",
  userId: "user-123",
  plan: "pro",
  status: "active",
  currentPeriodStart: "2024-01-01T00:00:00Z",
  currentPeriodEnd: "2024-12-31T23:59:59Z",
} as unknown as Subscription;

const mockSessionToken = "session-token-abc123";

// ============================================
// LOGIN METHODS TESTS
// ============================================

describe("authService", () => {
  describe("googleLogin", () => {
    it("should return success with authUrl when login succeeds", async () => {
      const authUrl = "https://accounts.google.com/oauth/authorize?...";
      mockGoogleLogin.mockResolvedValue({ success: true, authUrl });

      const result = await authService.googleLogin();

      expect(result.success).toBe(true);
      expect(result.data?.authUrl).toBe(authUrl);
      expect(mockGoogleLogin).toHaveBeenCalledTimes(1);
    });

    it("should return error when API returns failure", async () => {
      mockGoogleLogin.mockResolvedValue({ success: false, error: "OAuth failed" });

      const result = await authService.googleLogin();

      expect(result.success).toBe(false);
      expect(result.error).toBe("OAuth failed");
    });

    it("should catch and return error when API throws exception", async () => {
      mockGoogleLogin.mockRejectedValue(new Error("Network error"));

      const result = await authService.googleLogin();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
    });
  });

  describe("googleCompleteLogin", () => {
    it("should return LoginResult on successful completion", async () => {
      mockGoogleCompleteLogin.mockResolvedValue({
        success: true,
        user: mockUser,
        sessionToken: mockSessionToken,
        subscription: mockSubscription,
        isNewUser: false,
      });

      const result = await authService.googleCompleteLogin("auth-code-123");

      expect(result.success).toBe(true);
      expect(result.data?.user).toEqual(mockUser);
      expect(result.data?.sessionToken).toBe(mockSessionToken);
      expect(result.data?.subscription).toEqual(mockSubscription);
      expect(result.data?.isNewUser).toBe(false);
      expect(mockGoogleCompleteLogin).toHaveBeenCalledWith("auth-code-123");
    });

    it("should return error when API returns failure", async () => {
      mockGoogleCompleteLogin.mockResolvedValue({ success: false, error: "Invalid code" });

      const result = await authService.googleCompleteLogin("invalid-code");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid code");
    });

    it("should return 'Login failed' when success but missing user/sessionToken", async () => {
      mockGoogleCompleteLogin.mockResolvedValue({ success: true }); // Missing user/sessionToken

      const result = await authService.googleCompleteLogin("code");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Login failed");
    });

    it("should catch and return error when API throws exception", async () => {
      mockGoogleCompleteLogin.mockRejectedValue(new Error("Token exchange failed"));

      const result = await authService.googleCompleteLogin("code");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Token exchange failed");
    });
  });

  describe("microsoftLogin", () => {
    it("should return success with authUrl when login succeeds", async () => {
      const authUrl = "https://login.microsoftonline.com/oauth/authorize?...";
      mockMicrosoftLogin.mockResolvedValue({ success: true, authUrl });

      const result = await authService.microsoftLogin();

      expect(result.success).toBe(true);
      expect(result.data?.authUrl).toBe(authUrl);
      expect(mockMicrosoftLogin).toHaveBeenCalledTimes(1);
    });

    it("should return error when API returns failure", async () => {
      mockMicrosoftLogin.mockResolvedValue({ success: false, error: "Azure AD error" });

      const result = await authService.microsoftLogin();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Azure AD error");
    });

    it("should catch and return error when API throws exception", async () => {
      mockMicrosoftLogin.mockRejectedValue(new Error("Connection timeout"));

      const result = await authService.microsoftLogin();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Connection timeout");
    });
  });

  describe("microsoftCompleteLogin", () => {
    it("should return LoginResult on successful completion", async () => {
      mockMicrosoftCompleteLogin.mockResolvedValue({
        success: true,
        user: mockUser,
        sessionToken: mockSessionToken,
        subscription: mockSubscription,
        isNewUser: true,
      });

      const result = await authService.microsoftCompleteLogin("ms-auth-code");

      expect(result.success).toBe(true);
      expect(result.data?.user).toEqual(mockUser);
      expect(result.data?.sessionToken).toBe(mockSessionToken);
      expect(result.data?.isNewUser).toBe(true);
      expect(mockMicrosoftCompleteLogin).toHaveBeenCalledWith("ms-auth-code");
    });

    it("should return error when API returns failure", async () => {
      mockMicrosoftCompleteLogin.mockResolvedValue({ success: false, error: "Token expired" });

      const result = await authService.microsoftCompleteLogin("expired-code");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Token expired");
    });

    it("should return 'Login failed' when success but missing required fields", async () => {
      mockMicrosoftCompleteLogin.mockResolvedValue({ success: true, user: mockUser }); // Missing sessionToken

      const result = await authService.microsoftCompleteLogin("code");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Login failed");
    });

    it("should catch and return error when API throws exception", async () => {
      mockMicrosoftCompleteLogin.mockRejectedValue(new Error("Graph API error"));

      const result = await authService.microsoftCompleteLogin("code");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Graph API error");
    });
  });

  describe("completePendingLogin", () => {
    const mockOAuthData = { provider: "google", tokens: { access_token: "abc" } };

    it("should complete pending login successfully", async () => {
      mockCompletePendingLogin.mockResolvedValue({
        success: true,
        user: mockUser,
        sessionToken: mockSessionToken,
        subscription: mockSubscription,
        isNewUser: true,
      });

      const result = await authService.completePendingLogin(mockOAuthData);

      expect(result.success).toBe(true);
      expect(result.data?.user).toEqual(mockUser);
      expect(result.data?.sessionToken).toBe(mockSessionToken);
      expect(mockCompletePendingLogin).toHaveBeenCalledWith(mockOAuthData);
    });

    it("should return error when API returns failure", async () => {
      mockCompletePendingLogin.mockResolvedValue({ success: false, error: "Keychain setup failed" });

      const result = await authService.completePendingLogin(mockOAuthData);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Keychain setup failed");
    });

    it("should return 'Login failed' when success but missing required fields", async () => {
      mockCompletePendingLogin.mockResolvedValue({ success: true }); // Missing user/sessionToken

      const result = await authService.completePendingLogin(mockOAuthData);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Login failed");
    });

    it("should catch and return error when API throws exception", async () => {
      mockCompletePendingLogin.mockRejectedValue(new Error("Database error"));

      const result = await authService.completePendingLogin(mockOAuthData);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Database error");
    });
  });

  // ============================================
  // SESSION METHODS TESTS
  // ============================================

  describe("logout", () => {
    it("should logout successfully", async () => {
      mockLogout.mockResolvedValue({ success: true });

      const result = await authService.logout(mockSessionToken);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockLogout).toHaveBeenCalledWith(mockSessionToken);
    });

    it("should return error when API returns failure", async () => {
      mockLogout.mockResolvedValue({ success: false, error: "Session not found" });

      const result = await authService.logout("invalid-token");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Session not found");
    });

    it("should catch and return error when API throws exception", async () => {
      mockLogout.mockRejectedValue(new Error("Logout service unavailable"));

      const result = await authService.logout(mockSessionToken);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Logout service unavailable");
    });
  });

  describe("validateSession", () => {
    it("should return valid session with user", async () => {
      mockValidateSession.mockResolvedValue({ valid: true, user: mockUser });

      const result = await authService.validateSession(mockSessionToken);

      expect(result.success).toBe(true);
      expect(result.data?.valid).toBe(true);
      expect(result.data?.user).toEqual(mockUser);
      expect(mockValidateSession).toHaveBeenCalledWith(mockSessionToken);
    });

    it("should return invalid session", async () => {
      mockValidateSession.mockResolvedValue({ valid: false });

      const result = await authService.validateSession("expired-token");

      expect(result.success).toBe(true);
      expect(result.data?.valid).toBe(false);
      expect(result.data?.user).toBeUndefined();
    });

    it("should catch and return error when API throws exception", async () => {
      mockValidateSession.mockRejectedValue(new Error("Validation service error"));

      const result = await authService.validateSession(mockSessionToken);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Validation service error");
    });
  });

  describe("getCurrentUser", () => {
    it("should return current user successfully", async () => {
      mockGetCurrentUser.mockResolvedValue({
        success: true,
        user: mockUser,
        sessionToken: mockSessionToken,
        subscription: mockSubscription,
        provider: "google",
        isNewUser: false,
      });

      const result = await authService.getCurrentUser();

      expect(result.success).toBe(true);
      expect(result.data?.user).toEqual(mockUser);
      expect(result.data?.sessionToken).toBe(mockSessionToken);
      expect(result.data?.subscription).toEqual(mockSubscription);
      expect(result.data?.provider).toBe("google");
      expect(result.data?.isNewUser).toBe(false);
      expect(mockGetCurrentUser).toHaveBeenCalledTimes(1);
    });

    it("should return error when no user is logged in", async () => {
      mockGetCurrentUser.mockResolvedValue({ success: false, error: "Not authenticated" });

      const result = await authService.getCurrentUser();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Not authenticated");
    });

    it("should return error when success but missing user/sessionToken", async () => {
      mockGetCurrentUser.mockResolvedValue({ success: true }); // Missing required fields

      const result = await authService.getCurrentUser();

      expect(result.success).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it("should catch and return error when API throws exception", async () => {
      mockGetCurrentUser.mockRejectedValue(new Error("Session expired"));

      const result = await authService.getCurrentUser();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Session expired");
    });
  });

  describe("acceptTerms", () => {
    it("should accept terms successfully", async () => {
      mockAcceptTerms.mockResolvedValue({ success: true });

      const result = await authService.acceptTerms("user-123");

      expect(result.success).toBe(true);
      expect(mockAcceptTerms).toHaveBeenCalledWith("user-123");
    });

    it("should return error when API returns failure", async () => {
      mockAcceptTerms.mockResolvedValue({ success: false, error: "User not found" });

      const result = await authService.acceptTerms("invalid-user");

      expect(result.success).toBe(false);
      expect(result.error).toBe("User not found");
    });

    it("should catch and return error when API throws exception", async () => {
      mockAcceptTerms.mockRejectedValue(new Error("Database write error"));

      const result = await authService.acceptTerms("user-123");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Database write error");
    });
  });

  // ============================================
  // MAILBOX CONNECTION METHODS TESTS
  // ============================================

  describe("googleConnectMailbox", () => {
    it("should connect Google mailbox successfully", async () => {
      mockGoogleConnectMailbox.mockResolvedValue({ success: true });

      const result = await authService.googleConnectMailbox("user-123");

      expect(result.success).toBe(true);
      expect(mockGoogleConnectMailbox).toHaveBeenCalledWith("user-123");
    });

    it("should return error when API returns failure", async () => {
      mockGoogleConnectMailbox.mockResolvedValue({ success: false, error: "Gmail API error" });

      const result = await authService.googleConnectMailbox("user-123");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Gmail API error");
    });

    it("should catch and return error when API throws exception", async () => {
      mockGoogleConnectMailbox.mockRejectedValue(new Error("OAuth scope denied"));

      const result = await authService.googleConnectMailbox("user-123");

      expect(result.success).toBe(false);
      expect(result.error).toBe("OAuth scope denied");
    });
  });

  describe("microsoftConnectMailbox", () => {
    it("should connect Microsoft mailbox successfully", async () => {
      mockMicrosoftConnectMailbox.mockResolvedValue({ success: true });

      const result = await authService.microsoftConnectMailbox("user-123");

      expect(result.success).toBe(true);
      expect(mockMicrosoftConnectMailbox).toHaveBeenCalledWith("user-123");
    });

    it("should return error when API returns failure", async () => {
      mockMicrosoftConnectMailbox.mockResolvedValue({ success: false, error: "Graph API error" });

      const result = await authService.microsoftConnectMailbox("user-123");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Graph API error");
    });

    it("should catch and return error when API throws exception", async () => {
      mockMicrosoftConnectMailbox.mockRejectedValue(new Error("Tenant not allowed"));

      const result = await authService.microsoftConnectMailbox("user-123");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Tenant not allowed");
    });
  });

  describe("googleDisconnectMailbox", () => {
    it("should disconnect Google mailbox successfully", async () => {
      mockGoogleDisconnectMailbox.mockResolvedValue({ success: true });

      const result = await authService.googleDisconnectMailbox("user-123");

      expect(result.success).toBe(true);
      expect(mockGoogleDisconnectMailbox).toHaveBeenCalledWith("user-123");
    });

    it("should return error when API returns failure", async () => {
      mockGoogleDisconnectMailbox.mockResolvedValue({ success: false, error: "Mailbox not found" });

      const result = await authService.googleDisconnectMailbox("user-123");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Mailbox not found");
    });

    it("should catch and return error when API throws exception", async () => {
      mockGoogleDisconnectMailbox.mockRejectedValue(new Error("Token revocation failed"));

      const result = await authService.googleDisconnectMailbox("user-123");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Token revocation failed");
    });
  });

  describe("microsoftDisconnectMailbox", () => {
    it("should disconnect Microsoft mailbox successfully", async () => {
      mockMicrosoftDisconnectMailbox.mockResolvedValue({ success: true });

      const result = await authService.microsoftDisconnectMailbox("user-123");

      expect(result.success).toBe(true);
      expect(mockMicrosoftDisconnectMailbox).toHaveBeenCalledWith("user-123");
    });

    it("should return error when API returns failure", async () => {
      mockMicrosoftDisconnectMailbox.mockResolvedValue({ success: false, error: "Mailbox not connected" });

      const result = await authService.microsoftDisconnectMailbox("user-123");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Mailbox not connected");
    });

    it("should catch and return error when API throws exception", async () => {
      mockMicrosoftDisconnectMailbox.mockRejectedValue(new Error("Azure AD revoke error"));

      const result = await authService.microsoftDisconnectMailbox("user-123");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Azure AD revoke error");
    });
  });

  // ============================================
  // PENDING MAILBOX METHODS TESTS
  // ============================================

  describe("googleConnectMailboxPending", () => {
    it("should connect pending Google mailbox successfully", async () => {
      mockGoogleConnectMailboxPending.mockResolvedValue({ success: true });

      const result = await authService.googleConnectMailboxPending("user@gmail.com");

      expect(result.success).toBe(true);
      expect(mockGoogleConnectMailboxPending).toHaveBeenCalledWith("user@gmail.com");
    });

    it("should work without email hint", async () => {
      mockGoogleConnectMailboxPending.mockResolvedValue({ success: true });

      const result = await authService.googleConnectMailboxPending();

      expect(result.success).toBe(true);
      expect(mockGoogleConnectMailboxPending).toHaveBeenCalledWith(undefined);
    });

    it("should return error when API returns failure", async () => {
      mockGoogleConnectMailboxPending.mockResolvedValue({ success: false, error: "Pre-auth failed" });

      const result = await authService.googleConnectMailboxPending();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Pre-auth failed");
    });

    it("should catch and return error when API throws exception", async () => {
      mockGoogleConnectMailboxPending.mockRejectedValue(new Error("OAuth popup blocked"));

      const result = await authService.googleConnectMailboxPending();

      expect(result.success).toBe(false);
      expect(result.error).toBe("OAuth popup blocked");
    });
  });

  describe("microsoftConnectMailboxPending", () => {
    it("should connect pending Microsoft mailbox successfully", async () => {
      mockMicrosoftConnectMailboxPending.mockResolvedValue({ success: true });

      const result = await authService.microsoftConnectMailboxPending("user@outlook.com");

      expect(result.success).toBe(true);
      expect(mockMicrosoftConnectMailboxPending).toHaveBeenCalledWith("user@outlook.com");
    });

    it("should work without email hint", async () => {
      mockMicrosoftConnectMailboxPending.mockResolvedValue({ success: true });

      const result = await authService.microsoftConnectMailboxPending();

      expect(result.success).toBe(true);
      expect(mockMicrosoftConnectMailboxPending).toHaveBeenCalledWith(undefined);
    });

    it("should return error when API returns failure", async () => {
      mockMicrosoftConnectMailboxPending.mockResolvedValue({ success: false, error: "Tenant blocked" });

      const result = await authService.microsoftConnectMailboxPending();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Tenant blocked");
    });

    it("should catch and return error when API throws exception", async () => {
      mockMicrosoftConnectMailboxPending.mockRejectedValue(new Error("MSAL initialization failed"));

      const result = await authService.microsoftConnectMailboxPending();

      expect(result.success).toBe(false);
      expect(result.error).toBe("MSAL initialization failed");
    });
  });

  describe("savePendingMailboxTokens", () => {
    const mockTokenData = {
      userId: "user-123",
      provider: "google" as const,
      email: "user@gmail.com",
      tokens: {
        access_token: "access-token-xyz",
        refresh_token: "refresh-token-xyz",
        expires_at: "2024-12-31T23:59:59Z",
        scopes: "email profile",
      },
    };

    it("should save pending mailbox tokens successfully", async () => {
      mockSavePendingMailboxTokens.mockResolvedValue({ success: true });

      const result = await authService.savePendingMailboxTokens(mockTokenData);

      expect(result.success).toBe(true);
      expect(mockSavePendingMailboxTokens).toHaveBeenCalledWith(mockTokenData);
    });

    it("should handle Microsoft provider", async () => {
      const msTokenData = { ...mockTokenData, provider: "microsoft" as const };
      mockSavePendingMailboxTokens.mockResolvedValue({ success: true });

      const result = await authService.savePendingMailboxTokens(msTokenData);

      expect(result.success).toBe(true);
      expect(mockSavePendingMailboxTokens).toHaveBeenCalledWith(msTokenData);
    });

    it("should handle null refresh token", async () => {
      const tokenDataNoRefresh = {
        ...mockTokenData,
        tokens: { ...mockTokenData.tokens, refresh_token: null },
      };
      mockSavePendingMailboxTokens.mockResolvedValue({ success: true });

      const result = await authService.savePendingMailboxTokens(tokenDataNoRefresh);

      expect(result.success).toBe(true);
    });

    it("should return error when API returns failure", async () => {
      mockSavePendingMailboxTokens.mockResolvedValue({ success: false, error: "Token storage failed" });

      const result = await authService.savePendingMailboxTokens(mockTokenData);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Token storage failed");
    });

    it("should catch and return error when API throws exception", async () => {
      mockSavePendingMailboxTokens.mockRejectedValue(new Error("Keychain access denied"));

      const result = await authService.savePendingMailboxTokens(mockTokenData);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Keychain access denied");
    });
  });
});
