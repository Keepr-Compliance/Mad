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

// BACKLOG-3555 S1-S3: unlike the session and license 3555 suites, this harness MOCKS the
// initializationBroadcaster (whenDbReady -> ready). The persist path under test never calls
// whenDbReady; the store and saveSignInSession here are the real signInState module.
// BACKLOG-3322: user + session rows come from provisionDeepLinkSignIn (mocked here; real-driver
// controls in deepLinkProvisioningAtomicity-3322). The facade's createUser/createSession throw.
// Makes this file a module: the 2173b harness it is built from declares the same top-level names as a global script.
export {};

interface RegisteredHandlers {
  [channel: string]: (...args: unknown[]) => unknown;
}

// pii-allow-uuid: invented fixture id, not from any live row
const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";

function setup(options: {
  pendingUser: unknown;
  existingLocalUser?: unknown; // returned by getUserByEmail/getUserByOAuthId (pre-creation)
  createdLocalUser?: unknown; // returned by getUserById after createUser
  authSession?: unknown;
}) {
  const registered: RegisteredHandlers = {};

  const mockCreateSession = jest.fn().mockRejectedValue(new Error("facade createSession must not be called"));
  const mockSaveSession = jest.fn().mockResolvedValue(true);
  const mockGetSessionExpirationMs = jest.fn(() => 24 * 60 * 60 * 1000);

  const mockGetUserByEmail = jest.fn().mockResolvedValue(options.existingLocalUser ?? null);
  const mockGetUserByOAuthId = jest.fn().mockResolvedValue(options.existingLocalUser ?? null);
  const mockCreateUser = jest.fn().mockRejectedValue(new Error("facade createUser must not be called"));
  const mockProvisionDeepLinkSignIn = jest.fn().mockResolvedValue({
    user: options.existingLocalUser ?? options.createdLocalUser ?? null,
    sessionToken: "sqlite-session-token-abc",
    isNewUser: !options.existingLocalUser,
  });
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

  // The REAL store (main.ts re-exports it): a mocked drain could not tell a flag
  // set by setPendingDeepLinkUser from one set by hand.
  jest.doMock("../../main", () => {
    // Resolved NOW, inside the isolated registry: a lazy require at call time would
    // load a second copy of the module and drain a different store.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return { getAndClearPendingDeepLinkUser: require("../../services/signInState").getAndClearPendingDeepLinkUser };
  });

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
    // BACKLOG-3319: a successful init now schedules initialize() via setImmediate.
    default: { log: jest.fn(), initialize: jest.fn().mockResolvedValue(undefined) },
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

  jest.doMock("../../services/loginProvisioningService", () => ({
    provisionDeepLinkSignIn: mockProvisionDeepLinkSignIn,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gen: any = null;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerSystemHandlers } = require("../systemHandlersCompat");
    registerSystemHandlers();
    initHandler = registered["system:initialize-secure-storage"] as () => Promise<unknown>;
    gen = require("../../services/signInState");
  });

  return {
    gen,
    initHandler,
    mockCreateSession,
    mockSaveSession,
    mockCreateUser,
    mockGetUserById,
    mockGetAuthSession,
    mockProvisionDeepLinkSignIn,
  };
}

describe("BACKLOG-3555: the deferred persist ends the stale-file window only when it writes", () => {
  beforeEach(() => { jest.resetModules(); });
  const pendingUser = { supabaseId: TEST_USER_ID, email: "new-user@example.com", displayName: "Test", provider: "google", subscriptionTier: "free", subscriptionStatus: "trial" };
  const createdLocalUser = { id: TEST_USER_ID, email: "new-user@example.com", oauth_provider: "google", subscription_tier: "free", subscription_status: "trial" };
  const authSession = { userId: TEST_USER_ID, accessToken: "supabase-access-token", refreshToken: "supabase-refresh-token" };

  it("S1: session written -> flag cleared", async () => {
    const s = setup({ pendingUser, existingLocalUser: null, createdLocalUser, authSession });
    s.gen.setPendingDeepLinkUser(pendingUser);
    expect(s.gen.isSignInAwaitingSessionWrite()).toBe(true);
    await s.initHandler();
    expect(s.mockSaveSession).toHaveBeenCalledTimes(1);
    expect(s.gen.isSignInAwaitingSessionWrite()).toBe(false);
  });

  it("S2: saveSession reports false (BACKLOG-3299) -> flag stays set", async () => {
    const s = setup({ pendingUser, existingLocalUser: null, createdLocalUser, authSession });
    s.mockSaveSession.mockResolvedValueOnce(false);
    s.gen.setPendingDeepLinkUser(pendingUser);
    expect(s.gen.isSignInAwaitingSessionWrite()).toBe(true);
    await s.initHandler();
    expect(s.mockSaveSession).toHaveBeenCalledTimes(1);
    expect(s.gen.isSignInAwaitingSessionWrite()).toBe(true);
  });

  it("S3: no Supabase auth session to persist -> flag stays set", async () => {
    const s = setup({ pendingUser, existingLocalUser: null, createdLocalUser, authSession: null });
    s.gen.setPendingDeepLinkUser(pendingUser);
    expect(s.gen.isSignInAwaitingSessionWrite()).toBe(true);
    await s.initHandler();
    expect(s.mockSaveSession).not.toHaveBeenCalled();
    expect(s.gen.isSignInAwaitingSessionWrite()).toBe(true);
  });
});
