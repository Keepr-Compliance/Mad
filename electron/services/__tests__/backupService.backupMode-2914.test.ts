/**
 * BACKLOG-2914 (built as FIX 4 of BACKLOG-2911) — THE INCREMENTAL FLAG COMES FROM THE
 * DEVICE.
 *
 * On the founder's 09:07 run of 2026-08-28 the app logged `incremental=true` for a
 * transfer of 61.2 GB in 52 minutes. The on-disk state at the start was a 4.4 GB
 * partial with `SnapshotState: uploading` and NO `Manifest.db`, and `Status.plist`
 * reported `IsFullBackup: 1`. It was, in every sense that matters, a first sync.
 *
 * The flag came from `previousBackupExists && !forceFullBackup` — whether a DIRECTORY
 * existed. `idevicebackup2` had printed the answer on stderr and it was logged and
 * discarded.
 *
 * This is the single most damaging error possible for the duration model: first-sync
 * and incremental are the two distributions it exists to separate, and a 52-minute
 * full run filed as incremental teaches it that incremental syncs take an hour.
 *
 * The strings are libimobiledevice's own, from `tools/idevicebackup2.c`:
 *
 *     PRINT_VERBOSE(1, "Full backup mode.\n");
 *     PRINT_VERBOSE(1, "Incremental backup mode.\n");
 *
 * matched case-insensitively here, because the only thing this code pins about them is
 * the two words.
 */

import { EventEmitter } from "events";
import type { BackupResult } from "../../types/backup";

const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

/** Verbatim from idevicebackup2's own PRINT_VERBOSE calls. */
const FULL_MODE_LINE = "Full backup mode.\n";
const INCREMENTAL_MODE_LINE = "Incremental backup mode.\n";

const mockSpawn = jest.fn();

jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({
      all: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(null),
      run: jest.fn(),
    }),
    close: jest.fn(),
    exec: jest.fn(),
  })),
);

jest.mock("electron", () => ({
  app: { getPath: jest.fn().mockReturnValue("/mock/userData"), isPackaged: false },
}));

jest.mock("electron-log", () => ({
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("fs", () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    access: jest.fn().mockRejectedValue(new Error("Not found")),
    readdir: jest.fn().mockResolvedValue([]),
    stat: jest.fn().mockRejectedValue(Object.assign(new Error("no"), { code: "ENOENT" })),
    rm: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue("<plist></plist>"),
  },
}));

jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn((name: string) => `/mock/${name}`),
  isMockMode: jest.fn().mockReturnValue(false),
}));

jest.mock("../backupDecryptionService", () => ({
  backupDecryptionService: {
    isBackupEncrypted: jest.fn().mockResolvedValue(false),
    decryptBackup: jest.fn(),
    cleanup: jest.fn(),
  },
}));

import { BackupService } from "../backupService";

/** A child process whose stdout/stderr/close can be driven from the test. */
class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  kill = jest.fn();
}

/**
 * Drives one backup run. `previousBackupExists` is forced true throughout — that is the
 * whole point: the OLD derivation would answer "incremental" for every case below, so
 * any case that comes out "full" can only have come from the device.
 */
function runBackup(
  script: (proc: FakeProcess) => void,
  existingService?: BackupService,
): Promise<BackupResult> {
  // The service is reusable on purpose. `BackupService` is a long-lived singleton in
  // the app — `deviceSyncOrchestrator` constructs one per orchestrator, not one per
  // sync — so per-run state that is never reset leaks between the founder's syncs, not
  // between test cases. A test that builds a fresh service each time cannot see that.
  const service = existingService ?? new BackupService();

  mockSpawn.mockImplementation((cmd: string) => {
    const proc = new FakeProcess();
    if (cmd.includes("ideviceinfo")) {
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("false\n"));
        proc.emit("close", 0);
      });
    } else {
      setTimeout(() => script(proc), 0);
    }
    return proc;
  });

  return service.startBackup({ udid: TEST_UDID });
}

describe("BACKLOG-2914: idevicebackup2's own backup-mode line", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // A backup directory exists, so the OLD derivation says "incremental" for every
    // case in this file. That is what makes the `full` cases informative.
    const fsPromises = jest.requireMock("fs").promises as { stat: jest.Mock };
    fsPromises.stat.mockResolvedValue({ isDirectory: () => true, mtime: new Date() });
  });

  it("THE CONTROL — the device says FULL while a directory exists: the result says full", async () => {
    const result = await runBackup((proc) => {
      proc.stderr.emit("data", Buffer.from(FULL_MODE_LINE));
      proc.stdout.emit("data", Buffer.from("Backup Successful.\n"));
      proc.emit("close", 0);
    });

    expect(result.deviceReportedBackupMode).toBe("full");
    expect(result.isIncremental).toBe(false);
  });

  it("the device saying INCREMENTAL is recorded as reported", async () => {
    const result = await runBackup((proc) => {
      proc.stderr.emit("data", Buffer.from(INCREMENTAL_MODE_LINE));
      proc.stdout.emit("data", Buffer.from("Backup Successful.\n"));
      proc.emit("close", 0);
    });

    expect(result.deviceReportedBackupMode).toBe("incremental");
    expect(result.isIncremental).toBe(true);
  });

  it("when the device never says, the mode is null and the old derivation answers", async () => {
    // A run that dies before the mode line is printed still has to answer. It falls
    // back, and `deviceReportedBackupMode: null` is what tells telemetry the flag was
    // INFERRED rather than measured.
    const result = await runBackup((proc) => {
      proc.stdout.emit("data", Buffer.from("Backup Successful.\n"));
      proc.emit("close", 0);
    });

    expect(result.deviceReportedBackupMode).toBeNull();
  });

  it("THE CONTROL — the mode does not leak from one run into the next, on ONE service", async () => {
    // Reset lives in the same block as the watchdog state. Without it, run N+1 reports
    // run N's mode as a measured fact — a wrong answer wearing the clothes of a right
    // one, which is worse than no answer at all.
    //
    // The SAME service instance runs both, which is what makes this control real. An
    // earlier draft built a fresh `BackupService` per run and stayed green with the
    // reset deleted: instance construction was doing the resetting, and the app does
    // not construct one per sync.
    const service = new BackupService();

    const first = await runBackup((proc) => {
      proc.stderr.emit("data", Buffer.from(FULL_MODE_LINE));
      proc.emit("close", 0);
    }, service);
    expect(first.deviceReportedBackupMode).toBe("full");

    const second = await runBackup((proc) => {
      proc.emit("close", 0);
    }, service);
    expect(second.deviceReportedBackupMode).toBeNull();
  });
});
