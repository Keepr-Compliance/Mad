/**
 * BACKLOG-3440 — THE ORCHESTRATOR STOPS THROWING THE CAUSE AWAY.
 *
 * `syncRunEvidence-3440.test.ts` pins the transport: what the timeline writes and when.
 * This file pins the WIRING — that the orchestrator puts the right values on the row
 * during a real run, through the real code path.
 *
 * The thing being fixed here is NOT that the cause was unobservable. Since BACKLOG-2913
 * the backup path has parsed the device's own account of a failure: `MBErrorDomain/208`
 * becomes `errorCode: "DEVICE_LOCKED"`, with the numeric code kept beside it on
 * `BackupResult.failureCause`. Both were sitting on the result and neither reached the
 * row — only `backupResult.error`, the sentence written for the user, was forwarded. So
 * "her phone was locked" was established at the moment it happened and then discarded,
 * and the founder had to go and ask the user.
 *
 * FIXTURES ARE TRANSCRIBED, NOT INVENTED. The 208 values below come from the docblock at
 * `backupService.ts:228-243`, which is itself a transcription of the founder's dev log of
 * 2026-08-27 22:44:38. The mock shape mirrors what `classifyDeviceFailure` actually
 * returns at `backupService.ts:455-470`.
 */

import { EventEmitter } from "events";

const UDID = "00008030-0011223344556677";
const GB = 1024 * 1024 * 1024;

const mockStartBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();
const mockCancelBackup = jest.fn();
const mockStopForQuit = jest.fn();

// BACKLOG-3816 S4-C: the kept backup's at-rest layer is not this suite's subject.
jest.mock("../atRest/backupAtRest", () => ({
  ...jest.requireActual("../atRest/backupAtRest"),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getBackupAtRest: () => require("./helpers/passThroughBackupAtRest").passThroughBackupAtRest,
}));
jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn().mockReturnValue("/tmp") },
}));

const logLines: string[] = [];

