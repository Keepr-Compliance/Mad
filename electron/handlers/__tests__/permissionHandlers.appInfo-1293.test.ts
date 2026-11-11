/**
 * @jest-environment node
 *
 * BACKLOG-1293 — "get-app-info" returns the app version, which the account
 * side panel shows at its bottom. Before this, the handler returned only
 * { name, path, pid } and the renderer had no version to show.
 */

const appInfoAppMock = {
  isPackaged: true,
  getPath: jest.fn(() => "/Applications/Keepr.app/Contents/MacOS/Keepr"),
  getName: jest.fn(() => "Keepr"),
  getVersion: jest.fn(() => "2.46.2"),
};

function loadAppInfoHandler(): () => Record<string, unknown> {
  const registered: Record<string, (...a: unknown[]) => unknown> = {};
  jest.doMock("electron", () => ({
    ipcMain: {
      handle: (channel: string, handler: (...a: unknown[]) => unknown) => {
        registered[channel] = handler;
      },
    },
    app: appInfoAppMock,
    shell: { openExternal: jest.fn() },
  }));
  jest.doMock("../../services/logService", () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));
  jest.doMock("../../services/sessionService", () => ({ __esModule: true, default: {} }));
  jest.doMock("../../services/supabaseService", () => ({ __esModule: true, default: {} }));
  jest.doMock("../../services/databaseService", () => ({ __esModule: true, default: {} }));

  let handler!: () => Record<string, unknown>;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerPermissionHandlers } = require("../permissionHandlers");
    registerPermissionHandlers();
    handler = registered["get-app-info"] as () => Record<string, unknown>;
  });
  return handler;
}

describe("permissionHandlers — get-app-info (BACKLOG-1293)", () => {
  beforeEach(() => jest.resetModules());

  it("includes the app version alongside name, path and pid", () => {
    const info = loadAppInfoHandler()();
    expect(info).toEqual({
      name: "Keepr",
      version: "2.46.2",
      path: "/Applications/Keepr.app/Contents/MacOS/Keepr",
      pid: process.pid,
    });
  });
});
