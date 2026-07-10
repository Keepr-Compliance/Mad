/**
 * BACKLOG-1918: Tests for DeviceDetectionService iPhone-sync diagnostics.
 *
 * Covers:
 *  - collectIphoneSyncDiagnostics() composing enumeration + USB probe + trust
 *  - the refactored checkCorporateUsbRestrictions() struct return
 *  - Zoe's fingerprint (device_mounted && !device_detected → driver_missing_suspected)
 *  - trust state surfacing and macOS (no windows block) behavior
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

// Make libimobiledevice deterministically usable/available in tests.
jest.mock("../libimobiledeviceService", () => ({
  canUseLibimobiledevice: jest.fn().mockReturnValue(true),
  getCommand: jest.fn((name: string) => `/usr/bin/${name}`),
}));

import { DeviceDetectionService } from "../deviceDetectionService";
import type { IphoneSyncDiagnostic } from "../deviceDetectionService";

const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

/** exec() succeeds with a version string (libimobiledevice available). */
function mockExecVersionAvailable() {
  mockExec.mockImplementation(
    (
      _cmd: string,
      _opts: unknown,
      callback?: (
        err: Error | null,
        result?: { stdout: string; stderr: string }
      ) => void
    ) => {
      // execAsync(promisify) passes (cmd, callback) OR (cmd, opts, callback)
      const cb = typeof _opts === "function" ? _opts : callback;
      (cb as (e: Error | null, r?: { stdout: string; stderr: string }) => void)(
        null,
        { stdout: "1.3.0", stderr: "" }
      );
    }
  );
}

