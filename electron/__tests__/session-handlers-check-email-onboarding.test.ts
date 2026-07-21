/**
 * Unit tests for auth:check-email-onboarding db-ready gating
 * (BACKLOG-1842 resume-at-step fix round, startup-resilience follow-up).
 *
 * Live trace evidence (main.log 2026-07-20 21:55:38.859) caught this handler's
 * databaseService.getOAuthToken / hasCompletedEmailOnboarding reads firing
 * while the local DB was still starting up during a fast relaunch/sign-in
 * ("Check email onboarding status failed"). It recovered silently that time
 * (the existing catch block already returns a graceful success:false), but
 * per the BACKLOG-2149 pattern (see session-handlers-auth-validation.test.ts
 * for auth:get-current-user, electron/__tests__/system-handlers.test.ts for
 * system:verify-user-in-local-db), the handler now awaits the shared
 * db-ready signal first so the common case returns real onboarding status
 * instead of a false negative.
 */

const mockIpcHandle = jest.fn();
jest.mock("electron", () => ({
  ipcMain: { handle: mockIpcHandle },
  shell: { openExternal: jest.fn() },
}));

const mockDbIsInitialized = jest.fn().mockReturnValue(true);
const mockGetOAuthToken = jest.fn();
const mockHasCompletedEmailOnboarding = jest.fn();

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: mockDbIsInitialized,
    getOAuthToken: mockGetOAuthToken,
    hasCompletedEmailOnboarding: mockHasCompletedEmailOnboarding,
    completeEmailOnboarding: jest.fn(),
    // Unrelated methods referenced elsewhere in sessionHandlers.ts registration
    validateSession: jest.fn(),
    deleteSession: jest.fn(),
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    getUserByOAuthId: jest.fn(),
    createUser: jest.fn(),
    updateUser: jest.fn(),
    acceptTerms: jest.fn(),
    clearAllSessions: jest.fn(),
    getRawDatabase: jest.fn(),
  },
}));

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

jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: jest.fn(() => ({ auth: { getUser: jest.fn(), setSession: jest.fn(), getSession: jest.fn().mockResolvedValue({ data: { session: null } }) } })),
    signOut: jest.fn(),
    signOutGlobal: jest.fn(),
    getAuthUserId: jest.fn(),
    getUserById: jest.fn(),
    syncTermsAcceptance: jest.fn(),
    completeEmailOnboarding: jest.fn(),
  },
}));

jest.mock("../services/deviceService", () => ({
  getDeviceId: jest.fn().mockReturnValue("test-device-id"),
  registerDevice: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock("../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: jest.fn(), clearSession: jest.fn(), updateSession: jest.fn() },
}));

jest.mock("../services/sessionSecurityService", () => ({
  __esModule: true,
  default: { checkSessionValidity: jest.fn(), recordActivity: jest.fn(), cleanupSession: jest.fn() },
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn() },
}));

const mockLogWarn = jest.fn();
jest.mock("../services/logService", () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: mockLogWarn, error: jest.fn() },
}));

jest.mock("../handlers/syncHandlers", () => ({ setSyncUserId: jest.fn() }));
jest.mock("../services/failureLogService", () => ({
  __esModule: true,
  default: { logFailure: jest.fn() },
}));
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn(), setUser: jest.fn() }));

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

jest.mock("../constants/legalVersions", () => ({
  CURRENT_TERMS_VERSION: "1.0",
  CURRENT_PRIVACY_POLICY_VERSION: "1.0",
}));

import { registerSessionHandlers } from "../handlers/sessionHandlers";

describe("auth:check-email-onboarding db-ready gating (BACKLOG-1842)", () => {
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  beforeAll(() => {
    registerSessionHandlers();
    for (const call of mockIpcHandle.mock.calls) {
      const [channel, handler] = call;
      handlers[channel] = handler;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDbIsInitialized.mockReturnValue(true);
  });

  it("is registered", () => {
    expect(handlers["auth:check-email-onboarding"]).toBeDefined();
  });

  it("awaits db-ready before reading tokens when DB is not yet initialized", async () => {
    mockDbIsInitialized.mockReturnValue(false);
    mockWhenDbReady.mockResolvedValueOnce({ ready: true, timedOut: false });
    mockGetOAuthToken.mockResolvedValue(null);
    mockHasCompletedEmailOnboarding.mockResolvedValue(false);

    const result = (await handlers["auth:check-email-onboarding"](null, "user-123")) as {
      success: boolean;
      completed: boolean;
    };

    expect(mockWhenDbReady).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.completed).toBe(false);
  });

  it("returns a transient/retryable result (not a hard error) when db-ready times out", async () => {
    mockDbIsInitialized.mockReturnValue(false);
    mockWhenDbReady.mockResolvedValueOnce({ ready: false, timedOut: true });

    const result = (await handlers["auth:check-email-onboarding"](null, "user-123")) as {
      success: boolean;
      completed: boolean;
      transient?: boolean;
      retryable?: boolean;
    };

    expect(result.success).toBe(false);
    expect(result.completed).toBe(false);
    expect(result.transient).toBe(true);
    expect(result.retryable).toBe(true);
    // Must not have raced into the token reads that would throw.
    expect(mockGetOAuthToken).not.toHaveBeenCalled();
  });

  it("skips the db-ready wait entirely when the DB is already initialized", async () => {
    mockDbIsInitialized.mockReturnValue(true);
    mockGetOAuthToken.mockResolvedValue(null);
    mockHasCompletedEmailOnboarding.mockResolvedValue(true);

    await handlers["auth:check-email-onboarding"](null, "user-123");

    expect(mockWhenDbReady).not.toHaveBeenCalled();
  });
});
