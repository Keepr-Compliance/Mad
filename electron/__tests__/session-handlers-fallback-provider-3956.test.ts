/**
 * @jest-environment node
 */

/**
 * BACKLOG-3956: both Supabase-session fallbacks in get-current-user carry the provider.
 *
 * Mock setup copied from session-handlers-auth-validation.test.ts (TASK-2085).
 * Error objects come from a REAL supabase-js client (helpers/realAuthJsErrors):
 * auth-js RETURNS AuthRetryableFetchError on a network failure, it never throws.
 * Node environment because the real client needs fetch's Response.
 *
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

describe("BACKLOG-3956: get-current-user Supabase fallbacks carry the provider", () => {
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

  type Result = { success: boolean; provider?: string; user?: { id: string } };
  const run = () => handlers["auth:get-current-user"]() as Promise<Result>;

  const supaSessionFor = (provider: string) => ({
    data: {
      session: {
        user: {
          id: "supa-user-1",
          email: "agent@example.com",
          user_metadata: { full_name: "Agent Example" },
          app_metadata: { provider },
        },
      },
    },
  });

  it("cold-start fallback (DB never ready) returns microsoft for an azure session", async () => {
    mockDbIsInitialized.mockReturnValue(false);
    mockWhenDbReady.mockResolvedValue({ ready: false, timedOut: true });
    mockGetSession.mockResolvedValue(supaSessionFor("azure"));

    const res = await run();

    expect(res.success).toBe(true);
    expect(res.user?.id).toBe("supa-user-1");
    expect(res.provider).toBe("microsoft");
  });

  it("exception-path fallback returns microsoft for an azure session", async () => {
    mockDbIsInitialized.mockReturnValue(true);
    mockLoadSession.mockRejectedValue(new Error("local session read failed"));
    mockGetSession.mockResolvedValue(supaSessionFor("azure"));

    const res = await run();

    expect(res.success).toBe(true);
    expect(res.user?.id).toBe("supa-user-1");
    expect(res.provider).toBe("microsoft");
  });
});
