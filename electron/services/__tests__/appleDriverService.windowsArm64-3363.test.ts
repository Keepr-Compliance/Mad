/**
 * BACKLOG-3363 C3: installAppleDrivers() on Windows on ARM refuses before any
 * installer runs, and is not reported as a driver failure. On a normal Windows
 * PC the install still proceeds to the PowerShell/msiexec spawn.
 */

const mockSpawn = jest.fn();
jest.mock("child_process", () => ({
  exec: jest.fn(),
  execFile: jest.fn(),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockApp: {
  isPackaged: boolean;
  getPath: jest.Mock;
  runningUnderARM64Translation?: boolean;
} = {
  isPackaged: false,
  getPath: jest.fn(() => "/tmp/test-user-data"),
};
jest.mock("electron", () => ({ app: mockApp }));

const mockAddBreadcrumb = jest.fn();
const mockCaptureMessage = jest.fn();
const mockCaptureException = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: (...a: unknown[]) => mockAddBreadcrumb(...a),
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  captureException: (...a: unknown[]) => mockCaptureException(...a),
  setContext: jest.fn(),
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// The bundled MSI "exists", so a normal PC reaches the installer.
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

// BACKLOG-3806: the installer passes the Apple signature check here, so a
// normal PC still reaches the PowerShell/msiexec spawn.
jest.mock("../appleInstallerSignature", () => ({
  verifyAppleSignature: jest.fn(async () => ({ ok: true, reason: "valid", status: "Valid", subject: "CN=Apple Inc., O=Apple Inc." })),
  powershellPath: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
}));

import { EventEmitter } from "events";
import { installAppleDrivers } from "../appleDriverService";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;

function setHost(platform: string, arch: string, translated: boolean | undefined) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
  if (translated === undefined) delete mockApp.runningUnderARM64Translation;
  else mockApp.runningUnderARM64Translation = translated;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSpawn.mockImplementation(() => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    // User cancelled UAC: ends the install quickly without verification.
    setTimeout(() => proc.emit("close", 1223), 0);
    return proc;
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process, "arch", originalArch);
  delete mockApp.runningUnderARM64Translation;
});

describe("installAppleDrivers on Windows on ARM (BACKLOG-3363)", () => {
  it.each([
    ["translation false", false],
    ["translation undefined", undefined],
  ])("row A — Intel/AMD Windows PC (%s): install proceeds to the powershell spawn", async (_l, translated) => {
    setHost("win32", "x64", translated as boolean | undefined);
    await installAppleDrivers();
    expect(mockSpawn).toHaveBeenCalled();
    expect(mockSpawn.mock.calls[0][0]).toMatch(/powershell\.exe$/);
  });

  it("row B — Windows on ARM (x64 under emulation): refuses without spawning, reporting, or the install breadcrumb", async () => {
    setHost("win32", "x64", true);
    const result = await installAppleDrivers();
    expect(result.success).toBe(false);
    expect(result.error).toBe("iPhone USB sync isn't supported on this PC");
    expect(mockSpawn).not.toHaveBeenCalled();
    // An ARM refusal is not a driver failure: nothing goes to Sentry.
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Starting Apple driver installation" }),
    );
  });

  it("row B' — Windows on ARM, native arm64 build: refuses without spawning", async () => {
    setHost("win32", "arm64", false);
    const result = await installAppleDrivers();
    expect(result.success).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
