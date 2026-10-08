/**
 * BACKLOG-3806: which Apple installer is chosen, and that nothing reaches
 * msiexec or extraction without passing the Apple signature check.
 */

import { EventEmitter } from "events";
import path from "path";

const mockSpawn = jest.fn();
const mockExecFile = jest.fn();
jest.mock("child_process", () => ({
  exec: jest.fn((_cmd: string, opts: unknown, cb?: (e: Error, o: string, s: string) => void) => {
    const callback = typeof opts === "function" ? (opts as typeof cb) : cb;
    callback?.(new Error("not found"), "", "");
  }),
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockApp = {
  isPackaged: false,
  getPath: jest.fn((name: string) => (name === "temp" ? "/tmp/os-temp" : "/tmp/test-user-data")),
};
jest.mock("electron", () => ({ app: mockApp }));

const mockCaptureMessage = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  captureException: jest.fn(),
  setContext: jest.fn(),
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockVerify = jest.fn();
jest.mock("../appleInstallerSignature", () => ({
  verifyAppleSignature: (...a: unknown[]) => mockVerify(...a),
}));

// Files that "exist"; directories map to their entries.
const existing = new Set<string>();
const dirEntries = new Map<string, string[]>();

function fakeStream() {
  const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
  s.close = jest.fn();
  s.write = jest.fn(() => true);
  s.end = jest.fn((cb?: () => void) => {
    cb?.();
    s.emit("finish");
  });
  s.destroy = jest.fn();
  return s;
}

const mockFs = {
  existsSync: jest.fn((p: string) => existing.has(p) || dirEntries.has(p)),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn((p: string) =>
    (dirEntries.get(p) ?? []).map((name) => ({
      name,
      isFile: () => true,
      isDirectory: () => false,
    })),
  ),
  readFileSync: jest.fn(() => ""),
  createWriteStream: jest.fn(() => fakeStream()),
  unlinkSync: jest.fn(),
  unlink: jest.fn(),
  mkdtempSync: jest.fn((prefix: string) => `${prefix}RAND01`),
  copyFileSync: jest.fn(),
  rmSync: jest.fn(),
};
jest.mock("fs", () => mockFs);

// Download transport: Node https today; Electron net.fetch once BACKLOG-3799
// lands. Both are stubbed so this file holds under either merge order.
jest.mock("https", () => ({
  get: jest.fn((_url: string, cb: (res: unknown) => void) => {
    const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
    res.statusCode = 200;
    res.headers = {};
    res.pipe = (file: EventEmitter) => setTimeout(() => file.emit("finish"), 0);
    cb(res);
    return { on: jest.fn() };
  }),
}));
jest.mock(
  "../mainNetFetch",
  () => ({
    mainNetFetch: jest.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => ({ done: true }) }) },
    })),
  }),
  { virtual: true },
);

import {
  downloadAppleDrivers,
  getBundledDriverPath,
  installAppleDrivers,
  MSI_PATH_ENV,
  SIGNATURE_REFUSAL_MESSAGE,
} from "../appleDriverService";

const BUNDLED_DIR = path.join(__dirname, "../../../resources/win/apple-drivers");
const BUNDLED_MSI = path.join(BUNDLED_DIR, "AppleMobileDeviceSupport64.msi");
const DRIVERS_DIR = "/tmp/test-user-data/apple-drivers";
const EXTRACT_DIR = path.join(DRIVERS_DIR, "extracted");
const DOWNLOADED_MSI = path.join(EXTRACT_DIR, "AppleMobileDeviceSupport64.msi");
const INSTALLER_EXE = path.join(DRIVERS_DIR, "iTunes64Setup.exe");
const BUNDLED_7ZA = path.join(__dirname, "../../../resources/win/7za.exe");
const STAGING_DIR = "/tmp/os-temp/keepr-amds-RAND01";
const STAGED_MSI = path.join(STAGING_DIR, "AppleMobileDeviceSupport64.msi");

const OK = { ok: true, reason: "valid", status: "Valid", subject: "CN=Apple Inc., O=Apple Inc." };
const BAD = { ok: false, reason: "wrong_signer", status: "Valid", subject: "CN=Evil, O=Evil" };

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;

beforeEach(() => {
  jest.clearAllMocks();
  existing.clear();
  dirEntries.clear();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  Object.defineProperty(process, "arch", { value: "x64", configurable: true });
  mockSpawn.mockImplementation(() => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setTimeout(() => proc.emit("close", 1223), 0);
    return proc;
  });
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: Error | null, o: string, s: string) => void;
    cb(null, "", "");
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process, "arch", originalArch);
});

