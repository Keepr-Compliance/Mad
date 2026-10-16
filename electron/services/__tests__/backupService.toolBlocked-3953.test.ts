/**
 * BACKLOG-3953: the REAL BackupService when an iPhone tool never starts (Windows).
 *
 * Only `spawn` is replaced; the tools folder is real (helpers/iphoneToolsFolder-3953)
 * and so is every stat the block detector makes. Error shapes are transcribed in
 * fixtures/windowsSpawnErrors-3953.ts.
 *
 *  C1  idevicebackup2 spawn THROWS EPERM -> TOOL_BLOCKED, and the service is not left
 *      "Backup already in progress" (SR probe confirmed that lock-up on the old code).
 *  C2  idevicebackup2 'error' ENOENT then 'close'(-4058), exe gone -> TOOL_BLOCKED, not
 *      "neither this computer nor your iPhone reported a reason (exit code -4058)".
 *  C11 ideviceinfo spawn THROWS EPERM inside the encryption check -> TOOL_BLOCKED from
 *      startBackup, not a raw rejection; idevicebackup2 never spawned.
 *  C4  a tool that STARTED and failed (exit 1, no output; exit -1) is never TOOL_BLOCKED.
 */
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

const UDID = "a1b2c3d4e5f6789012345678901234567890abcd";
const mockSpawn = jest.fn();
let mockUserData = "";
let mockToolsDir = "";

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => mockUserData),
    getVersion: jest.fn(() => "2.42.0"),
    isPackaged: false,
  },
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockCaptureMessage = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  addBreadcrumb: jest.fn(),
}));
jest.mock("child_process", () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));
jest.mock("../libimobiledeviceService", () => ({
  ...jest.requireActual("../libimobiledeviceService"),
  getLibimobiledevicePath: () => mockToolsDir,
  getCommand: (name: string) => path.join(mockToolsDir, `${name}.exe`),
  isMockMode: () => false,
}));
jest.mock("../backupDecryptionService", () => ({
  backupDecryptionService: {
    isBackupEncrypted: jest.fn().mockResolvedValue(false),
    decryptBackup: jest.fn(),
    cleanup: jest.fn(),
  },
}));

import { BackupService } from "../backupService";
import { __resetToolBlockReportForTests } from "../iphoneToolBlock";
import { REQUIRED_IPHONE_TOOL_FILES } from "../libimobiledeviceService";
import { formatToolBlockedError } from "../diagnostics/userFacingErrors";
import { makeToolsFolder, type ToolsFolder } from "./helpers/iphoneToolsFolder-3953";
import {
  thrownSpawnError,
  emittedSpawnError,
  WIN_ERRNO,
  DLL_NOT_FOUND_UNSIGNED,
} from "./fixtures/windowsSpawnErrors-3953";

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  kill = jest.fn();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
}

type ToolBehaviour = (args: string[]) => FakeProcess;

/** ideviceinfo answers "false" (encryption off) unless overridden. */
const encryptionOff: ToolBehaviour = () => {
  const proc = new FakeProcess();
  setTimeout(() => {
    proc.stdout.emit("data", Buffer.from("false\n"));
    proc.emit("close", 0);
  }, 0);
  return proc;
};

function tools(behaviour: { ideviceinfo?: ToolBehaviour; idevicebackup2: ToolBehaviour }) {
  mockSpawn.mockImplementation((cmd: string, args: string[]) => {
    if (cmd.includes("ideviceinfo")) return (behaviour.ideviceinfo ?? encryptionOff)(args);
    if (cmd.includes("idevicebackup2")) return behaviour.idevicebackup2(args);
    throw new Error(`unexpected spawn ${cmd}`);
  });
}

const spawnedBackupTool = () => mockSpawn.mock.calls.filter((c) => String(c[0]).includes("idevicebackup2")).length;

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let folder: ToolsFolder;

