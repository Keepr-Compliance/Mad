/**
 * BACKLOG-2899 — does the disk-space detector match what idevicebackup2 actually
 * prints on a full host disk?
 *
 * BACKLOG-2870 is the precedent for assuming it does: the equivalent detector
 * there hunted for /disk space|no space|ENOSPC|not enough space/i and missed
 * SQLite's real message, "database or disk is full", which contains none of
 * those tokens.
 *
 * The strings below are TRANSCRIBED, in two steps:
 *
 *   1. The format string, out of the binary this repo ships
 *      (`strings resources/win/libimobiledevice/idevicebackup2.exe`):
 *
 *          Error opening '%s' for writing: %s
 *
 *      and its producer, libimobiledevice tools/idevicebackup2.c,
 *      mb2_handle_receive_files():
 *
 *          errdesc = strerror(errno);
 *          progress_printf("Error opening '%s' for writing: %s\n", bname, errdesc);
 *
 *   2. The `%s` tail is strerror(errno), supplied by the C runtime at run time,
 *      so it is NOT in the binary and this step is INFERRED: Windows maps
 *      ERROR_DISK_FULL to ENOSPC (_dosmaperr) and UCRT/glibc/BSD all render
 *      ENOSPC as "No space left on device".
 *
 * Two facts these tests pin down, both of which cost the app a real detection:
 *
 *   - progress_printf() is vprintf(), so the line lands on STDOUT. backupService
 *     only ever fed stderrBuffer to getErrorMessage().
 *   - `fwrite(buf, 1, r, f);` and `fclose(f)` have unchecked return values in
 *     that same function, so the usual full-disk outcome is silence and exit 0.
 */

import { EventEmitter } from "events";
import type { BackupResult } from "../../types/backup";

const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

/** Transcribed line 1 + inferred strerror tail. What a full disk looks like. */
const REAL_DISK_FULL_STDOUT =
  "Error opening 'C:\\Users\\dhaim\\AppData\\Roaming\\Keepr\\Backups\\" +
  TEST_UDID +
  "\\3d\\3d0d7e5fb2ce288813306e4d4636395e047a3d28' for writing: No space left on device\n";

/** The pattern deviceSyncOrchestrator already uses on a failed backup result. */
const ORCHESTRATOR_DISK_SPACE_PATTERN =
  /disk space|no space|ENOSPC|not enough space/i;

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

import {
  BackupService,
  isIdevicebackup2DiskFullOutput,
} from "../backupService";

/** A child process whose stdout/stderr/close can be driven from the test. */
class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  kill = jest.fn();
}

/**
 * Drives one backup run: the first spawn is the `ideviceinfo` encryption probe,
 * the second is `idevicebackup2` itself.
 */
function runBackup(script: (proc: FakeProcess) => void): Promise<BackupResult> {
  const service = new BackupService();
  const spawns: FakeProcess[] = [];

  mockSpawn.mockImplementation((cmd: string) => {
    const proc = new FakeProcess();
    spawns.push(proc);

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

describe("BACKLOG-2899 — idevicebackup2 full-disk output", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("the detector vs the real string", () => {
    it("matches the transcribed full-disk line", () => {
      expect(isIdevicebackup2DiskFullOutput(REAL_DISK_FULL_STDOUT)).toBe(true);
    });

    it("does not match ordinary transfer output", () => {
      const ordinary = [
        "Receiving files\n",
        "[==================    ] 71% (4.1 MB/5.8 MB)\n",
        "Received 47118 files from device.\n",
        "Backup Successful.\n",
        "Error opening 'C:\\x\\y' for writing: Permission denied\n",
      ].join("");
      expect(isIdevicebackup2DiskFullOutput(ordinary)).toBe(false);
    });

    it("covers the phrasing BACKLOG-2870's detector missed", () => {
      // SQLite's real full-disk message, the one that slipped through there.
      const sqliteFullDisk = "database or disk is full";

      // The orchestrator's own pattern still cannot see it — that IS the 2870
      // gap, reproduced here so nobody assumes token lists generalise.
      expect(ORCHESTRATOR_DISK_SPACE_PATTERN.test(sqliteFullDisk)).toBe(false);

      // This detector was written from producers' words rather than from
      // guesses about them, so "disk is full" is in it.
      expect(isIdevicebackup2DiskFullOutput(sqliteFullDisk)).toBe(true);
    });
  });

  describe("wiring", () => {
    it("detects the full-disk line on STDOUT, where progress_printf puts it", async () => {
      const result = await runBackup((proc) => {
        proc.stdout.emit("data", Buffer.from("Receiving files\n"));
        proc.stdout.emit("data", Buffer.from(REAL_DISK_FULL_STDOUT));
        // The tool does not fail on this: exit 0, having written nothing.
        proc.emit("close", 0);
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("INSUFFICIENT_SPACE");
      expect(result.error).toMatch(ORCHESTRATOR_DISK_SPACE_PATTERN);
    });

    it("still reports disk space when the process also exits non-zero", async () => {
      const result = await runBackup((proc) => {
        proc.stdout.emit("data", Buffer.from(REAL_DISK_FULL_STDOUT));
        proc.emit("close", 255);
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("INSUFFICIENT_SPACE");
      expect(result.error).toMatch(ORCHESTRATOR_DISK_SPACE_PATTERN);
    });

    it("leaves a clean run alone", async () => {
      const result = await runBackup((proc) => {
        proc.stdout.emit("data", Buffer.from("Received 47118 files from device.\n"));
        proc.stdout.emit("data", Buffer.from("Backup Successful.\n"));
        proc.emit("close", 0);
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
    });
  });
});
