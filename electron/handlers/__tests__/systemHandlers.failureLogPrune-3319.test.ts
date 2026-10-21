/**
 * @jest-environment node
 *
 * BACKLOG-3319 — the failure log is pruned once per launch, from the live
 * startup path.
 *
 * The only previous call to `failureLogService.initialize()` sat in the
 * "system:initialize-database" handler, which no renderer code invokes, so the
 * prune never ran. The live path is "system:initialize-secure-storage"
 * (LoadingOrchestrator -> systemBridge), guarded by a module-level
 * `initializationComplete` flag.
 *
 * Harness cloned from systemHandlers.initFailure-2999.test.ts, with the
 * failureLogService.initialize mock exposed. Each test isolates the module
 * fresh, because the run-once flag is module state.
 */

interface RegisteredHandlers {
  [channel: string]: (...args: unknown[]) => unknown;
}

/** Placeholder, non-personal — this repo is public. */
const TEST_DB_PATH = "/mock/userData/mad.db";
const TEST_DB_KEY = "abcdef1234567890";

function setup(options: { initializeDatabaseRejectsWith?: Error }) {
  const registered: RegisteredHandlers = {};

  const mockInitializeDatabase = options.initializeDatabaseRejectsWith
    ? jest.fn().mockRejectedValue(options.initializeDatabaseRejectsWith)
    : jest.fn().mockResolvedValue(undefined);
  const mockInitializePool = jest.fn().mockResolvedValue(undefined);
  const mockBroadcast = jest.fn();
  const mockFailureLogInitialize = jest.fn().mockResolvedValue(undefined);

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
    initializeDatabase: mockInitializeDatabase,
  }));

  jest.doMock("../../main", () => ({
    getAndClearPendingDeepLinkUser: jest.fn().mockReturnValue(null),
  }));

  jest.doMock("../../workers/contactWorkerPool", () => ({
    initializePool: mockInitializePool,
  }));

  // Real-looking values, unlike the sibling suite's nulls: the handler only
  // warms the pool `if (poolDbPath && poolEncKey)`, so nulls here would make
  // "the pool was never warmed" true for the wrong reason and the negative
  // assertion below would be vacuous.
  jest.doMock("../../services/db/core/dbConnection", () => ({
    getDbPath: jest.fn().mockReturnValue(TEST_DB_PATH),
    getEncryptionKey: jest.fn().mockReturnValue(TEST_DB_KEY),
  }));

  jest.doMock("../../services/initializationBroadcaster", () => ({
    initializationBroadcaster: {
      broadcast: mockBroadcast,
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
    default: { log: jest.fn(), initialize: mockFailureLogInitialize },
  }));

  jest.doMock("../../services/databaseService", () => ({
    __esModule: true,
    default: {
      isInitialized: jest.fn().mockReturnValue(false),
      getUserByEmail: jest.fn().mockResolvedValue(null),
      getUserByOAuthId: jest.fn().mockResolvedValue(null),
      createUser: jest.fn().mockResolvedValue(undefined),
      getUserById: jest.fn().mockResolvedValue(null),
      createSession: jest.fn().mockResolvedValue("token"),
    },
  }));

  jest.doMock("../../services/supabaseService", () => ({
    __esModule: true,
    default: {
      getAuthSession: jest.fn().mockResolvedValue(null),
      getUserById: jest.fn().mockResolvedValue(null),
    },
  }));

  jest.doMock("../../services/sessionService", () => ({
    __esModule: true,
    default: {
      saveSession: jest.fn().mockResolvedValue(true),
      getSessionExpirationMs: jest.fn(() => 24 * 60 * 60 * 1000),
    },
  }));

  let initHandler!: () => Promise<{ success: boolean; error?: string }>;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerSystemHandlers } = require("../systemHandlersCompat");
    registerSystemHandlers();
    initHandler = registered["system:initialize-secure-storage"] as () => Promise<{
      success: boolean;
      error?: string;
    }>;
  });

  return { initHandler, mockInitializeDatabase, mockFailureLogInitialize };
}

/** setImmediate callbacks run after every pending microtask; one turn flushes the deferred prune. */
function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("systemHandlers — failure-log prune runs once per launch (BACKLOG-3319)", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("a successful init calls initialize() exactly once, AFTER the handler has replied", async () => {
    const { initHandler, mockFailureLogInitialize } = setup({});

    const result = await initHandler();

    expect(result.success).toBe(true);
    // Deferred to the next event-loop turn, so the DB-ready reply is not held
    // behind the prune.
    expect(mockFailureLogInitialize).not.toHaveBeenCalled();
    await flushImmediate();
    expect(mockFailureLogInitialize).toHaveBeenCalledTimes(1);
  });

  it("a second invoke in the same launch does not prune again", async () => {
    const { initHandler, mockFailureLogInitialize } = setup({});

    await initHandler();
    await flushImmediate();
    const second = await initHandler();
    await flushImmediate();

    expect(second.success).toBe(true);
    expect(mockFailureLogInitialize).toHaveBeenCalledTimes(1);
  });

  it("a failed DB init never prunes", async () => {
    const { initHandler, mockFailureLogInitialize, mockInitializeDatabase } = setup({
      initializeDatabaseRejectsWith: new Error("Database migration failed"),
    });

    const result = await initHandler();
    await flushImmediate();

    expect(mockInitializeDatabase).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(mockFailureLogInitialize).not.toHaveBeenCalled();
  });

  it("a rejecting initialize() does not escape as an unhandled rejection", async () => {
    const { initHandler, mockFailureLogInitialize } = setup({});
    mockFailureLogInitialize.mockRejectedValueOnce(new Error("logService.warn rejected"));
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await initHandler();
      await flushImmediate();
      await flushImmediate();
      expect(mockFailureLogInitialize).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

// No top-level imports: without this export the file is a global SCRIPT under
// tsconfig.test.json and its declarations collide with the sibling suites.
export {};