jest.mock("electron-log", () => ({
  info: (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  },
  warn: (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  },
  error: (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
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
  jest.fn().mockResolvedValue({ diskPath: "C:", free: 500 * GB, size: 1000 * GB }),
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

/** Captured so a test can drive the real `progress` / `backup-mode` events. */
let backupServiceInstance: EventEmitter | null = null;

jest.mock("../backupService", () => ({
  BackupService: jest.fn().mockImplementation(() => {
    const svc = new EventEmitter();
    backupServiceInstance = svc;
    return Object.assign(svc, {
      checkBackupStatus: mockCheckBackupStatus,
      startBackup: mockStartBackup,
      cancelBackup: mockCancelBackup,
      stopForQuit: mockStopForQuit,
      // BACKLOG-3598: leftover cleanup. Inert here; the cleanup itself is proven in
      // deviceSyncOrchestrator.failedSyncCleanup-3598.test.ts against a real folder.
      sweepLeftoverBackups: jest.fn().mockResolvedValue({ removed: 0, bytesFreed: 0, failures: [] }),
      classifyBackupFolder: jest.fn().mockResolvedValue("absent"),
      removeLeftoverBackup: jest.fn().mockResolvedValue({ outcome: "kept", folder: "absent" }),
    });
  }),
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
  const svc = new EventEmitter();
  Object.assign(svc, {
    start: jest.fn(),
    stop: jest.fn(),
    getConnectedDevices: jest.fn().mockReturnValue([
      {
        udid: UDID,
        // A NAME is present deliberately, so the PII control has something to leak.
        // A placeholder: the founder's real device name is a personal nickname.
        name: "Daniel's iPhone",
        productType: "iPhone18,2",
        productVersion: "26.6.1",
        serialNumber: "F2LX00000000",
        isConnected: true,
      },
    ]),
    getDeviceStorageInfo: jest.fn().mockResolvedValue({
      totalCapacity: 256 * GB,
      usedSpace: 128 * GB,
      availableSpace: 128 * GB,
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

import { DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";
import { syncTimeline } from "../syncTimeline";
import type { BackupResult } from "../../types/backup";

/** The founder's 2026-08-27 locked-phone failure, transcribed. */
const DEVICE_LOCKED_208: Partial<BackupResult> = {
  error:
    "Your iPhone is locked. Unlock it, keep it unlocked, and start the sync again.",
  errorCode: "DEVICE_LOCKED",
  failureCause: {
    deviceErrorCode: 208,
    deviceErrorDescription: "Device locked (MBErrorDomain/208)",
    // NOT transcribed — the log does not record idevicebackup2's exit status for this
    // run, and nothing below asserts on it.
    exitCode: 1,
    source: "stdout-line",
  },
};

/** The 30-minute no-progress watchdog killing an unresponsive process. */
const WATCHDOG_TIMEOUT: Partial<BackupResult> = {
  error: "Backup process became unresponsive and was terminated",
  errorCode: "BACKUP_TIMEOUT",
};

const PRIOR_BACKUP_PRESENT = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  size: { measured: true as const, bytes: Math.round(57.9 * GB) },
  lastModified: new Date("2026-09-14T12:24:42Z"),
};

/** Run a sync whose backup fails in the given way, and return the outcome row line. */
async function outcomeRowForFailure(backup: Partial<BackupResult>): Promise<string> {
  logLines.length = 0;
  mockCheckBackupStatus.mockReset().mockResolvedValue(PRIOR_BACKUP_PRESENT);
  mockStartBackup.mockReset().mockResolvedValue({
    success: false,
    backupPath: null,
    duration: 1000,
    deviceUdid: UDID,
    backupSize: null,
    isIncremental: true,
    isEncrypted: false,
    deviceReportedBackupMode: null,
    ...backup,
  });

  const orchestrator = new DeviceSyncOrchestrator();
  orchestrator.on("error", () => {});
  await orchestrator.sync({ udid: UDID });

  const rows = logLines.filter((l) => l.includes("sync-outcome"));
  if (rows.length !== 1) throw new Error(`expected one outcome row, got ${rows.length}`);
  return rows[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  syncTimeline.reset();
  backupServiceInstance = null;
});

// ---------------------------------------------------------------------------
// CONTROL — the device's own answer reaches the row
// ---------------------------------------------------------------------------

describe("BACKLOG-3440: the cause the device reported reaches the row", () => {
  it("THE CONTROL — a locked phone records DEVICE_LOCKED and MBErrorDomain 208", async () => {
    // Delete the `setContext` block guarding the backup-failure return in
    // `deviceSyncOrchestrator` and this reds: the row keeps only the sentence, which is
    // exactly the state that made the founder ask the user instead of reading the data.
    const row = await outcomeRowForFailure(DEVICE_LOCKED_208);

    expect(row).toContain("reasonCode=DEVICE_LOCKED");
    expect(row).toContain("deviceErrorCode=208");
    expect(row).toContain("endedBy=device-error");
  });

  it("the watchdog killing a dead process is NOT the same as the device reporting a fault", async () => {
    // Collapse `endedBy` to one value for both and this reds. A process that went
    // unresponsive for 30 minutes and a device that said what was wrong need different
    // fixes, and they were the same row.
    const row = await outcomeRowForFailure(WATCHDOG_TIMEOUT);

    expect(row).toContain("reasonCode=BACKUP_TIMEOUT");
    expect(row).toContain("endedBy=watchdog");
    // The device said nothing, so the row says nothing rather than zero.
    expect(row).not.toContain("deviceErrorCode=");
  });

  it("a failure the device did not explain records no code at all, never a zero", async () => {
    const row = await outcomeRowForFailure({
      error: "Backup failed",
      errorCode: "UNKNOWN_ERROR",
    });

    expect(row).toContain("reasonCode=UNKNOWN_ERROR");
    expect(row).not.toContain("deviceErrorCode=");
  });

  it("no UDID, no device name and no serial reach the row, from a device carrying all three", async () => {
    const row = await outcomeRowForFailure(DEVICE_LOCKED_208);

    expect(row).not.toContain(UDID);
    expect(row).not.toContain("Daniel's iPhone");
    expect(row).not.toContain("F2LX00000000");
    // ...and the legitimate device facts still travel, so this could have failed.
    expect(row).toContain("deviceModel=iPhone18,2");
    expect(row).toContain("deviceIosVersion=26.6.1");
  });
});

// ---------------------------------------------------------------------------
// CONTROL — which act ended the run, named at the act
// ---------------------------------------------------------------------------

describe("BACKLOG-3440: Cancel, Reset and Try-Again are three different acts", () => {
  it("THE CONTROL — Cancel records `user-cancel`", () => {
    const orchestrator = new DeviceSyncOrchestrator();
    syncTimeline.beginSync();

    orchestrator.cancel();

    expect(syncTimeline.contextSnapshot().endedBy).toBe("user-cancel");
  });

  it("THE CONTROL — the restart-while-running guard records `restart-while-running`", () => {
    // This is the one nobody expects. `forceReset` is what fires when a user clicks Sync
    // or Try Again while a run is still going, and it sets the same abort signal Cancel
    // does — so both produced `outcome = cancelled` and were indistinguishable.
    const orchestrator = new DeviceSyncOrchestrator();
    syncTimeline.beginSync();

    orchestrator.forceReset("restart-while-running");

    expect(syncTimeline.contextSnapshot().endedBy).toBe("restart-while-running");
  });

  it("the two do not collapse into one value", () => {
    const orchestrator = new DeviceSyncOrchestrator();

    syncTimeline.beginSync();
    orchestrator.cancel();
    const cancelled = syncTimeline.contextSnapshot().endedBy;

    syncTimeline.beginSync();
    orchestrator.forceReset("restart-while-running");
    const restarted = syncTimeline.contextSnapshot().endedBy;

    expect(cancelled).not.toBe(restarted);
  });
});

// ---------------------------------------------------------------------------
// CONTROL — the byte counter is fed from the only place that sees it
// ---------------------------------------------------------------------------

describe("BACKLOG-3440: the orchestrator forwards the transferred byte count", () => {
  it("THE CONTROL — a progress event advances the timeline's byte mark", async () => {
    // Delete the `syncTimeline.recordBytesTransferred(...)` call from the progress
    // listener and this reds. That listener is the ONLY consumer of the backup's byte
    // stream, so it is the only place the figure can be observed at all.
    const orchestrator = new DeviceSyncOrchestrator();
    orchestrator.on("progress", () => {});
    syncTimeline.beginSync();
    expect(backupServiceInstance).not.toBeNull();

    backupServiceInstance!.emit("progress", {
      phase: "transferring",
      percentComplete: 12,
      currentFile: null,
      filesTransferred: 100,
      totalFiles: null,
      bytesTransferred: 2_100_000_000,
      totalBytes: null,
      estimatedTimeRemaining: null,
    });

    syncTimeline.endSync("error");
    const row = logLines.filter((l) => l.includes("sync-outcome")).pop() ?? "";
    expect(row).toContain("bytesTransferred=2100000000");
  });

  it("BACKLOG-3784 — the end-of-backup total does not overwrite the bytes moved", async () => {
    // backupService re-emits the TOTAL backup size as `bytesTransferred` on its
    // `finishing` and `decrypting` events (backupService.ts, both BACKLOG-2917 sites:
    // `bytesTransferred: backupSize ?? 0`). On an incremental run that total is the
    // whole 71 GB backup; the row must keep the bytes the transfer actually moved.
    const orchestrator = new DeviceSyncOrchestrator();
    orchestrator.on("progress", () => {});
    syncTimeline.beginSync();
    expect(backupServiceInstance).not.toBeNull();

    const base = {
      currentFile: null,
      filesTransferred: 3,
      totalFiles: null,
      estimatedTimeRemaining: null,
    };
    backupServiceInstance!.emit("progress", {
      ...base,
      phase: "transferring",
      percentComplete: 50,
      bytesTransferred: 4_000_000,
      totalBytes: null,
    });
    backupServiceInstance!.emit("progress", {
      ...base,
      phase: "decrypting",
      percentComplete: 95,
      bytesTransferred: 71_568_139_822,
      totalBytes: 71_568_139_822,
    });
    backupServiceInstance!.emit("progress", {
      ...base,
      phase: "finishing",
      percentComplete: 100,
      bytesTransferred: 71_568_139_822,
      totalBytes: 71_568_139_822,
    });

    syncTimeline.endSync("complete");
    const row = logLines.filter((l) => l.includes("sync-outcome")).pop() ?? "";
    expect(row).toContain("bytesTransferred=4000000");
    expect(row).not.toContain("bytesTransferred=71568139822");
  });

  it("THE CONTROL — the device's backup mode is recorded the moment it is announced", async () => {
    // Not at the end. Every `cancelled` run in the corpus before this change had
    // `incremental` NULL, because it was written after the sync resolved and those runs
    // never resolved. Remove the `backup-mode` listener and this reds.
    const orchestrator = new DeviceSyncOrchestrator();
    orchestrator.on("progress", () => {});
    syncTimeline.beginSync();

    backupServiceInstance!.emit("backup-mode", "full");

    expect(syncTimeline.contextSnapshot()).toMatchObject({
      incremental: false,
      backupModeSource: "device-reported",
    });
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3598 — an app quit that kills the backup is not a device fault
// ---------------------------------------------------------------------------

describe("BACKLOG-3598: quitting during a backup is recorded as app-quit, not device-error", () => {
  it("stopBackupForQuit during a pending backup, then the killed backup fails -> endedBy=app-quit", async () => {
    // Drop the `stoppedForQuit` branch in the orchestrator's backup-failure path and this
    // reds: the killed backup's failure falls through to endedBy=device-error.
    logLines.length = 0;
    mockCheckBackupStatus.mockReset().mockResolvedValue(PRIOR_BACKUP_PRESENT);
    mockStopForQuit.mockReset().mockReturnValue(Promise.resolve("exited"));
    let resolveBackup!: (r: unknown) => void;
    mockStartBackup.mockReset().mockReturnValue(new Promise((r) => (resolveBackup = r)));

    const orchestrator = new DeviceSyncOrchestrator();
    orchestrator.on("error", () => {});
    const syncing = orchestrator.sync({ udid: UDID });
    for (let i = 0; i < 200 && mockStartBackup.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(mockStartBackup).toHaveBeenCalled();

    expect(orchestrator.stopBackupForQuit()).not.toBeNull();
    // What onProcessClose resolves after the child is killed.
    resolveBackup({
      success: false,
      backupPath: null,
      duration: 1000,
      deviceUdid: UDID,
      backupSize: null,
      isIncremental: true,
      isEncrypted: false,
      deviceReportedBackupMode: null,
      error: "Backup process exited with code null",
      errorCode: "UNKNOWN_ERROR",
    });
    await syncing;

    const rows = logLines.filter((l) => l.includes("sync-outcome"));
    const last = rows[rows.length - 1];
    expect(last).toContain("endedBy=app-quit");
    expect(last).not.toContain("endedBy=device-error");
    expect(last).not.toContain("reasonCode=");
  });
});
