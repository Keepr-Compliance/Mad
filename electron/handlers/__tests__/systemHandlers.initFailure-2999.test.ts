/**
 * @jest-environment node
 *
 * BACKLOG-2999 — the CALLER must not proceed to normal startup when the
 * database failed to initialize.
 *
 * A return-value (or rejection) test inside databaseService proves only that
 * initialize() stopped lying. It does NOT prove the app stops — and that was
 * the whole defect: `initialize()` reported success, `initializeDatabase()`
 * discarded the value, and `system:initialize-secure-storage` went on to
 * report success and warm the contact worker pool against a database that had
 * been half-migrated, restored-and-unverified, or never opened at all.
 *
 * Harness cloned from systemHandlers.deferredDbSessionPersist.test.ts, which
 * already mocks `../authHandlers` initializeDatabase and
 * `../../workers/contactWorkerPool` initializePool — the exact two seams this
 * needs. systemHandlers.ts keeps module-level isInitializing /
 * initializationComplete guards, so every test isolates the module fresh.
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
    default: { log: jest.fn(), initialize: jest.fn().mockResolvedValue(undefined) },
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

  return { initHandler, mockInitializeDatabase, mockInitializePool, mockBroadcast };
}

describe("systemHandlers — a failed DB init must not proceed to normal startup (BACKLOG-2999)", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  /**
   * DISCRIMINATOR, and the reason the negative assertion below means
   * something: with the SAME fixture, a successful init DOES warm the pool.
   * Without this row, `initializePool` not being called could simply mean the
   * harness never wires it up.
   */
  it("BASELINE: when initializeDatabase resolves, the handler reports success AND warms the contact worker pool", async () => {
    const { initHandler, mockInitializePool } = setup({});

    const result = await initHandler();

    expect(result.success).toBe(true);
    expect(mockInitializePool).toHaveBeenCalledWith(TEST_DB_PATH, TEST_DB_KEY);
  });

  it("when initializeDatabase REJECTS, the handler reports failure and never reaches normal startup", async () => {
    const { initHandler, mockInitializePool, mockInitializeDatabase } = setup({
      initializeDatabaseRejectsWith: new Error(
        "Database migration failed and could not be recovered from a backup",
      ),
    });

    const result = await initHandler();

    expect(mockInitializeDatabase).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain("could not be recovered");

    // THE POINT OF THIS FILE. Pre-BACKLOG-2999 initialize() resolved `true` on
    // this path, so execution ran straight past here and the pool was warmed
    // against the broken database.
    expect(mockInitializePool).not.toHaveBeenCalled();
  });

  it("reports the failure to the renderer as an error stage rather than staying silent", async () => {
    const { initHandler, mockBroadcast } = setup({
      initializeDatabaseRejectsWith: new Error("Database migration failed"),
    });

    await initHandler();

    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "error" }),
    );
    expect(mockBroadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: "complete" }),
    );
  });
});

// This file declares no top-level imports, so without an explicit export it
// would be a global SCRIPT under tsconfig.test.json and its `RegisteredHandlers`
// / `setup` would collide with the sibling systemHandlers suite (TS2374 /
// TS2393). Caught by `npm run type-check:tests`, which is its own CI step and
// which `npm run type-check` does NOT cover.
export {};
