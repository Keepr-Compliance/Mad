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

import { EventEmitter } from "events";
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

  it("checkAppleDrivers reports installed when the Apple Devices Store package is present", async () => {
    fsMock.existsSync.mockReturnValue(false); // no AppleMobileDeviceService.exe in Program Files
    mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, v?: unknown) => void) =>
      cb(null, { stdout: "AppleInc.AppleDevices\r\n", stderr: "" }),
    );
    const status = await checkAppleDrivers();
    expect(status.isInstalled).toBe(true);
    const [file, args] = mockExecFile.mock.calls[0];
    expect(file).toMatch(/powershell\.exe$/);
    expect(args.join(" ")).toContain("Get-AppxPackage -Name AppleInc.AppleDevices,AppleInc.iTunes");
  });

  it("checkAppleDrivers reports not installed when no Apple Store package is present", async () => {
    fsMock.existsSync.mockReturnValue(false);
    mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, v?: unknown) => void) =>
      cb(null, { stdout: "", stderr: "" }),
    );
    expect((await checkAppleDrivers()).isInstalled).toBe(false);
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
});
