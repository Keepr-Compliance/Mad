/**
 * Unit tests for TASK-2085: Server-side token validation in handleGetCurrentUser
 *
 * Tests that auth.getUser() is called after setSession() to validate the session
 * server-side before showing authenticated UI. Covers:
 * - Valid session (server confirms user exists)
 * - Revoked session (server returns auth error)
 * - Deleted user (server returns null user)
 * - Network error (proceeds optimistically)
 * - setSession failure (existing behavior preserved, no getUser call)
 * - No supabase tokens (skips server validation)
 */

// Mock electron
const mockIpcHandle = jest.fn();
jest.mock("electron", () => ({
  ipcMain: {
    handle: mockIpcHandle,
  },
  shell: {
    openExternal: jest.fn(),
  },
}));

// Mock supabaseService
const mockGetUser = jest.fn();
const mockSetSession = jest.fn();
// BACKLOG-2149: the DB-not-ready fallback reads the Supabase session directly.
const mockGetSession = jest.fn().mockResolvedValue({ data: { session: null } });
const mockGetClient = jest.fn(() => ({
  auth: {
    getUser: mockGetUser,
    setSession: mockSetSession,
    getSession: mockGetSession,
  },
}));
const mockGetAuthUserId = jest.fn();
const mockGetUserById = jest.fn();

jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: mockGetClient,
    signOut: jest.fn(),
    signOutGlobal: jest.fn(),
    getAuthUserId: mockGetAuthUserId,
    getUserById: mockGetUserById,
    syncTermsAcceptance: jest.fn(),
    completeEmailOnboarding: jest.fn(),
  },
}));

// Mock deviceService
jest.mock("../services/deviceService", () => ({
  getDeviceId: jest.fn().mockReturnValue("test-device-id"),
  registerDevice: jest.fn().mockResolvedValue({ success: true }),
}));

// Mock databaseService
const mockDbIsInitialized = jest.fn().mockReturnValue(true);
const mockDbValidateSession = jest.fn();
const mockDbDeleteSession = jest.fn();
const mockDbGetUserById = jest.fn();
const mockDbGetUserByEmail = jest.fn();
const mockDbGetUserByOAuthId = jest.fn();
const mockDbCreateUser = jest.fn();
const mockDbUpdateUser = jest.fn();

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: mockDbIsInitialized,
    validateSession: mockDbValidateSession,
    deleteSession: mockDbDeleteSession,
    getUserById: mockDbGetUserById,
    getUserByEmail: mockDbGetUserByEmail,
    getUserByOAuthId: mockDbGetUserByOAuthId,
    createUser: mockDbCreateUser,
    updateUser: mockDbUpdateUser,
    acceptTerms: jest.fn(),
    completeEmailOnboarding: jest.fn(),
    hasCompletedEmailOnboarding: jest.fn(),
    getOAuthToken: jest.fn(),
    clearAllSessions: jest.fn(),
    getRawDatabase: jest.fn(),
  },
}));

// BACKLOG-2149: handleGetCurrentUser now awaits the db-ready signal when the DB
// is not yet initialized. Mock it; default to "timed out, not ready" so the
// not-initialized path resolves quickly instead of on the real 30s bound.
const mockWhenDbReady = jest.fn().mockResolvedValue({ ready: false, timedOut: true });
jest.mock("../services/initializationBroadcaster", () => ({
  initializationBroadcaster: {
    whenDbReady: mockWhenDbReady,
    broadcast: jest.fn(),
    getCurrentStage: jest.fn().mockReturnValue({ stage: "idle" }),
    setWindow: jest.fn(),
    reset: jest.fn(),
  },
}));

// Mock sessionService
const mockLoadSession = jest.fn();
const mockClearSession = jest.fn();
const mockUpdateSession = jest.fn();

jest.mock("../services/sessionService", () => ({
  __esModule: true,
  default: {
    loadSession: mockLoadSession,
    clearSession: mockClearSession,
    updateSession: mockUpdateSession,
  },
}));

