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

const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockLogError = jest.fn();
const mockLogDebug = jest.fn();

jest.mock("electron-log", () => ({
  info: (...a: unknown[]) => mockLogInfo(...a),
  error: (...a: unknown[]) => mockLogError(...a),
  warn: (...a: unknown[]) => mockLogWarn(...a),
  debug: (...a: unknown[]) => mockLogDebug(...a),
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

import {
  DeviceSyncOrchestrator,
  SYNC_DISK_POLL_INTERVAL_MS,
  SYNC_DISK_LOG_DELTA_BYTES,
} from "../deviceSyncOrchestrator";

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
  let checksBeforeBackup = 0;
  let checks = 0;

  mockCheckDiskSpace.mockImplementation(async () => {
    checks += 1;
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
      checksBeforeBackup = checks;
    },
    /** Disk measurements taken while the backup was running — i.e. monitor polls. */
    pollCount: () => checks - checksBeforeBackup,
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
    mockLogInfo.mockClear();
    mockLogWarn.mockClear();
    mockLogError.mockClear();
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

  describe("log volume — BACKLOG-2898 must stay bought", () => {
    /** Lines the mid-transfer monitor writes, at any level. */
    const monitorLines = () =>
      [
        ...mockLogInfo.mock.calls,
        ...mockLogWarn.mock.calls,
        ...mockLogError.mock.calls,
      ]
        .map((c) => String(c[0]))
        .filter((l) => /Backup disk space:|fell below reserve/.test(l));

    it("writes ONE reading across a full backup when free space does not move", async () => {
      // The founder's own log, on the merged tree: 293 identical
      // "Disk space: 64 GB free on /" lines across one 24.4-minute sync.
      const disk = installDisk({ initialFree: 64 * GB, drainBytesPerSec: 0 });
      installBackup({
        markBackupStarted: disk.markBackupStarted,
        succeedAfterMs: 1_464_030,
      });

      await runSync(orchestrator, 1_600_000);

      // The disk was still measured ~293 times — see the interval control below.
      expect(disk.pollCount()).toBeGreaterThan(250);
      expect(monitorLines()).toHaveLength(1);
    });

    it("writes a line when free space moves materially, and only then", async () => {
      // Drops by just under the material delta, then well past it.
      let free = 64 * GB;
      mockCheckDiskSpace.mockImplementation(async () => ({
        diskPath: "C:",
        free,
        size: TOTAL_DISK_BYTES,
      }));
      installBackup({ markBackupStarted: () => {}, succeedAfterMs: 300_000 });

      const promise = orchestrator.sync({ udid: TEST_UDID }).then((r) => r);

      await jest.advanceTimersByTimeAsync(60_000);
      const afterFirstWindow = monitorLines().length;

      free = 64 * GB - (SYNC_DISK_LOG_DELTA_BYTES - 1);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(monitorLines()).toHaveLength(afterFirstWindow); // not material

      free = 64 * GB - SYNC_DISK_LOG_DELTA_BYTES;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(monitorLines()).toHaveLength(afterFirstWindow + 1); // material

      await jest.advanceTimersByTimeAsync(300_000);
      await promise;
    });

    it("keeps the refusal loud: the crossing is written at info or louder", async () => {
      const disk = installDisk({
        initialFree: 10 * GB,
        drainBytesPerSec: MEASURED_BYTES_PER_SEC,
      });
      installBackup({
        markBackupStarted: disk.markBackupStarted,
        succeedAfterMs: 1_464_030,
      });

      await runSync(orchestrator, 1_600_000);

      // Not swallowed into debug: the crossing itself is at error, and the
      // approach to it is at warn.
      const crossing = mockLogError.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => /fell below reserve/.test(l));
      expect(crossing).toHaveLength(1);

      const approach = mockLogWarn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => /Backup disk space:.*approaching the/.test(l));
      expect(approach.length).toBeGreaterThan(0);

      // And it stays a handful of lines, not one per poll.
      expect(disk.pollCount()).toBeGreaterThan(40);
      expect(monitorLines().length).toBeLessThan(30);
    });

    it("still MEASURES every 5 s — quieting the log must not slow the poll", async () => {
      // The control that matters: a test counting only log lines would pass if
      // someone slowed the timer instead, and a slower poll widens the window in
      // which the disk can fill undetected. SYNC_DISK_RESERVE_BYTES sizes its
      // 256 MB drift term against ONE poll at the measured ~40 MB/s.
      expect(SYNC_DISK_POLL_INTERVAL_MS).toBe(5000);

      const disk = installDisk({ initialFree: 64 * GB, drainBytesPerSec: 0 });
      installBackup({
        markBackupStarted: disk.markBackupStarted,
        succeedAfterMs: 600_000, // 10 minutes
      });

      await runSync(orchestrator, 700_000);

      // 600 s / 5 s = 120 measurements, whatever the log shows.
      expect(disk.pollCount()).toBeGreaterThanOrEqual(115);
      expect(disk.pollCount()).toBeLessThanOrEqual(125);
      expect(monitorLines()).toHaveLength(1);
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
