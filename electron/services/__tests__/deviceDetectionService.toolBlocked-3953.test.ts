/**
 * BACKLOG-3953: the device poller (Connect screen) when idevice_id never starts.
 *
 * The REAL DeviceDetectionService; `spawn`/`exec` replaced, the tools folder real.
 *
 *  C9  spawn THROWS UNKNOWN for `idevice_id -l` -> tools-blocked, and the poll resolves
 *      (the old code rejected the promise: nothing reached the user).
 *  C6  Windows ENOENT with idevice_id.exe gone -> tools-blocked, never tools-missing
 *      (tools-missing makes the renderer say "Install iTunes", wrong for a removed file).
 *  C7  macOS ENOENT -> tools-missing exactly as before, and no file is stat-ed.
 *  C4  "ERROR: Unable to retrieve device list!" exit -1, and exit 0 with no phone,
 *      are never tools-blocked.
 *  C8  five blocked polls -> one Sentry event.
 */
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";

const mockSpawn = jest.fn();
const mockExec = jest.fn();
jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  exec: (...args: unknown[]) => mockExec(...args),
}));
let mockToolsDir = "";
jest.mock("../libimobiledeviceService", () => ({
  ...jest.requireActual("../libimobiledeviceService"),
  getLibimobiledevicePath: () => mockToolsDir,
  getCommand: (name: string) =>
    process.platform === "win32" ? path.join(mockToolsDir, `${name}.exe`) : name,
  canUseLibimobiledevice: () => true,
}));
jest.mock("electron", () => ({ app: { isPackaged: false } }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockCaptureMessage = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  addBreadcrumb: jest.fn(),
}));

import { DeviceDetectionService } from "../deviceDetectionService";
import { __resetToolBlockReportForTests } from "../iphoneToolBlock";
import { REQUIRED_IPHONE_TOOL_FILES } from "../libimobiledeviceService";
import { makeToolsFolder, type ToolsFolder } from "./helpers/iphoneToolsFolder-3953";
import { thrownSpawnError, emittedSpawnError, WIN_ERRNO } from "./fixtures/windowsSpawnErrors-3953";

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

/** exec(cmd, cb): the `--version` probe answers, or fails like cmd.exe would. */
function versionProbe(ok: boolean) {
  mockExec.mockImplementation((_cmd: string, cb: (e: Error | null, so?: string, se?: string) => void) => {
    if (ok) cb(null, "idevice_id 1.3.0\n", "");
    else cb(Object.assign(new Error("Command failed"), { code: 1 }));
  });
}

function idevice(behaviour: () => FakeProcess) {
  mockSpawn.mockImplementation(() => behaviour());
}

const exits = (code: number, stdout = "", stderr = "") => () => {
  const proc = new FakeProcess();
  setTimeout(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", code);
  }, 0);
  return proc;
};

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value, configurable: true });
let folder: ToolsFolder;

function watch(service: DeviceDetectionService) {
  const events: string[] = [];
  const payloads: unknown[] = [];
  service.on("tools-blocked", (p) => {
    events.push("tools-blocked");
    payloads.push(p);
  });
  service.on("tools-missing", () => events.push("tools-missing"));
  service.on("tools-available", () => events.push("tools-available"));
  return { events, payloads };
}

const blockedEvents = () =>
  mockCaptureMessage.mock.calls.filter((c) => c[0] === "iPhone tool blocked by security software");

beforeEach(() => {
  jest.clearAllMocks();
  __resetToolBlockReportForTests();
  delete process.env.MOCK_DEVICE;
  setPlatform("win32");
  folder = makeToolsFolder(REQUIRED_IPHONE_TOOL_FILES);
  mockToolsDir = folder.dir;
  versionProbe(true);
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  folder.cleanup();
  jest.restoreAllMocks();
});

