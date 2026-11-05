/**
 * @jest-environment node
 */

/**
 * BACKLOG-4148 (f): auth:get-current-user answers with the LOCAL row re-read
 * from users_local (sessionHandlers.handleGetCurrentUser: `freshUser =
 * databaseService.getUserById(session.user.id)`, then `user = freshUser ||
 * session.user`), so a "Last login" stamped by the sign-in reaches the renderer
 * even when session.json still holds an older snapshot of the user.
 *
 * Harness copied from session-handlers-network-3768 (mock setup from
 * session-handlers-auth-validation, TASK-2085). Fixture: the DB user shape is
 * that file's createMockDbUser (the users_local columns getUserByIdSync's
 * SELECT * returns); the dates are SQLite CURRENT_TIMESTAMP text.
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

describe("BACKLOG-4148: get-current-user returns the re-read local row", () => {
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

  it("G1 session.json holds an old stamp, the row a new one: the answer carries the row's", async () => {
    setupReturningUserMocks(
      createMockSession({ user: { ...createMockSession().user, last_login_at: "2026-01-27 09:00:00" } }),
    );
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-123" } }, error: null });
    mockDbGetUserById.mockResolvedValue(createMockDbUser({ last_login_at: "2026-11-05 03:30:00" }));
    const result = (await handlers["auth:get-current-user"]()) as {
      success: boolean;
      user?: { last_login_at?: string; created_at?: string };
    };
    expect(result.success).toBe(true);
    expect(result.user?.last_login_at).toBe("2026-11-05 03:30:00");
    expect(result.user?.created_at).toBe("2024-01-01T00:00:00Z");
  });
});
