/**
 * @jest-environment node
 */

/**
 * Unit tests for libimobiledeviceService
 * Tests binary path resolution for Windows libimobiledevice tools
 */


// Store original platform
const originalPlatform = process.platform;

// Mock electron module
jest.mock("electron", () => ({
  app: {
    isPackaged: false,
  },
}));

// Mock electron-log
jest.mock("electron-log", () => ({
  debug: jest.fn(),
  error: jest.fn(),
}));

// Mock fs module
jest.mock("fs", () => ({
  existsSync: jest.fn(),
}));

describe("libimobiledeviceService", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore original platform
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
    });
  });

  describe("getLibimobiledevicePath", () => {
    it("should throw error when not on Windows", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
      });

      const { getLibimobiledevicePath } =
        await import("../libimobiledeviceService");

      expect(() => getLibimobiledevicePath()).toThrow(
        "libimobiledevice binaries only available on Windows",
      );
    });

    it("should return dev path when app is not packaged", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
      });

      jest.doMock("electron", () => ({
        app: {
          isPackaged: false,
        },
      }));

      const { getLibimobiledevicePath } =
        await import("../libimobiledeviceService");
      const result = getLibimobiledevicePath();

      expect(result).toContain("resources");
      expect(result).toContain("win");
      expect(result).toContain("libimobiledevice");
    });

    it("should return production path when app is packaged", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
      });

      // Set resourcesPath for production
      Object.defineProperty(process, "resourcesPath", {
        value: "/app/resources",
        configurable: true,
      });

      jest.doMock("electron", () => ({
        app: {
          isPackaged: true,
        },
      }));

      jest.resetModules();
      const { getLibimobiledevicePath } =
        await import("../libimobiledeviceService");
      const result = getLibimobiledevicePath();

      expect(result).toContain("win");
      expect(result).toContain("libimobiledevice");
    });
  });

  describe("getExecutablePath", () => {
    it("should return path with .exe extension", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
      });

      const { getExecutablePath } = await import("../libimobiledeviceService");
      const result = getExecutablePath("idevice_id");

      expect(result).toContain("idevice_id.exe");
    });

    it("should throw error on non-Windows platform", async () => {
      Object.defineProperty(process, "platform", {
        value: "linux",
      });

      jest.resetModules();
      const { getExecutablePath } = await import("../libimobiledeviceService");

      expect(() => getExecutablePath("idevice_id")).toThrow(
        "libimobiledevice binaries only available on Windows",
      );
    });
  });

  describe("areBinariesAvailable", () => {
    it("should return false on non-Windows platform", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
      });

      jest.resetModules();
      const { areBinariesAvailable } =
        await import("../libimobiledeviceService");
      const result = areBinariesAvailable();

      expect(result).toBe(false);
    });

    it("should return true when binaries directory exists", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
      });

      jest.resetModules();

      // Re-mock fs after resetModules
      jest.doMock("fs", () => ({
        existsSync: jest.fn().mockReturnValue(true),
      }));

      const { areBinariesAvailable } =
        await import("../libimobiledeviceService");
      const result = areBinariesAvailable();

      expect(result).toBe(true);
    });

    it("should return false when binaries directory does not exist", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
      });

      jest.resetModules();

      // Re-mock fs after resetModules
      jest.doMock("fs", () => ({
        existsSync: jest.fn().mockReturnValue(false),
      }));

      const { areBinariesAvailable } =
        await import("../libimobiledeviceService");
      const result = areBinariesAvailable();

      expect(result).toBe(false);
    });
  });

  describe("REQUIRED_EXECUTABLES", () => {
    it("should contain expected executables", async () => {
      const { REQUIRED_EXECUTABLES } =
        await import("../libimobiledeviceService");

      expect(REQUIRED_EXECUTABLES).toContain("idevice_id");
      expect(REQUIRED_EXECUTABLES).toContain("ideviceinfo");
      expect(REQUIRED_EXECUTABLES).toContain("idevicebackup2");
      expect(REQUIRED_EXECUTABLES).toHaveLength(3);
    });
  });
});

// BACKLOG-2414: marks this file as a MODULE for TypeScript. Without it the suite
// is a global script, so its top-level `const mockPlatform` / `originalPlatform`
// collide with the identically-named consts in the sibling service suites
// (TS2451 "Cannot redeclare block-scoped variable"). Jest already evaluates each
// test file in its own scope, so this is a compile-time scoping fix only.
export {};