describe("installer selection", () => {
  it("prefers the bundled MSI when a downloaded one also exists", () => {
    existing.add(BUNDLED_MSI);
    dirEntries.set(EXTRACT_DIR, ["AppleMobileDeviceSupport64.msi"]);
    expect(getBundledDriverPath()).toBe(BUNDLED_MSI);
  });

  it("falls back to the downloaded MSI only when nothing is bundled", () => {
    dirEntries.set(EXTRACT_DIR, ["AppleMobileDeviceSupport64.msi"]);
    expect(getBundledDriverPath()).toBe(DOWNLOADED_MSI);
  });

  it("installs from a copy of the bundled MSI when both exist", async () => {
    existing.add(BUNDLED_MSI);
    dirEntries.set(EXTRACT_DIR, ["AppleMobileDeviceSupport64.msi"]);
    mockVerify.mockResolvedValue(OK);
    await installAppleDrivers();
    expect(mockFs.copyFileSync).toHaveBeenCalledWith(BUNDLED_MSI, STAGED_MSI);
  });
});

describe("installAppleDrivers checks the exact file it installs", () => {
  beforeEach(() => existing.add(BUNDLED_MSI));

  it("verifies the staged copy and hands that same path to msiexec", async () => {
    mockVerify.mockResolvedValue(OK);
    await installAppleDrivers();

    expect(mockFs.mkdtempSync).toHaveBeenCalledWith(path.join("/tmp/os-temp", "keepr-amds-"));
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenCalledWith(STAGED_MSI);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, , opts] = mockSpawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(opts.env[MSI_PATH_ENV]).toBe(STAGED_MSI);
    // verification ran before the installer started
    expect(mockVerify.mock.invocationCallOrder[0]).toBeLessThan(
      mockSpawn.mock.invocationCallOrder[0],
    );
    // the private copy is removed afterwards
    expect(mockFs.rmSync).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
  });

  it("refuses without running msiexec when the signature check fails", async () => {
    mockVerify.mockResolvedValue(BAD);
    const result = await installAppleDrivers();

    expect(result).toEqual({ success: false, error: SIGNATURE_REFUSAL_MESSAGE, rebootRequired: false });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Apple driver installer failed signature check",
      expect.objectContaining({
        tags: expect.objectContaining({ failureReason: "signature_invalid" }),
      }),
    );
    expect(mockFs.rmSync).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
  });

  it("passes a path with quotes and ; to PowerShell only through the environment", async () => {
    const hostileDir = "/tmp/os-temp/x'y\"; Remove-Item C:\\ -Recurse; $(calc) `id`";
    mockFs.mkdtempSync.mockReturnValueOnce(hostileDir);
    mockVerify.mockResolvedValue(OK);
    await installAppleDrivers();

    const [cmd, args, opts] = mockSpawn.mock.calls[0] as [string, string[], { env: Record<string, string>; shell: boolean }];
    expect(cmd).toBe("powershell");
    expect(opts.shell).toBe(false);
    for (const a of args) {
      expect(a).not.toContain("Remove-Item");
      expect(a).not.toContain("x'y");
    }
    expect(args.join(" ")).toContain(`$env:${MSI_PATH_ENV}`);
    expect(opts.env[MSI_PATH_ENV]).toBe(path.join(hostileDir, "AppleMobileDeviceSupport64.msi"));
  });

  it("leaves non-Windows behaviour unchanged: no check, no copy, no spawn", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const result = await installAppleDrivers();
    expect(result.error).toBe("Driver installation only supported on Windows");
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("downloadAppleDrivers verifies before extracting and after", () => {
  beforeEach(() => {
    existing.add(INSTALLER_EXE);
    existing.add(BUNDLED_7ZA);
    // extraction "produces" the MSI
    mockExecFile.mockImplementation((...args: unknown[]) => {
      dirEntries.set(EXTRACT_DIR, ["AppleMobileDeviceSupport64.msi"]);
      const cb = args[args.length - 1] as (e: Error | null, o: string, s: string) => void;
      cb(null, "", "");
    });
  });

  it("deletes an unverified download and never extracts or runs it", async () => {
    mockVerify.mockResolvedValue(BAD);
    const result = await downloadAppleDrivers();

    expect(result).toEqual({ success: false, error: SIGNATURE_REFUSAL_MESSAGE });
    expect(mockVerify).toHaveBeenCalledWith(INSTALLER_EXE);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(INSTALLER_EXE);
  });

  it("removes the extracted files when the extracted MSI fails the check", async () => {
    mockVerify.mockResolvedValueOnce(OK).mockResolvedValueOnce(BAD);
    const result = await downloadAppleDrivers();

    expect(result.success).toBe(false);
    expect(mockExecFile).toHaveBeenCalled();
    expect(mockVerify.mock.calls.map((c) => c[0])).toEqual([INSTALLER_EXE, DOWNLOADED_MSI]);
    expect(mockFs.rmSync).toHaveBeenCalledWith(EXTRACT_DIR, { recursive: true, force: true });
  });

  it("returns the MSI when both the download and the MSI verify", async () => {
    mockVerify.mockResolvedValue(OK);
    const result = await downloadAppleDrivers();

    expect(result).toEqual({ success: true, msiPath: DOWNLOADED_MSI });
    expect(mockVerify.mock.calls.map((c) => c[0])).toEqual([INSTALLER_EXE, DOWNLOADED_MSI]);
    expect(mockVerify.mock.invocationCallOrder[0]).toBeLessThan(
      mockExecFile.mock.invocationCallOrder[0],
    );
  });
});
