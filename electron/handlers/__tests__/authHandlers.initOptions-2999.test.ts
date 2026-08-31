/**
 * @jest-environment node
 *
 * BACKLOG-2999 — startup is the one caller that opts INTO quitting.
 *
 * `initialize({ quitOnUnrecoverableFailure })` defaults to FALSE on purpose:
 * the other call sites are sqliteBackupService's restore, which calls
 * initialize() at step 5 and AGAIN from inside its own safety-copy recovery.
 * A default of `true` would let a forgotten argument tear the process down
 * mid-recovery and cost a user who explicitly asked to restore the database
 * they still had. Forgetting it at startup costs only the exit.
 *
 * That safe default has a cost: deleting the argument here is silent. Nothing
 * else in the suite would go red, because the FIX is the rejection and the
 * rejection still happens. This file is the only thing that catches it.
 *
 * It asserts the shape of a one-argument pass-through, and is labelled as such
 * — that is the correct granularity for this, not a proxy for behaviour tested
 * elsewhere.
 */

describe("authHandlers.initializeDatabase — startup opts into the terminal exit (BACKLOG-2999)", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  function setup() {
    const mockInitialize = jest.fn().mockResolvedValue(true);
    const mockAuditInitialize = jest.fn();

    jest.doMock("electron", () => ({
      ipcMain: { handle: jest.fn(), on: jest.fn() },
      shell: { openExternal: jest.fn() },
      BrowserWindow: jest.fn(),
    }));
    jest.doMock("../../services/databaseService", () => ({
      __esModule: true,
      default: { initialize: mockInitialize },
    }));
    jest.doMock("../../services/supabaseService", () => ({ __esModule: true, default: {} }));
    jest.doMock("../../services/auditService", () => ({
      __esModule: true,
      default: { initialize: mockAuditInitialize },
    }));
    jest.doMock("../../services/logService", () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));
    jest.doMock("../googleAuthHandlers", () => ({ registerGoogleAuthHandlers: jest.fn() }));
    jest.doMock("../microsoftAuthHandlers", () => ({ registerMicrosoftAuthHandlers: jest.fn() }));
    jest.doMock("../sessionHandlers", () => ({ registerSessionHandlers: jest.fn() }));
    jest.doMock("../sharedAuthHandlers", () => ({ registerSharedAuthHandlers: jest.fn() }));

    let initializeDatabase!: () => Promise<void>;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      initializeDatabase = require("../authHandlers").initializeDatabase;
    });

    return { initializeDatabase, mockInitialize, mockAuditInitialize };
  }

  it("passes quitOnUnrecoverableFailure: true — deleting this argument is otherwise silent", async () => {
    const { initializeDatabase, mockInitialize } = setup();

    await initializeDatabase();

    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockInitialize).toHaveBeenCalledWith({ quitOnUnrecoverableFailure: true });
  });

  it("still re-throws, so the rejection reaches the IPC handler — the flag is not the fix, the throw is", async () => {
    const { initializeDatabase, mockInitialize, mockAuditInitialize } = setup();
    mockInitialize.mockRejectedValue(new Error("Database migration failed"));

    await expect(initializeDatabase()).rejects.toThrow("Database migration failed");

    // And nothing downstream of the failed init runs.
    expect(mockAuditInitialize).not.toHaveBeenCalled();
  });
});

// This file declares no top-level imports, so without an explicit export it
// would be a global SCRIPT under tsconfig.test.json and its `RegisteredHandlers`
// / `setup` would collide with the sibling systemHandlers suite (TS2374 /
// TS2393). Caught by `npm run type-check:tests`, which is its own CI step and
// which `npm run type-check` does NOT cover.
export {};
