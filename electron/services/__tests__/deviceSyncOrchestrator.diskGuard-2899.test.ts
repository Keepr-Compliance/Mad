/**
 * BACKLOG-2899 — the iPhone sync disk guard must stop trusting the size estimate
 *
 * MEASURED, from the founder's Windows run 2026-08-26:
 *
 *   [16:11:44] Backup completed successfully in 1464030ms, size: 58761372853 bytes
 *
 *   estimatedBackupSize .......  3.7 GB   (storageInfo, 0.25 x device used space)
 *   guard required ............  5.6 GB   (estimate x 1.5)
 *   actual backup on disk ..... 58.8 GB
 *   never checked for ......... 53.2 GB   (15.9x underestimate)
 *
 * The fixture below is that run: a 3.7 GB estimate against a machine with 10 GB
 * free, and a disk that then drains at the run's own measured transfer rate
 * (58,761,372,853 B / 1464.03 s = ~40 MB/s). The up-front check passes — that is
 * the defect — so the safety property has to come from re-checking DURING the
 * transfer.
 *
 * Why prevention and not detection: transcribed from libimobiledevice
 * tools/idevicebackup2.c mb2_handle_receive_files(), the host-side write is
 *
 *     fwrite(buf, 1, r, f);          // return value never checked
 *     ...
 *     if (f) { fclose(f); ... }      // fclose return never checked
 *
 * so a full disk is silently absorbed and the tool can still print
 * "Backup Successful." with exit code 0. A detector cannot be the last line of
 * defence against a failure the producer does not report.
 */

import { EventEmitter } from "events";
import type { BackupResult } from "../../types/backup";

// ---------------------------------------------------------------------------
// Measured constants — every number below traces to the run above
// ---------------------------------------------------------------------------

const GB = 1024 * 1024 * 1024;

/** The run's own transfer rate: 58,761,372,853 bytes over 1,464,030 ms. */
const MEASURED_BYTES_PER_SEC = Math.round(58_761_372_853 / (1_464_030 / 1000));

/** storageInfo.estimatedBackupSize on the measured run. */
const MEASURED_ESTIMATE_BYTES = Math.round(3.7 * GB);

/** What actually landed on disk on the measured run. */
const MEASURED_ACTUAL_BYTES = 58_761_372_853;

/**
 * The reserve the guard must defend, in bytes.
 *
 * DISK_SPACE_THRESHOLDS.sync (2048 MB — what the rest of the sync pipeline
 * already declares it needs) + one poll interval of drift at the measured rate
 * (5 s x ~40 MB/s = ~200 MB, rounded up to 256 MB).
 */
const RESERVE_BYTES = (2048 + 256) * 1024 * 1024;

const TOTAL_DISK_BYTES = 512 * GB;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCheckDiskSpace = jest.fn();
const mockStartBackup = jest.fn();
const mockCancelBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();
const mockDeleteBackup = jest.fn();
const mockDecryptionCleanup = jest.fn();
const mockGetDeviceStorageInfo = jest.fn();

jest.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn().mockReturnValue("/tmp"),
  },
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({
      all: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(null),
      run: jest.fn(),
    }),
    close: jest.fn(),
  })),
);

jest.mock("check-disk-space", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockCheckDiskSpace(...args),
}));

jest.mock("../backupService", () => ({
  BackupService: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    emit: jest.fn(),
    removeAllListeners: jest.fn(),
    checkBackupStatus: (...args: unknown[]) => mockCheckBackupStatus(...args),
    startBackup: (...args: unknown[]) => mockStartBackup(...args),
    cancelBackup: (...args: unknown[]) => mockCancelBackup(...args),
    deleteBackup: (...args: unknown[]) => mockDeleteBackup(...args),
  })),
}));

jest.mock("../backupDecryptionService", () => ({
  BackupDecryptionService: jest.fn().mockImplementation(() => ({
    isBackupEncrypted: jest.fn().mockResolvedValue(false),
    decryptBackup: jest.fn(),
    cleanup: (...args: unknown[]) => mockDecryptionCleanup(...args),
  })),
}));

jest.mock("../deviceDetectionService", () => {
  const mockService = new EventEmitter();
  Object.assign(mockService, {
    start: jest.fn(),
    stop: jest.fn(),
    getConnectedDevices: jest.fn().mockReturnValue([]),
    getDeviceStorageInfo: (...args: unknown[]) => mockGetDeviceStorageInfo(...args),
  });
  return {
    DeviceDetectionService: jest.fn().mockImplementation(() => mockService),
    deviceDetectionService: mockService,
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

jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: jest.fn().mockResolvedValue({
    isInstalled: true,
    serviceRunning: true,
  }),
}));