// Mock sessionSecurityService
const mockCheckSessionValidity = jest.fn();
const mockCleanupSession = jest.fn();

jest.mock("../services/sessionSecurityService", () => ({
  __esModule: true,
  default: {
    checkSessionValidity: mockCheckSessionValidity,
    recordActivity: jest.fn(),
    cleanupSession: mockCleanupSession,
  },
}));

// Mock auditService
jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
  },
}));

// Mock logService
const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();

jest.mock("../services/logService", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: mockLogInfo,
    warn: mockLogWarn,
    error: jest.fn(),
  },
}));

// Mock sync-handlers
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

// Mock validation utilities
jest.mock("../utils/validation", () => ({
  ValidationError: class ValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ValidationError";
    }
  },
  validateUserId: jest.fn((id: string) => id),
  validateSessionToken: jest.fn((token: string) => token),
}));

// Mock constants
jest.mock("../constants/legalVersions", () => ({
  CURRENT_TERMS_VERSION: "1.0",
  CURRENT_PRIVACY_POLICY_VERSION: "1.0",
}));

import { registerSessionHandlers } from "../handlers/sessionHandlers";

// Helper to create a mock session object
function createMockSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionToken: "test-session-token",
    user: {
      id: "user-123",
      email: "test@example.com",
      first_name: "Test",
      last_name: "User",
      display_name: "Test User",
      avatar_url: null,
      oauth_provider: "google",
      oauth_id: "oauth-123",
      subscription_tier: "free",
      subscription_status: "trial",
      trial_ends_at: null,
      terms_accepted_at: "2024-01-01T00:00:00Z",
      terms_version_accepted: "1.0",
      privacy_policy_accepted_at: "2024-01-01T00:00:00Z",
      privacy_policy_version_accepted: "1.0",
    },
    subscription: null,
    provider: "google",
    supabaseTokens: {
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
    },
    ...overrides,
  };
}

// Helper to create a mock DB user
function createMockDbUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-123",
    email: "test@example.com",
    first_name: "Test",
    last_name: "User",
    display_name: "Test User",
    avatar_url: null,
    oauth_provider: "google",
    oauth_id: "oauth-123",
    subscription_tier: "free",
    subscription_status: "trial",
    trial_ends_at: null,
    terms_accepted_at: "2024-01-01T00:00:00Z",
    terms_version_accepted: "1.0",
    privacy_policy_accepted_at: "2024-01-01T00:00:00Z",
    privacy_policy_version_accepted: "1.0",
    created_at: "2024-01-01T00:00:00Z",
    last_login_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Sets up the standard mocks for a returning user with a cached session.
 * This mimics Phase 3 (loading-auth) of the LoadingOrchestrator.
 */
function setupReturningUserMocks(session = createMockSession()) {
  mockDbIsInitialized.mockReturnValue(true);
  mockLoadSession.mockResolvedValue(session);
  mockDbValidateSession.mockResolvedValue(
    createMockDbUser({ created_at: "2024-01-01T00:00:00Z", last_login_at: "2024-01-01T00:00:00Z" })
  );
  mockCheckSessionValidity.mockResolvedValue({ valid: true });
  mockSetSession.mockResolvedValue({ error: null });
  mockGetAuthUserId.mockReturnValue("user-123");
  mockDbGetUserById.mockResolvedValue(createMockDbUser());
  // Cloud user fetch (TASK-1809) -- return valid user
  mockGetUserById.mockResolvedValue(createMockDbUser());
}

