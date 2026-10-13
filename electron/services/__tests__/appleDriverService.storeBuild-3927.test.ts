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
let mockSource: "auto" | "msi" | "appledevices" = "auto";
jest.mock("../distributionChannelService", () => ({
  isStoreBuild: () => mockStore,
  getAppleDriverSource: () => mockSource,
}));

const mockProbeConnectedUdids = jest.fn();
let mockDetectionRequested = true;
jest.mock("../deviceDetectionService", () => ({
  deviceDetectionService: {
    probeConnectedUdids: (...a: unknown[]) => mockProbeConnectedUdids(...a),
    isDetectionRequested: () => mockDetectionRequested,
  },
}));

import { EventEmitter } from "events";
import {
  APPLE_DEVICES_PROBE_SCRIPT,
  APPLE_IOS_USB_INSTANCE_PATTERN,
  matchesAppleIosUsbInstance,
  parseAppleDevicesProbe,
} from "../appleDevicesProbe";
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
  mockSource = "auto";
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
// Fixtures: the probe script's stdout.
//
// REAL: PROBE_READY and PROBE_READY_UNPLUGGED are the PC's output, verbatim
// (BACKLOG-3927 "REAL PROBE OUTPUT" row, Windows PowerShell 5.1.26100.9444,
// Apple Devices + Apple USB driver; Microsoft = MI_00 WPD, Apple rows =
// composite + MI_01). Unplugged: the packages/amds lines only.
//
// UNVERIFIED (still constructed, not captured on Windows):
// PROBE_NOT_RUNNING_NO_PHONE, PROBE_NOT_RUNNING_WITH_PHONE,
// PROBE_USB_DRIVER_MISSING, PROBE_NOTHING. Provider strings copied from the
// real output above; the line combinations are inferred.
// ---------------------------------------------------------------------------
const PROBE_READY = [
  "packages=AppleInc.AppleDevices",
  "amds=True",
  "usbProvider=Microsoft",
  "usbProvider=Apple, Inc.",
  "usbProvider=Apple, Inc.",
].join("\r\n");
const PROBE_READY_UNPLUGGED = ["packages=AppleInc.AppleDevices", "amds=True"].join("\r\n");
// UNVERIFIED
const PROBE_NOT_RUNNING_NO_PHONE = ["packages=AppleInc.AppleDevices", "amds=False"].join("\r\n");
// UNVERIFIED
const PROBE_NOT_RUNNING_WITH_PHONE = [
  "packages=AppleInc.AppleDevices",
  "amds=False",
  "usbProvider=Microsoft",
  "usbProvider=Apple, Inc.",
  "usbProvider=Apple, Inc.",
].join("\r\n");
// UNVERIFIED
const PROBE_USB_DRIVER_MISSING = [
  "packages=AppleInc.AppleDevices",
  "amds=True",
  "usbProvider=Microsoft",
  "usbProvider=Microsoft",
].join("\r\n");
// UNVERIFIED
const PROBE_NOTHING = ["packages=", "amds=False"].join("\r\n");

