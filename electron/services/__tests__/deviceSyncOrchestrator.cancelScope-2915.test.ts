/**
 * BACKLOG-2915 — THE TWO CANCEL DEFENCES, PINNED INDEPENDENTLY.
 *
 * The founder found on 2026-08-31, in about forty minutes of real use and after three
 * review rounds and 38 mutations, that only ONE of them was live.
 *
 * His third run started `00:27:56.486` and exited 16 ms later with the phone unplugged.
 * `BackupService` classified it `CONNECTION_LOST` — a cancelled sync reported as a cable
 * fault — because the `cancelRequested` latch had been reset when that run spawned. His
 * cancels had landed at `00:27:08.701` and `00:27:22.737`, against the PREVIOUS run. The
 * measurement that names the defect is in the same log: sync elapsed **37,299 ms**
 * against backup elapsed **26 ms**. A sync outlives its runs, so a latch scoped to a run
 * cannot answer a question about the sync.
 *
 * Nothing reached the user, because `deviceSyncOrchestrator`'s abort checkpoint returned
 * "Sync cancelled by user" before the failure could be reported. That defence held and
 * is pinned here — SEPARATELY from the BackupService one, so neither can mask the other.
 * A single test that only asserts "the user saw nothing wrong" is exactly what let this
 * ship: it was green with one of the two defences dead.
 *
 * Why 38 mutations missed it: every cancel control drove cancel DURING an active run.
 * No fixture started a second run inside one sync, so the fixture space could not
 * express the shape. Same lesson as the SR's C1 finding, from a different angle — a
 * control can only fail on inputs it can express.
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

import { DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";

/** The orchestrator's own BackupService mock, so the two layers are tested apart. */
function orchestratorWithFailingBackup(error: string, errorCode: string) {
  mockCheckBackupStatus.mockResolvedValue({
    state: "absent" as const,
  });
  mockStartBackup.mockResolvedValue({
    success: false,
    backupPath: null,
    error,
    errorCode,
    duration: 26,
    deviceUdid: UDID,
    isIncremental: false,
    deviceReportedBackupMode: null,
    backupSize: null,
  });
  return new DeviceSyncOrchestrator();
}

describe("BACKLOG-2915 — defence 2 of 2: the orchestrator's abort checkpoint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("ROW 29 — a cancelled sync reports CANCELLED even when the backup layer says otherwise", async () => {
    // THE SHAPE THAT SHIPPED. `BackupService` hands up `CONNECTION_LOST` — exactly what
    // it did on the founder's third run — and this layer must still report a cancel,
    // because the abort checkpoint (deviceSyncOrchestrator.ts, immediately after the
    // backup) runs BEFORE the `!backupResult.success` discard.
    //
    // Mutation that turns this red: move the abort checkpoint below the failure return,
    // or delete it. The user then sees the cable message for a sync they cancelled.
    const orchestrator = orchestratorWithFailingBackup(
      "We couldn't get the backup going, and your iPhone didn't tell us why.",
      "CONNECTION_LOST",
    );

    mockStartBackup.mockImplementation(async () => {
      // The user hits Cancel while the backup is in flight, as he did.
      orchestrator.cancel();
      return {
        success: false,
        backupPath: null,
        error: "We couldn't get the backup going, and your iPhone didn't tell us why.",
        errorCode: "CONNECTION_LOST",
        duration: 26,
        deviceUdid: UDID,
        isIncremental: false,
        deviceReportedBackupMode: null,
        backupSize: null,
      };
    });

    const result = await orchestrator.sync({ udid: UDID });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancelled/i);
    // And specifically NOT the connection sentence the backup layer produced.
    expect(result.error).not.toMatch(/couldn't get the backup going/i);
  });

  it("ROW 29b — THE COUNTER-CONTROL: an uncancelled failure still reports the backup layer's reason", async () => {
    // Without this, ROW 29 would also pass if the checkpoint swallowed EVERY failure.
    const orchestrator = orchestratorWithFailingBackup(
      "We couldn't get the backup going, and your iPhone didn't tell us why.",
      "CONNECTION_LOST",
    );

    const result = await orchestrator.sync({ udid: UDID });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/couldn't get the backup going/i);
    expect(result.error).not.toMatch(/cancelled/i);
  });

  it("ROW 29c — the orchestrator opens a sync scope on the backup service, every sync", async () => {
    // The wiring for defence 1. It is asserted here rather than trusted, because a
    // missed call would make every later backup report "Backup was cancelled" — loud,
    // but only if something looks.
    const orchestrator = orchestratorWithFailingBackup("boom", "UNKNOWN_ERROR");
    const svc = (orchestrator as unknown as {
      backupService: { beginSyncScope: jest.Mock };
    }).backupService;

    await orchestrator.sync({ udid: UDID });
    expect(svc.beginSyncScope).toHaveBeenCalledTimes(1);

    await orchestrator.sync({ udid: UDID });
    expect(svc.beginSyncScope).toHaveBeenCalledTimes(2);
  });
});
