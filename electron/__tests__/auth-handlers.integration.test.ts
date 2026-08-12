/**
 * Integration tests for Auth Handlers
 * Tests complete OAuth flows including:
 * - Full login flow with token exchange
 * - Session lifecycle (create, validate, expire, cleanup)
 * - Multi-step mailbox connection flows
 * - Error handling and recovery
 */

import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
  type RegisteredIpcHandler,
} from "../../tests/support/ipcHandlerRegistry";
import type { IpcMainInvokeEvent } from "electron";

// Store original setTimeout for async operations (prefixed with _ to indicate intentionally unused)
const _originalSetTimeout = global.setTimeout;

// Mock electron module
const mockIpcHandle = jest.fn();
const mockShellOpenExternal = jest.fn();
const mockWebContentsSend = jest.fn();

jest.mock("electron", () => ({
  ipcMain: {
    handle: mockIpcHandle,
  },
  app: {
    getVersion: jest.fn().mockReturnValue("1.0.0"),
  },
  shell: {
    openExternal: mockShellOpenExternal,
  },
  BrowserWindow: jest.fn().mockImplementation(() => ({
    loadURL: jest.fn(),
    close: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
    on: jest.fn(),
    isDestroyed: jest.fn().mockReturnValue(false),
    webContents: {
      on: jest.fn(),
      send: mockWebContentsSend,
      session: {
        webRequest: {
          onHeadersReceived: jest.fn(),
        },
      },
    },
  })),
}));

// Mock crypto
jest.mock("crypto", () => ({
  randomUUID: jest.fn().mockReturnValue("test-device-uuid"),
}));

// Mock os
jest.mock("os", () => ({
  hostname: jest.fn().mockReturnValue("test-host"),
  platform: jest.fn().mockReturnValue("darwin"),
  release: jest.fn().mockReturnValue("21.0.0"),
}));

// Mock all services
const mockDatabaseService = {
  initialize: jest.fn().mockResolvedValue(undefined),
  isInitialized: jest.fn().mockReturnValue(true),
  getUserByOAuthId: jest.fn(),
  getUserByEmail: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  updateLastLogin: jest.fn(),
  getUserById: jest.fn(),
  saveOAuthToken: jest.fn(),
  createSession: jest.fn(),
  validateSession: jest.fn(),
  deleteSession: jest.fn(),
  acceptTerms: jest.fn(),
  completeEmailOnboarding: jest.fn(),
  hasCompletedEmailOnboarding: jest.fn(),
  getOAuthToken: jest.fn(),
  clearAllSessions: jest.fn(),
  getRawDatabase: jest.fn(),
};

const mockGoogleAuthService = {
  authenticateForLogin: jest.fn(),
  authenticateForMailbox: jest.fn(),
  exchangeCodeForTokens: jest.fn(),
  getUserInfo: jest.fn(),
  stopLocalServer: jest.fn(),
};

const mockMicrosoftAuthService = {
  authenticateForLogin: jest.fn(),
  authenticateForMailbox: jest.fn(),
  exchangeCodeForTokens: jest.fn(),
  getUserInfo: jest.fn(),
  stopLocalServer: jest.fn(),
};

const mockSupabaseService = {
  syncUser: jest.fn(),
  validateSubscription: jest.fn(),
  registerDevice: jest.fn(),
  trackEvent: jest.fn(),
  syncTermsAcceptance: jest.fn(),
  completeEmailOnboarding: jest.fn(),
  // TASK-1507G: Add getAuthUserId for unified ID handling
  getAuthUserId: jest.fn().mockReturnValue(null),
  // TASK-1809: getUserById used by fetchCloudUserWithRetry for terms sync
  getUserById: jest.fn().mockResolvedValue(null),
  // TASK-2085: getClient used for setSession/getUser server-side validation
  getClient: jest.fn().mockReturnValue({
    auth: {
      setSession: jest.fn().mockResolvedValue({ error: null }),
      getUser: jest.fn().mockResolvedValue({ data: { user: { id: "test-user" } }, error: null }),
    },
  }),
  signOut: jest.fn(),
  signOutGlobal: jest.fn(),
};

