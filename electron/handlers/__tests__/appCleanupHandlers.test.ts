/**
 * @jest-environment node
 *
 * App Cleanup Handlers Tests
 * BACKLOG-2111: App-data cleanup engine + detached uninstall helper.
 *
 * Pins the IPC contract: the two channels register, wrapHandler surrounds them,
 * and each delegates to appCleanupService.runCleanup with the correct mode.
 */

const registeredHandlers: Record<string, Function> = {};
const mockIpcHandle = jest.fn((channel: string, handler: Function) => {
  registeredHandlers[channel] = handler;
});

jest.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) =>
      mockIpcHandle(...(args as [string, Function])),
  },
}));

jest.mock("@sentry/electron/main", () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockRunCleanup = jest.fn();
jest.mock("../../services/appCleanupService", () => ({
  runCleanup: (...args: unknown[]) => mockRunCleanup(...args),
}));

import { registerAppCleanupHandlers } from "../appCleanupHandlers";

describe("appCleanupHandlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    registerAppCleanupHandlers();
  });

  it("registers exactly the app-cleanup:reset and app-cleanup:uninstall channels", () => {
    expect(new Set(Object.keys(registeredHandlers))).toEqual(
      new Set(["app-cleanup:reset", "app-cleanup:uninstall"]),
    );
  });

  it("app-cleanup:reset delegates to runCleanup with mode 'reset'", async () => {
    mockRunCleanup.mockResolvedValue({ success: true, mode: "reset" });
    const result = await registeredHandlers["app-cleanup:reset"]({});
    expect(mockRunCleanup).toHaveBeenCalledWith({ mode: "reset" });
    expect(result).toEqual({ success: true, mode: "reset" });
  });

  it("app-cleanup:uninstall delegates to runCleanup with mode 'uninstall'", async () => {
    mockRunCleanup.mockResolvedValue({ success: true, mode: "uninstall" });
    const result = await registeredHandlers["app-cleanup:uninstall"]({});
    expect(mockRunCleanup).toHaveBeenCalledWith({ mode: "uninstall" });
    expect(result).toEqual({ success: true, mode: "uninstall" });
  });

  it("surfaces a thrown service error as a { success:false } result (wrapHandler)", async () => {
    mockRunCleanup.mockRejectedValue(new Error("boom"));
    const result = await registeredHandlers["app-cleanup:reset"]({});
    expect(result).toEqual({ success: false, error: "boom" });
  });

  it("passes through a typed dev-build refusal result unchanged", async () => {
    mockRunCleanup.mockResolvedValue({
      success: false,
      mode: "uninstall",
      error: "App cleanup is disabled in development builds ...",
    });
    const result = await registeredHandlers["app-cleanup:uninstall"]({});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/development/i);
  });
});
