/**
 * BACKLOG-3598 — a failed or cancelled iPhone sync leaves `Backups/<udid>` as it found it.
 *
 * Rule: if the sync started with no backup folder, or with an unusable one (no
 * `Manifest.db`), a failed or cancelled backup removes the unfinished folder. If it
 * started from a usable backup, that backup is kept. A sync also sweeps leftovers from
 * earlier failed syncs before it starts.
 *
 * ## Harness
 *
 * The REAL `BackupService` runs against a REAL temp directory (`fs` is not mocked), the
 * same approach as `backupService.interruptedDetection-2911.test.ts`. Only
 * `startBackup` / `cancelBackup` are replaced: each fake `startBackup` writes the
 * on-disk state the real idevicebackup2 run leaves behind, then returns the
 * `BackupResult` that run returns. Nothing about classification or deletion is mocked.
 *
 * ## Fixture provenance
 *
 * On-disk states are the BACKLOG-2911 STATE A-D shapes (see that file for the real
 * bytes and where they came from):
 *   STATE A  finished Status.plist + Info.plist + Manifest.db   (usable)
 *   STATE B  torn Status.plist + Info.plist, NO Manifest.db       (unfinished first backup)
 *   STATE C  torn Status.plist + Info.plist + Manifest.db         (interrupted incremental;
 *            BACKLOG-2911 measured Manifest.db byte-identical before/after a cable pull)
 * The Status.plist bytes below are copied from that file unchanged. Blob files are
 * filler: only their existence and size matter to the code under test.
 */

import fsSync from "fs";
import os from "os";
import path from "path";

const UDID = "00008030-0011223344556677";
const OTHER_UDID = "00008101-0099887766554433";
const GB = 1024 * 1024 * 1024;

// Copied unchanged from backupService.interruptedDetection-2911.test.ts.
const REAL_TORN_STATUS_PLIST_B64 =
  "YnBsaXN0MDDWAQIDBAUGBwgJCgsMXElzRnVsbEJhY2t1cFdWZXJzaW9uVFVVSURURGF0ZVtCYWNrdXBTdGF0ZV1TbmFwc2hvdFN0YXRlCVMzLjNfECQ2MUFDNDYzMi1DNDZFLTRCRjgtODg4QS0wQjFDODlGQUEzOUQzQcgf5+ZAILxVZW1wdHlZdXBsb2FkaW5nCBUiKi80QE5PU3qDiQAAAAAAAAEBAAAAAAAAAA0AAAAAAAAAAAAAAAAAAACT";
const DERIVED_FINISHED_STATUS_PLIST_B64 =
  "YnBsaXN0MDDWAQIDBAUGBwgJCgsMXVNuYXBzaG90U3RhdGVXVmVyc2lvbltCYWNrdXBTdGF0ZVxJc0Z1bGxCYWNrdXBURGF0ZVRVVUlEWGZpbmlzaGVkUzMuM1NuZXcJM0HIH+fmQCC8XxAkNjFBQzQ2MzItQzQ2RS00QkY4LTg4OEEtMEIxQzg5RkFBMzlECBUjKzdESU5XW19gaQAAAAAAAAEBAAAAAAAAAA0AAAAAAAAAAAAAAAAAAACQ";
const TORN_BYTES = Buffer.from(REAL_TORN_STATUS_PLIST_B64, "base64");
const FINISHED_BYTES = Buffer.from(DERIVED_FINISHED_STATUS_PLIST_B64, "base64");
// Escaped NUL, never a raw byte (a raw NUL makes the file grep as binary).
const SQLITE_MAGIC = "SQLite format 3\u0000";
const BLOB_BYTES = 4096;

jest.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(() => process.env.KEEPR_3598_USERDATA as string),
  },
}));

