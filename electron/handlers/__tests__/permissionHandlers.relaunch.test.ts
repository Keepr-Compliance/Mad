/**
 * @jest-environment node
 *
 * Permission Handlers — relaunch-app IPC (BACKLOG-1842)
 *
 * Pins the clean-relaunch contract used to recover from the FDA-grant force-quit:
 *   - Packaged build: `relaunch-app` calls app.relaunch() then app.exit(0)
 *     (non-destructive — NO data wipe, mirrors resetService.relaunchApp).
 *   - E2E/dev harness (!app.isPackaged && KEEPR_E2E=1): suppressed — must NOT
 *     call relaunch/exit (that would kill the QA driver). Returns relaunched:false.
 *
 * permissionHandlers uses a module-level `handlersRegistered` guard, so each test
 * isolates the module to re-register against a fresh electron mock + env.
 */

const mockRelaunch = jest.fn();
const mockExit = jest.fn();

interface AppMock {
  isPackaged: boolean;
  relaunch: jest.Mock;
  exit: jest.Mock;
  getPath: jest.Mock;
  getName: jest.Mock;
}

const appMock: AppMock = {
  isPackaged: true,
  relaunch: mockRelaunch,
  exit: mockExit,
  getPath: jest.fn(() => "/Applications/Keepr.app/Contents/MacOS/Keepr"),
  getName: jest.fn(() => "Keepr"),
};

/**
 * Register the handlers fresh against the current appMock/env and return the
 * captured `relaunch-app` handler.
 */
function loadRelaunchHandler(): () => { relaunched: boolean } {
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

  jest.doMock("../../services/logService", () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));

  let handler!: () => { relaunched: boolean };
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerPermissionHandlers } = require("../permissionHandlers");
    registerPermissionHandlers();
    handler = registered["relaunch-app"] as () => { relaunched: boolean };
  });
  return handler;
}

describe("permissionHandlers — relaunch-app (BACKLOG-1842)", () => {
  const ORIGINAL_E2E = process.env.KEEPR_E2E;

  beforeEach(() => {
    jest.resetModules();
    mockRelaunch.mockReset();
    mockExit.mockReset();
    appMock.isPackaged = true;
    delete process.env.KEEPR_E2E;
  });

  afterAll(() => {
    if (ORIGINAL_E2E === undefined) delete process.env.KEEPR_E2E;
    else process.env.KEEPR_E2E = ORIGINAL_E2E;
  });

  it("registers a relaunch-app handler", () => {
    const handler = loadRelaunchHandler();
    expect(typeof handler).toBe("function");
  });

  it("packaged build relaunches: app.relaunch() then app.exit(0)", () => {
    appMock.isPackaged = true;
    const handler = loadRelaunchHandler();

    const result = handler();

    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(result).toEqual({ relaunched: true });
  });

  it("E2E/dev harness (!isPackaged && KEEPR_E2E=1): suppressed — never kills the process", () => {
    appMock.isPackaged = false;
    process.env.KEEPR_E2E = "1";
    const handler = loadRelaunchHandler();

    const result = handler();

    expect(mockRelaunch).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
    expect(result).toEqual({ relaunched: false });
  });

  it("plain dev (!isPackaged, KEEPR_E2E unset) still relaunches — flow stays testable", () => {
    appMock.isPackaged = false;
    delete process.env.KEEPR_E2E;
    const handler = loadRelaunchHandler();

    const result = handler();

    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(result).toEqual({ relaunched: true });
  });
});