describe("C9: idevice_id spawn THROWS UNKNOWN", () => {
  it("emits tools-blocked with the restore steps and the poll resolves empty", async () => {
    idevice(() => {
      throw thrownSpawnError("UNKNOWN");
    });
    const service = new DeviceDetectionService();
    const { events, payloads } = watch(service);
    await expect(service.listDevices()).resolves.toEqual([]);
    expect(events).toEqual(["tools-blocked"]);
    expect(payloads[0]).toMatchObject({ userError: { code: "SECURITY_SOFTWARE_BLOCKED" } });
  });
});

describe("C6: Windows ENOENT with idevice_id.exe removed after a good poll", () => {
  it("emits tools-blocked, never tools-missing", async () => {
    idevice(exits(0, ""));
    const service = new DeviceDetectionService();
    const { events } = watch(service);
    await service.listDevices(); // availability cached true
    folder.remove("idevice_id.exe");
    idevice(() => {
      const proc = new FakeProcess();
      setTimeout(() => {
        proc.emit("error", emittedSpawnError("ENOENT", path.join(mockToolsDir, "idevice_id.exe"), ["-l"]));
        proc.emit("close", WIN_ERRNO.ENOENT);
      }, 0);
      return proc;
    });
    await service.listDevices();
    expect(events).toEqual(["tools-blocked"]);
  });

  it("a file removed before the first poll is named by the pre-check, without running idevice_id", async () => {
    folder.remove("usbmuxd.dll");
    idevice(exits(0, ""));
    const service = new DeviceDetectionService();
    const { events } = watch(service);
    await service.listDevices();
    expect(events).toEqual(["tools-blocked"]);
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("C7: macOS keeps the existing path", () => {
  it("ENOENT -> tools-missing, no tools-blocked, no stat", async () => {
    setPlatform("darwin");
    const stat = jest.spyOn(fs, "statSync");
    idevice(() => {
      const proc = new FakeProcess();
      setTimeout(() => {
        proc.emit("error", Object.assign(new Error("spawn idevice_id ENOENT"), {
          errno: -2,
          code: "ENOENT",
          syscall: "spawn idevice_id",
          path: "idevice_id",
          spawnargs: ["-l"],
        }));
        proc.emit("close", -2);
      }, 0);
      return proc;
    });
    const service = new DeviceDetectionService();
    const { events } = watch(service);
    await service.listDevices();
    expect(events).toEqual(["tools-missing"]);
    expect(stat).not.toHaveBeenCalled();
    expect(blockedEvents()).toHaveLength(0);
  });
});

describe("C4: look-alikes on the poller", () => {
  it("'Unable to retrieve device list' exit -1 is not a block (even with a file missing)", async () => {
    idevice(exits(0, ""));
    const service = new DeviceDetectionService();
    const { events } = watch(service);
    await service.listDevices();
    folder.remove("idevicepair.exe");
    idevice(exits(-1, "", "ERROR: Unable to retrieve device list!\n"));
    await service.listDevices();
    expect(events).toEqual([]);
    expect(blockedEvents()).toHaveLength(0);
  });

  it("exit 0 with no phone is not a block", async () => {
    idevice(exits(0, ""));
    const service = new DeviceDetectionService();
    const { events } = watch(service);
    await service.listDevices();
    await service.listDevices();
    expect(events).toEqual([]);
  });
});

describe("C8: one Sentry event across five blocked polls", () => {
  it("sends one event; main.log gets every occurrence", async () => {
    idevice(() => {
      throw thrownSpawnError("EPERM");
    });
    // The --version probe keeps answering, so every poll reaches the refused spawn.
    const service = new DeviceDetectionService();
    let detections = 0;
    service.on("tools-blocked", () => detections++);
    for (let i = 0; i < 5; i++) await service.listDevices();
    expect(detections).toBe(5);
    expect(blockedEvents()).toHaveLength(1);
    expect(blockedEvents()[0][1]).toMatchObject({ tags: { iphone_tool_block: "spawn-eperm", tool: "idevice_id" } });
  });
});
