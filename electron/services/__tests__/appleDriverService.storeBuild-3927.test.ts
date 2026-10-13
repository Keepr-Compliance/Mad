/**
 * BACKLOG-3927: the Microsoft Store build never installs, downloads or offers
 * Apple's driver installer (Store policy 10.2.4.2), and detects Apple
 * Mobile Device Support delivered by Apple's "Apple Devices" Store app.
 * The website build is unchanged.
 */

const mockSpawn = jest.fn();
const mockExec = jest.fn();
const mockExecFile = jest.fn();
jest.mock("child_process", () => ({
  exec: (...args: unknown[]) => mockExec(...args),
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn(() => "/tmp/test-user-data") },
}));

const mockAddBreadcrumb = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: (...a: unknown[]) => mockAddBreadcrumb(...a),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  setContext: jest.fn(),
}));

jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// Every path "exists": a website build finds the bundled MSI.
jest.mock("fs", () => ({
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn(() => []),
  readFileSync: jest.fn(() => ""),
  createWriteStream: jest.fn(() => ({ on: jest.fn(), close: jest.fn() })),
  unlinkSync: jest.fn(),
  mkdtempSync: jest.fn((prefix: string) => `${prefix}x`),
  copyFileSync: jest.fn(),
  rmSync: jest.fn(),
}));

jest.mock("../appleInstallerSignature", () => ({
  verifyAppleSignature: jest.fn(async () => ({ ok: true, reason: "valid", status: "Valid", subject: "CN=Apple Inc." })),
  powershellPath: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
}));

const mockNetFetch = jest.fn();
jest.mock("../mainNetFetch", () => ({ mainNetFetch: (...a: unknown[]) => mockNetFetch(...a) }));

let mockStore = false;
jest.mock("../distributionChannelService", () => ({ isStoreBuild: () => mockStore }));

const mockProbeConnectedUdids = jest.fn();
let mockDetectionRequested = true;
jest.mock("../deviceDetectionService", () => ({
  deviceDetectionService: {
    probeConnectedUdids: (...a: unknown[]) => mockProbeConnectedUdids(...a),
    isDetectionRequested: () => mockDetectionRequested,
  },
}));

import { EventEmitter } from "events";
import { APPLE_DEVICES_PROBE_SCRIPT, parseAppleDevicesProbe } from "../appleDevicesProbe";
import {
  checkAppleDrivers,
  downloadAppleDrivers,
  getBundledDriverPath,
  installAppleDrivers,
  STORE_INSTALL_REFUSAL_MESSAGE,
} from "../appleDriverService";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
const fsMock = jest.requireMock("fs") as { existsSync: jest.Mock };

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  // An Intel/AMD PC (the test host may be arm64, which is the 3363 ARM refusal).
  Object.defineProperty(process, "arch", { value: "x64", configurable: true });
  fsMock.existsSync.mockReturnValue(true);
  mockSpawn.mockImplementation(() => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setTimeout(() => proc.emit("close", 1223), 0);
    return proc;
  });
  // Registry keys and service: absent.
  mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (e: Error | null) => void) => cb(new Error("not found")));
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process, "arch", originalArch);
});

describe("Store build (BACKLOG-3927)", () => {
  beforeEach(() => {
    mockStore = true;
  });

  it("installAppleDrivers refuses before any installer runs", async () => {
    const result = await installAppleDrivers();
    expect(result).toEqual({ success: false, error: STORE_INSTALL_REFUSAL_MESSAGE, rebootRequired: false });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Starting Apple driver installation" }),
    );
  });

  it("downloadAppleDrivers refuses without touching the network", async () => {
    const result = await downloadAppleDrivers();
    expect(result).toEqual({ success: false, error: STORE_INSTALL_REFUSAL_MESSAGE });
    expect(mockNetFetch).not.toHaveBeenCalled();
  });

  it("getBundledDriverPath offers no installer, even when one exists on disk", () => {
    expect(getBundledDriverPath()).toBeNull();
  });

});