beforeEach(() => {
  jest.clearAllMocks();
  __resetToolBlockReportForTests();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  folder = makeToolsFolder(REQUIRED_IPHONE_TOOL_FILES);
  mockToolsDir = folder.dir;
  mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3953-ud-"));
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  folder.cleanup();
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

function newService(): BackupService {
  const service = new BackupService();
  // 'error' with no listener throws on an EventEmitter; the orchestrator always listens.
  service.on("error", () => {});
  return service;
}

describe("C1: spawn THROWS EPERM for idevicebackup2", () => {
  it("resolves TOOL_BLOCKED and leaves the service free for the next sync", async () => {
    tools({
      idevicebackup2: () => {
        throw thrownSpawnError("EPERM");
      },
    });
    const service = newService();
    const first = await service.startBackup({ udid: UDID });
    expect(first.errorCode).toBe("TOOL_BLOCKED");
    expect(first.error).toBe(formatToolBlockedError().description);
    expect(first.toolBlock).toMatchObject({ kind: "spawn-eperm", tool: "idevicebackup2" });
    expect((service as unknown as { isRunning: boolean }).isRunning).toBe(false);

    // The old code threw "Backup already in progress" here until the app restarted.
    const second = await service.startBackup({ udid: UDID });
    expect(second.errorCode).toBe("TOOL_BLOCKED");
    expect(spawnedBackupTool()).toBe(2);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it("a throw that is not a block (ENOEXEC-like code) still resets the service and rejects", async () => {
    tools({
      idevicebackup2: () => {
        throw Object.assign(new Error("spawn ENOEXEC"), { code: "ENOEXEC", errno: -8, syscall: "spawn" });
      },
    });
    const service = newService();
    await expect(service.startBackup({ udid: UDID })).rejects.toThrow("spawn ENOEXEC");
    await expect(service.startBackup({ udid: UDID })).rejects.toThrow("spawn ENOEXEC");
  });
});

describe("C2: 'error' ENOENT then 'close'(-4058) with idevicebackup2.exe gone", () => {
  it("is TOOL_BLOCKED, not the no-reason exit-code sentence", async () => {
    folder.remove("idevicebackup2.exe");
    tools({
      idevicebackup2: (args) => {
        const proc = new FakeProcess();
        const file = path.join(mockToolsDir, "idevicebackup2.exe");
        setTimeout(() => {
          proc.emit("error", emittedSpawnError("ENOENT", file, args));
          proc.emit("close", WIN_ERRNO.ENOENT, null);
        }, 0);
        return proc;
      },
    });
    const result = await newService().startBackup({ udid: UDID });
    expect(result.errorCode).toBe("TOOL_BLOCKED");
    expect(result.error).not.toMatch(/exit code -4058/);
  });
});

describe("C11: ideviceinfo spawn THROWS EPERM inside the encryption check", () => {
  it("startBackup resolves TOOL_BLOCKED and never starts idevicebackup2", async () => {
    tools({
      ideviceinfo: () => {
        throw thrownSpawnError("EPERM");
      },
      idevicebackup2: () => {
        throw new Error("must not be reached");
      },
    });
    const result = await newService().startBackup({ udid: UDID });
    expect(result.errorCode).toBe("TOOL_BLOCKED");
    expect(result.toolBlock).toMatchObject({ kind: "spawn-eperm", tool: "ideviceinfo" });
    expect(spawnedBackupTool()).toBe(0);
  });
});

describe("C4: a tool that started and failed is never TOOL_BLOCKED", () => {
  const exitsWith = (code: number, stderr = ""): ToolBehaviour => () => {
    const proc = new FakeProcess();
    setTimeout(() => {
      if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
      proc.emit("close", code, null);
    }, 0);
    return proc;
  };

  it.each([
    ["exit 1, no output", 1, ""],
    ["exit -1, no output", -1, ""],
    ["exit 255 with a device error line", 255, "ERROR: Could not connect to lockdownd: -17\n"],
  ])("%s", async (_label, code, stderr) => {
    tools({ idevicebackup2: exitsWith(code as number, stderr as string) });
    const result = await newService().startBackup({ udid: UDID });
    expect(result.success).toBe(false);
    expect(result.errorCode).not.toBe("TOOL_BLOCKED");
    expect(mockCaptureMessage.mock.calls.filter((c) => /security software/.test(String(c[0])))).toHaveLength(0);
  });

  it("exit 1 with a file missing is still not TOOL_BLOCKED (it started)", async () => {
    folder.remove("idevicepair.exe");
    tools({ idevicebackup2: exitsWith(1) });
    expect((await newService().startBackup({ udid: UDID })).errorCode).not.toBe("TOOL_BLOCKED");
  });

  it("DLL-not-found exit with every file present is not TOOL_BLOCKED", async () => {
    tools({ idevicebackup2: exitsWith(DLL_NOT_FOUND_UNSIGNED) });
    expect((await newService().startBackup({ udid: UDID })).errorCode).not.toBe("TOOL_BLOCKED");
  });

  it("DLL-not-found exit WITH a DLL missing is TOOL_BLOCKED", async () => {
    folder.remove("libssl-1_1-x64.dll");
    tools({ idevicebackup2: exitsWith(DLL_NOT_FOUND_UNSIGNED) });
    const result = await newService().startBackup({ udid: UDID });
    expect(result.errorCode).toBe("TOOL_BLOCKED");
  });
});
