/**
 * BACKLOG-3814 — one automatic retry after a backup tool start held by a security scan.
 *
 * Harness: the 3598 suite's (real BackupService, real temp folder, `startBackup`
 * replaced). Every failed attempt returns `heldStartFailure()`, the result the REAL
 * BackupService produces for the transcribed Windows run — asserted in
 * backupService.toolStartHold-3814.test.ts. Only `toolStart` is varied, and only to the
 * values that producer emits.
 *
 * The BACKLOG-2913 rule is the reason for the gate: quick repeated retries are what
 * leave the phone's backup service refusing. So the retry happens once, after a wait,
 * and only on the held-start signal (or the tool's first run under this version).
 */
import fsSync from "fs";
import os from "os";
import path from "path";

const UDID = "00008030-0011223344556677";

jest.mock("../atRest/backupAtRest", () => ({
  ...jest.requireActual("../atRest/backupAtRest"),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getBackupAtRest: () => require("./helpers/passThroughBackupAtRest").passThroughBackupAtRest,
}));
jest.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(() => process.env.KEEPR_3814_USERDATA as string),
  },
}));

const logLines: string[] = [];
const push = (...args: unknown[]) => {
  logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
};
jest.mock("electron-log", () => ({
  info: (...a: unknown[]) => push(...a),
  warn: (...a: unknown[]) => push(...a),
  error: (...a: unknown[]) => push(...a),
  debug: jest.fn(),
}));
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
  checkDiskSpaceForOperation: jest.fn().mockResolvedValue({ sufficient: true, availableMB: 500000, requiredMB: 1000 }),
}));
jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: jest.fn().mockResolvedValue({ isInstalled: true, serviceRunning: true, version: "12.0.0", error: null }),
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
    probeConnectedUdids: jest.fn().mockResolvedValue([]),
    getDeviceStorageInfo: jest.fn().mockResolvedValue({
      totalCapacity: 256 * 1024 * 1024 * 1024,
      usedSpace: 128 * 1024 * 1024 * 1024,
      availableSpace: 128 * 1024 * 1024 * 1024,
      estimatedBackupSize: 1024 * 1024,
    }),
  });
  return { DeviceDetectionService: jest.fn().mockImplementation(() => svc), deviceDetectionService: svc };
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

import { BackupService, BACKUP_SERVICE_UNAVAILABLE_MESSAGE } from "../backupService";
import { BACKUP_DEVICE_DISCONNECTED_MESSAGE, DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";
import { syncTimeline } from "../syncTimeline";
import { TOOL_START_HOLD_FAILED_MESSAGE, TOOL_START_HOLD_STATUS_MESSAGE } from "../toolStartHold";
import { heldStartFailure, SPAWN_BLOCK_MS } from "./helpers/toolStartHoldFixture";
import type { BackupResult } from "../../types/backup";

// Copied unchanged from backupService.interruptedDetection-2911.test.ts (real bytes).
const DERIVED_FINISHED_STATUS_PLIST_B64 =
  "YnBsaXN0MDDWAQIDBAUGBwgJCgsMXVNuYXBzaG90U3RhdGVXVmVyc2lvbltCYWNrdXBTdGF0ZVxJc0Z1bGxCYWNrdXBURGF0ZVRVVUlEWGZpbmlzaGVkUzMuM1NuZXcJM0HIH+fmQCC8XxAkNjFBQzQ2MzItQzQ2RS00QkY4LTg4OEEtMEIxQzg5RkFBMzlECBUjKzdESU5XW19gaQAAAAAAAAEBAAAAAAAAAA0AAAAAAAAAAAAAAAAAAACQ";

let userDataDir: string;
const folder = () => path.join(userDataDir, "Backups", UDID);

/** A finished backup on disk (STATE A of the 2911/3598 suites). */
function writeFinishedBackup(): void {
  fsSync.mkdirSync(path.join(folder(), "0a"), { recursive: true });
  fsSync.writeFileSync(path.join(folder(), "0a", "blob0"), Buffer.alloc(4096, 1));
  fsSync.writeFileSync(path.join(folder(), "Info.plist"), "<plist></plist>");
  fsSync.writeFileSync(path.join(folder(), "Status.plist"), Buffer.from(DERIVED_FINISHED_STATUS_PLIST_B64, "base64"));
  fsSync.writeFileSync(path.join(folder(), "Manifest.db"), "SQLite format 3\u0000");
}

function success(): BackupResult {
  writeFinishedBackup();
  return {
    success: true,
    backupPath: folder(),
    error: null,
    duration: 1000,
    deviceUdid: UDID,
    backupSize: 4096,
    isIncremental: true,
    isEncrypted: false,
    deviceReportedBackupMode: null,
    toolStart: { delayMs: 40, delayed: false, firstRunThisVersion: false },
  } as BackupResult;
}

const HELD = () => heldStartFailure(UDID);
const NOT_HELD = () => heldStartFailure(UDID, { delayMs: 40, delayed: false, firstRunThisVersion: false });
const FIRST_RUN_NOT_HELD = () => heldStartFailure(UDID, { delayMs: 40, delayed: false, firstRunThisVersion: true });

let startBackupSpy: jest.SpyInstance;

/** Each call to startBackup takes the next entry. */
function attempts(...seq: Array<() => BackupResult>): void {
  let i = 0;
  startBackupSpy.mockImplementation(async () => {
    const next = seq[Math.min(i, seq.length - 1)];
    i++;
    return next();
  });
}

interface Observed {
  orchestrator: DeviceSyncOrchestrator;
  errors: string[];
  statuses: string[];
}

function newOrchestrator(): Observed {
  const orchestrator = new DeviceSyncOrchestrator();
  const errors: string[] = [];
  const statuses: string[] = [];
  orchestrator.on("error", (e: { message?: string }) => errors.push(String(e?.message)));
  orchestrator.on("progress", (p: { message?: string }) => {
    if (p.message) statuses.push(p.message);
  });
  orchestrator.on("complete", () => {});
  Object.assign(orchestrator, { disconnectConfirmDelayMs: 5, toolHoldRetryEnabled: true, toolHoldRetryDelayMs: 20 });
  return { orchestrator, errors, statuses };
}

function probeMock(): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../deviceDetectionService").deviceDetectionService.probeConnectedUdids;
}

