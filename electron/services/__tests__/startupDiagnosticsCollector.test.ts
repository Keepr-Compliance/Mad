/**
 * Tests for startup diagnostics collector (TASK-2275)
 *
 * Tests cover:
 * - collectStartupDiagnostics returns valid shape on success
 * - collectStartupDiagnostics returns fallback on disk check failure
 * - getLatestDiagnostics returns null before collection
 * - getLatestDiagnostics returns diagnostics after collection
 * - Sentry.setContext called with correct data
 * - Sentry.setTag called with disk.available_gb
 * - Apple driver check included only on win32
 * - Network status detection
 */

// Mock electron
const mockGetPath = jest.fn(() => "/mock/user/data");
const mockGetVersion = jest.fn(() => "1.2.3");
const mockNetIsOnline = jest.fn(() => true);

jest.mock("electron", () => ({
  app: {
    getPath: mockGetPath,
    getVersion: mockGetVersion,
    isPackaged: false,
  },
  net: {
    isOnline: mockNetIsOnline,
  },
}));

// Mock Sentry
const mockSetContext = jest.fn();
const mockSetTag = jest.fn();
const mockCaptureException = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  setContext: mockSetContext,
  setTag: mockSetTag,
  captureException: mockCaptureException,
}));

// Mock check-disk-space
const mockCheckDiskSpace = jest.fn();
jest.mock("check-disk-space", () => ({
  __esModule: true,
  default: mockCheckDiskSpace,
}));

// Mock electron-log
const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockLogError = jest.fn();
jest.mock("electron-log", () => ({
  __esModule: true,
  default: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
  },
}));

// Mock os
const mockOsRelease = jest.fn(() => "23.0.0");
const mockOsType = jest.fn(() => "Darwin");
const mockOsArch = jest.fn(() => "arm64");
const mockOsTotalmem = jest.fn(() => 16 * 1024 * 1024 * 1024); // 16GB
const mockOsFreemem = jest.fn(() => 8 * 1024 * 1024 * 1024); // 8GB
jest.mock("os", () => ({
  release: () => mockOsRelease(),
  type: () => mockOsType(),
  arch: () => mockOsArch(),
  totalmem: () => mockOsTotalmem(),
  freemem: () => mockOsFreemem(),
}));

// Mock appleDriverService for Windows tests
const mockCheckAppleDrivers = jest.fn();
jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: mockCheckAppleDrivers,
}));

import {
  collectStartupDiagnostics,
  getLatestDiagnostics,
  _resetDiagnosticsForTesting,
} from "../diagnostics/startupDiagnosticsCollector";