// Session-only OAuth: tokens stored directly in encrypted database, no separate tokenEncryptionService

const mockSessionService = {
  saveSession: jest.fn().mockResolvedValue(undefined),
  loadSession: jest.fn(),
  clearSession: jest.fn().mockResolvedValue(undefined),
  updateSession: jest.fn().mockResolvedValue(undefined),
  getSessionExpirationMs: jest.fn().mockReturnValue(86400000),
};

const mockRateLimitService = {
  recordAttempt: jest.fn().mockResolvedValue(undefined),
  isRateLimited: jest.fn().mockReturnValue(false),
};

const mockSessionSecurityService = {
  checkSessionValidity: jest.fn().mockResolvedValue({ valid: true }),
  recordActivity: jest.fn(),
  cleanupSession: jest.fn(),
};

const mockAuditService = {
  initialize: jest.fn(),
  log: jest.fn().mockResolvedValue(undefined),
};

const mockLogService = {
  debug: jest.fn().mockResolvedValue(undefined),
  info: jest.fn().mockResolvedValue(undefined),
  error: jest.fn().mockResolvedValue(undefined),
  warn: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: mockDatabaseService,
}));

jest.mock("../services/googleAuthService", () => ({
  __esModule: true,
  default: mockGoogleAuthService,
}));

jest.mock("../services/microsoftAuthService", () => ({
  __esModule: true,
  default: mockMicrosoftAuthService,
}));

jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: mockSupabaseService,
}));

jest.mock("../services/sessionService", () => ({
  __esModule: true,
  default: mockSessionService,
}));

jest.mock("../services/rateLimitService", () => ({
  __esModule: true,
  default: mockRateLimitService,
}));

jest.mock("../services/sessionSecurityService", () => ({
  __esModule: true,
  default: mockSessionSecurityService,
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: mockAuditService,
}));

jest.mock("../services/logService", () => ({
  __esModule: true,
  default: mockLogService,
}));

// Mock sync-handlers for setSyncUserId
jest.mock("../handlers/syncHandlers", () => ({
  setSyncUserId: jest.fn(),
}));

// Mock failureLogService
jest.mock("../services/failureLogService", () => ({
  __esModule: true,
  default: {
    logFailure: jest.fn(),
  },
}));

// Mock @sentry/electron/main
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
}));

// Mock deviceService
jest.mock("../services/deviceService", () => ({
  getDeviceId: jest.fn().mockReturnValue("test-device-id"),
  registerDevice: jest.fn().mockResolvedValue({ success: true }),
}));

// NOTE: We do NOT mock the handler modules (googleAuthHandlers, microsoftAuthHandlers, etc.)
// because the integration tests need to exercise the real handler registration functions.
// The individual handlers use services (databaseService, googleAuthService, etc.) which
// ARE mocked above, so the handlers will work with mocked dependencies.

// Import after mocks
import { registerAuthHandlers } from "../handlers/authHandlers";

// Test constants
const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_SESSION_TOKEN = "test-session-token-" + Date.now();
const TEST_AUTH_CODE = "valid-authorization-code-12345";