beforeAll(() => {
  userDataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "keepr-3814-"));
  process.env.KEEPR_3814_USERDATA = userDataDir;
});
afterAll(() => {
  fsSync.rmSync(userDataDir, { recursive: true, force: true });
  delete process.env.KEEPR_3814_USERDATA;
});
beforeEach(() => {
  jest.restoreAllMocks();
  logLines.length = 0;
  syncTimeline.reset();
  fsSync.rmSync(path.join(userDataDir, "Backups"), { recursive: true, force: true });
  fsSync.mkdirSync(path.join(userDataDir, "Backups"), { recursive: true });
  startBackupSpy = jest.spyOn(BackupService.prototype, "startBackup");
  jest.spyOn(BackupService.prototype, "cancelBackup").mockImplementation(() => {});
  jest.spyOn(BackupService.prototype, "getStatus").mockReturnValue({ isRunning: false, currentDeviceUdid: null, progress: null });
  probeMock().mockReset();
  probeMock().mockResolvedValue([UDID]);
});

describe("BACKLOG-3814: one automatic retry after a held tool start", () => {
  it("C1 — held start + service unavailable -> exactly one retry -> success, no failure shown", async () => {
    const { orchestrator, errors, statuses } = newOrchestrator();
    attempts(HELD, success);

    const result = await orchestrator.sync({ udid: UDID });

    expect(startBackupSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(errors).toEqual([]);
    expect(statuses).toContain(TOOL_START_HOLD_STATUS_MESSAGE);
    expect(statuses).not.toContain(BACKUP_SERVICE_UNAVAILABLE_MESSAGE);
    expect(logLines.some((l) => l.includes("Retrying the backup once after a held tool start") && l.includes(String(SPAWN_BLOCK_MS)))).toBe(true);
  });

  it("C2 — held start + the retry fails the same way -> the scan message, error code unchanged", async () => {
    const { orchestrator } = newOrchestrator();
    attempts(HELD, NOT_HELD);

    const result = await orchestrator.sync({ udid: UDID });

    expect(startBackupSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.error).toBe(TOOL_START_HOLD_FAILED_MESSAGE);
    const outcome = logLines.filter((l) => l.includes("sync-outcome")).pop() ?? "";
    expect(outcome).toContain("SERVICE_UNAVAILABLE");
  });

  it("C3 — THE 2913 RULE: a service-unavailable failure with a normal start (not a first run) is NOT retried and keeps its message", async () => {
    const { orchestrator } = newOrchestrator();
    attempts(NOT_HELD, success);

    const result = await orchestrator.sync({ udid: UDID });

    expect(startBackupSpy).toHaveBeenCalledTimes(1);
    expect(result.error).toBe(BACKUP_SERVICE_UNAVAILABLE_MESSAGE);
  });

  it("C3b — the tool's first run under this version: one retry even without a measured hold", async () => {
    const { orchestrator } = newOrchestrator();
    attempts(FIRST_RUN_NOT_HELD, success);

    const result = await orchestrator.sync({ udid: UDID });

    expect(startBackupSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  it("C3c — first run, retry fails, no hold measured on either: the original message (not the scan one)", async () => {
    const { orchestrator } = newOrchestrator();
    attempts(FIRST_RUN_NOT_HELD, NOT_HELD);

    const result = await orchestrator.sync({ udid: UDID });

    expect(startBackupSpy).toHaveBeenCalledTimes(2);
    expect(result.error).toBe(BACKUP_SERVICE_UNAVAILABLE_MESSAGE);
  });

  it("C6 — at most one retry: the retry is held and refused again -> no third attempt", async () => {
    const { orchestrator } = newOrchestrator();
    attempts(HELD, HELD, success);

    const result = await orchestrator.sync({ udid: UDID });

    expect(startBackupSpy).toHaveBeenCalledTimes(2);
    expect(result.error).toBe(TOOL_START_HOLD_FAILED_MESSAGE);
  });

  it("other failures after a held start are untouched: no retry, their own message", async () => {
    const { orchestrator } = newOrchestrator();
    attempts(() => ({ ...HELD(), errorCode: "CONNECTION_LOST", error: "The connection to your iPhone dropped." }) as BackupResult);

    const result = await orchestrator.sync({ udid: UDID });

    expect(startBackupSpy).toHaveBeenCalledTimes(1);
    expect(result.error).toBe("The connection to your iPhone dropped.");
  });

  it("platform without hold handling (macOS): no retry, original message", async () => {
    const { orchestrator } = newOrchestrator();
    Object.assign(orchestrator, { toolHoldRetryEnabled: false });
    attempts(HELD, success);

    const result = await orchestrator.sync({ udid: UDID });

    expect(startBackupSpy).toHaveBeenCalledTimes(1);
    expect(result.error).toBe(BACKUP_SERVICE_UNAVAILABLE_MESSAGE);
  });
});

describe("BACKLOG-3814 C4: cancel, unplug or quit during the wait -> no retry", () => {
  /** Runs `during` once the wait has started (the scan status is the wait's first act). */
  async function syncWithDuringWait(during: (o: DeviceSyncOrchestrator) => void) {
    const obs = newOrchestrator();
    Object.assign(obs.orchestrator, { toolHoldRetryDelayMs: 200 });
    attempts(HELD, success);
    obs.orchestrator.on("progress", (p: { message?: string }) => {
      if (p.message === TOOL_START_HOLD_STATUS_MESSAGE) setTimeout(() => during(obs.orchestrator), 10);
    });
    const result = await obs.orchestrator.sync({ udid: UDID });
    return { result, ...obs };
  }

  it("user cancel during the wait", async () => {
    const { result } = await syncWithDuringWait((o) => o.cancel("cancel-button" as never));
    expect(startBackupSpy).toHaveBeenCalledTimes(1);
    expect(result.error).toMatch(/cancel/i);
  });

  it("app quit during the wait: the quit is not held, and no retry starts", async () => {
    let stopping: unknown = "unset";
    const { result } = await syncWithDuringWait((o) => {
      stopping = o.stopBackupForQuit();
    });
    expect(stopping).toBeNull();
    expect(startBackupSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    const outcome = logLines.filter((l) => l.includes("sync-outcome")).pop() ?? "";
    expect(outcome).toContain("app-quit");
  });

  it("phone unplugged during the wait (absent from the listing after it): no retry, the disconnect message", async () => {
    probeMock().mockResolvedValue([]);
    const { result } = await syncWithDuringWait(() => {});
    expect(startBackupSpy).toHaveBeenCalledTimes(1);
    expect(result.error).toBe(BACKUP_DEVICE_DISCONNECTED_MESSAGE);
  });

  it("idevice_id cannot answer after the wait (unknown, not gone): the retry runs", async () => {
    probeMock().mockResolvedValue(null);
    const { result } = await syncWithDuringWait(() => {});
    expect(startBackupSpy).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  it("Try Again during the wait is refused (the first backup's frame still holds the phone)", async () => {
    let second: ReturnType<DeviceSyncOrchestrator["sync"]> | null = null;
    const { result } = await syncWithDuringWait((o) => {
      second = o.sync({ udid: UDID });
    });
    expect(result.success).toBe(true);
    expect((await second!).error).toBe("Sync already in progress");
    expect(startBackupSpy).toHaveBeenCalledTimes(2);
  });
});
