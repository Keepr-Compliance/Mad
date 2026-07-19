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

// BACKLOG-2112: handlers inject the BACKLOG-2113 lifecycle log call as the
// `beforeWipe` seam. Mock those so we can assert the wiring (which log fn is
// used, and that the user's reason is threaded through).
const mockLogResetEvent = jest.fn();
const mockLogUninstallEvent = jest.fn();
jest.mock("../../services/lifecycleEventService", () => ({
  logResetEvent: (...args: unknown[]) => mockLogResetEvent(...args),
  logUninstallEvent: (...args: unknown[]) => mockLogUninstallEvent(...args),
}));

import { registerAppCleanupHandlers } from "../appCleanupHandlers";

/** Extract the single CleanupOptions arg passed to runCleanup. */
function lastRunCleanupOptions(): {
  mode: "reset" | "uninstall";
  beforeWipe?: () => Promise<void>;
} {
  return mockRunCleanup.mock.calls[mockRunCleanup.mock.calls.length - 1][0];
}

describe("appCleanupHandlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    mockRunCleanup.mockResolvedValue({ success: true, mode: "reset" });
    mockLogResetEvent.mockResolvedValue(undefined);
    mockLogUninstallEvent.mockResolvedValue(undefined);
    registerAppCleanupHandlers();
  });

  it("registers exactly the app-cleanup:reset and app-cleanup:uninstall channels", () => {
    expect(new Set(Object.keys(registeredHandlers))).toEqual(
      new Set(["app-cleanup:reset", "app-cleanup:uninstall"]),
    );
  });

  it("app-cleanup:reset delegates to runCleanup with mode 'reset' and a beforeWipe seam", async () => {
    mockRunCleanup.mockResolvedValue({ success: true, mode: "reset" });
    const result = await registeredHandlers["app-cleanup:reset"]({});
    const opts = lastRunCleanupOptions();
    expect(opts.mode).toBe("reset");
    expect(typeof opts.beforeWipe).toBe("function");
    expect(result).toEqual({ success: true, mode: "reset" });
  });

  it("app-cleanup:uninstall delegates to runCleanup with mode 'uninstall' and a beforeWipe seam", async () => {
    mockRunCleanup.mockResolvedValue({ success: true, mode: "uninstall" });
    const result = await registeredHandlers["app-cleanup:uninstall"]({});
    const opts = lastRunCleanupOptions();
    expect(opts.mode).toBe("uninstall");
    expect(typeof opts.beforeWipe).toBe("function");
    expect(result).toEqual({ success: true, mode: "uninstall" });
  });

  it("reset beforeWipe invokes logResetEvent with the threaded reason", async () => {
    await registeredHandlers["app-cleanup:reset"]({}, { reason: "privacy" });
    // Invoke the injected seam exactly as the engine would.
    await lastRunCleanupOptions().beforeWipe?.();
    expect(mockLogResetEvent).toHaveBeenCalledTimes(1);
    expect(mockLogResetEvent).toHaveBeenCalledWith("privacy");
    expect(mockLogUninstallEvent).not.toHaveBeenCalled();
  });

  it("uninstall beforeWipe invokes logUninstallEvent with the threaded reason", async () => {
    await registeredHandlers["app-cleanup:uninstall"](
      {},
      { reason: "switching-device" },
    );
    await lastRunCleanupOptions().beforeWipe?.();
    expect(mockLogUninstallEvent).toHaveBeenCalledTimes(1);
    expect(mockLogUninstallEvent).toHaveBeenCalledWith("switching-device");
    expect(mockLogResetEvent).not.toHaveBeenCalled();
  });

  it("threads an undefined reason when no payload is provided", async () => {
    await registeredHandlers["app-cleanup:reset"]({});
    await lastRunCleanupOptions().beforeWipe?.();
    expect(mockLogResetEvent).toHaveBeenCalledWith(undefined);
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