// ---------------------------------------------------------------------------
// Apple Devices readiness (fix round after the 2026-10-12 PC test).
//
// FIXTURES: constructed from what the PC session reported (package
// AppleInc.AppleDevices_nzyj5cx40ttqa, AppleMobileDeviceProcess running,
// appleusb.inf from provider "Apple, Inc." on the composite device and MI_01,
// MI_00 left on Microsoft's WPD driver). The probe script's own stdout has NOT
// been captured on Windows yet — replace these with the PC's pasted output.
// ---------------------------------------------------------------------------
const PROBE_READY = [
  "packages=AppleInc.AppleDevices",
  "amds=True",
  "usbProvider=Apple, Inc.",
  "usbProvider=Microsoft",
  "usbProvider=Apple, Inc.",
].join("\r\n");
const PROBE_NOT_RUNNING_NO_PHONE = ["packages=AppleInc.AppleDevices", "amds=False"].join("\r\n");
const PROBE_USB_DRIVER_MISSING = [
  "packages=AppleInc.AppleDevices",
  "amds=True",
  "usbProvider=Microsoft",
  "usbProvider=Microsoft",
].join("\r\n");
const PROBE_NOTHING = ["packages=", "amds=False"].join("\r\n");

function probeStdout(stdout: string) {
  mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, v?: unknown) => void) =>
    cb(null, { stdout, stderr: "" }),
  );
}

/** Registry: 64-bit key present with a version; `sc query` reports `scState`. */
function msiInstalled(scState: "RUNNING" | "STOPPED") {
  fsMock.existsSync.mockReturnValue(false);
  mockExec.mockImplementation((cmd: string, _opts: unknown, cb: (e: Error | null, v?: unknown) => void) => {
    if (cmd.startsWith("reg query") && !cmd.includes("WOW6432Node")) {
      cb(null, { stdout: "    Version    REG_SZ    20.0.0.35\r\n", stderr: "" });
    } else if (cmd.startsWith("sc query")) {
      cb(null, { stdout: `        STATE              : 1  ${scState}\r\n`, stderr: "" });
    } else {
      cb(new Error("not found"));
    }
  });
}

describe("Store build: Apple Devices readiness (BACKLOG-3927)", () => {
  beforeEach(() => {
    mockStore = true;
    fsMock.existsSync.mockReturnValue(false); // no Common Files AppleMobileDeviceService.exe
    mockProbeConnectedUdids.mockResolvedValue(null);
    mockDetectionRequested = true;
  });

  it("BACKLOG-3418: iPhone checking off -> usbmux not asked (no iPhone helper spawn), not-running", async () => {
    mockDetectionRequested = false;
    probeStdout(PROBE_NOT_RUNNING_NO_PHONE);
    mockProbeConnectedUdids.mockResolvedValue([]);
    const status = await checkAppleDrivers();
    expect(mockProbeConnectedUdids).not.toHaveBeenCalled();
    expect(status.appleDevices).toMatchObject({ state: "not-running", usbmuxReachable: false });
  });

  it("package + AMDS process running + Apple USB driver: ready, via apple-devices; usbmux not asked", async () => {
    probeStdout(PROBE_READY);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: true, serviceRunning: true, installedVia: "apple-devices" });
    expect(status.appleDevices).toMatchObject({ state: "ready", amdsRunning: true, usbDriver: "bound" });
    expect(mockProbeConnectedUdids).not.toHaveBeenCalled();
  });

  it("package, process not seen, usbmux answers: ready (the usbmux probe counts)", async () => {
    probeStdout(PROBE_NOT_RUNNING_NO_PHONE);
    mockProbeConnectedUdids.mockResolvedValue([]);
    const status = await checkAppleDrivers();
    expect(mockProbeConnectedUdids).toHaveBeenCalledTimes(1);
    expect(status.serviceRunning).toBe(true);
    expect(status.appleDevices).toMatchObject({ state: "ready", usbmuxReachable: true });
  });

  it("package, process not seen, usbmux silent: not-running, sync preflight would refuse", async () => {
    probeStdout(PROBE_NOT_RUNNING_NO_PHONE);
    const status = await checkAppleDrivers();
    expect(status.isInstalled).toBe(true);
    expect(status.serviceRunning).toBe(false);
    expect(status.appleDevices).toMatchObject({ state: "not-running", usbmuxReachable: false });
  });

  it("iPhone present on Microsoft drivers only: usb-driver-missing, separate from not-installed", async () => {
    probeStdout(PROBE_USB_DRIVER_MISSING);
    const status = await checkAppleDrivers();
    expect(status.isInstalled).toBe(true);
    expect(status.appleDevices).toMatchObject({ state: "usb-driver-missing", usbDriver: "missing" });
  });

  it("no Apple package: not-installed; usbmux not asked", async () => {
    probeStdout(PROBE_NOTHING);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: false, serviceRunning: false, installedVia: null });
    expect(status.appleDevices?.state).toBe("not-installed");
    expect(mockProbeConnectedUdids).not.toHaveBeenCalled();
  });

  it("SR R1: MSI found, service stopped -> serviceRunning stays false, probe not run", async () => {
    msiInstalled("STOPPED");
    probeStdout(PROBE_READY);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: true, serviceRunning: false, installedVia: "msi", version: "20.0.0.35" });
    expect(status.appleDevices).toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("SR B1: one PowerShell call, no comma list bound to Get-AppxPackage -Name", async () => {
    probeStdout(PROBE_READY);
    await checkAppleDrivers();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [file, args] = mockExecFile.mock.calls[0];
    expect(file).toMatch(/powershell\.exe$/);
    const script = args[args.length - 1] as string;
    expect(script).toBe(APPLE_DEVICES_PROBE_SCRIPT);
    expect(script).not.toMatch(/Get-AppxPackage\s+-Name/);
    expect(script).toContain("Where-Object { $names -contains $_.Name }");
    expect(script).toContain("Get-Process -Name AppleMobileDeviceProcess");
    expect(script).toContain("Get-PnpDevice -PresentOnly");
  });
});

