/**
 * BACKLOG-3598 — quitting Keepr stops a running iPhone backup.
 *
 * Before: `before-quit` (backupHandlers.ts) cancelled only the module singleton
 * `backupService`, but the sync runs on the orchestrator's OWN `new BackupService()`,
 * and idevicebackup2 is spawned without `detached`, so it kept running after quit.
 *
 * `currentProcess` is set directly to a fake ChildProcess (an EventEmitter with `kill`,
 * `pid`, `exitCode`, `signalCode` — the fields `stopForQuit` reads), as in
 * backupService.cancelKillTimer-3598.test.ts. Spawning a real idevicebackup2 is not
 * possible here. `child_process.spawn` is mocked so the Windows taskkill path never runs.
 *
 * The orchestrator harness (mocks below) is copied from
 * deviceSyncOrchestrator.failedSyncCleanup-3598.test.ts.
 */

import { EventEmitter } from "events";

const spawnMock = jest.fn(() => ({ on: jest.fn() }));
jest.mock("child_process", () => ({
  ...jest.requireActual("child_process"),
  spawn: (...args: unknown[]) => (spawnMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

jest.mock("electron", () => ({
  // BACKLOG-3816 S4-C (B1): a fresh userData per file, never a fixed shared path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  app: { isPackaged: false, getPath: jest.fn(() => require("./helpers/testUserData").testUserDataDir()) },
}));
// B1: the kept backup's at-rest layer and the saved-password store are not this suite's subject.
jest.mock("../atRest/backupAtRest", () => ({
  ...jest.requireActual("../atRest/backupAtRest"),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getBackupAtRest: () => require("./helpers/passThroughBackupAtRest").passThroughBackupAtRest,
}));
jest.mock("../atRest/backupPassword", () => ({
  ...jest.requireActual("../atRest/backupPassword"),
  getBackupPasswordStore: () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./helpers/passThroughBackupAtRest").passThroughBackupPasswordStore,
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));
jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({ all: jest.fn(), get: jest.fn(), run: jest.fn() }),
    close: jest.fn(),
  })),
);
jest.mock("check-disk-space", () =>
  jest.fn().mockResolvedValue({ diskPath: "C:", free: 500 * 1024 * 1024 * 1024, size: 1000 * 1024 * 1024 * 1024 }),
);

jest.mock("../diagnostics/diskSpaceDiagnostics", () => ({
  ...jest.requireActual("../diagnostics/diskSpaceDiagnostics"),
  checkDiskSpaceForOperation: jest
    .fn()
    .mockResolvedValue({ sufficient: true, availableMB: 500000, requiredMB: 1000 }),
}));

jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: jest
    .fn()
    .mockResolvedValue({ isInstalled: true, serviceRunning: true, version: "12.0.0", error: null }),
}));

jest.mock("../libimobiledeviceService", () => ({
  canUseLibimobiledevice: jest.fn(() => true),
  getCommand: jest.fn(() => "/nonexistent/idevicebackup2"),
  isMockMode: jest.fn(() => false),
}));

jest.mock("../backupDecryptionService", () => ({
  BackupDecryptionService: jest.fn().mockImplementation(() => ({
    isBackupEncrypted: jest.fn().mockResolvedValue(false),
    decryptBackup: jest.fn(),
    cleanup: jest.fn(),
  })),
  backupDecryptionService: { isBackupEncrypted: jest.fn().mockResolvedValue(false) },
}));

jest.mock("../deviceDetectionService", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require("events");
  const svc = new Emitter();
  Object.assign(svc, {
    start: jest.fn(),
    stop: jest.fn(),
    getConnectedDevices: jest.fn().mockReturnValue([]),
    getDeviceStorageInfo: jest.fn().mockResolvedValue({
      totalCapacity: 256 * 1024 * 1024 * 1024,
      usedSpace: 128 * 1024 * 1024 * 1024,
      availableSpace: 128 * 1024 * 1024 * 1024,
      estimatedBackupSize: 11_547 * 1024 * 1024,
    }),
  });
  return {
    DeviceDetectionService: jest.fn().mockImplementation(() => svc),
    deviceDetectionService: svc,
  };
});

jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    getConversationsAsync: jest.fn().mockResolvedValue([]),
    getMessagesAsync: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock("../iosContactsParser", () => ({
  iOSContactsParser: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    getAllContacts: jest.fn().mockReturnValue([]),
    lookupByHandle: jest.fn().mockReturnValue({ contact: null, matchType: null }),
  })),
}));

import { BackupService, backupService as singletonBackupService } from "../backupService";
import { DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";
import { syncTimeline } from "../syncTimeline";
import { createBackupStopOnQuit } from "../../utils/backupStopOnQuit";

type FakeProcess = EventEmitter & {
  kill: jest.Mock;
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
};

/** `exitsOnSigterm`: the process exits when asked (the normal idevicebackup2 case). */
function fakeProcess(exitsOnSigterm: boolean): FakeProcess {
  const p = new EventEmitter() as FakeProcess;
  p.pid = 4242;
  p.exitCode = null;
  p.signalCode = null;
  p.kill = jest.fn((signal: string) => {
    if (exitsOnSigterm || signal === "SIGKILL") {
      p.signalCode = signal;
      p.emit("exit", null, signal);
    }
    return true;
  });
  return p;
}

const setCurrent = (svc: BackupService, p: FakeProcess | null) => {
  (svc as unknown as { currentProcess: FakeProcess | null }).currentProcess = p;
};
const getBackupServiceOf = (orch: DeviceSyncOrchestrator): BackupService =>
  (orch as unknown as { backupService: BackupService }).backupService;

/** Settles microtasks without advancing fake time. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p });

afterEach(() => {
  jest.useRealTimers();
  setPlatform(realPlatform);
  spawnMock.mockClear();
  setCurrent(singletonBackupService, null);
});

describe("BACKLOG-3598: BackupService.stopForQuit", () => {
  it("SIGTERMs the process and resolves when it exits — no force-kill", async () => {
    const svc = new BackupService();
    const proc = fakeProcess(true);
    setCurrent(svc, proc);

    await expect(svc.stopForQuit()).resolves.toBe("exited");
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(svc.getStatus().isRunning).toBe(false);
  });

  it("is bounded: a process that ignores SIGTERM is SIGKILLed at 3 s and the wait ends", async () => {
    jest.useFakeTimers();
    setPlatform("darwin");
    const svc = new BackupService();
    const proc = fakeProcess(false);
    setCurrent(svc, proc);

    let outcome: string | null = null;
    void svc.stopForQuit()!.then((o) => (outcome = o));

    jest.advanceTimersByTime(BackupService.QUIT_STOP_TIMEOUT_MS - 1);
    await flush();
    expect(outcome).toBeNull();
    expect(proc.kill).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    await flush();
    expect(outcome).toBe("killed");
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(BackupService.QUIT_STOP_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });

  it("on Windows the force-kill takes the whole process tree (taskkill /T /F)", async () => {
    jest.useFakeTimers();
    setPlatform("win32");
    const svc = new BackupService();
    const proc = fakeProcess(false);
    setCurrent(svc, proc);

    let outcome: string | null = null;
    void svc.stopForQuit()!.then((o) => (outcome = o));
    jest.advanceTimersByTime(BackupService.QUIT_STOP_TIMEOUT_MS);
    await flush();

    expect(outcome).toBe("killed");
    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("no process: returns null, no error", () => {
    const svc = new BackupService();
    setCurrent(svc, null);
    expect(svc.stopForQuit()).toBeNull();
  });

  it("process already exited: returns null and sends no signal", () => {
    const svc = new BackupService();
    const proc = fakeProcess(true);
    proc.exitCode = 0;
    setCurrent(svc, proc);

    expect(() => svc.stopForQuit()).not.toThrow();
    expect(svc.stopForQuit()).toBeNull();
    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-3598: the orchestrator stops ITS OWN backup, not the singleton's", () => {
  it("kills the process on the orchestrator's BackupService and records only endedBy=app-quit", async () => {
    const orch = new DeviceSyncOrchestrator();
    const orchestratorProc = fakeProcess(true);
    const singletonProc = fakeProcess(true);
    setCurrent(getBackupServiceOf(orch), orchestratorProc);
    setCurrent(singletonBackupService, singletonProc);
    expect(getBackupServiceOf(orch)).not.toBe(singletonBackupService);

    const endSync = jest.spyOn(syncTimeline, "endSync");
    const noteEndedBy = jest.spyOn(syncTimeline, "noteEndedBy");

    await expect(orch.stopBackupForQuit()).resolves.toBe("exited");
    expect(orchestratorProc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(singletonProc.kill).not.toHaveBeenCalled();
    expect(endSync).not.toHaveBeenCalled();
    expect(noteEndedBy).toHaveBeenCalledTimes(1);
    expect(noteEndedBy).toHaveBeenCalledWith("app-quit");
  });

  it("no backup running: returns null so the quit is not deferred", () => {
    const orch = new DeviceSyncOrchestrator();
    expect(orch.stopBackupForQuit()).toBeNull();
  });
});

describe("BACKLOG-3598: before-quit wiring (createBackupStopOnQuit)", () => {
  const makeApp = () => ({ quit: jest.fn() });
  const makeEvent = () => ({ preventDefault: jest.fn() });

  it("nothing running: the quit goes ahead, untouched", () => {
    const app = makeApp();
    const check = createBackupStopOnQuit(app, () => null);
    const event = makeEvent();
    expect(check(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("backup running: defers the quit, stops it, quits again exactly once", async () => {
    const app = makeApp();
    let release!: () => void;
    const stop = jest.fn(() => new Promise<void>((r) => (release = r)));
    const check = createBackupStopOnQuit(app, stop);

    const first = makeEvent();
    expect(check(first)).toBe(true);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();

    release();
    await flush();
    expect(app.quit).toHaveBeenCalledTimes(1);

    // The re-quit is not deferred again, and stop is not asked twice.
    const second = makeEvent();
    expect(check(second)).toBe(false);
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("a second quit while the backup is being stopped is held; stop is not asked twice (BACKLOG-3785)", async () => {
    const app = makeApp();
    let release!: () => void;
    const stop = jest.fn(() => new Promise<void>((r) => (release = r)));
    const check = createBackupStopOnQuit(app, stop);

    expect(check(makeEvent())).toBe(true);
    const second = makeEvent();
    expect(check(second)).toBe(true);
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);

    release();
    await flush();
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(check(makeEvent())).toBe(false);
  });

  it("re-entrant re-quit: before-quit fires synchronously inside app.quit() and is not deferred (BACKLOG-3785)", async () => {
    // Real Electron emits before-quit synchronously from app.quit().
    let release!: () => void;
    const stop = jest.fn(() => new Promise<void>((r) => (release = r)));
    const reentrant: Array<{ deferred: boolean; prevented: number }> = [];
    let check!: ReturnType<typeof createBackupStopOnQuit>;
    const app = {
      quit: jest.fn(() => {
        const event = makeEvent();
        const deferred = check(event);
        reentrant.push({ deferred, prevented: event.preventDefault.mock.calls.length });
      }),
    };
    check = createBackupStopOnQuit(app, stop);

    expect(check(makeEvent())).toBe(true);
    release();
    await flush();

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(reentrant).toEqual([{ deferred: false, prevented: 0 }]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("a stop that rejects still quits", async () => {
    const app = makeApp();
    const check = createBackupStopOnQuit(app, () => Promise.reject(new Error("boom")));
    expect(check(makeEvent())).toBe(true);
    await flush();
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it("a stop that throws does not defer the quit", () => {
    const app = makeApp();
    const event = makeEvent();
    const check = createBackupStopOnQuit(app, () => {
      throw new Error("boom");
    });
    expect(check(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./helpers/testUserData").removeTestUserDataDir();
});