describe("startupDiagnosticsCollector", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetDiagnosticsForTesting();

    // Default: 50GB free, 500GB total
    mockCheckDiskSpace.mockResolvedValue({
      free: 50 * 1024 * 1024 * 1024,
      size: 500 * 1024 * 1024 * 1024,
    });

    mockGetPath.mockReturnValue("/mock/user/data");
    mockNetIsOnline.mockReturnValue(true);
    mockCheckAppleDrivers.mockResolvedValue({
      isInstalled: true,
      version: "14.0.0",
      serviceRunning: true,
      error: null,
    });
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  describe("getLatestDiagnostics", () => {
    it("should return null before collection", () => {
      expect(getLatestDiagnostics()).toBeNull();
    });

    it("should return diagnostics after collection", async () => {
      await collectStartupDiagnostics();

      const result = getLatestDiagnostics();
      expect(result).not.toBeNull();
      expect(result!.timestamp).toBeDefined();
      expect(result!.app.version).toBe("1.2.3");
    });
  });

  describe("collectStartupDiagnostics", () => {
    it("should return valid shape on success", async () => {
      const result = await collectStartupDiagnostics();

      // Validate all top-level keys exist
      expect(result.timestamp).toEqual(expect.any(String));
      expect(result.app.version).toBe("1.2.3");
      expect(result.app.nodeVersion).toBe(process.version);
      expect(result.app.isPackaged).toBe(false);
      expect(result.system.platform).toBe("darwin");
      expect(result.system.osRelease).toBe("23.0.0");
      expect(result.system.osType).toBe("Darwin");
      expect(result.system.arch).toBe("arm64");
      expect(result.disk.path).toBe("/mock/user/data");
      expect(result.network.status).toBe("online");
    });

    it("should populate memory values correctly", async () => {
      const result = await collectStartupDiagnostics();

      expect(result.system.totalMemoryMB).toBe(16384); // 16GB in MB
      expect(result.system.freeMemoryMB).toBe(8192); // 8GB in MB
    });

    it("should populate disk values correctly", async () => {
      const result = await collectStartupDiagnostics();

      expect(result.disk.availableMB).toBe(51200); // 50GB in MB
      expect(result.disk.totalMB).toBe(512000); // 500GB in MB
      expect(result.disk.path).toBe("/mock/user/data");
    });

    it("should detect network as online", async () => {
      mockNetIsOnline.mockReturnValue(true);

      const result = await collectStartupDiagnostics();

      expect(result.network.status).toBe("online");
    });

    it("should detect network as offline", async () => {
      mockNetIsOnline.mockReturnValue(false);

      const result = await collectStartupDiagnostics();

      expect(result.network.status).toBe("offline");
    });

    it("should fallback to unknown when net.isOnline throws", async () => {
      mockNetIsOnline.mockImplementation(() => {
        throw new Error("net not available");
      });

      const result = await collectStartupDiagnostics();

      expect(result.network.status).toBe("unknown");
    });

    it("should return diagnostics with zeroed disk when checkDiskSpace fails", async () => {
      // checkDiskSpace rejection is caught internally via .catch()
      mockCheckDiskSpace.mockRejectedValue(new Error("Permission denied"));

      const result = await collectStartupDiagnostics();

      // Disk values should be 0 (from the .catch fallback)
      expect(result.disk.availableMB).toBe(0);
      expect(result.disk.totalMB).toBe(0);
      // Rest of diagnostics should still be valid
      expect(result.app.version).toBe("1.2.3");
      expect(result.system.platform).toBe("darwin");
    });

    it("should return fallback with -1 disk values on total collection failure", async () => {
      // Force getPath to throw to trigger the outer catch
      mockGetPath.mockImplementation(() => {
        throw new Error("app not ready");
      });

      const result = await collectStartupDiagnostics();

      expect(result.disk.availableMB).toBe(-1);
      expect(result.disk.totalMB).toBe(-1);
      expect(result.disk.path).toBe("");
      expect(result.network.status).toBe("unknown");
    });

    it("should store fallback in latestDiagnostics on total collection failure", async () => {
      mockGetPath.mockImplementation(() => {
        throw new Error("app not ready");
      });

      await collectStartupDiagnostics();
      const stored = getLatestDiagnostics();

      expect(stored).not.toBeNull();
      expect(stored!.disk.availableMB).toBe(-1);
    });

    it("should log collection duration on success", async () => {
      await collectStartupDiagnostics();

      // log.info is called with a template literal string
      const infoCalls = mockLogInfo.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      const durationLog = infoCalls.find((msg: string) =>
        /\[StartupDiagnostics\] Collected in \d+ms/.test(msg),
      );
      expect(durationLog).toBeDefined();
    });

    it("should log disk space info on success", async () => {
      await collectStartupDiagnostics();

      expect(mockLogInfo).toHaveBeenCalledWith(
        "[StartupDiagnostics] Disk: 51200MB free",
      );
    });
  });

  describe("Sentry integration", () => {
    it("should call Sentry.setContext with correct data", async () => {
      await collectStartupDiagnostics();

      expect(mockSetContext).toHaveBeenCalledWith("startup_diagnostics", {
        diskAvailableMB: 51200,
        osRelease: "23.0.0",
        appVersion: "1.2.3",
        platform: "darwin",
        appleDriversInstalled: "n/a",
      });
    });

    it("should call Sentry.setTag with disk.available_gb", async () => {
      await collectStartupDiagnostics();

      // 51200MB / 1024 = 50GB
      expect(mockSetTag).toHaveBeenCalledWith("disk.available_gb", "50");
    });

    it("should call Sentry.captureException on total collection failure", async () => {
      const error = new Error("app not ready");
      mockGetPath.mockImplementation(() => {
        throw error;
      });

      await collectStartupDiagnostics();

      expect(mockCaptureException).toHaveBeenCalledWith(error, {
        tags: { component: "startup_diagnostics" },
      });
    });

    it("should NOT call Sentry.captureException on success", async () => {
      await collectStartupDiagnostics();

      expect(mockCaptureException).not.toHaveBeenCalled();
    });
  });

  describe("Apple driver check (Windows only)", () => {
    it("should NOT include appleDrivers on macOS", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      const result = await collectStartupDiagnostics();

      expect(result.appleDrivers).toBeUndefined();
    });

    it("should NOT include appleDrivers on Linux", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });

      const result = await collectStartupDiagnostics();

      expect(result.appleDrivers).toBeUndefined();
    });

    it("should include appleDrivers on win32", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      const result = await collectStartupDiagnostics();

      expect(result.appleDrivers).toEqual({
        isInstalled: true,
        version: "14.0.0",
        serviceRunning: true,
      });
    });

    it("BACKLOG-3927: startup diagnostics carry installedViaOverride only for an override session", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      mockCheckAppleDrivers.mockResolvedValue({
        isInstalled: true,
        version: "14.0.0",
        serviceRunning: true,
        error: null,
        installedVia: "msi",
        sourceOverridden: true,
      });

      const result = await collectStartupDiagnostics();

      expect(result.appleDrivers).toEqual({
        isInstalled: true,
        version: "14.0.0",
        serviceRunning: true,
        installedVia: "msi",
        installedViaOverride: true,
      });
    });

    it("should handle Apple driver check failure gracefully on win32", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      mockCheckAppleDrivers.mockRejectedValue(
        new Error("driver check failed"),
      );

      const result = await collectStartupDiagnostics();

      // Should still return valid diagnostics without appleDrivers
      expect(result.app.version).toBe("1.2.3");
      expect(result.system.platform).toBe("win32");
      expect(result.appleDrivers).toBeUndefined();
    });

    it("should log warning when Apple driver check fails on win32", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      mockCheckAppleDrivers.mockRejectedValue(
        new Error("driver check failed"),
      );

      await collectStartupDiagnostics();

      expect(mockLogWarn).toHaveBeenCalledWith(
        "[StartupDiagnostics] Failed to check Apple drivers:",
        expect.any(Error),
      );
    });

    it("should include appleDriversInstalled in Sentry context on win32", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      await collectStartupDiagnostics();

      expect(mockSetContext).toHaveBeenCalledWith(
        "startup_diagnostics",
        expect.objectContaining({
          appleDriversInstalled: true,
        }),
      );
    });
  });

  describe("never blocks startup", () => {
    it("should never throw even when everything fails", async () => {
      mockGetPath.mockImplementation(() => {
        throw new Error("app not ready");
      });

      // Should NOT throw
      const result = await collectStartupDiagnostics();
      expect(result).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });

    it("should log error on total collection failure", async () => {
      const error = new Error("app not ready");
      mockGetPath.mockImplementation(() => {
        throw error;
      });

      await collectStartupDiagnostics();

      expect(mockLogError).toHaveBeenCalledWith(
        "[StartupDiagnostics] Collection failed:",
        error,
      );
    });
  });
});