const UDID = "00008110-000A1B2C3D4E5F60";

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
    mockProbeConnectedUdids.mockResolvedValue([]);
    mockDetectionRequested = true;
  });

  it("BACKLOG-3418: iPhone checking off -> usbmux not asked (no iPhone helper spawn), not-running", async () => {
    mockDetectionRequested = false;
    probeStdout(PROBE_NOT_RUNNING_WITH_PHONE);
    mockProbeConnectedUdids.mockResolvedValue([UDID]);
    const status = await checkAppleDrivers();
    expect(mockProbeConnectedUdids).not.toHaveBeenCalled();
    expect(status.appleDevices).toMatchObject({ state: "not-running", usbmuxReachable: false });
  });

  it("REAL PC output: package + AMDS process + Apple USB driver -> ready via apple-devices; usbmux not asked", async () => {
    probeStdout(PROBE_READY);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: true, serviceRunning: true, installedVia: "apple-devices" });
    expect(status.appleDevices).toMatchObject({ state: "ready", amdsRunning: true, usbDriver: "bound" });
    expect(mockProbeConnectedUdids).not.toHaveBeenCalled();
  });

  it("REAL PC output, phone unplugged: ready, no device", async () => {
    probeStdout(PROBE_READY_UNPLUGGED);
    const status = await checkAppleDrivers();
    expect(status.appleDevices).toMatchObject({ state: "ready", usbDriver: "no-device" });
  });

  it("process not seen, iPhone plugged, usbmux lists it: ready (a non-empty idevice_id list counts)", async () => {
    probeStdout(PROBE_NOT_RUNNING_WITH_PHONE);
    mockProbeConnectedUdids.mockResolvedValue([UDID]);
    const status = await checkAppleDrivers();
    expect(mockProbeConnectedUdids).toHaveBeenCalledTimes(1);
    expect(status.serviceRunning).toBe(true);
    expect(status.appleDevices).toMatchObject({ state: "ready", usbmuxReachable: true });
  });

  it("process not seen, iPhone plugged, idevice_id exits 0 with EMPTY stdout: not-running (exit code means nothing)", async () => {
    probeStdout(PROBE_NOT_RUNNING_WITH_PHONE);
    mockProbeConnectedUdids.mockResolvedValue([]);
    const status = await checkAppleDrivers();
    expect(mockProbeConnectedUdids).toHaveBeenCalledTimes(1);
    expect(status.serviceRunning).toBe(false);
    expect(status.appleDevices).toMatchObject({ state: "not-running", usbmuxReachable: false });
  });

  it("process not seen, no iPhone plugged: usbmux not asked (it cannot tell), not-running", async () => {
    probeStdout(PROBE_NOT_RUNNING_NO_PHONE);
    const status = await checkAppleDrivers();
    expect(mockProbeConnectedUdids).not.toHaveBeenCalled();
    expect(status.isInstalled).toBe(true);
    expect(status.appleDevices).toMatchObject({ state: "not-running", usbmuxReachable: null });
  });

  it("iPhone present on Microsoft drivers only: usb-driver-missing, separate from not-installed", async () => {
    probeStdout(PROBE_USB_DRIVER_MISSING);
    const status = await checkAppleDrivers();
    expect(status.isInstalled).toBe(true);
    expect(status.appleDevices).toMatchObject({ state: "usb-driver-missing", usbDriver: "missing" });
  });

  it("no Apple package and no MSI: not-installed; usbmux not asked", async () => {
    probeStdout(PROBE_NOTHING);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: false, serviceRunning: false, installedVia: null });
    expect(status.appleDevices?.state).toBe("not-installed");
    expect(mockProbeConnectedUdids).not.toHaveBeenCalled();
  });

  it("MSI found, service stopped, no Apple Devices: msi-service-stopped, serviceRunning false", async () => {
    msiInstalled("STOPPED");
    probeStdout(PROBE_NOTHING);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: true, serviceRunning: false, installedVia: "msi", version: "20.0.0.35" });
    expect(status.appleDevices?.state).toBe("msi-service-stopped");
  });

  it("MSI found but stopped, Apple Devices ready: either source counts -> ready via apple-devices", async () => {
    msiInstalled("STOPPED");
    probeStdout(PROBE_READY);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: true, serviceRunning: true, installedVia: "apple-devices" });
    expect(status.appleDevices?.state).toBe("ready");
  });

  it("MSI found and running: ready via msi, no PowerShell probe", async () => {
    msiInstalled("RUNNING");
    probeStdout(PROBE_NOTHING);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: true, serviceRunning: true, installedVia: "msi" });
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

  it("SR D1: the script ends with exit 0", () => {
    expect(APPLE_DEVICES_PROBE_SCRIPT.endsWith("; exit 0")).toBe(true);
  });

  it("SR D1: PowerShell exits non-zero but printed good lines -> those lines are used (ready)", async () => {
    mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, v?: unknown) => void) =>
      cb(Object.assign(new Error("Command failed"), { code: 1, stdout: PROBE_READY, stderr: "" })),
    );
    const status = await checkAppleDrivers();
    expect(status.appleDevices).toMatchObject({ state: "ready", packageInstalled: true, amdsRunning: true });
  });

  it("SR D1: PowerShell fails with no output -> not-installed", async () => {
    mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, v?: unknown) => void) =>
      cb(Object.assign(new Error("spawn failed"), { code: "ENOENT" })),
    );
    const status = await checkAppleDrivers();
    expect(status.appleDevices?.state).toBe("not-installed");
  });
});

describe("SR D2: USB filter covers iPhone/iPad only (BACKLOG-3927)", () => {
  // The filter runs inside PowerShell, so a stdout fixture cannot exercise it.
  // These pin the script text and a JS mirror of its `-like` pattern.
  it("the script filters on the iOS product-id pattern, not every Apple vendor id", () => {
    expect(APPLE_DEVICES_PROBE_SCRIPT).toContain(`-like '${APPLE_IOS_USB_INSTANCE_PATTERN}'`);
    expect(APPLE_DEVICES_PROBE_SCRIPT).not.toContain("-like 'USB\\VID_05AC*'");
  });
  it("an Apple keyboard does not match; iPhone composite and interfaces do", () => {
    // Apple Magic Keyboard (USB) and an Apple USB-C adapter: not iOS devices.
    expect(matchesAppleIosUsbInstance("USB\\VID_05AC&PID_024F\\5&1A2B3C4D&0&2")).toBe(false);
    expect(matchesAppleIosUsbInstance("USB\\VID_05AC&PID_1460\\6&2B3C4D5E&0&1")).toBe(false);
    // iPhone (serial segment masked).
    expect(matchesAppleIosUsbInstance("USB\\VID_05AC&PID_12A8\\XXXXXXXX")).toBe(true);
    expect(matchesAppleIosUsbInstance("USB\\VID_05AC&PID_12A8&MI_00\\7&XXXX&0&0000")).toBe(true);
    expect(matchesAppleIosUsbInstance("usb\\vid_05ac&pid_12ab&mi_01\\7&XXXX&0&0001")).toBe(true);
  });
});

