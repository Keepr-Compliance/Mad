/**
 * @jest-environment node
 *
 * System Handlers — deferred-DB deep-link session persistence (BACKLOG-2173b)
 *
 * LAUNCH BLOCKER root cause: on a fresh macOS profile, the deep-link OAuth
 * callback in main.ts fires BEFORE the local DB is initialized (onboarding
 * order is login -> phone-type -> secure-storage[DB init] -> ... ->
 * permissions). main.ts's session-save block only runs in the
 * `databaseService.isInitialized()` branch; the deferred branch just calls
 * setPendingDeepLinkUser() and never persists a session. When the DB later
 * initializes, this file's pending-deep-link-user handler creates the SQLite
 * user but (pre-fix) never called sessionService.saveSession() -- so
 * session.json was never written. The session lived ONLY in the Supabase
 * SDK's in-memory storage adapter and was lost the instant BACKLOG-2173's
 * app.relaunch() restarted the process for the FDA grant, dumping the user
 * to a failed login screen instead of the dashboard.
 *
 * This pins the fix: once the pending deep-link user is created/confirmed in
 * the now-initialized DB, the handler persists a durable session (SQLite
 * session row + encrypted session.json with supabaseTokens) using the
 * Supabase auth session already established by main.ts's setSession() call.
 *
 * systemHandlers.ts has module-level isInitializing/initializationComplete
 * guards, so each test isolates the module fresh via jest.isolateModules().
 */

interface RegisteredHandlers {
  [channel: string]: (...args: unknown[]) => unknown;
}

const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000";

function setup(options: {
  pendingUser: unknown;
  existingLocalUser?: unknown; // returned by getUserByEmail/getUserByOAuthId (pre-creation)
  createdLocalUser?: unknown; // returned by getUserById after createUser
  authSession?: unknown;
}) {
  const registered: RegisteredHandlers = {};

  const mockCreateSession = jest.fn().mockResolvedValue("sqlite-session-token-abc");
  const mockSaveSession = jest.fn().mockResolvedValue(true);
  const mockGetSessionExpirationMs = jest.fn(() => 24 * 60 * 60 * 1000);

  const mockGetUserByEmail = jest.fn().mockResolvedValue(options.existingLocalUser ?? null);
  const mockGetUserByOAuthId = jest.fn().mockResolvedValue(options.existingLocalUser ?? null);
  const mockCreateUser = jest.fn().mockResolvedValue(undefined);
  const mockGetUserById = jest
    .fn()
    .mockResolvedValue(options.createdLocalUser ?? options.existingLocalUser ?? null);

  const mockGetAuthSession = jest.fn().mockResolvedValue(options.authSession ?? null);

  jest.doMock("electron", () => ({
    ipcMain: {
      handle: (channel: string, handler: (...a: unknown[]) => unknown) => {
        registered[channel] = handler;
      },
      on: jest.fn(),
    },
    shell: { openExternal: jest.fn() },
    BrowserWindow: jest.fn(),
  }));

  jest.doMock("../../services/logService", () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));

  jest.doMock("../../services/databaseEncryptionService", () => ({
    databaseEncryptionService: { hasKeyStore: jest.fn().mockReturnValue(true) },
  }));

  jest.doMock("../authHandlers", () => ({
    initializeDatabase: jest.fn().mockResolvedValue(undefined),
  }));

  jest.doMock("../../main", () => ({
    getAndClearPendingDeepLinkUser: jest.fn().mockReturnValue(options.pendingUser),
  }));

  jest.doMock("../../workers/contactWorkerPool", () => ({
    initializePool: jest.fn().mockResolvedValue(undefined),
  }));

  jest.doMock("../../services/db/core/dbConnection", () => ({
    getDbPath: jest.fn().mockReturnValue(null),
    getEncryptionKey: jest.fn().mockReturnValue(null),
  }));

  jest.doMock("../../services/initializationBroadcaster", () => ({
    initializationBroadcaster: {
      broadcast: jest.fn(),
      getCurrentStage: jest.fn().mockReturnValue({ stage: "idle" }),
      whenDbReady: jest.fn().mockResolvedValue({ ready: true, timedOut: false }),
      setWindow: jest.fn(),
      reset: jest.fn(),
    },
  }));

  jest.doMock("../../services/permissionService", () => ({ default: {} }));
  jest.doMock("../../services/connectionStatusService", () => ({ default: {} }));
  jest.doMock("../../services/macOSPermissionHelper", () => ({ default: {} }));
  jest.doMock("../../services/failureLogService", () => ({
    __esModule: true,
    default: { log: jest.fn() },
  }));

  jest.doMock("../../services/databaseService", () => ({
    __esModule: true,
    default: {
      isInitialized: jest.fn().mockReturnValue(true),
      getUserByEmail: mockGetUserByEmail,
      getUserByOAuthId: mockGetUserByOAuthId,
      createUser: mockCreateUser,
      getUserById: mockGetUserById,
      createSession: mockCreateSession,
    },
  }));

  jest.doMock("../../services/supabaseService", () => ({
    __esModule: true,
    default: {
      getAuthSession: mockGetAuthSession,
      getUserById: jest.fn().mockResolvedValue(null),
    },
  }));

  jest.doMock("../../services/sessionService", () => ({
    __esModule: true,
    default: {
      saveSession: mockSaveSession,
      getSessionExpirationMs: mockGetSessionExpirationMs,
    },
  }));

  let initHandler!: () => Promise<unknown>;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerSystemHandlers } = require("../systemHandlersCompat");
    registerSystemHandlers();
    initHandler = registered["system:initialize-secure-storage"] as () => Promise<unknown>;
  });

  return {
    initHandler,
    mockCreateSession,
    mockSaveSession,
    mockCreateUser,
    mockGetUserById,
    mockGetAuthSession,
  };
}

