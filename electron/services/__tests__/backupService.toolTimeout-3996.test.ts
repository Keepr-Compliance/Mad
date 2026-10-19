/**
 * BACKLOG-3996: BackupService's iPhone queries and kills.
 *
 *  F   the backup-encryption check has a time limit and stops on Cancel.
 *  R5  startBackup's own encryption check timing out ends the backup with
 *      IPHONE_TOOL_TIMEOUT; idevicebackup2 is NOT started on the "unknown" reading.
 *  C8  the watchdog SIGKILLs a stopped idevicebackup2 (macOS). The old guard was
 *      `!killed`, which the SIGTERM had already set, so the SIGKILL never went out.
 *
 * Fakes follow real child_process behaviour (plan probe P1a): a stopped process sent
 * SIGTERM reads killed=true and emits nothing; only SIGKILL makes it exit. They carry
 * pid, exitCode and signalCode, null while alive (SR R2). Runs as darwin.
 */
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

const UDID = "a1b2c3d4e5f6789012345678901234567890abcd";
const mockSpawn = jest.fn();
let mockUserData = "";

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => mockUserData),
    getVersion: jest.fn(() => "2.42.0"),
    isPackaged: false,
  },
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("child_process", () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));
jest.mock("../libimobiledeviceService", () => ({
  ...jest.requireActual("../libimobiledeviceService"),
  getCommand: (name: string) => name,
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
import { formatIphoneToolTimeoutError } from "../diagnostics/userFacingErrors";
import { IPHONE_QUERY_TIMEOUT_MS, __resetIphoneToolProcessForTests } from "../iphoneToolProcess";

class StoppedProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  pid: number;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  kill = jest.fn((signal?: string) => {
    this.killed = true;
    if (signal === "SIGKILL") {
      this.signalCode = "SIGKILL";
      this.emit("exit", null, "SIGKILL");
      this.emit("close", null, "SIGKILL");
    }
    return true;
  });
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

let spawned: Array<{ cmd: string; proc: StoppedProcess }> = [];
let infoBehaviour: "held" | "off" = "held";

const flush = () => new Promise<void>((r) => jest.requireActual<typeof import("timers")>("timers").setImmediate(r));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  jest.useFakeTimers();
  __resetIphoneToolProcessForTests();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3996-ud-"));
  spawned = [];
  infoBehaviour = "held";
  let pid = 300;
  mockSpawn.mockReset().mockImplementation((cmd: string) => {
    const proc = new StoppedProcess(pid++);
    spawned.push({ cmd, proc });
    if (cmd === "ideviceinfo" && infoBehaviour === "off") {
      void Promise.resolve().then(() => {
        proc.stdout.emit("data", Buffer.from("false\n"));
        proc.exitCode = 0;
        proc.emit("exit", 0, null);
        proc.emit("close", 0, null);
      });
    }
    return proc;
  });
});
afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(process, "platform", originalPlatform);
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

function newService(): BackupService {
  const s = new BackupService();
  s.on("error", () => {});
  return s;
}
const of = (cmd: string) => spawned.filter((s) => s.cmd === cmd);

describe("F: the backup-encryption check", () => {
  it("never answers -> 'unknown' + timedOut at 90 s, and the query is killed", async () => {
    let info: unknown = "pending";
    void newService().checkEncryptionStatus(UDID).then((v) => (info = v));
    await flush();
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS - 1);
    await flush();
    expect(info).toBe("pending");
    jest.advanceTimersByTime(1);
    await flush();
    expect(info).toEqual({ isEncrypted: false, needsPassword: false, status: "unknown", timedOut: true });
    expect(of("ideviceinfo")[0].proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("Cancel (abort) -> 'unknown' + cancelled at once, and the query is killed", async () => {
    const ac = new AbortController();
    const pending = newService().checkEncryptionStatus(UDID, { signal: ac.signal });
    await flush();
    ac.abort();
    await expect(pending).resolves.toEqual({ isEncrypted: false, needsPassword: false, status: "unknown", cancelled: true });
    expect(of("ideviceinfo")[0].proc.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("R5: startBackup's own encryption check", () => {
  it("a time-out ends the backup with IPHONE_TOOL_TIMEOUT and idevicebackup2 is never spawned", async () => {
    let result: { errorCode?: string; error?: string | null } | null = null;
    void newService().startBackup({ udid: UDID }).then((r) => (result = r));
    await flush();
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS);
    await flush();
    await flush();
    expect(result).not.toBeNull();
    expect(result!.errorCode).toBe("IPHONE_TOOL_TIMEOUT");
    expect(result!.error).toBe(formatIphoneToolTimeoutError().description);
    expect(of("idevicebackup2")).toHaveLength(0);
  });

  it("Cancel during it: the query is killed, BACKUP_CANCELLED, and idevicebackup2 is never spawned", async () => {
    const svc = newService();
    const pending = svc.startBackup({ udid: UDID });
    await flush();
    expect(of("ideviceinfo")).toHaveLength(1);
    svc.cancelBackup();
    const result = await pending;
    expect(result.errorCode).toBe("BACKUP_CANCELLED");
    expect(of("ideviceinfo")[0].proc.kill).toHaveBeenCalledWith("SIGKILL");
    jest.advanceTimersByTime(IPHONE_QUERY_TIMEOUT_MS);
    await flush();
    expect(of("idevicebackup2")).toHaveLength(0);
  });

  it("quit during it: the query is stopped and idevicebackup2 is never spawned", async () => {
    const svc = newService();
    const pending = svc.startBackup({ udid: UDID });
    await flush();
    expect(svc.stopForQuit()).toBeNull();
    const result = await pending;
    expect(result.errorCode).toBe("BACKUP_CANCELLED");
    expect(of("idevicebackup2")).toHaveLength(0);
  });
});

describe("C8: the watchdog kills a STOPPED idevicebackup2 on macOS", () => {
  it("SIGTERM, then SIGKILL 5 s later although .killed is already true", async () => {
    infoBehaviour = "off";
    const svc = newService();
    void svc.startBackup({ udid: UDID });
    // Wait on the spawn itself, not a turn count: the pre-spawn async steps take a
    // variable number of turns on a slow runner (Windows CI flaked at 10).
    let turns = 0;
    while (of("idevicebackup2").length === 0 && turns < 500) {
      await flush();
      turns++;
    }
    const backup = of("idevicebackup2")[0];
    if (!backup) throw new Error(`idevicebackup2 was never spawned after ${turns} event-loop turns`);

    // No output at all: step the clock until the watchdog fires (past the 30 min window).
    let waited = 0;
    while (backup.proc.kill.mock.calls.length === 0 && waited < 40 * 60 * 1000) {
      jest.advanceTimersByTime(1000);
      waited += 1000;
    }
    expect(waited).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(backup.proc.kill.mock.calls).toEqual([["SIGTERM"]]);
    jest.advanceTimersByTime(4999);
    expect(backup.proc.kill.mock.calls).toEqual([["SIGTERM"]]);
    jest.advanceTimersByTime(1);
    expect(backup.proc.killed).toBe(true);
    expect(backup.proc.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });
});
