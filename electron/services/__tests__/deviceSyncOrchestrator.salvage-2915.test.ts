/**
 * BACKLOG-2915 (round 4, absorbing BACKLOG-3035) — THE ORCHESTRATOR ACTUALLY CONSULTS
 * THE SALVAGE JUDGEMENT.
 *
 * `backupSalvageService-2915` pins the judgement itself, against real SQLite. This file
 * pins the WIRING: that a failed run's data is examined before it is discarded, that a
 * sound one carries on, and — the half that matters most — that an unsound one still
 * fails exactly as it did before.
 *
 * It exists because the equivalent wiring for the disconnect feed was pinned six ways at
 * the classification layer and NOT AT ALL at the call site, and the mutation that deleted
 * the call left every test green. A judgement nobody consults is worth nothing.
 *
 * The founder's measurement, for scale: 506,993 files claimed, 14 missing, 61.9 GB
 * discarded over 0.003%.
 */

import { EventEmitter } from "events";

const UDID = "00008030-0011223344556677";

const mockStartBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();

jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn().mockReturnValue("/tmp") },
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
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
  jest.fn().mockResolvedValue({
    diskPath: "C:",
    free: 500 * 1024 * 1024 * 1024,
    size: 1000 * 1024 * 1024 * 1024,
  }),
);

// Pass the real module through and override only the one call this test drives.
// deviceSyncOrchestrator reads other exports from here at MODULE level (PR #2409
// evaluates `DISK_SPACE_THRESHOLDS.sync` while computing SYNC_DISK_RESERVE_BYTES),
// and a mock that enumerates exports breaks the suite at import time the moment a
// new one is added. Verified against the merged tree.
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

jest.mock("../backupService", () => ({
  BackupService: jest.fn().mockImplementation(() => {
    const svc = new EventEmitter();
    return Object.assign(svc, {
      checkBackupStatus: mockCheckBackupStatus,
      startBackup: mockStartBackup,
      cancelBackup: jest.fn(),
      // BACKLOG-2915: the orchestrator opens a sync scope here; a mock without it
      // throws, which is the wiring being pinned rather than assumed.
      beginSyncScope: jest.fn(),
      attachDeviceDisconnectFeed: jest.fn(),
      noteDeviceDisconnected: jest.fn(),
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
    getConnectedDevices: jest.fn().mockReturnValue([]),
    getDeviceStorageInfo: jest.fn().mockResolvedValue({
      totalSpace: 256 * 1024 * 1024 * 1024,
      usedSpace: 128 * 1024 * 1024 * 1024,
      freeSpace: 128 * 1024 * 1024 * 1024,
      estimatedBackupSize: 50 * 1024 * 1024 * 1024,
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

const mockJudge = jest.fn();
const mockDescribe = jest.fn((..._args: unknown[]) => "SALVAGE NOTICE");
jest.mock("../backupSalvageService", () => ({
  judgeFailedBackup: (...args: unknown[]) => mockJudge(...args),
  describeSalvagedBackup: (...args: unknown[]) => mockDescribe(...args),
}));

import { DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";

const BACKUP_PATH = "/mock/userData/Backups/" + UDID;
const DEVICE_ERROR =
  "The backup stopped with error 205. Your iPhone reported: " +
  "Manifest references files not in backup (MBErrorDomain/205).";

/** A run that FAILED the way the founder's did: device error 205, data on disk. */
function failedRunWithDataOnDisk() {
  mockCheckBackupStatus.mockResolvedValue({ state: "absent" as const });
  mockStartBackup.mockResolvedValue({
    success: false,
    backupPath: BACKUP_PATH,
    error: DEVICE_ERROR,
    errorCode: "UNKNOWN_ERROR",
    duration: 1_140_000,
    deviceUdid: UDID,
    isIncremental: true,
    deviceReportedBackupMode: "incremental",
    backupSize: 61.9 * 1024 * 1024 * 1024,
  });
}

const SOUND = {
  salvageable: true as const,
  snapshotState: "finished",
  coverage: {
    manifestFiles: 506_993,
    blobsPresent: 506_979,
    missingCount: 14,
    missingFileIds: ["a".repeat(40)],
    missingRequired: [],
  },
};

describe("BACKLOG-2915 rows 45-48 — a near-complete backup is not thrown away", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDescribe.mockReturnValue("SALVAGE NOTICE");
  });

  it("ROW 45 — a failed run whose data is SOUND carries on, and says so", async () => {
    // Mutation that turns this red: delete the salvage branch, or move it below the
    // failure return. The founder's 61.9 GB goes in the bin again.
    failedRunWithDataOnDisk();
    mockJudge.mockResolvedValue(SOUND);

    const orchestrator = new DeviceSyncOrchestrator();
    const result = await orchestrator.sync({ udid: UDID });

    expect(mockJudge).toHaveBeenCalledWith(BACKUP_PATH);
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.notice).toBe("SALVAGE NOTICE");
  });

  it("ROW 46 — THE HALF THAT MATTERS MOST: an UNSOUND one still fails, unchanged", async () => {
    // The error check is not relaxed and must not be. Without this row, "salvage" could
    // be implemented as "ignore failures" and every test above would still pass.
    failedRunWithDataOnDisk();
    mockJudge.mockResolvedValue({
      salvageable: false,
      reason: "the backup is missing the messages database",
      snapshotState: "finished",
    });

    const orchestrator = new DeviceSyncOrchestrator();
    const result = await orchestrator.sync({ udid: UDID });

    expect(result.success).toBe(false);
    expect(result.error).toBe(DEVICE_ERROR);
    expect(result.notice).toBeUndefined();
  });

  it("ROW 47 — the judgement is given the PATH and nothing else", async () => {
    // The gate is evidence about the DATA. It is never told whether the run
    // "succeeded", so it cannot be turned into a softened failure test — which is the
    // one thing the scope note forbids.
    failedRunWithDataOnDisk();
    mockJudge.mockResolvedValue(SOUND);

    const orchestrator = new DeviceSyncOrchestrator();
    await orchestrator.sync({ udid: UDID });

    expect(mockJudge).toHaveBeenCalledTimes(1);
    expect(mockJudge.mock.calls[0]).toEqual([BACKUP_PATH]);
  });

  it("ROW 48 — a SUCCESSFUL run is never judged at all", async () => {
    // The salvage path is reachable only from a failure. A successful backup must not
    // pay for a half-million-row set comparison, and must not become rejectable by it.
    mockCheckBackupStatus.mockResolvedValue({ state: "absent" as const });
    mockStartBackup.mockResolvedValue({
      success: true,
      backupPath: BACKUP_PATH,
      error: null,
      duration: 1_000,
      deviceUdid: UDID,
      isIncremental: false,
      deviceReportedBackupMode: "full",
      backupSize: 100,
    });

    const orchestrator = new DeviceSyncOrchestrator();
    const result = await orchestrator.sync({ udid: UDID });

    expect(mockJudge).not.toHaveBeenCalled();
    expect(result.notice).toBeUndefined();
  });
});
