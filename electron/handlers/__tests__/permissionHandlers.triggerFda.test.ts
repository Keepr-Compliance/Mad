/**
 * @jest-environment node
 *
 * Permission Handlers — trigger-full-disk-access IPC (BACKLOG-2184, BACKLOG-2192)
 *
 * Pins the TCC-registration fix: on macOS, fs.access()/fs.stat() against a
 * TCC-protected path (e.g. ~/Library/Messages/chat.db) return EPERM WITHOUT
 * ever registering the app in System Settings > Privacy & Security > Full
 * Disk Access. Only a genuine open() syscall causes macOS to add the app to
 * that list (toggled off, awaiting the user to grant it).
 *
 * BACKLOG-2192 escalates the trigger from open()+close() to
 * open() -> read 1 byte -> close(), and adds logging of the outcome. This test
 * pins that exact fs sequence, confirms the return shape
 * (`{ triggered, alreadyGranted }`) is unchanged, confirms the expected EPERM
 * (not-yet-granted) case is CAUGHT + LOGGED and does NOT throw, and keeps the
 * platform-agnostic path assertion (path.join, not a hardcoded POSIX string —
 * BACKLOG-2036) so it also passes on Windows CI.
 *
 * permissionHandlers uses a module-level `handlersRegistered` guard, so each
 * test isolates the module to re-register against a fresh electron/fs mock.
 */

import path from "path";

const mockOpen = jest.fn();

// Shared logService mock so tests can assert the BACKLOG-2192 log lines. Reset
// in beforeEach; injected into the isolated module via jest.doMock below.
const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

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
    default: mockLog,
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

describe("permissionHandlers — trigger-full-disk-access (BACKLOG-2184, BACKLOG-2192)", () => {
  const ORIGINAL_HOME = process.env.HOME;

  beforeEach(() => {
    jest.resetModules();
    mockOpen.mockReset();
    mockLog.info.mockReset();
    mockLog.warn.mockReset();
    mockLog.error.mockReset();
    mockLog.debug.mockReset();
    process.env.HOME = "/Users/testuser";
  });

  afterAll(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
  });

  /** A resolved fs.FileHandle mock exposing read()+close() (BACKLOG-2192). */
  function makeGrantedHandle(): { read: jest.Mock; close: jest.Mock } {
    return {
      read: jest.fn().mockResolvedValue({ bytesRead: 1 }),
      close: jest.fn().mockResolvedValue(undefined),
    };
  }

  it("registers a trigger-full-disk-access handler", () => {
    const handler = loadTriggerFdaHandler();
    expect(typeof handler).toBe("function");
  });

  it("calls fs.open (not fs.access) against the Messages chat.db path, then reads 1 byte and closes", async () => {
    const handle = makeGrantedHandle();
    mockOpen.mockResolvedValue(handle);

    const handler = loadTriggerFdaHandler();
    await handler();

    // Build the expected path the same way the handler does (path.join under
    // process.env.HOME). Asserting a hardcoded POSIX string would fail on
    // Windows CI, where path.join uses backslash separators
    // (\Users\testuser\Library\Messages\chat.db) — the handler's path
    // construction is platform-native, so the assertion must be too.
    const expectedPath = path.join(
      "/Users/testuser",
      "Library/Messages/chat.db"
    );
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen).toHaveBeenCalledWith(expectedPath, "r");

    // BACKLOG-2192: the 1-byte read forces the kernel to perform the protected
    // I/O so tccd reliably registers the app.
    expect(handle.read).toHaveBeenCalledTimes(1);
    expect(handle.read).toHaveBeenCalledWith(expect.any(Buffer), 0, 1, 0);
    expect(handle.close).toHaveBeenCalledTimes(1);

    // The target path is logged so a fresh-install log shows what was attempted.
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining("Triggering Full Disk Access"),
      "PermissionHandlers",
      expect.objectContaining({ path: expectedPath })
    );
  });

  it("FDA not yet granted: fs.open rejects with EPERM -> caught + logged, does NOT throw, returns triggered:true, alreadyGranted:false", async () => {
    const epermError = Object.assign(new Error("Operation not permitted"), {
      code: "EPERM",
    });
    mockOpen.mockRejectedValue(epermError);

    const handler = loadTriggerFdaHandler();

    // The denial must NOT surface as a thrown/rejected promise.
    await expect(handler()).resolves.toEqual({
      triggered: true,
      alreadyGranted: false,
    });

    // The exact EPERM code is logged so the next install's log is diagnosable.
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.any(String),
      "PermissionHandlers",
      expect.objectContaining({ code: "EPERM" })
    );
  });

  it("FDA granted but the 1-byte read rejects with EPERM -> caught + logged, does NOT throw, alreadyGranted:false", async () => {
    // open() can succeed while the protected read still fails on a partially
    // granted / racing TCC state — that error must also be swallowed and the
    // file handle still closed.
    const epermError = Object.assign(new Error("Operation not permitted"), {
      code: "EPERM",
    });
    const handle = {
      read: jest.fn().mockRejectedValue(epermError),
      close: jest.fn().mockResolvedValue(undefined),
    };
    mockOpen.mockResolvedValue(handle);

    const handler = loadTriggerFdaHandler();

    await expect(handler()).resolves.toEqual({
      triggered: true,
      alreadyGranted: false,
    });
    // The handle is closed even when the read throws (finally block).
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.any(String),
      "PermissionHandlers",
      expect.objectContaining({ code: "EPERM" })
    );
  });

  it("FDA already granted: fs.open + read resolve -> returns triggered:true, alreadyGranted:true and logs success", async () => {
    const handle = makeGrantedHandle();
    mockOpen.mockResolvedValue(handle);

    const handler = loadTriggerFdaHandler();
    const result = await handler();

    expect(result).toEqual({ triggered: true, alreadyGranted: true });
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining("SUCCEEDED"),
      "PermissionHandlers"
    );
  });
});
