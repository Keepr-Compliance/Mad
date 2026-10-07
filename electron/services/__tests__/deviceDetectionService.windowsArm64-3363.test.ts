/**
 * BACKLOG-3363: DeviceDetectionService.start() on Windows on ARM spawns no
 * idevice_id, sets no polling timer and emits no tools-missing (which would
 * make the renderer show "Install iTunes" — the wrong message on these PCs).
 * On a normal Windows PC start() still polls immediately.
 */
import { EventEmitter } from "events";

const mockSpawn = jest.fn();
const mockExec = jest.fn();
jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  exec: (...args: unknown[]) => mockExec(...args),
}));

// Tools present, so a supported host really reaches the idevice_id spawn — and
// a gate wrongly placed in canUseLibimobiledevice() (instead of start()) is not
// what makes the ARM row pass.
jest.mock("../libimobiledeviceService", () => ({
  getCommand: (name: string) => name,
  canUseLibimobiledevice: () => true,
}));

const mockApp: { runningUnderARM64Translation?: boolean } = {};
jest.mock("electron", () => ({ app: mockApp }));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import { DeviceDetectionService } from "../deviceDetectionService";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;

function setHost(platform: string, arch: string, translated: boolean | undefined) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
  if (translated === undefined) delete mockApp.runningUnderARM64Translation;
  else mockApp.runningUnderARM64Translation = translated;
}

function enoentProcess() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setTimeout(() => {
    const err = new Error("spawn idevice_id ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    proc.emit("error", err);
  }, 0);
  return proc;
}

describe("DeviceDetectionService.start on Windows on ARM (BACKLOG-3363)", () => {
  let service: DeviceDetectionService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    delete process.env.MOCK_DEVICE;
    mockSpawn.mockImplementation(enoentProcess);
    mockExec.mockImplementation((...args: unknown[]) => {
      const cb = (typeof args[1] === "function" ? args[1] : args[2]) as (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void;
      cb(null, { stdout: "1.3.0", stderr: "" });
    });
    service = new DeviceDetectionService();
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
    Object.defineProperty(process, "platform", originalPlatform);
    Object.defineProperty(process, "arch", originalArch);
    delete mockApp.runningUnderARM64Translation;
  });

  it("Windows on ARM: no spawn, no timer, no tools-missing after 4 s", async () => {
    setHost("win32", "x64", true);
    const toolsMissing = jest.fn();
    service.on("tools-missing", toolsMissing);

    service.start(2000);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(4000);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
    expect(toolsMissing).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("Intel/AMD Windows PC: start() polls immediately (spawns)", async () => {
    setHost("win32", "x64", false);
    service.start(2000);
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await jest.advanceTimersByTimeAsync(10);
    expect(mockSpawn).toHaveBeenCalledWith("idevice_id", ["-l"]);
  });

  it("Apple Silicon Mac, x64 build under Rosetta: start() still polls (win32 guard)", async () => {
    setHost("darwin", "x64", true);
    service.start(2000);
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await jest.advanceTimersByTimeAsync(10);
    expect(mockSpawn).toHaveBeenCalledWith("idevice_id", ["-l"]);
  });
});