jest.mock("../libimobiledeviceService", () => ({
  canUseLibimobiledevice: jest.fn().mockReturnValue(true),
  getCommand: jest.fn().mockReturnValue("/mock/idevicebackup2"),
  isMockMode: jest.fn().mockReturnValue(false),
}));

import { DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";

const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Free space as a function of fake time: constant until the backup starts, then
 * draining at `drainBytesPerSec`. Fake timers fake Date.now(), so advancing the
 * clock advances the drain — the number of polls the implementation chooses does
 * not change the fixture.
 */
function installDisk(opts: { initialFree: number; drainBytesPerSec: number }) {
  let backupStartedAt: number | null = null;

  mockCheckDiskSpace.mockImplementation(async () => {
    const elapsedSec =
      backupStartedAt === null ? 0 : (Date.now() - backupStartedAt) / 1000;
    const free = Math.max(
      0,
      opts.initialFree - Math.round(elapsedSec * opts.drainBytesPerSec),
    );
    return { diskPath: "C:", free, size: TOTAL_DISK_BYTES };
  });

  return {
    markBackupStarted: () => {
      backupStartedAt = Date.now();
    },
  };
}

/**
 * A backup that behaves the way the measured run behaved: it keeps running, and
 * — because idevicebackup2 never checks its own fwrite — it eventually reports
 * SUCCESS whether or not the disk filled underneath it. It resolves early only
 * if something cancels it.
 */
function installBackup(opts: {
  markBackupStarted: () => void;
  succeedAfterMs: number;
}) {
  let settle: ((r: BackupResult) => void) | null = null;
  let settled = false;

  const resolveOnce = (result: BackupResult) => {
    if (settled || !settle) return;
    settled = true;
    settle(result);
  };

  mockStartBackup.mockImplementation(() => {
    opts.markBackupStarted();
    return new Promise<BackupResult>((resolve) => {
      settle = resolve;
      setTimeout(() => {
        // "Backup Successful." on a disk that may be full — see the file header.
        resolveOnce({
          success: true,
          backupPath: "/tmp/Backups/" + TEST_UDID,
          error: null,
          duration: opts.succeedAfterMs,
          deviceUdid: TEST_UDID,
          isIncremental: false,
          backupSize: MEASURED_ACTUAL_BYTES,
          isEncrypted: false,
        });
      }, opts.succeedAfterMs);
    });
  });

  mockCancelBackup.mockImplementation(() => {
    resolveOnce({
      success: false,
      backupPath: null,
      error: "Backup was cancelled.",
      errorCode: "BACKUP_CANCELLED",
      duration: 0,
      deviceUdid: TEST_UDID,
      isIncremental: false,
      backupSize: 0,
      isEncrypted: false,
    });
  });
}

/**
 * Advance fake time in slices until the sync settles.
 *
 * `budgetMs` must exceed the fixture's `succeedAfterMs`, so the promise settles
 * on every path — with the guard (early abort) and without it (the backup
 * "succeeds"). A promise that never settles under fake timers hangs the runner
 * instead of failing the assertion.
 */
async function runSync(
  orchestrator: DeviceSyncOrchestrator,
  budgetMs: number,
  sliceMs = 30_000,
) {
  let done = false;

  const promise = orchestrator.sync({ udid: TEST_UDID }).then(
    (r) => {
      done = true;
      return r;
    },
    (err) => {
      done = true;
      throw err;
    },
  );

  for (let elapsed = 0; elapsed <= budgetMs && !done; elapsed += sliceMs) {
    await jest.advanceTimersByTimeAsync(sliceMs);
  }

  if (!done) {
    throw new Error(
      `sync() did not settle within ${budgetMs}ms of fake time — fixture budget too small`,
    );
  }

  return promise;
}

describe("BACKLOG-2899 — sync disk guard", () => {
  let orchestrator: DeviceSyncOrchestrator;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockCheckBackupStatus.mockResolvedValue(null); // first sync — the measured run
    mockGetDeviceStorageInfo.mockResolvedValue({
      totalCapacity: 128 * GB,
      availableSpace: 113 * GB,
      usedSpace: 14.8 * GB,
      estimatedBackupSize: MEASURED_ESTIMATE_BYTES,
    });

    orchestrator = new DeviceSyncOrchestrator();
    // syncHandlers.ts:407 registers this listener in production; without one an
    // EventEmitter turns every emitted "error" into a throw.
    orchestrator.on("error", () => {});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("the measured run", () => {
    it("stops the sync when the disk drains under the reserve mid-transfer", async () => {
      const disk = installDisk({
        initialFree: 10 * GB,
        drainBytesPerSec: MEASURED_BYTES_PER_SEC,
      });
      installBackup({
        markBackupStarted: disk.markBackupStarted,
        succeedAfterMs: 1_464_030, // the measured 24.4-minute run
      });

      const result = await runSync(orchestrator, 1_600_000);

      // The up-front check passes on this fixture. That is the defect: 10 GB
      // free clears `3.7 GB x 1.5 = 5.6 GB` for an operation that needs 58.8 GB.
      expect(mockStartBackup).toHaveBeenCalled();

      // ...so the guard has to act during the transfer.
      expect(mockCancelBackup).toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/disk space/i);
    });

    it("leaves the partial backup resumable rather than deleting it", async () => {
      const disk = installDisk({
        initialFree: 10 * GB,
        drainBytesPerSec: MEASURED_BYTES_PER_SEC,
      });
      installBackup({
        markBackupStarted: disk.markBackupStarted,
        succeedAfterMs: 1_464_030,
      });

      await runSync(orchestrator, 1_600_000);

      // `Backups/<udid>` must survive: checkBackupStatus reports it on the next
      // run (exists / isCorrupted), which is this codebase's resume signal
      // (deviceSyncOrchestrator "Previous backup was interrupted, will attempt
      // to resume").
      expect(mockDeleteBackup).not.toHaveBeenCalled();
      expect(mockDecryptionCleanup).not.toHaveBeenCalled();
    });

    it("surfaces an error the orchestrator's own disk-space matcher recognises", async () => {
      const disk = installDisk({
        initialFree: 10 * GB,
        drainBytesPerSec: MEASURED_BYTES_PER_SEC,
      });
      installBackup({
        markBackupStarted: disk.markBackupStarted,
        succeedAfterMs: 1_464_030,
      });

      const result = await runSync(orchestrator, 1_600_000);

      // The pattern already in deviceSyncOrchestrator for backup failures.
      expect(result.error).toMatch(
        /disk space|no space|ENOSPC|not enough space/i,
      );
    });
  });

  describe("boundary — up-front refusal", () => {
    it("refuses to start when free space is one byte under the reserve", async () => {
      installDisk({ initialFree: RESERVE_BYTES - 1, drainBytesPerSec: 0 });
      installBackup({ markBackupStarted: () => {}, succeedAfterMs: 1000 });

      const result = await runSync(orchestrator, 700_000);

      expect(mockStartBackup).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/space/i);
    });

    it("starts when free space is exactly at the reserve", async () => {
      installDisk({ initialFree: RESERVE_BYTES, drainBytesPerSec: 0 });
      installBackup({ markBackupStarted: () => {}, succeedAfterMs: 1000 });

      await runSync(orchestrator, 700_000);

      expect(mockStartBackup).toHaveBeenCalled();
    });
  });

  describe("boundary — mid-transfer", () => {
    it("does not abort while free space holds above the reserve", async () => {
      const disk = installDisk({
        initialFree: RESERVE_BYTES + 1,
        drainBytesPerSec: 0,
      });
      installBackup({
        markBackupStarted: disk.markBackupStarted,
        succeedAfterMs: 60_000,
      });

      const result = await runSync(orchestrator, 700_000);

      expect(mockCancelBackup).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it("aborts as soon as free space crosses one byte under the reserve", async () => {
      // Starts one byte above the reserve, loses one byte per second.
      const disk = installDisk({
        initialFree: RESERVE_BYTES + 1,
        drainBytesPerSec: 1,
      });
      installBackup({
        markBackupStarted: disk.markBackupStarted,
        succeedAfterMs: 600_000,
      });

      const result = await runSync(orchestrator, 700_000);

      expect(mockCancelBackup).toHaveBeenCalled();
      expect(result.success).toBe(false);
    });
  });

  describe("fail-open", () => {
    it("does not abort a running backup when the disk check itself fails", async () => {
      let started = false;
      mockCheckDiskSpace.mockImplementation(async () => {
        if (started) throw new Error("EBUSY: stat failed");
        return { diskPath: "C:", free: 200 * GB, size: TOTAL_DISK_BYTES };
      });
      installBackup({
        markBackupStarted: () => {
          started = true;
        },
        succeedAfterMs: 60_000,
      });

      const result = await runSync(orchestrator, 700_000);

      expect(mockCancelBackup).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });
});