describe("parseAppleDevicesProbe (BACKLOG-3927)", () => {
  it("Apple provider on any present Apple-VID device = bound, even with MI_00 on WPD", () => {
    expect(parseAppleDevicesProbe(PROBE_READY)).toEqual({ packageInstalled: true, amdsRunning: true, usbDriver: "bound" });
  });
  it("only Microsoft providers = missing; no lines = no-device", () => {
    expect(parseAppleDevicesProbe(PROBE_USB_DRIVER_MISSING).usbDriver).toBe("missing");
    expect(parseAppleDevicesProbe(PROBE_NOT_RUNNING_NO_PHONE).usbDriver).toBe("no-device");
  });
  it("a package name that only contains the Apple name does not count", () => {
    expect(parseAppleDevicesProbe("packages=NotAppleInc.AppleDevicesX\r\namds=False").packageInstalled).toBe(false);
  });
});

describe("website build is unchanged (BACKLOG-3927)", () => {
  beforeEach(() => {
    mockStore = false;
  });

  it("getBundledDriverPath returns the bundled MSI", () => {
    expect(getBundledDriverPath()).toMatch(/AppleMobileDeviceSupport64\.msi$/);
  });

  it("installAppleDrivers proceeds to the installer spawn", async () => {
    await installAppleDrivers();
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("checkAppleDrivers does not consult Store packages", async () => {
    fsMock.existsSync.mockReturnValue(false); // registry and service exe both absent
    mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, v?: unknown) => void) =>
      cb(null, { stdout: "AppleInc.AppleDevices", stderr: "" }),
    );
    expect((await checkAppleDrivers()).isInstalled).toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("website build ignores a ready Apple Devices setup and keeps the raw service result", async () => {
    fsMock.existsSync.mockReturnValue(false);
    probeStdout(PROBE_READY);
    mockProbeConnectedUdids.mockResolvedValue([]);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: false, serviceRunning: false, installedVia: null });
    expect(status.appleDevices).toBeUndefined();
    expect(mockProbeConnectedUdids).not.toHaveBeenCalled();
  });

  it("website build, MSI installed and service running: unchanged", async () => {
    msiInstalled("RUNNING");
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: true, serviceRunning: true, version: "20.0.0.35", installedVia: "msi" });
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
