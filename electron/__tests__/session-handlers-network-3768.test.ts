/**
 * @jest-environment node
 */

/**
 * BACKLOG-3768: get-current-user keeps the session on a network error.
 *
 * Mock setup copied from session-handlers-auth-validation.test.ts (TASK-2085).
 * Error objects come from a REAL supabase-js client (helpers/realAuthJsErrors):
 * auth-js RETURNS AuthRetryableFetchError on a network failure, it never throws.
 * Node environment because the real client needs fetch's Response.
 *
 * Controls: S1, S2, N1, N2 (SR ruling f3d7522a).
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
import {
  apiError400Refresh,
  apiError401,
  retryable503Error,
  retryableCertError,
  sessionMissingAfterFailedRestore,
} from "./helpers/realAuthJsErrors";

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

describe("BACKLOG-3768: get-current-user on network errors", () => {
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  beforeAll(() => {
    registerSessionHandlers();
    for (const [channel, handler] of mockIpcHandle.mock.calls) {
      handlers[channel] = handler;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  type Result = { success: boolean; error?: string };
  const run = () => handlers["auth:get-current-user"]() as Promise<Result>;

  function expectKept() {
    expect(mockDbDeleteSession).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockCleanupSession).not.toHaveBeenCalled();
    expect(mockUpdateSession).not.toHaveBeenCalledWith({ supabaseTokens: undefined });
  }

  function expectCleared() {
    expect(mockDbDeleteSession).toHaveBeenCalledWith("test-session-token");
    expect(mockClearSession).toHaveBeenCalled();
    expect(mockCleanupSession).toHaveBeenCalledWith("test-session-token");
  }

  it("S1: getUser returns a transport AuthRetryableFetchError -> session kept, success", async () => {
    setupReturningUserMocks();
    const err = await retryableCertError();
    expect(err.name).toBe("AuthRetryableFetchError");
    mockGetUser.mockResolvedValue({ data: { user: null }, error: err });

    const result = await run();

    expect(result.success).toBe(true);
    expectKept();
  });

  it("S2: setSession fails on the network (real follow-on getUser: AuthSessionMissingError) -> tokens kept, session kept", async () => {
    setupReturningUserMocks();
    const restoreErr = await retryableCertError();
    const followOn = await sessionMissingAfterFailedRestore();
    // Transcribed: what the SAME client's getUser() returns after that failure.
    expect(followOn.name).toBe("AuthSessionMissingError");
    mockSetSession.mockResolvedValue({ data: { session: null, user: null }, error: restoreErr });
    mockGetUser.mockResolvedValue({ data: { user: null }, error: followOn });

    const result = await run();

    expect(result.success).toBe(true);
    expectKept();
  });

  it("N2: a 503 (retryable WITH a status) keeps the session on both paths", async () => {
    setupReturningUserMocks();
    const err = await retryable503Error();
    expect(err.status).toBe(503);
    mockGetUser.mockResolvedValue({ data: { user: null }, error: err });
    expect((await run()).success).toBe(true);
    expectKept();

    jest.clearAllMocks();
    setupReturningUserMocks();
    mockSetSession.mockResolvedValue({ data: { session: null, user: null }, error: err });
    mockGetUser.mockResolvedValue({ data: { user: null }, error: await sessionMissingAfterFailedRestore() });
    expect((await run()).success).toBe(true);
    expectKept();
  });

  it("N1: getUser returns 401 bad_jwt (AuthApiError) -> session STILL cleared", async () => {
    setupReturningUserMocks();
    const err = await apiError401();
    expect(err.name).toBe("AuthApiError");
    mockGetUser.mockResolvedValue({ data: { user: null }, error: err });

    const result = await run();

    expect(result).toEqual({ success: false, error: "Session no longer valid" });
    expectCleared();
  });

  it("N1: setSession returns 400 refresh_token_not_found -> session STILL cleared", async () => {
    setupReturningUserMocks();
    const err = await apiError400Refresh();
    expect(err.name).toBe("AuthApiError");
    mockSetSession.mockResolvedValue({ data: { session: null, user: null }, error: err });
    // The SDK holds no session after a failed restore; its getUser() returns
    // AuthSessionMissingError (transcribed). The message above does not match
    // the existing expired/invalid/refresh substrings, so the getUser block decides.
    mockGetUser.mockResolvedValue({ data: { user: null }, error: await sessionMissingAfterFailedRestore() });

    const result = await run();

    expect(result.success).toBe(false);
    expect(mockUpdateSession).toHaveBeenCalledWith({ supabaseTokens: undefined });
    expectCleared();
  });
});
