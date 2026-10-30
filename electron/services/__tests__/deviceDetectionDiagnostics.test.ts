/**
 * Unit tests for DeviceDetectionService diagnostic chain and Sentry reporting
 * Tests runDiagnosticChain() and Sentry breadcrumb/message integration
 */

import { EventEmitter } from "events";

// Mock Sentry before importing anything
const mockAddBreadcrumb = jest.fn();
const mockCaptureMessage = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: (...args: unknown[]) => mockAddBreadcrumb(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

// Mock child_process before importing the service
const mockSpawn = jest.fn();
const mockExec = jest.fn();
jest.mock("child_process", () => ({
  // BACKLOG-3996: the --version probe is a spawn now; its answer still comes from mockExec.
  spawn: (...args: unknown[]) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./helpers/versionProbeViaExec-3996").routeSpawn(args, mockSpawn, mockExec),
  exec: (...args: unknown[]) => mockExec(...args),
}));

// Mock electron-log
jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Import after mocks are set up
import { DeviceDetectionService } from "../deviceDetectionService";
import type { DeviceDetectionDiagnostic } from "../deviceDetectionService";

// Valid UDID formats for testing (TASK-601 security requirement)
const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

// Helper to create a mock process
function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe("DeviceDetectionService - Diagnostic Chain", () => {
  let service: DeviceDetectionService;
  let originalPlatform: PropertyDescriptor | undefined;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    delete process.env.MOCK_DEVICE;
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    service = new DeviceDetectionService();
  });

  afterEach(() => {
    service.stop();
    process.env = originalEnv;
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  describe("runDiagnosticChain", () => {
    it("should succeed when tools available and device found", async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (
            err: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callback(null, { stdout: "1.3.0", stderr: "" });
        },
      );

      const listProcess = createMockProcess();
      const infoProcess = createMockProcess();

      let spawnCallCount = 0;
      mockSpawn.mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount === 1) return listProcess;
        return infoProcess;
      });

      const promise = service.runDiagnosticChain();

      await new Promise((resolve) => setTimeout(resolve, 10));

      listProcess.stdout.emit("data", `${TEST_UDID}\n`);
      listProcess.emit("close", 0);

      await new Promise((resolve) => setTimeout(resolve, 10));

      infoProcess.stdout.emit(
        "data",
        "DeviceName: Test iPhone\nProductType: iPhone14,2\nProductVersion: 17.0\nSerialNumber: ABC123456789\n",
      );
      infoProcess.emit("close", 0);

      const result: DeviceDetectionDiagnostic = await promise;

      expect(result.overallStatus).toBe("success");
      expect(result.connectedDeviceCount).toBe(1);
      expect(result.platform).toBe(process.platform);
      expect(result.steps).toHaveLength(4);

      expect(result.steps[0]).toMatchObject({ name: "platform_check", status: "pass" });
      expect(result.steps[1]).toMatchObject({ name: "libimobiledevice_check", status: "pass" });
      expect(result.steps[2]).toMatchObject({ name: "device_enumeration", status: "pass" });
      expect(result.steps[3]).toMatchObject({ name: "device_info", status: "pass" });

      // Verify Sentry breadcrumbs were added
      expect(mockAddBreadcrumb).toHaveBeenCalled();
      const breadcrumbCalls = mockAddBreadcrumb.mock.calls;
      expect(
        breadcrumbCalls.some(
          (call: [{ category: string }]) => call[0].category === "diagnostics.device",
        ),
      ).toBe(true);

      // Should NOT captureMessage on success
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it("should return partial when tools available but no device found", async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (
            err: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callback(null, { stdout: "1.3.0", stderr: "" });
        },
      );

      const listProcess = createMockProcess();
      mockSpawn.mockReturnValue(listProcess);

      const promise = service.runDiagnosticChain();

      await new Promise((resolve) => setTimeout(resolve, 10));

      listProcess.stdout.emit("data", "");
      listProcess.emit("close", 0);

      const result = await promise;

      expect(result.overallStatus).toBe("partial");
      expect(result.connectedDeviceCount).toBe(0);
      expect(result.steps).toHaveLength(4);

      expect(result.steps[0]).toMatchObject({ name: "platform_check", status: "pass" });
      expect(result.steps[1]).toMatchObject({ name: "libimobiledevice_check", status: "pass" });
      expect(result.steps[2]).toMatchObject({ name: "device_enumeration", status: "fail" });
      expect(result.steps[2].error).toBe("No devices detected via USB");
      expect(result.steps[3]).toMatchObject({ name: "device_info", status: "skip" });

      // captureMessage NOT called for partial (has some passes)
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it("should return partial when tools are not available", async () => {
      mockExec.mockImplementation(
        (_cmd: string, callback: (err: Error | null) => void) => {
          callback(new Error("command not found"));
        },
      );

      const result = await service.runDiagnosticChain();

      expect(result.overallStatus).toBe("partial");
      expect(result.connectedDeviceCount).toBe(0);
      expect(result.steps).toHaveLength(4);

      expect(result.steps[0]).toMatchObject({ name: "platform_check", status: "pass" });
      expect(result.steps[1]).toMatchObject({ name: "libimobiledevice_check", status: "fail" });
      expect(result.steps[1].error).toBe("libimobiledevice CLI tools not available");
      expect(result.steps[2]).toMatchObject({ name: "device_enumeration", status: "skip" });
      expect(result.steps[3]).toMatchObject({ name: "device_info", status: "skip" });

      // captureMessage NOT called for partial
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it("should handle listDevices spawn error gracefully", async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (
            err: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callback(null, { stdout: "1.3.0", stderr: "" });
        },
      );

      const listProcess = createMockProcess();
      mockSpawn.mockReturnValue(listProcess);

      const promise = service.runDiagnosticChain();

      await new Promise((resolve) => setTimeout(resolve, 10));

      listProcess.emit("error", new Error("ENOENT"));

      const result = await promise;

      expect(result.connectedDeviceCount).toBe(0);
      expect(
        result.steps.find((s) => s.name === "device_enumeration"),
      ).toMatchObject({ status: "fail" });
    });

    it("should fail on unsupported platform", async () => {
      Object.defineProperty(process, "platform", { value: "freebsd" });

      const result = await service.runDiagnosticChain();

      expect(result.overallStatus).toBe("failed");
      expect(result.connectedDeviceCount).toBe(0);
      expect(result.steps).toHaveLength(4);

      expect(result.steps[0]).toMatchObject({
        name: "platform_check",
        status: "fail",
        error: expect.stringContaining("Unsupported platform"),
      });
      expect(result.steps[1]).toMatchObject({ name: "libimobiledevice_check", status: "skip" });
      expect(result.steps[2]).toMatchObject({ name: "device_enumeration", status: "skip" });
      expect(result.steps[3]).toMatchObject({ name: "device_info", status: "skip" });

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        "Device detection diagnostic failed",
        expect.objectContaining({
          level: "warning",
          tags: expect.objectContaining({ diagnostic: "device_detection" }),
        }),
      );
    });

    it("should include timing info in each step", async () => {
      mockExec.mockImplementation(
        (_cmd: string, callback: (err: Error | null) => void) => {
          callback(new Error("not found"));
        },
      );

      const result = await service.runDiagnosticChain();

      for (const step of result.steps) {
        expect(typeof step.durationMs).toBe("number");
        expect(step.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("should report device count in info step detail", async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (
            err: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callback(null, { stdout: "1.3.0", stderr: "" });
        },
      );

      const listProcess = createMockProcess();
      const infoProcess = createMockProcess();

      let spawnCallCount = 0;
      mockSpawn.mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount === 1) return listProcess;
        return infoProcess;
      });

      const promise = service.runDiagnosticChain();

      await new Promise((resolve) => setTimeout(resolve, 10));

      listProcess.stdout.emit("data", `${TEST_UDID}\n`);
      listProcess.emit("close", 0);

      await new Promise((resolve) => setTimeout(resolve, 10));

      infoProcess.stdout.emit(
        "data",
        "DeviceName: Test iPhone\nProductType: iPhone14,2\nProductVersion: 17.0\nSerialNumber: ABC123456789\n",
      );
      infoProcess.emit("close", 0);

      const result = await promise;

      const infoStep = result.steps.find(
        (s) => s.name === "device_info" && s.status === "pass",
      );
      expect(infoStep).toBeDefined();
      expect(infoStep!.detail).toContain("1/1");
    });

    it("should handle device info failure gracefully", async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (
            err: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callback(null, { stdout: "1.3.0", stderr: "" });
        },
      );

      const listProcess = createMockProcess();
      const infoProcess = createMockProcess();

      let spawnCallCount = 0;
      mockSpawn.mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount === 1) return listProcess;
        return infoProcess;
      });

      const promise = service.runDiagnosticChain();

      await new Promise((resolve) => setTimeout(resolve, 10));

      listProcess.stdout.emit("data", `${TEST_UDID}\n`);
      listProcess.emit("close", 0);

      await new Promise((resolve) => setTimeout(resolve, 10));

      infoProcess.stderr.emit("data", "ERROR: Could not connect to lockdownd");
      infoProcess.emit("close", 1);

      const result = await promise;

      expect(result.overallStatus).toBe("partial");
      expect(result.connectedDeviceCount).toBe(0);

      const infoStep = result.steps.find(
        (s) => s.name === "device_info" && s.status === "fail",
      );
      expect(infoStep).toBeDefined();
      expect(infoStep!.error).toBe("Failed to get info for any device");
    });

    it("should add Sentry breadcrumbs for each step plus summary", async () => {
      mockExec.mockImplementation(
        (_cmd: string, callback: (err: Error | null) => void) => {
          callback(new Error("not found"));
        },
      );

      await service.runDiagnosticChain();

      const diagnosticBreadcrumbs = mockAddBreadcrumb.mock.calls.filter(
        (call: [{ category: string }]) => call[0].category === "diagnostics.device",
      );
      // 4 steps + 1 summary = 5 breadcrumbs
      expect(diagnosticBreadcrumbs.length).toBe(5);
    });
  });

  describe("Sentry breadcrumbs on pollDevices connect/disconnect", () => {
    it("should add Sentry breadcrumb when device connects", async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (
            err: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callback(null, { stdout: "1.3.0", stderr: "" });
        },
      );

      const listProcess = createMockProcess();
      const infoProcess = createMockProcess();

      let spawnCallCount = 0;
      mockSpawn.mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount === 1) return listProcess;
        return infoProcess;
      });

      const pollPromise = (
        service as unknown as { pollDevices: () => Promise<void> }
      ).pollDevices();

      await new Promise((resolve) => setTimeout(resolve, 10));

      listProcess.stdout.emit("data", `${TEST_UDID}\n`);
      listProcess.emit("close", 0);

      await new Promise((resolve) => setTimeout(resolve, 10));

      infoProcess.stdout.emit(
        "data",
        "DeviceName: Test iPhone\nProductType: iPhone14,2\nProductVersion: 17.0\nSerialNumber: ABC123456789\n",
      );
      infoProcess.emit("close", 0);

      await pollPromise;

      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "device.connect",
          message: expect.stringContaining("Test iPhone"),
          data: expect.objectContaining({
            udid: "a1b2c3d4...",
            productType: "iPhone14,2",
          }),
        }),
      );
    });

    it("should add Sentry breadcrumb when device disconnects", async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (
            err: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callback(null, { stdout: "1.3.0", stderr: "" });
        },
      );

      const listProcess1 = createMockProcess();
      const infoProcess = createMockProcess();

      let spawnCallCount = 0;
      mockSpawn.mockImplementation(() => {
        spawnCallCount++;
        if (spawnCallCount === 1) return listProcess1;
        return infoProcess;
      });

      const poll1 = (
        service as unknown as { pollDevices: () => Promise<void> }
      ).pollDevices();

      await new Promise((resolve) => setTimeout(resolve, 10));

      listProcess1.stdout.emit("data", `${TEST_UDID}\n`);
      listProcess1.emit("close", 0);

      await new Promise((resolve) => setTimeout(resolve, 10));

      infoProcess.stdout.emit(
        "data",
        "DeviceName: Test iPhone\nProductType: iPhone14,2\nProductVersion: 17.0\nSerialNumber: ABC123456789\n",
      );
      infoProcess.emit("close", 0);

      await poll1;

      mockAddBreadcrumb.mockClear();

      const listProcess2 = createMockProcess();
      spawnCallCount = 0;
      mockSpawn.mockImplementation(() => {
        return listProcess2;
      });

      const poll2 = (
        service as unknown as { pollDevices: () => Promise<void> }
      ).pollDevices();

      await new Promise((resolve) => setTimeout(resolve, 10));

      listProcess2.stdout.emit("data", "");
      listProcess2.emit("close", 0);

      await poll2;

      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "device.disconnect",
          message: expect.stringContaining("Test iPhone"),
        }),
      );
    });
  });

  describe("Sentry breadcrumb on listDevices error", () => {
    it("should add Sentry breadcrumb when idevice_id fails with stderr", async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (
            err: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callback(null, { stdout: "1.3.0", stderr: "" });
        },
      );

      const listProcess = createMockProcess();
      mockSpawn.mockReturnValue(listProcess);

      const promise = service.listDevices();

      await new Promise((resolve) => setTimeout(resolve, 10));

      listProcess.stderr.emit("data", "ERROR: No device found!");
      listProcess.emit("close", 1);

      await promise;

      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "device.detection",
          message: expect.stringContaining("idevice_id failed with code 1"),
          level: "warning",
          data: expect.objectContaining({
            exitCode: 1,
            stderr: expect.stringContaining("ERROR: No device found!"),
          }),
        }),
      );
    });

    it("should not add Sentry breadcrumb when idevice_id fails without stderr", async () => {
      mockExec.mockImplementation(
        (
          _cmd: string,
          callback: (
            err: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          callback(null, { stdout: "1.3.0", stderr: "" });
        },
      );

      const listProcess = createMockProcess();
      mockSpawn.mockReturnValue(listProcess);

      const promise = service.listDevices();

      await new Promise((resolve) => setTimeout(resolve, 10));

      listProcess.emit("close", 1);

      await promise;

      const detectionBreadcrumbs = mockAddBreadcrumb.mock.calls.filter(
        (call: [{ category: string }]) => call[0].category === "device.detection",
      );
      expect(detectionBreadcrumbs).toHaveLength(0);
    });
  });
});
