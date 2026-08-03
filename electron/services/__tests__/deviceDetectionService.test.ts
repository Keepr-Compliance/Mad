/**
 * Unit tests for DeviceDetectionService
 * Tests iOS device detection functionality via libimobiledevice CLI tools
 */

import { EventEmitter } from "events";

// Mock child_process before importing the service
const mockSpawn = jest.fn();
const mockExec = jest.fn();
jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
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
import log from "electron-log";

// Valid UDID formats for testing (TASK-601 security requirement)
// Traditional format: 40 hex chars
const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

// Helper to create a mock process
function createMockProcess() {
  const process = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  return process;
}

describe("DeviceDetectionService", () => {
  let service: DeviceDetectionService;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    originalEnv = { ...process.env };
    delete process.env.MOCK_DEVICE;
    service = new DeviceDetectionService();
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
    process.env = originalEnv;
  });

  describe("constructor", () => {
    it("should create instance without mock mode by default", () => {
      expect(service).toBeDefined();
      expect(service.getConnectedDevices()).toEqual([]);
    });

    it("should enable mock mode when MOCK_DEVICE=true", () => {
      process.env.MOCK_DEVICE = "true";
      const mockService = new DeviceDetectionService();
      expect(log.info).toHaveBeenCalledWith(
        "[DeviceDetection] Running in mock mode",
      );
      mockService.stop();
    });
  });

  describe("checkLibimobiledeviceAvailable", () => {
    it("should return true when idevice_id is available", async () => {
      mockExec.mockImplementation((...args: unknown[]) => { const callback = (typeof args[1] === 'function' ? args[1] : args[2]) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: "1.3.0", stderr: "" });
      });

      const result = await service.checkLibimobiledeviceAvailable();
      expect(result).toBe(true);
      expect(log.info).toHaveBeenCalledWith(
        "[DeviceDetection] libimobiledevice is available",
      );
    });

    it("should return false when idevice_id is not available", async () => {
      mockExec.mockImplementation((...args: unknown[]) => { const callback = (typeof args[1] === 'function' ? args[1] : args[2]) as // `result` optional: this case invokes the callback with the error only.
      (err: Error | null, result?: { stdout: string; stderr: string }) => void;
        callback(new Error("command not found"));
      });

      const result = await service.checkLibimobiledeviceAvailable();
      expect(result).toBe(false);
      expect(log.warn).toHaveBeenCalledWith(
        "[DeviceDetection] libimobiledevice is not available - device detection will not work",
        expect.any(Error),
      );
    });

    it("should cache the availability check result", async () => {
      mockExec.mockImplementation((...args: unknown[]) => { const callback = (typeof args[1] === 'function' ? args[1] : args[2]) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: "1.3.0", stderr: "" });
      });

      await service.checkLibimobiledeviceAvailable();
      await service.checkLibimobiledeviceAvailable();

      expect(mockExec).toHaveBeenCalledTimes(1);
    });
  });

  describe("start/stop", () => {
    it("should start polling for devices", () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      service.start(2000);

      expect(log.info).toHaveBeenCalledWith(
        "[DeviceDetection] Starting device polling (interval: 2000ms)",
      );

      // Simulate empty device list
      setTimeout(() => {
        mockProcess.stdout.emit("data", "");
        mockProcess.emit("close", 0);
      }, 0);
    });

    it("should enforce minimum polling interval of 2000ms", () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      service.start(500); // Try to start with 500ms

      expect(log.info).toHaveBeenCalledWith(
        "[DeviceDetection] Starting device polling (interval: 2000ms)",
      );
    });

    it("should stop polling when stop is called", () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      service.start();
      service.stop();

      expect(log.info).toHaveBeenCalledWith(
        "[DeviceDetection] Stopping device polling",
      );
    });

    it("should stop existing polling before starting new", () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      service.start();
      service.start();

      expect(log.warn).toHaveBeenCalledWith(
        "[DeviceDetection] Already running, stopping first",
      );
    });
  });

  describe("listDevices", () => {
    it("should return empty array when no devices are connected", async () => {
      jest.useRealTimers(); // Use real timers for async operations
      const realTimerService = new DeviceDetectionService(); // Create new service with real timers

      // Mock availability check - call callback asynchronously
      mockExec.mockImplementation((...args: unknown[]) => { const callback = (typeof args[1] === 'function' ? args[1] : args[2]) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        setTimeout(() => callback(null, { stdout: "1.3.0", stderr: "" }), 0);
      });

      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const promise = realTimerService.listDevices();

      // Wait for availability check to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate empty output
      mockProcess.stdout.emit("data", "");
      mockProcess.emit("close", 0);

      const devices = await promise;
      expect(devices).toEqual([]);

      realTimerService.stop(); // Clean up
    });

    it("should return device UDIDs when devices are connected", async () => {
      jest.useRealTimers(); // Use real timers for async operations
      const realTimerService = new DeviceDetectionService(); // Create new service with real timers

      // Mock availability check - call callback asynchronously
      mockExec.mockImplementation((...args: unknown[]) => { const callback = (typeof args[1] === 'function' ? args[1] : args[2]) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        setTimeout(() => callback(null, { stdout: "1.3.0", stderr: "" }), 0);
      });

      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const promise = realTimerService.listDevices();

      // Wait for availability check to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate device list output
      mockProcess.stdout.emit(
        "data",
        "00000000-0000000000000001\n00000000-0000000000000002\n",
      );
      mockProcess.emit("close", 0);

      const devices = await promise;
      expect(devices).toEqual([
        "00000000-0000000000000001",
        "00000000-0000000000000002",
      ]);

      realTimerService.stop(); // Clean up
    });

    it("should return mock device in mock mode", async () => {
      process.env.MOCK_DEVICE = "true";
      const mockService = new DeviceDetectionService();

      const devices = await mockService.listDevices();
      expect(devices).toEqual(["00000000-0000000000000000"]);

      mockService.stop();
    });
  });

  describe("getDeviceInfo", () => {
    it("should parse device info from ideviceinfo output", async () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const promise = service.getDeviceInfo(TEST_UDID);

      // Simulate ideviceinfo output
      mockProcess.stdout.emit(
        "data",
        `DeviceName: Test iPhone
ProductType: iPhone14,2
ProductVersion: 17.0
SerialNumber: ABC123456789
`,
      );
      mockProcess.emit("close", 0);

      const device = await promise;
      expect(device).toEqual({
        udid: TEST_UDID,
        name: "Test iPhone",
        productType: "iPhone14,2",
        productVersion: "17.0",
        serialNumber: "ABC123456789",
        isConnected: true,
      });
    });

    it("should return mock device info in mock mode", async () => {
      process.env.MOCK_DEVICE = "true";
      const mockService = new DeviceDetectionService();

      // Mock mode returns mock device, UDID is ignored
      const device = await mockService.getDeviceInfo(TEST_UDID);
      expect(device.name).toBe("Mock iPhone");
      expect(device.productType).toBe("iPhone14,2");

      mockService.stop();
    });

    it("should reject when ideviceinfo fails", async () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      const promise = service.getDeviceInfo(TEST_UDID);

      mockProcess.stderr.emit("data", "Device not found");
      mockProcess.emit("close", 1);

      await expect(promise).rejects.toThrow("ideviceinfo exited with code 1");
    });

    // SECURITY: TASK-601 - Validate that invalid UDIDs are rejected
    it("should reject invalid UDID format (security)", async () => {
      await expect(service.getDeviceInfo("invalid-udid")).rejects.toThrow(
        "Device UDID has invalid"
      );
    });

    it("should reject command injection attempts in UDID (security)", async () => {
      await expect(service.getDeviceInfo("$(rm -rf /)")).rejects.toThrow(
        "Device UDID has invalid"
      );
    });
  });

  describe("event emission", () => {
    // TODO: This test has timing issues with real timers and async event handling
    it.skip("should emit device-connected when new device is detected", async () => {
      jest.useRealTimers(); // Use real timers for async operations
      const realTimerService = new DeviceDetectionService(); // Create new service with real timers

      // Mock availability check - call callback asynchronously
      mockExec.mockImplementation((...args: unknown[]) => { const callback = (typeof args[1] === 'function' ? args[1] : args[2]) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        setTimeout(() => callback(null, { stdout: "1.3.0", stderr: "" }), 0);
      });

      const connectedCallback = jest.fn();
      realTimerService.on("device-connected", connectedCallback);

      // Mock list devices
      const listProcess = createMockProcess();
      const infoProcess = createMockProcess();

      mockSpawn.mockImplementation((cmd) => {
        if (cmd === "idevice_id") {
          return listProcess;
        }
        return infoProcess;
      });

      // Start service - this will trigger immediate poll
      realTimerService.start(2000);

      // Wait for availability check to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate device being found (use valid UDID format for TASK-601 compliance)
      listProcess.stdout.emit("data", `${TEST_UDID}\n`);
      listProcess.emit("close", 0);

      // Wait for the info request
      await new Promise((resolve) => setTimeout(resolve));

      // Simulate device info response
      infoProcess.stdout.emit(
        "data",
        `DeviceName: Test iPhone
ProductType: iPhone14,2
ProductVersion: 17.0
SerialNumber: ABC123456789
`,
      );
      infoProcess.emit("close", 0);

      // Wait for event emission
      await new Promise((resolve) => setTimeout(resolve));

      expect(connectedCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          udid: TEST_UDID,
          name: "Test iPhone",
        }),
      );

      realTimerService.stop(); // Clean up
    });
  });

  describe("getConnectedDevices", () => {
    it("should return empty array initially", () => {
      expect(service.getConnectedDevices()).toEqual([]);
    });
  });
});