const logLines: string[] = [];
jest.mock("electron-log", () => ({
  info: (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  },
  warn: (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  },
  error: (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  },
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

import { BackupService } from "../backupService";
import { DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";
import { syncTimeline } from "../syncTimeline";
import type { BackupResult } from "../../types/backup";

// ---------------------------------------------------------------------------
// On-disk states
// ---------------------------------------------------------------------------

type DiskState = "A" | "B" | "C" | "B-with-manifest";

let userDataDir: string;

function folderFor(udid: string): string {
  return path.join(userDataDir, "Backups", udid);
}

/** Lay down one of the STATE shapes in `Backups/<udid>`, replacing what is there. */
function writeState(udid: string, state: DiskState, blobs = 3): void {
  const dir = folderFor(udid);
  fsSync.rmSync(dir, { recursive: true, force: true });
  fsSync.mkdirSync(path.join(dir, "0a"), { recursive: true });
  for (let i = 0; i < blobs; i++) {
    fsSync.writeFileSync(path.join(dir, "0a", `blob${i}`), Buffer.alloc(BLOB_BYTES, 1));
  }
  fsSync.writeFileSync(path.join(dir, "Info.plist"), "<plist></plist>");
  fsSync.writeFileSync(path.join(dir, "Status.plist"), state === "A" ? FINISHED_BYTES : TORN_BYTES);
  if (state === "A" || state === "C" || state === "B-with-manifest") {
    fsSync.writeFileSync(path.join(dir, "Manifest.db"), SQLITE_MAGIC);
  }
}

const exists = (udid: string) => fsSync.existsSync(folderFor(udid));

// ---------------------------------------------------------------------------
// The backup process stand-in
// ---------------------------------------------------------------------------

function failure(overrides: Partial<BackupResult> = {}): BackupResult {
  return {
    success: false,
    backupPath: null,
    error: "The connection to your iPhone was lost.",
    errorCode: "CONNECTION_LOST",
    duration: 1000,
    deviceUdid: UDID,
    backupSize: null,
    isIncremental: false,
    isEncrypted: false,
    deviceReportedBackupMode: null,
    ...overrides,
  } as BackupResult;
}

let startBackupSpy: jest.SpyInstance;
let cancelBackupSpy: jest.SpyInstance;
let sweepSpy: jest.SpyInstance;
let removeSpy: jest.SpyInstance;

/** The fake run writes `post` into this phone's folder, then fails with `result`. */
function backupLeaves(post: DiskState | null, result: BackupResult = failure()): void {
  startBackupSpy.mockImplementation(async () => {
    if (post) writeState(UDID, post);
    return result;
  });
}

function newOrchestrator(): DeviceSyncOrchestrator {
  const o = new DeviceSyncOrchestrator();
  o.on("error", () => {});
  return o;
}

function outcomeRow(): string {
  const rows = logLines.filter((l) => l.includes("sync-outcome"));
  return rows[rows.length - 1] ?? "";
}

beforeAll(() => {
  userDataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "keepr-3598-"));
  process.env.KEEPR_3598_USERDATA = userDataDir;
});

afterAll(() => {
  fsSync.rmSync(userDataDir, { recursive: true, force: true });
  delete process.env.KEEPR_3598_USERDATA;
});

beforeEach(() => {
  jest.restoreAllMocks();
  logLines.length = 0;
  syncTimeline.reset();
  fsSync.rmSync(path.join(userDataDir, "Backups"), { recursive: true, force: true });
  fsSync.mkdirSync(path.join(userDataDir, "Backups"), { recursive: true });
  startBackupSpy = jest.spyOn(BackupService.prototype, "startBackup");
  cancelBackupSpy = jest.spyOn(BackupService.prototype, "cancelBackup").mockImplementation(() => {});
  sweepSpy = jest.spyOn(BackupService.prototype, "sweepLeftoverBackups");
  removeSpy = jest.spyOn(BackupService.prototype, "removeLeftoverBackup");
});

// ---------------------------------------------------------------------------
// Control 1 / 2 — a first sync that fails or is cancelled leaves nothing behind
// ---------------------------------------------------------------------------

describe("BACKLOG-3598: a failed first sync removes its unfinished backup", () => {
  it("CONTROL 1 — device error mid-transfer: the folder is gone and the row records it", async () => {
    backupLeaves("B");

    const result = await newOrchestrator().sync({ udid: UDID });

    expect(result.success).toBe(false);
    // The sync's own error reaches the user unchanged.
    expect(result.error).toBe("The connection to your iPhone was lost.");
    expect(exists(UDID)).toBe(false);
    const row = outcomeRow();
    expect(row).toContain("leftoverCleanup=removed");
    // 3 blobs + Info.plist + Status.plist, measured before removal.
    expect(row).toMatch(/leftoverBackupBytesCleared=(\d+)/);
    expect(Number(/leftoverBackupBytesCleared=(\d+)/.exec(row)![1])).toBeGreaterThanOrEqual(3 * BLOB_BYTES);
  });

  it("CONTROL 2c — the watchdog kills a stalled first sync: the folder is gone", async () => {
    backupLeaves(
      "B",
      failure({ error: "Backup process became unresponsive and was terminated", errorCode: "BACKUP_TIMEOUT" }),
    );

    await newOrchestrator().sync({ udid: UDID });

    expect(exists(UDID)).toBe(false);
  });

  it("CONTROL 2a — the user cancels a first sync: the folder is gone", async () => {
    const orchestrator = newOrchestrator();
    let finish!: () => void;
    startBackupSpy.mockImplementation(
      () =>
        new Promise<BackupResult>((resolve) => {
          writeState(UDID, "B");
          // The real `startBackup` resolves on the process `close` event, after cancel.
          finish = () => resolve(failure({ error: "Backup cancelled", errorCode: undefined }));
        }),
    );

    const running = orchestrator.sync({ udid: UDID });
    await waitFor(() => startBackupSpy.mock.calls.length === 1 && finish !== undefined);
    orchestrator.cancel();
    expect(cancelBackupSpy).toHaveBeenCalled();
    finish();
    const result = await running;

    expect(result.error).toBe("Sync cancelled by user");
    expect(exists(UDID)).toBe(false);
  });

  it("a first sync that failed but left a complete index is KEPT (D1)", async () => {
    // A run can report failure after the device wrote Manifest.db. That folder is a
    // usable backup — the next sync is incremental against it — so it stays.
    backupLeaves("B-with-manifest");

    await newOrchestrator().sync({ udid: UDID });

    expect(exists(UDID)).toBe(true);
    expect(fsSync.existsSync(path.join(folderFor(UDID), "Manifest.db"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Control 3 — the most likely wrong implementation: deleting on ANY failure
// ---------------------------------------------------------------------------

describe("BACKLOG-3598: a failed incremental keeps the usable backup it started from", () => {
  it("CONTROL 3 — start STATE A, the incremental fails, STATE C is on disk afterwards: kept and still usable", async () => {
    writeState(UDID, "A");
    backupLeaves("C", failure({ isIncremental: true }));

    await newOrchestrator().sync({ udid: UDID });

    expect(exists(UDID)).toBe(true);
    const status = await new BackupService().checkBackupStatus(UDID);
    // `isUsablePriorBackup` is `state === "present" && isComplete`.
    expect(status.state).toBe("present");
    expect(status.state === "present" && status.isComplete).toBe(true);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(outcomeRow()).not.toContain("leftoverCleanup");
  });
});

// ---------------------------------------------------------------------------
// Control 4 — retroactive cleanup at sync start
// ---------------------------------------------------------------------------

describe("BACKLOG-3598: leftovers from earlier syncs are removed when a sync starts", () => {
  it("CONTROL 4 — a leftover (this phone's and another's) is removed before the backup starts; a usable backup is not", async () => {
    writeState(UDID, "B");
    // A second phone's folders are laid down by hand: a leftover and, separately, a
    // usable backup under a third name.
    const otherDir = folderFor(OTHER_UDID);
    fsSync.mkdirSync(otherDir, { recursive: true });
    fsSync.writeFileSync(path.join(otherDir, "Status.plist"), TORN_BYTES);
    fsSync.writeFileSync(path.join(otherDir, "Info.plist"), "<plist></plist>");
    const usableUdid = "00008110-0001020304050607";
    const usableDir = folderFor(usableUdid);
    fsSync.mkdirSync(usableDir, { recursive: true });
    fsSync.writeFileSync(path.join(usableDir, "Manifest.db"), SQLITE_MAGIC);
    fsSync.writeFileSync(path.join(usableDir, "Info.plist"), "<plist></plist>");

    const seenAtStart: boolean[] = [];
    startBackupSpy.mockImplementation(async () => {
      seenAtStart.push(exists(UDID), exists(OTHER_UDID));
      return failure();
    });

    await newOrchestrator().sync({ udid: UDID });

    expect(seenAtStart).toEqual([false, false]);
    expect(exists(usableUdid)).toBe(true);
    expect(outcomeRow()).toContain("leftoverCleanup=removed");
  });

  it("a leftover that is the reason for a 'not enough space' refusal is cleared BEFORE the disk check", async () => {
    writeState(UDID, "B");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const diag = require("../diagnostics/diskSpaceDiagnostics");
    let leftoverPresentAtDiskCheck: boolean | null = null;
    diag.checkDiskSpaceForOperation.mockImplementationOnce(async () => {
      leftoverPresentAtDiskCheck = exists(UDID);
      return { sufficient: true, availableMB: 500000, requiredMB: 1000 };
    });
    startBackupSpy.mockImplementation(async () => failure());

    await newOrchestrator().sync({ udid: UDID });

    expect(sweepSpy).toHaveBeenCalledTimes(1);
    expect(leftoverPresentAtDiskCheck).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Control 6 — a delete that fails (a locked file on Windows) never breaks the sync
// ---------------------------------------------------------------------------

describe("BACKLOG-3598: a failed delete is recorded, never thrown", () => {
  it("CONTROL 6 — rm rejects EBUSY: the sync returns its own error, no throw, row says failed:EBUSY", async () => {
    backupLeaves("B");
    const busy = Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    const rmSpy = jest.spyOn(fsSync.promises, "rm").mockRejectedValue(busy);

    const result = await newOrchestrator().sync({ udid: UDID });

    expect(rmSpy).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe("The connection to your iPhone was lost.");
    expect(exists(UDID)).toBe(true);
    expect(outcomeRow()).toContain("leftoverCleanup=failed:EBUSY");
  });
});

// ---------------------------------------------------------------------------
// Control 7 — a start reading that established nothing authorises nothing
// ---------------------------------------------------------------------------

describe("BACKLOG-3598: an unknown start reading never leads to a delete", () => {
  it("CONTROL 7 — the folder could not be read at start (EACCES), the run fails leaving no manifest: kept", async () => {
    // Emittable: on Windows a scanner or a still-closing process can hold the folder
    // when the sync starts, and release it by the time the run ends.
    writeState(UDID, "B");
    const realStat = fsSync.promises.stat;
    let denyOnce = true;
    jest.spyOn(fsSync.promises, "stat").mockImplementation((async (p: fsSync.PathLike, opts?: unknown) => {
      if (denyOnce && String(p) === folderFor(UDID)) {
        denyOnce = false;
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return (realStat as (p: fsSync.PathLike, o?: unknown) => Promise<fsSync.Stats>)(p, opts);
    }) as typeof fsSync.promises.stat);
    // The sweep runs first; keep it off this folder so the start reading is the thing tested.
    sweepSpy.mockResolvedValue({ removed: 0, bytesFreed: 0, failures: [] });
    backupLeaves("B");

    await newOrchestrator().sync({ udid: UDID });

    expect(denyOnce).toBe(false); // the denial was actually served to the start check
    expect(exists(UDID)).toBe(true);
    expect(removeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SR R1 — no sweep while an earlier frame's backup process may still be alive
// ---------------------------------------------------------------------------

describe("BACKLOG-3598 (R1): Try Again while a first sync is still running", () => {
  it("THE CONTROL — the new sync is refused fast: no sweep, no second backup, the earlier run's folder survives", async () => {
    const orchestrator = newOrchestrator();
    let finishA!: (r: BackupResult) => void;
    startBackupSpy.mockImplementation(
      () =>
        new Promise<BackupResult>((resolve) => {
          // A healthy first sync, mid-transfer: no manifest yet.
          writeState(UDID, "B");
          finishA = resolve;
        }),
    );

    const frameA = orchestrator.sync({ udid: UDID });
    await waitFor(() => startBackupSpy.mock.calls.length === 1 && finishA !== undefined);
    const sweepsBeforeB = sweepSpy.mock.calls.length;
    const endSyncSpy = jest.spyOn(syncTimeline, "endSync");

    // syncHandlers' "Sync appears stuck" path: forceReset, then sync().
    orchestrator.forceReset("restart-while-running");
    const resultB = await orchestrator.sync({ udid: UDID });

    expect(resultB.success).toBe(false);
    expect(resultB.error).toBe("Sync already in progress");
    expect(sweepSpy.mock.calls.length).toBe(sweepsBeforeB);
    expect(startBackupSpy).toHaveBeenCalledTimes(1);
    // B never opened a timeline, so it must not close A's.
    expect(endSyncSpy).not.toHaveBeenCalled();
    expect(exists(UDID)).toBe(true);

    // Once A's process exits (here: fails), A removes its own unfinished folder and a
    // new sync is allowed again.
    finishA(failure());
    await frameA;
    expect(exists(UDID)).toBe(false);

    startBackupSpy.mockImplementation(async () => failure());
    const sweepsBeforeC = sweepSpy.mock.calls.length;
    await orchestrator.sync({ udid: UDID });
    expect(sweepSpy.mock.calls.length).toBe(sweepsBeforeC + 1);
  });
});

/** Poll the microtask/macrotask queue until `cond` holds (max ~2 s). */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor: condition never held");
}