describe("Auth Handlers Integration Tests", () => {
  let registeredHandlers: IpcHandlerRegistry;
  const mockEvent = {} as IpcMainInvokeEvent;
  const mockMainWindow = {
    webContents: {
      send: mockWebContentsSend,
    },
  };

  beforeAll(() => {
    // Capture registered handlers
    registeredHandlers = createIpcHandlerRegistry();
    mockIpcHandle.mockImplementation((channel: string, handler: RegisteredIpcHandler) => {
      registeredHandlers.set(channel, handler);
    });

    // Register all handlers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAuthHandlers(mockMainWindow as any);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Complete Google OAuth Login Flow", () => {
    const mockTokens = {
      access_token: "google-access-token",
      refresh_token: "google-refresh-token",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      scopes: ["email", "profile"],
    };

    const mockUserInfo = {
      id: "google-user-123",
      email: "newuser@gmail.com",
      given_name: "New",
      family_name: "User",
      name: "New User",
      picture: "https://example.com/avatar.png",
    };

    const mockCloudUser = {
      id: "cloud-user-123",
      subscription_tier: "free",
      subscription_status: "active",
      trial_ends_at: new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    };

    it("should complete full login flow for new user", async () => {
      // Step 1: Start login - get auth URL
      mockGoogleAuthService.authenticateForLogin.mockResolvedValue({
        authUrl: "https://accounts.google.com/oauth?client_id=test",
        scopes: ["email", "profile"],
      });

      const loginHandler = registeredHandlers.get("auth:google:login");
      const loginResult = await loginHandler(mockEvent);

      expect(loginResult.success).toBe(true);
      expect(loginResult.authUrl).toContain("google.com");
      expect(mockLogService.info).toHaveBeenCalledWith(
        "Starting Google login flow with redirect",
        "AuthHandlers",
      );

      // Step 2: Complete login with auth code
      mockGoogleAuthService.exchangeCodeForTokens.mockResolvedValue({
        tokens: mockTokens,
        userInfo: mockUserInfo,
      });
      mockSupabaseService.syncUser.mockResolvedValue(mockCloudUser);
      mockDatabaseService.getUserByOAuthId.mockResolvedValue(null); // New user
      mockDatabaseService.createUser.mockResolvedValue({
        id: TEST_USER_ID,
        email: mockUserInfo.email,
        terms_accepted_at: null,
      });
      mockDatabaseService.getUserById.mockResolvedValue({
        id: TEST_USER_ID,
        email: mockUserInfo.email,
        terms_accepted_at: null,
      });
      mockDatabaseService.createSession.mockResolvedValue(TEST_SESSION_TOKEN);
      mockSupabaseService.validateSubscription.mockResolvedValue({
        tier: "free",
        status: "active",
      });

      const completeHandler = registeredHandlers.get(
        "auth:google:complete-login",
      );
      const completeResult = await completeHandler(mockEvent, TEST_AUTH_CODE);

      expect(completeResult.success).toBe(true);
      expect(completeResult.user.id).toBe(TEST_USER_ID);
      expect(completeResult.sessionToken).toBe(TEST_SESSION_TOKEN);
      expect(completeResult.isNewUser).toBe(true);

      // Verify all steps were executed (session-only OAuth: no token encryption, no session file persistence)
      expect(mockSupabaseService.syncUser).toHaveBeenCalled();
      expect(mockDatabaseService.createUser).toHaveBeenCalled();
      expect(mockDatabaseService.saveOAuthToken).toHaveBeenCalled();
      expect(mockDatabaseService.createSession).toHaveBeenCalled();
      // Note: sessionService.saveSession not called in session-only OAuth
      expect(mockRateLimitService.recordAttempt).toHaveBeenCalledWith(
        mockUserInfo.email,
        true,
      );
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "LOGIN",
          success: true,
        }),
      );
    });

    it("should handle returning user login", async () => {
      const existingUser = {
        id: TEST_USER_ID,
        email: "existing@gmail.com",
        terms_accepted_at: new Date().toISOString(),
        terms_version_accepted: "1.0",
        privacy_policy_version_accepted: "1.0",
      };

      mockGoogleAuthService.exchangeCodeForTokens.mockResolvedValue({
        tokens: mockTokens,
        userInfo: { ...mockUserInfo, email: "existing@gmail.com" },
      });
      mockSupabaseService.syncUser.mockResolvedValue(mockCloudUser);
      mockDatabaseService.getUserByOAuthId.mockResolvedValue(existingUser);
      mockDatabaseService.getUserById.mockResolvedValue(existingUser);
      mockDatabaseService.createSession.mockResolvedValue(TEST_SESSION_TOKEN);
      mockSupabaseService.validateSubscription.mockResolvedValue({
        tier: "pro",
        status: "active",
      });

      const completeHandler = registeredHandlers.get(
        "auth:google:complete-login",
      );
      const result = await completeHandler(mockEvent, TEST_AUTH_CODE);

      expect(result.success).toBe(true);
      expect(result.isNewUser).toBe(false);
      expect(mockDatabaseService.updateUser).toHaveBeenCalled();
      expect(mockDatabaseService.createUser).not.toHaveBeenCalled();
    });
  });

  describe("Complete Microsoft OAuth Login Flow", () => {
    it("should complete full Microsoft login flow", async () => {
      const codePromise = Promise.resolve("ms-auth-code");

      mockMicrosoftAuthService.authenticateForLogin.mockResolvedValue({
        authUrl: "https://login.microsoftonline.com/oauth",
        codePromise,
        codeVerifier: "verifier-123",
        scopes: ["User.Read"],
      });

      const loginHandler = registeredHandlers.get("auth:microsoft:login");
      const loginResult = await loginHandler(mockEvent);

      expect(loginResult.success).toBe(true);
      expect(loginResult.authUrl).toContain("microsoftonline");
    });
  });

  describe("Session Lifecycle", () => {
    const mockSession = {
      user_id: TEST_USER_ID,
      created_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString(),
    };

    const mockUser = {
      id: TEST_USER_ID,
      email: "test@example.com",
      terms_accepted_at: new Date().toISOString(),
    };

    it("should validate and extend active session", async () => {
      mockDatabaseService.validateSession.mockResolvedValue(mockSession);
      mockSessionSecurityService.checkSessionValidity.mockResolvedValue({
        valid: true,
      });

      const handler = registeredHandlers.get("auth:validate-session");
      const result = await handler(mockEvent, TEST_SESSION_TOKEN);

      expect(result.success).toBe(true);
      expect(result.valid).toBe(true);
      expect(mockSessionSecurityService.recordActivity).toHaveBeenCalledWith(
        TEST_SESSION_TOKEN,
      );
    });

    it("should cleanup expired session", async () => {
      mockDatabaseService.validateSession.mockResolvedValue(mockSession);
      mockSessionSecurityService.checkSessionValidity.mockResolvedValue({
        valid: false,
        reason: "absolute timeout exceeded",
      });

      const handler = registeredHandlers.get("auth:validate-session");
      const result = await handler(mockEvent, TEST_SESSION_TOKEN);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("absolute timeout exceeded");
      expect(mockDatabaseService.deleteSession).toHaveBeenCalledWith(
        TEST_SESSION_TOKEN,
      );
      expect(mockSessionSecurityService.cleanupSession).toHaveBeenCalledWith(
        TEST_SESSION_TOKEN,
      );
    });

    it("should restore session on get-current-user", async () => {
      mockSessionService.loadSession.mockResolvedValue({
        user: mockUser,
        sessionToken: TEST_SESSION_TOKEN,
        provider: "google",
        subscription: { tier: "pro" },
      });
      mockDatabaseService.validateSession.mockResolvedValue(mockSession);
      mockSessionSecurityService.checkSessionValidity.mockResolvedValue({
        valid: true,
      });
      mockDatabaseService.getUserById.mockResolvedValue(mockUser);

      const handler = registeredHandlers.get("auth:get-current-user");
      const result = await handler(mockEvent);

      expect(result.success).toBe(true);
      expect(result.user.id).toBe(TEST_USER_ID);
      expect(result.sessionToken).toBe(TEST_SESSION_TOKEN);
      expect(result.provider).toBe("google");
    });

    it("should handle complete logout flow", async () => {
      mockDatabaseService.validateSession.mockResolvedValue(mockSession);

      const handler = registeredHandlers.get("auth:logout");
      const result = await handler(mockEvent, TEST_SESSION_TOKEN);

      expect(result.success).toBe(true);
      expect(mockDatabaseService.deleteSession).toHaveBeenCalledWith(
        TEST_SESSION_TOKEN,
      );
      expect(mockSessionService.clearSession).toHaveBeenCalled();
      expect(mockSessionSecurityService.cleanupSession).toHaveBeenCalledWith(
        TEST_SESSION_TOKEN,
      );
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "LOGOUT",
          success: true,
        }),
      );
    });
  });

  describe("Terms Acceptance Flow", () => {
    it("should accept terms and sync to cloud", async () => {
      const updatedUser = {
        id: TEST_USER_ID,
        email: "test@example.com",
        terms_accepted_at: new Date().toISOString(),
      };

      mockDatabaseService.acceptTerms.mockResolvedValue(updatedUser);
      mockSupabaseService.syncTermsAcceptance.mockResolvedValue(undefined);

      const handler = registeredHandlers.get("auth:accept-terms");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.user.terms_accepted_at).toBeDefined();
      expect(mockSupabaseService.syncTermsAcceptance).toHaveBeenCalled();
    });

    it("should succeed even if cloud sync fails", async () => {
      mockDatabaseService.acceptTerms.mockResolvedValue({
        id: TEST_USER_ID,
        terms_accepted_at: new Date().toISOString(),
      });
      mockSupabaseService.syncTermsAcceptance.mockRejectedValue(
        new Error("Network error"),
      );

      const handler = registeredHandlers.get("auth:accept-terms");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(mockLogService.warn).toHaveBeenCalledWith(
        "Failed to sync terms to Supabase",
        "AuthHandlers",
        expect.any(Object),
      );
    });
  });

  describe("Error Handling and Recovery", () => {
    it("should handle token exchange failure gracefully", async () => {
      mockGoogleAuthService.exchangeCodeForTokens.mockRejectedValue(
        new Error("Invalid authorization code"),
      );

      const handler = registeredHandlers.get("auth:google:complete-login");
      const result = await handler(mockEvent, "invalid-code");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid authorization code");
      // Note: auditService.log is not called in this error path - only logService.error
      expect(mockLogService.error).toHaveBeenCalledWith(
        "Google complete login failed",
        "AuthHandlers",
        expect.any(Object),
      );
    });

    it("should handle database errors during user creation", async () => {
      mockGoogleAuthService.exchangeCodeForTokens.mockResolvedValue({
        tokens: { access_token: "token" },
        userInfo: { id: "123", email: "test@example.com" },
      });
      mockSupabaseService.syncUser.mockResolvedValue({ id: "cloud-123" });
      mockDatabaseService.getUserByOAuthId.mockResolvedValue(null);
      mockDatabaseService.createUser.mockRejectedValue(
        new Error("Database connection lost"),
      );

      const handler = registeredHandlers.get("auth:google:complete-login");
      const result = await handler(mockEvent, TEST_AUTH_CODE);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Database connection lost");
    });

    it("should validate input parameters", async () => {
      const handler = registeredHandlers.get("auth:google:complete-login");

      // Empty auth code
      const result1 = await handler(mockEvent, "");
      expect(result1.success).toBe(false);
      expect(result1.error).toContain("Authorization code");

      // Malformed auth code (must be long enough to pass length check)
      const result2 = await handler(
        mockEvent,
        "abcdefghijklmnop<script>alert(1)</script>",
      );
      expect(result2.success).toBe(false);
      expect(result2.error).toContain("invalid characters");
    });

    // Note: shell:open-external handler tests are in system-handlers.test.ts
  });

  describe("Mailbox Connection Flows", () => {
    it("should start Google mailbox connection", async () => {
      mockDatabaseService.getUserById.mockResolvedValue({
        id: TEST_USER_ID,
        email: "test@example.com",
      });
      mockGoogleAuthService.authenticateForMailbox.mockResolvedValue({
        authUrl: "https://accounts.google.com/oauth/mailbox",
        codePromise: new Promise(() => {}),
        scopes: ["gmail.readonly"],
      });

      const handler = registeredHandlers.get("auth:google:connect-mailbox");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.authUrl).toContain("google.com");
      expect(result.scopes).toContain("gmail.readonly");
    });

    it("should start Microsoft mailbox connection", async () => {
      mockDatabaseService.getUserById.mockResolvedValue({
        id: TEST_USER_ID,
        email: "test@example.com",
      });
      mockMicrosoftAuthService.authenticateForMailbox.mockResolvedValue({
        authUrl: "https://login.microsoftonline.com/oauth/mailbox",
        codePromise: new Promise(() => {}),
        codeVerifier: "verifier",
        scopes: ["Mail.Read"],
      });

      const handler = registeredHandlers.get("auth:microsoft:connect-mailbox");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.authUrl).toContain("microsoftonline");
    });
  });
});