describe("systemHandlers — deferred-DB deep-link session persistence (BACKLOG-2173b)", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("new pending user (first login on fresh profile): creates local user AND persists session with Supabase tokens", async () => {
    const pendingUser = {
      supabaseId: TEST_USER_ID,
      email: "new-user@example.com",
      displayName: "New User",
      provider: "google",
      subscriptionTier: "free",
      subscriptionStatus: "trial",
    };
    const createdLocalUser = {
      id: TEST_USER_ID,
      email: "new-user@example.com",
      oauth_provider: "google",
      subscription_tier: "free",
      subscription_status: "trial",
    };
    const authSession = {
      userId: TEST_USER_ID,
      accessToken: "supabase-access-token",
      refreshToken: "supabase-refresh-token",
    };

    const { initHandler, mockCreateUser, mockCreateSession, mockSaveSession } = setup({
      pendingUser,
      existingLocalUser: null,
      createdLocalUser,
      authSession,
    });

    await initHandler();

    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    expect(mockCreateSession).toHaveBeenCalledWith(TEST_USER_ID);
    expect(mockSaveSession).toHaveBeenCalledTimes(1);
    const savedSession = mockSaveSession.mock.calls[0][0];
    expect(savedSession.supabaseTokens).toEqual({
      access_token: "supabase-access-token",
      refresh_token: "supabase-refresh-token",
    });
    expect(savedSession.sessionToken).toBe("sqlite-session-token-abc");
    expect(savedSession.provider).toBe("google");
  });

  it("pending user that already exists locally: still persists a session (idempotent re-login case)", async () => {
    const pendingUser = {
      supabaseId: TEST_USER_ID,
      email: "existing-user@example.com",
      provider: "microsoft",
      subscriptionTier: "pro",
      subscriptionStatus: "active",
    };
    const existingLocalUser = {
      id: TEST_USER_ID,
      email: "existing-user@example.com",
      oauth_provider: "microsoft",
      subscription_tier: "pro",
      subscription_status: "active",
    };
    const authSession = {
      userId: TEST_USER_ID,
      accessToken: "at-2",
      refreshToken: "rt-2",
    };

    const { initHandler, mockCreateUser, mockSaveSession } = setup({
      pendingUser,
      existingLocalUser,
      authSession,
    });

    await initHandler();

    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockSaveSession).toHaveBeenCalledTimes(1);
    expect(mockSaveSession.mock.calls[0][0].supabaseTokens).toEqual({
      access_token: "at-2",
      refresh_token: "rt-2",
    });
  });

  it("no Supabase auth session available: does NOT throw, does NOT save a session (best-effort)", async () => {
    const pendingUser = {
      supabaseId: TEST_USER_ID,
      email: "no-session@example.com",
      provider: "google",
    };
    const createdLocalUser = { id: TEST_USER_ID, email: "no-session@example.com", oauth_provider: "google" };

    const { initHandler, mockSaveSession } = setup({
      pendingUser,
      existingLocalUser: null,
      createdLocalUser,
      authSession: null,
    });

    await expect(initHandler()).resolves.toBeDefined();
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it("no pending user (normal launch, not a deep-link login): does not attempt session persistence via this path", async () => {
    const { initHandler, mockSaveSession, mockCreateUser } = setup({
      pendingUser: null,
    });

    await initHandler();

    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockSaveSession).not.toHaveBeenCalled();
  });
});