describe("TASK-2085: Server-side auth token validation in handleGetCurrentUser", () => {
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  beforeAll(() => {
    registerSessionHandlers();

    // Capture registered handlers
    for (const call of mockIpcHandle.mock.calls) {
      const [channel, handler] = call;
      handlers[channel] = handler;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should be registered as auth:get-current-user handler", () => {
    expect(handlers["auth:get-current-user"]).toBeDefined();
  });

  describe("valid session (server confirms user exists)", () => {
    it("should return success when auth.getUser() confirms the user", async () => {
      setupReturningUserMocks();

      // Server validates the session successfully
      mockGetUser.mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const result = await handlers["auth:get-current-user"]() as {
        success: boolean;
        user?: { id: string };
      };

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user!.id).toBe("user-123");

      // Verify getUser was called
      expect(mockGetUser).toHaveBeenCalledTimes(1);

      // Verify session was NOT cleaned up
      expect(mockDbDeleteSession).not.toHaveBeenCalled();
      expect(mockClearSession).not.toHaveBeenCalled();
      expect(mockCleanupSession).not.toHaveBeenCalled();

      // Verify "validated server-side" was logged
      expect(mockLogInfo).toHaveBeenCalledWith(
        "Supabase session validated server-side",
        "SessionHandlers"
      );
    });
  });

  describe("revoked session (server returns auth error)", () => {
    it("should return failure and clean up session when auth.getUser() returns AuthApiError", async () => {
      setupReturningUserMocks();

      // Server says token is revoked
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid Refresh Token: Already Used" },
      });

      const result = await handlers["auth:get-current-user"]() as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Session no longer valid");

      // Verify session cleanup was performed
      expect(mockDbDeleteSession).toHaveBeenCalledWith("test-session-token");
      expect(mockClearSession).toHaveBeenCalled();
      expect(mockCleanupSession).toHaveBeenCalledWith("test-session-token");

      // Verify the invalidation was logged
      expect(mockLogInfo).toHaveBeenCalledWith(
        "Supabase session invalid on server, forcing re-login",
        "SessionHandlers",
        { error: "Invalid Refresh Token: Already Used" }
      );
    });
  });

  describe("deleted user (server returns null user, no error)", () => {
    it("should return failure when auth.getUser() returns user: null without error", async () => {
      setupReturningUserMocks();

      // Server returns no user (user was deleted from Supabase)
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: null,
      });

      const result = await handlers["auth:get-current-user"]() as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Session no longer valid");

      // Verify session cleanup
      expect(mockDbDeleteSession).toHaveBeenCalledWith("test-session-token");
      expect(mockClearSession).toHaveBeenCalled();
      expect(mockCleanupSession).toHaveBeenCalledWith("test-session-token");
    });
  });

  describe("network error (proceeds optimistically)", () => {
    it("should return success when auth.getUser() throws a network error", async () => {
      setupReturningUserMocks();

      // Network error -- getUser throws
      mockGetUser.mockRejectedValue(new Error("fetch failed"));

      const result = await handlers["auth:get-current-user"]() as {
        success: boolean;
        user?: { id: string };
      };

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();

      // Verify session was NOT cleaned up (optimistic)
      expect(mockDbDeleteSession).not.toHaveBeenCalled();
      expect(mockClearSession).not.toHaveBeenCalled();
      expect(mockCleanupSession).not.toHaveBeenCalled();

      // Verify warning was logged
      expect(mockLogWarn).toHaveBeenCalledWith(
        "Server-side session validation failed (network?), proceeding optimistically",
        "SessionHandlers",
        { error: "fetch failed" }
      );
    });
  });

  describe("setSession failure (existing behavior preserved)", () => {
    it("should return failure when setSession fails with expired error, without calling getUser", async () => {
      const session = createMockSession();
      mockDbIsInitialized.mockReturnValue(true);
      mockLoadSession.mockResolvedValue(session);
      mockDbValidateSession.mockResolvedValue(
        createMockDbUser({ created_at: "2024-01-01T00:00:00Z", last_login_at: "2024-01-01T00:00:00Z" })
      );
      mockCheckSessionValidity.mockResolvedValue({ valid: true });

      // setSession fails with "expired" error
      mockSetSession.mockResolvedValue({
        error: { message: "Auth session expired" },
      });

      const result = await handlers["auth:get-current-user"]() as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Session expired, please sign in again");

      // The key assertion: getUser should NOT have been called
      // because the setSession failure returns early before reaching
      // the TASK-2085 validation block
      expect(mockGetUser).not.toHaveBeenCalled();
    });
  });

  describe("no supabase tokens (skips server validation)", () => {
    it("should skip server validation when session has no supabaseTokens", async () => {
      const session = createMockSession({ supabaseTokens: undefined });
      mockDbIsInitialized.mockReturnValue(true);
      mockLoadSession.mockResolvedValue(session);
      mockDbValidateSession.mockResolvedValue(
        createMockDbUser({ created_at: "2024-01-01T00:00:00Z", last_login_at: "2024-01-01T00:00:00Z" })
      );
      mockCheckSessionValidity.mockResolvedValue({ valid: true });
      mockGetAuthUserId.mockReturnValue("user-123");
      mockDbGetUserById.mockResolvedValue(createMockDbUser());
      mockGetUserById.mockResolvedValue(createMockDbUser());

      const result = await handlers["auth:get-current-user"]() as {
        success: boolean;
        user?: { id: string };
      };

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();

      // getUser should NOT have been called -- no tokens to validate
      expect(mockGetUser).not.toHaveBeenCalled();

      // setSession should also NOT have been called -- no tokens
      expect(mockSetSession).not.toHaveBeenCalled();
    });
  });

  describe("revoked session with specific error types", () => {
    it("should handle getUserError with no user data", async () => {
      setupReturningUserMocks();

      // Server returns error with undefined user
      mockGetUser.mockResolvedValue({
        data: { user: undefined },
        error: { message: "User not found" },
      });

      const result = await handlers["auth:get-current-user"]() as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Session no longer valid");
    });
  });

  // BACKLOG-2149: DB-not-ready path must not hard-error the renderer.
  describe("DB starting up (BACKLOG-2149)", () => {
    it("awaits db-ready when the DB is not initialized", async () => {
      mockDbIsInitialized.mockReturnValue(false);
      // DB becomes ready during the wait; then normal session validation runs.
      mockWhenDbReady.mockResolvedValueOnce({ ready: true, timedOut: false });
      mockLoadSession.mockResolvedValue(null); // no session → returns cleanly

      await handlers["auth:get-current-user"]();

      expect(mockWhenDbReady).toHaveBeenCalled();
    });

    it("returns TRANSIENT/retryable (not a hard error) when DB never readies and there is no Supabase session", async () => {
      mockDbIsInitialized.mockReturnValue(false);
      mockWhenDbReady.mockResolvedValueOnce({ ready: false, timedOut: true });
      mockGetSession.mockResolvedValueOnce({ data: { session: null } });

      const result = (await handlers["auth:get-current-user"]()) as {
        success: boolean;
        error?: string;
        transient?: boolean;
        retryable?: boolean;
      };

      expect(result.success).toBe(false);
      expect(result.transient).toBe(true);
      expect(result.retryable).toBe(true);
      expect(result.error).not.toBe("Database not initialized");
    });

    it("falls back to the Supabase session for basic user info when DB never readies", async () => {
      mockDbIsInitialized.mockReturnValue(false);
      mockWhenDbReady.mockResolvedValueOnce({ ready: false, timedOut: true });
      mockGetSession.mockResolvedValueOnce({
        data: {
          session: {
            user: {
              id: "supa-123",
              email: "user@example.com",
              user_metadata: { full_name: "Test User" },
            },
          },
        },
      });

      const result = (await handlers["auth:get-current-user"]()) as {
        success: boolean;
        user?: { id: string; email: string };
      };

      expect(result.success).toBe(true);
      expect(result.user!.id).toBe("supa-123");
      expect(result.user!.email).toBe("user@example.com");
    });
  });
});