describe("parseAppleDevicesProbe (BACKLOG-3927)", () => {
  it("REAL PC output: Apple provider on any present iOS node = bound, even with MI_00 on WPD", () => {
    expect(parseAppleDevicesProbe(PROBE_READY)).toEqual({ packageInstalled: true, amdsRunning: true, usbDriver: "bound" });
  });
  it("only Microsoft providers = missing; no lines = no-device", () => {
    expect(parseAppleDevicesProbe(PROBE_USB_DRIVER_MISSING).usbDriver).toBe("missing");
    expect(parseAppleDevicesProbe(PROBE_READY_UNPLUGGED).usbDriver).toBe("no-device");
  });
  it("a package name that only contains the Apple name does not count", () => {
    expect(parseAppleDevicesProbe("packages=NotAppleInc.AppleDevicesX\r\namds=False").packageInstalled).toBe(false);
  });
});

describe("website build: install path unchanged, either source accepted (BACKLOG-3927)", () => {
  beforeEach(() => {
    mockStore = false;
    mockProbeConnectedUdids.mockResolvedValue([]);
  });

  it("getBundledDriverPath returns the bundled MSI", () => {
    expect(getBundledDriverPath()).toMatch(/AppleMobileDeviceSupport64\.msi$/);
  });

  it("installAppleDrivers proceeds to the installer spawn", async () => {
    await installAppleDrivers();
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("no MSI, Apple Devices ready (REAL PC output): website accepts the Apple Devices route", async () => {
    fsMock.existsSync.mockReturnValue(false);
    probeStdout(PROBE_READY);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: true, serviceRunning: true, installedVia: "apple-devices" });
    expect(status.appleDevices?.state).toBe("ready");
  });

  it("neither source: not installed, so the website install prompt (bundled MSI) still applies", async () => {
    fsMock.existsSync.mockReturnValue(false);
    probeStdout(PROBE_NOTHING);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: false, serviceRunning: false, installedVia: null });
  });

  it("MSI installed and service running: unchanged, no PowerShell probe", async () => {
    msiInstalled("RUNNING");
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: true, serviceRunning: true, version: "20.0.0.35", installedVia: "msi" });
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe("KEEPR_APPLE_DRIVER_SOURCE override narrows which source counts (BACKLOG-3927)", () => {
  beforeEach(() => {
    mockProbeConnectedUdids.mockResolvedValue([]);
  });

  it("override=msi: Apple Devices ready but no MSI -> not installed, Apple Devices not probed", async () => {
    mockStore = true;
    mockSource = "msi";
    fsMock.existsSync.mockReturnValue(false);
    probeStdout(PROBE_READY);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: false, serviceRunning: false, installedVia: null });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("override=appledevices: MSI running is ignored; Apple Devices absent -> not-installed", async () => {
    mockStore = false;
    mockSource = "appledevices";
    msiInstalled("RUNNING");
    probeStdout(PROBE_NOTHING);
    const status = await checkAppleDrivers();
    expect(status).toMatchObject({ isInstalled: false, installedVia: null });
    expect(status.appleDevices?.state).toBe("not-installed");
  });

  it("override=appledevices on website: Apple Devices ready -> ready via apple-devices", async () => {
    mockStore = false;
    mockSource = "appledevices";
    msiInstalled("RUNNING");
    probeStdout(PROBE_READY);
    expect((await checkAppleDrivers()).installedVia).toBe("apple-devices");
  });

  it("coordinator pin: Store build + override=msi never unlocks an install path", async () => {
    mockStore = true;
    mockSource = "msi";
    fsMock.existsSync.mockReturnValue(true); // an MSI is on disk
    expect(getBundledDriverPath()).toBeNull();
    expect(await installAppleDrivers()).toEqual({
      success: false,
      error: STORE_INSTALL_REFUSAL_MESSAGE,
      rebootRequired: false,
    });
    expect(await downloadAppleDrivers()).toEqual({ success: false, error: STORE_INSTALL_REFUSAL_MESSAGE });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockNetFetch).not.toHaveBeenCalled();
  });
});