describe("DeviceDetectionService - collectIphoneSyncDiagnostics (BACKLOG-1918)", () => {
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

  function setPlatform(p: string) {
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  }

  it("reports driver_missing_suspected (Zoe's fingerprint) on Windows: PnP sees iPhone but idevice_id -l returns 0", async () => {
    setPlatform("win32");
    mockExecVersionAvailable();

    // First exec is the version check (available). Subsequent exec calls are the
    // Windows USB probe (sc query + wmic). We need those to report a PnP device
    // present with the USB driver service not_found.
    mockExec.mockImplementation(
      (
        cmd: string,
        optsOrCb: unknown,
        maybeCb?: (
          err: Error | null,
          result?: { stdout: string; stderr: string }
        ) => void
      ) => {
        const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (
          e: Error | null,
          r?: { stdout: string; stderr: string }
        ) => void;
        if (cmd.includes("--version")) {
          cb(null, { stdout: "1.3.0", stderr: "" });
        } else if (cmd.startsWith("sc query")) {
          // Apple Mobile Device USB Driver service missing.
          cb(new Error("service not found"));
        } else if (cmd.startsWith("wmic")) {
          // Windows PnP DOES see an Apple iPhone device.
          cb(null, { stdout: "Name=Apple iPhone\nStatus=OK\n", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      }
    );

    // idevice_id -l returns NO devices.
    const listProcess = createMockProcess();
    mockSpawn.mockReturnValue(listProcess);

    const promise = service.collectIphoneSyncDiagnostics();
    await new Promise((r) => setTimeout(r, 10));
    listProcess.stdout.emit("data", "");
    listProcess.emit("close", 0);

    const result: IphoneSyncDiagnostic = await promise;

    expect(result.libimobiledeviceAvailable).toBe(true);
    expect(result.connectedDeviceCount).toBe(0);
    expect(result.deviceDetected).toBe(false);
    expect(result.deviceMounted).toBe(true); // PnP saw the iPhone
    expect(result.driverMissingSuspected).toBe(true);
    expect(result.windows).toEqual({
      appleUsbDriverService: "not_found",
      pnpDeviceFound: true,
      pnpStatus: expect.stringContaining("Apple iPhone"),
    });
  });

  it("does not flag driver_missing when device is both mounted and detected", async () => {
    setPlatform("win32");
    mockExec.mockImplementation(
      (
        cmd: string,
        optsOrCb: unknown,
        maybeCb?: (
          err: Error | null,
          result?: { stdout: string; stderr: string }
        ) => void
      ) => {
        const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (
          e: Error | null,
          r?: { stdout: string; stderr: string }
        ) => void;
        if (cmd.includes("--version")) {
          cb(null, { stdout: "1.3.0", stderr: "" });
        } else if (cmd.startsWith("sc query")) {
          cb(null, { stdout: "STATE : 4 RUNNING", stderr: "" });
        } else if (cmd.startsWith("wmic")) {
          cb(null, { stdout: "Name=Apple iPhone\nStatus=OK\n", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      }
    );

    const listProcess = createMockProcess();
    const infoProcess = createMockProcess();
    let call = 0;
    mockSpawn.mockImplementation(() => {
      call++;
      return call === 1 ? listProcess : infoProcess;
    });

    const promise = service.collectIphoneSyncDiagnostics();
    await new Promise((r) => setTimeout(r, 10));
    listProcess.stdout.emit("data", `${TEST_UDID}\n`);
    listProcess.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));
    // getDeviceInfo succeeds → device usable, no trust issue.
    infoProcess.stdout.emit(
      "data",
      "DeviceName: Test iPhone\nProductType: iPhone14,2\n"
    );
    infoProcess.emit("close", 0);

    const result = await promise;

    expect(result.deviceDetected).toBe(true);
    expect(result.deviceMounted).toBe(true);
    expect(result.driverMissingSuspected).toBe(false);
    expect(result.trustState).toBeNull();
    expect(result.windows?.appleUsbDriverService).toBe("running");
  });

  it("surfaces trust_state when a detected device fails ideviceinfo with a pairing-pending error", async () => {
    setPlatform("darwin");
    mockExecVersionAvailable();

    const listProcess = createMockProcess();
    const infoProcess = createMockProcess();
    let call = 0;
    mockSpawn.mockImplementation(() => {
      call++;
      return call === 1 ? listProcess : infoProcess;
    });

    const promise = service.collectIphoneSyncDiagnostics();
    await new Promise((r) => setTimeout(r, 10));
    listProcess.stdout.emit("data", `${TEST_UDID}\n`);
    listProcess.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));
    // getDeviceInfo fails with the trust-pending signature.
    infoProcess.stderr.emit("data", "Pairing dialog response pending");
    infoProcess.emit("close", 255);

    const result = await promise;

    expect(result.deviceDetected).toBe(true);
    expect(result.trustState).toBe("trust_pending");
    // macOS → no windows block
    expect(result.windows).toBeNull();
  });

  it("reflects macOS availability + device count with no windows block", async () => {
    setPlatform("darwin");
    mockExecVersionAvailable();

    const listProcess = createMockProcess();
    const infoProcess = createMockProcess();
    let call = 0;
    mockSpawn.mockImplementation(() => {
      call++;
      return call === 1 ? listProcess : infoProcess;
    });

    const promise = service.collectIphoneSyncDiagnostics();
    await new Promise((r) => setTimeout(r, 10));
    listProcess.stdout.emit("data", `${TEST_UDID}\n`);
    listProcess.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));
    infoProcess.stdout.emit("data", "DeviceName: Mac-connected iPhone\n");
    infoProcess.emit("close", 0);

    const result = await promise;

    expect(result.libimobiledeviceAvailable).toBe(true);
    expect(result.libimobiledeviceInPath).toBe(true);
    expect(result.connectedDeviceCount).toBe(1);
    expect(result.deviceDetected).toBe(true);
    expect(result.windows).toBeNull();
  });

  it("returns safe defaults when libimobiledevice is unavailable", async () => {
    setPlatform("darwin");
    // Version check fails → tools unavailable.
    mockExec.mockImplementation(
      (
        _cmd: string,
        optsOrCb: unknown,
        maybeCb?: (err: Error | null) => void
      ) => {
        const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (
          e: Error | null
        ) => void;
        cb(new Error("command not found"));
      }
    );

    const result = await service.collectIphoneSyncDiagnostics();

    expect(result.libimobiledeviceAvailable).toBe(false);
    expect(result.connectedDeviceCount).toBe(0);
    expect(result.deviceDetected).toBe(false);
    expect(result.deviceMounted).toBe(false);
    expect(result.driverMissingSuspected).toBe(false);
    expect(result.trustState).toBeNull();
  });
});
