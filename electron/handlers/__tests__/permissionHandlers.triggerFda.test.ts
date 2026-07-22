/**
 * @jest-environment node
 *
 * Permission Handlers — trigger-full-disk-access IPC (BACKLOG-2184)
 *
 * Pins the TCC-registration fix: on macOS, fs.access()/fs.stat() against a
 * TCC-protected path (e.g. ~/Library/Messages/chat.db) return EPERM WITHOUT
 * ever registering the app in System Settings > Privacy & Security > Full
 * Disk Access. Only a genuine open() syscall causes macOS to add the app to
 * that list (toggled off, awaiting the user to grant it). The handler must
 * therefore call fs.open()+close() instead of fs.access() -- this test pins
 * that exact fs call and confirms the return shape (`{ triggered, alreadyGranted }`)
 * is unchanged and the expected EPERM (not-yet-granted) case is swallowed.
 *
 * permissionHandlers uses a module-level `handlersRegistered` guard, so each
 * test isolates the module to re-register against a fresh electron/fs mock.
 */

const mockOpen = jest.fn();

interface AppMock {
  isPackaged: boolean;
  getPath: jest.Mock;
  getName: jest.Mock;
}

const appMock: AppMock = {
  isPackaged: true,
  getPath: jest.fn(() => "/Applications/Keepr.app/Contents/MacOS/Keepr"),
  getName: jest.fn(() => "Keepr"),
};

/**
 * Register the handlers fresh against the current appMock/fs mock and return
 * the captured `trigger-full-disk-access` handler.
 */
function loadTriggerFdaHandler(): () => Promise<{
  triggered: boolean;
  alreadyGranted: boolean;
}> {
  const registered: Record<string, (...a: unknown[]) => unknown> = {};

  jest.doMock("electron", () => ({
    ipcMain: {
      handle: (channel: string, handler: (...a: unknown[]) => unknown) => {
        registered[channel] = handler;
      },
    },
    app: appMock,
    shell: { openExternal: jest.fn() },
  }));

  jest.doMock("fs", () => ({
    promises: {
      open: mockOpen,
      access: jest.fn(),
      constants: { R_OK: 4 },
    },
    constants: { R_OK: 4 },
  }));

  jest.doMock("../../services/logService", () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));

  jest.doMock("../../services/sessionService", () => ({
    __esModule: true,
    default: {
      loadSession: jest.fn(),
      saveSession: jest.fn(),
      getSessionExpirationMs: jest.fn(() => 24 * 60 * 60 * 1000),
    },
  }));

  jest.doMock("../../services/supabaseService", () => ({
    __esModule: true,
    default: {
      getPreferences: jest.fn(),
      syncPreferences: jest.fn(),
      getAuthSession: jest.fn(),
    },
  }));

  jest.doMock("../../services/databaseService", () => ({
    __esModule: true,
    default: {
      getUserById: jest.fn(),
      createSession: jest.fn(),
    },
  }));

  let handler!: () => Promise<{ triggered: boolean; alreadyGranted: boolean }>;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerPermissionHandlers } = require("../permissionHandlers");
    registerPermissionHandlers();
    handler = registered["trigger-full-disk-access"] as () => Promise<{
      triggered: boolean;
      alreadyGranted: boolean;
    }>;
  });
  return handler;
}

describe("permissionHandlers — trigger-full-disk-access (BACKLOG-2184)", () => {
  const ORIGINAL_HOME = process.env.HOME;

  beforeEach(() => {
    jest.resetModules();
    mockOpen.mockReset();
    process.env.HOME = "/Users/testuser";
  });

  afterAll(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
  });

  it("registers a trigger-full-disk-access handler", () => {
    const handler = loadTriggerFdaHandler();
    expect(typeof handler).toBe("function");
  });

  it("calls fs.open (not fs.access) against the Messages chat.db path", async () => {
    const mockClose = jest.fn().mockResolvedValue(undefined);
    mockOpen.mockResolvedValue({ close: mockClose });

    const handler = loadTriggerFdaHandler();
    await handler();

    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen).toHaveBeenCalledWith(
      "/Users/testuser/Library/Messages/chat.db",
      "r"
    );
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("FDA not yet granted: fs.open rejects with EPERM -> returns triggered:true, alreadyGranted:false", async () => {
    const epermError = Object.assign(new Error("Operation not permitted"), {
      code: "EPERM",
    });
    mockOpen.mockRejectedValue(epermError);

    const handler = loadTriggerFdaHandler();
    const result = await handler();

    expect(result).toEqual({ triggered: true, alreadyGranted: false });
  });

  it("FDA already granted: fs.open resolves -> returns triggered:true, alreadyGranted:true", async () => {
    const mockClose = jest.fn().mockResolvedValue(undefined);
    mockOpen.mockResolvedValue({ close: mockClose });

    const handler = loadTriggerFdaHandler();
    const result = await handler();

    expect(result).toEqual({ triggered: true, alreadyGranted: true });
  });
});
