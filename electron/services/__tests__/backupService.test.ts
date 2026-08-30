/**
 * Unit tests for BackupService
 * Tests iPhone backup operations via idevicebackup2
 */

import { BackupService } from "../backupService";
import {
  BackupOptions,
  BackupProgress,
  BackupResult,
} from "../../types/backup";

// Valid UDID formats for testing (TASK-601 security requirement)
// Traditional format: 40 hex chars
const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

// Mock better-sqlite3-multiple-ciphers native module
jest.mock("better-sqlite3-multiple-ciphers", () => {
  return jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({
      all: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(null),
      run: jest.fn(),
    }),
    close: jest.fn(),
    exec: jest.fn(),
  }));
});

// Mock electron modules
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn().mockReturnValue("/mock/userData"),
    isPackaged: false,
  },
}));

// Mock electron-log
jest.mock("electron-log", () => ({
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock fs/promises
jest.mock("fs", () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    access: jest.fn().mockRejectedValue(new Error("Not found")),
    readdir: jest.fn().mockResolvedValue([]),
    stat: jest.fn().mockResolvedValue({ size: 1024, mtime: new Date() }),
    rm: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue("<plist></plist>"),
  },
}));

// Mock child_process
jest.mock("child_process", () => ({
  spawn: jest.fn().mockImplementation(() => {
    const mockStdout = {
      on: jest.fn(),
    };

    const mockStderr = {
      on: jest.fn(),
    };

    // Explicit annotation: `on` returns mockProcess, so inference would be circular
    // (TS7022/TS7024). Shape is unchanged.
    const mockProcess: {
      stdout: typeof mockStdout;
      stderr: typeof mockStderr;
      on: jest.Mock;
      kill: jest.Mock;
    } = {
      stdout: mockStdout,
      stderr: mockStderr,
      on: jest.fn((event: string, callback: Function) => {
        if (event === "close") {
          // Simulate successful process completion after a delay
          // Longer delay (200ms) to allow testing concurrent backup scenarios
          setTimeout(() => callback(0), 200);
        }
        return mockProcess;
      }),
      kill: jest.fn(),
    };

    return mockProcess;
  }),
}));

// Mock libimobiledeviceService
jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn().mockReturnValue("/mock/idevicebackup2"),
  isMockMode: jest.fn().mockReturnValue(false), // Use spawn mock, not mockBackup
}));

describe("BackupService", () => {
  let backupService: BackupService;

  beforeEach(() => {
    jest.clearAllMocks();
    backupService = new BackupService();
  });

  afterEach(() => {
    // Clean up any running processes
    backupService.cancelBackup();
    backupService.removeAllListeners();
  });

  describe("checkCapabilities", () => {
    it("should return backup capabilities", async () => {
      const capabilities = await backupService.checkCapabilities();

      expect(capabilities).toEqual({
        supportsDomainFiltering: false,
        supportsIncremental: true,
        supportsEncryption: true,
        availableDomains: expect.arrayContaining([
          "HomeDomain",
          "CameraRollDomain",
          "AppDomain",
          "MediaDomain",
          "SystemPreferencesDomain",
        ]),
      });
    });

    it("should indicate domain filtering is NOT supported", async () => {
      const capabilities = await backupService.checkCapabilities();

      // Critical: Domain filtering is not possible with idevicebackup2
      // See docs/BACKUP_RESEARCH.md for details
      expect(capabilities.supportsDomainFiltering).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("should return initial status when no backup is running", () => {
      const status = backupService.getStatus();

      expect(status).toEqual({
        isRunning: false,
        currentDeviceUdid: null,
        progress: null,
      });
    });

    it("should reflect running status during backup", async () => {
      const options: BackupOptions = {
        udid: TEST_UDID, // Use valid UDID format (TASK-601)
      };

      // Start backup (in mock mode, it runs asynchronously)
      const backupPromise = backupService.startBackup(options);

      // Wait for checkEncryptionStatus to complete (200ms) + Promise executor to run
      await new Promise((resolve) => setTimeout(resolve, 250));

      const status = backupService.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.currentDeviceUdid).toBe(TEST_UDID);

      // Wait for completion
      await backupPromise;
    });
  });

  describe("startBackup", () => {
    it("should throw error if backup already in progress", async () => {
      const options: BackupOptions = {
        udid: TEST_UDID, // Use valid UDID format (TASK-601)
      };

      // Start first backup (don't await it)
      const firstBackup = backupService.startBackup(options);

      // Wait for checkEncryptionStatus to complete (200ms) + Promise executor to set isRunning flag
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Attempt to start second backup while first is still running
      await expect(backupService.startBackup(options)).rejects.toThrow(
        "Backup already in progress",
      );

      // Wait for first backup to complete
      await firstBackup;
    });

    it("should emit progress events during backup", async () => {
      const options: BackupOptions = {
        udid: TEST_UDID, // Use valid UDID format (TASK-601)
      };

      const progressEvents: BackupProgress[] = [];
      backupService.on("progress", (progress: BackupProgress) => {
        progressEvents.push(progress);
      });

      await backupService.startBackup(options);

      // Should have received multiple progress events
      expect(progressEvents.length).toBeGreaterThan(0);

      // Should have gone through phases
      const phases = progressEvents.map((p) => p.phase);
      expect(phases).toContain("preparing");
      expect(phases).toContain("finishing");
    });

    it("should return success result on completion", async () => {
      const options: BackupOptions = {
        udid: TEST_UDID, // Use valid UDID format (TASK-601)
      };

      const result = await backupService.startBackup(options);

      expect(result).toMatchObject({
        success: true,
        deviceUdid: TEST_UDID,
        error: null,
      });
      expect(result.duration).toBeGreaterThan(0);
      expect(result.backupPath).toBeTruthy();
    });

    it("should emit complete event when finished", async () => {
      const options: BackupOptions = {
        udid: TEST_UDID, // Use valid UDID format (TASK-601)
      };

      let completedResult: BackupResult | null = null;
      backupService.on("complete", (result: BackupResult) => {
        completedResult = result;
      });

      await backupService.startBackup(options);

      expect(completedResult).not.toBeNull();
      expect(completedResult!.success).toBe(true);
    });

    it("should support custom output directory", async () => {
      const options: BackupOptions = {
        udid: TEST_UDID, // Use valid UDID format (TASK-601)
        outputDir: "/custom/backup/path",
      };

      const result = await backupService.startBackup(options);
      expect(result.success).toBe(true);
    });

    it("should support force full backup option", async () => {
      const options: BackupOptions = {
        udid: TEST_UDID, // Use valid UDID format (TASK-601)
        forceFullBackup: true,
      };

      const result = await backupService.startBackup(options);
      expect(result.success).toBe(true);
    });
  });

  describe("cancelBackup", () => {
    it("should cancel running backup", async () => {
      const options: BackupOptions = {
        udid: TEST_UDID, // Use valid UDID format (TASK-601)
      };

      // Start backup
      const backupPromise = backupService.startBackup(options);

      // Give it a moment to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Cancel
      backupService.cancelBackup();

      // Verify status
      const status = backupService.getStatus();
      expect(status.isRunning).toBe(false);

      // Wait for promise to resolve
      await backupPromise;
    });

    it("should do nothing if no backup is running", () => {
      expect(() => backupService.cancelBackup()).not.toThrow();
    });
  });

  describe("listBackups", () => {
    it("should return empty array when no backups exist", async () => {
      const backups = await backupService.listBackups();
      expect(backups).toEqual([]);
    });
  });

  describe("deleteBackup", () => {
    it("should throw error for paths outside backup directory", async () => {
      // Mock fs.access to resolve (path exists) so we reach the validation check
      const fs = require("fs");
      fs.promises.access = jest.fn().mockResolvedValue(undefined);

      await expect(
        backupService.deleteBackup("/some/other/path"),
      ).rejects.toThrow("Cannot delete backup outside of backup directory");
    });
  });

  describe("cleanupOldBackups", () => {
    it("should not throw when no backups exist", async () => {
      await expect(backupService.cleanupOldBackups(1)).resolves.not.toThrow();
    });
  });

  describe("getBackupMetadata (TASK-908)", () => {
    it("should return null when manifest does not exist", async () => {
      // Reset fs.stat to reject with ENOENT (file not found)
      const fsModule = require("fs");
      const enoent = new Error("ENOENT: no such file or directory") as Error & { code: string };
      enoent.code = "ENOENT";
      fsModule.promises.stat = jest.fn().mockRejectedValue(enoent);

      const result = await backupService.getBackupMetadata("/some/backup/path");
      expect(result).toBeNull();
    });

    it("should return metadata when manifest exists", async () => {
      const fsModule = require("fs");
      const mockDate = new Date("2024-01-15T10:00:00Z");

      // Mock pathExists to return true for manifest
      fsModule.promises.access = jest.fn().mockResolvedValue(undefined);
      fsModule.promises.stat = jest.fn().mockResolvedValue({
        mtime: mockDate,
        size: 1024,
      });
      fsModule.promises.readFile = jest
        .fn()
        .mockResolvedValue(Buffer.from("test manifest content"));

      const result = await backupService.getBackupMetadata("/mock/backup/path");

      expect(result).not.toBeNull();
      expect(result?.modifiedAt).toEqual(mockDate);
      expect(result?.manifestHash).toBeDefined();
      expect(result?.manifestHash).toHaveLength(64); // SHA-256 hex is 64 chars
    });

    it("should return consistent hash for same content", async () => {
      const fsModule = require("fs");
      const mockContent = Buffer.from("consistent manifest content");

      fsModule.promises.access = jest.fn().mockResolvedValue(undefined);
      fsModule.promises.stat = jest.fn().mockResolvedValue({
        mtime: new Date(),
        size: 1024,
      });
      fsModule.promises.readFile = jest.fn().mockResolvedValue(mockContent);

      const result1 = await backupService.getBackupMetadata("/mock/backup/path");
      const result2 = await backupService.getBackupMetadata("/mock/backup/path");

      expect(result1?.manifestHash).toBe(result2?.manifestHash);
    });

    it("should return different hash for different content", async () => {
      const fsModule = require("fs");

      fsModule.promises.access = jest.fn().mockResolvedValue(undefined);
      fsModule.promises.stat = jest.fn().mockResolvedValue({
        mtime: new Date(),
        size: 1024,
      });

      // First call with content A
      fsModule.promises.readFile = jest
        .fn()
        .mockResolvedValue(Buffer.from("content A"));
      const result1 = await backupService.getBackupMetadata("/mock/backup/path");

      // Second call with content B
      fsModule.promises.readFile = jest
        .fn()
        .mockResolvedValue(Buffer.from("content B"));
      const result2 = await backupService.getBackupMetadata("/mock/backup/path");

      expect(result1?.manifestHash).not.toBe(result2?.manifestHash);
    });
  });

  describe("event emitter", () => {
    it("should support progress event listeners", () => {
      const listener = jest.fn();
      backupService.on("progress", listener);
      backupService.emit("progress", {
        phase: "preparing",
        percentComplete: 0,
      } as BackupProgress);
      expect(listener).toHaveBeenCalled();
    });

    it("should support error event listeners", () => {
      const listener = jest.fn();
      backupService.on("error", listener);
      backupService.emit("error", new Error("Test error"));
      expect(listener).toHaveBeenCalled();
    });

    it("should support complete event listeners", () => {
      const listener = jest.fn();
      backupService.on("complete", listener);
      backupService.emit("complete", { success: true } as BackupResult);
      expect(listener).toHaveBeenCalled();
    });
  });
});

describe("BackupService - buildBackupArgs", () => {
  let backupService: BackupService;

  beforeEach(() => {
    backupService = new BackupService();
  });

  // BACKLOG-2915: THE `-d` FLAG IS GONE. This assertion is inverted deliberately.
  //
  // BACKLOG-1628 added `-d` to get libimobiledevice's debug output on stderr, for the
  // watchdog and for progress. Neither purpose survived contact with the evidence:
  // `-d` maps to `case 'd': idevice_set_debug_level(1);` and never touches `verbose`,
  // so stdout is byte-identical with and without it, and every signal this service
  // needs is a `printf` on stdout. What the flag actually produced was a 65 KB stderr
  // cap hit in 5 of 5 real failures, 336 mis-labelled "error pattern" log records in
  // one run (BACKLOG-2903), and a watchdog liveness clock that could never age
  // (BACKLOG-2911). Measured with the flag off, on 2026-08-30: 11 bytes of stderr in
  // 20 minutes.
  it("does NOT pass -d, and -u is the first argument", () => {
    const buildArgs = (backupService as any).buildBackupArgs.bind(
      backupService,
    );
    const args = buildArgs({ udid: TEST_UDID }, "/backup/path", TEST_UDID);

    expect(args).not.toContain("-d");
    expect(args[0]).toBe("-u");
  });

  // TASK-601: buildBackupArgs now takes validatedUdid as third parameter
  // The method signature is: buildBackupArgs(options, backupPath, validatedUdid)
  it("should include -u flag with UDID", () => {
    // Access private method via type assertion for testing
    const buildArgs = (backupService as any).buildBackupArgs.bind(
      backupService,
    );
    // Pass validated UDID as third parameter (TASK-601 security change)
    const args = buildArgs({ udid: TEST_UDID }, "/backup/path", TEST_UDID);

    expect(args).toContain("-u");
    expect(args).toContain(TEST_UDID);
  });

  it("should include backup command", () => {
    const buildArgs = (backupService as any).buildBackupArgs.bind(
      backupService,
    );
    const args = buildArgs({ udid: TEST_UDID }, "/backup/path", TEST_UDID);

    expect(args).toContain("backup");
  });

  it("should include --full when forceFullBackup is true", () => {
    const buildArgs = (backupService as any).buildBackupArgs.bind(
      backupService,
    );
    const args = buildArgs(
      { udid: TEST_UDID, forceFullBackup: true },
      "/backup/path",
      TEST_UDID,
    );

    expect(args).toContain("--full");
  });

  it("should include backup path as last argument", () => {
    const buildArgs = (backupService as any).buildBackupArgs.bind(
      backupService,
    );
    const args = buildArgs({ udid: TEST_UDID }, "/backup/path", TEST_UDID);

    expect(args[args.length - 1]).toBe("/backup/path");
  });
});

/**
 * BACKLOG-2915 — `parseProgress` and `parseStderrLine` are both gone; `parseStdoutLine`
 * replaces them, and it is fed by a `\r`/`\n` line splitter rather than a regex over
 * the raw chunk.
 *
 * `parseStderrLine`'s five tests are RETIRED rather than moved. They called the method
 * directly with a string, so they proved a substring matched and nothing about which
 * stream carries the line — and six of that method's eight patterns matched lines
 * idevicebackup2 prints on STDOUT (`Sending '...Manifest.db'`, the two `.plist` sends,
 * `Negotiated Protocol`, `Requesting backup`, the backup-mode line). Pattern 1's
 * "Preparing incremental backup — uploading backup index" message had therefore never
 * fired in production. The remaining two, `SSL_write` and `service_send`, existed only
 * under `-d`.
 *
 * The claims worth keeping are re-asserted in
 * `backupService.stdoutProgress-2915.test.ts`, through the real `proc.stdout` emitter,
 * with a control that the same bytes on `proc.stderr` do nothing. The smoke tests below
 * cover the same five branches the old `parseProgress` block did.
 */
describe("BackupService - parseStdoutLine", () => {
  let backupService: BackupService;
  const parse = (line: string) =>
    (backupService as any).parseStdoutLine.bind(backupService)(line);

  beforeEach(() => {
    backupService = new BackupService();
    (backupService as any).startTime = Date.now();
  });

  it("should parse the byte progress render", () => {
    const progress = parse("[====      ] 50% (25.0 MB/50.0 MB)");
    expect(progress).not.toBeNull();
    expect(progress?.phase).toBe("transferring");
    expect(progress?.bytesTransferred).toBeGreaterThan(0);
    expect(progress?.batchTotalBytes).toBe(50 * 1024 * 1024);
  });

  it("should parse the device's file count at the end of the backup", () => {
    const progress = parse("Received 500 files from device.");
    expect(progress).not.toBeNull();
    expect(progress?.filesTransferred).toBe(500);
    expect(progress?.phase).toBe("finishing");
  });

  it("should detect the preparing phase", () => {
    const progress = parse("Requesting backup from device...");
    expect(progress).not.toBeNull();
    expect(progress?.phase).toBe("preparing");
  });

  it("should detect the start of the backup", () => {
    const progress = parse("Starting backup...");
    expect(progress).not.toBeNull();
    expect(progress?.phase).toBe("preparing");
  });

  it("should return null for unrecognised output", () => {
    expect(parse("Some random output")).toBeNull();
  });
});

/**
 * BACKLOG-2910 — the argv control.
 *
 * `--skip-apps` is a RESTORE option. Measured against the binaries this project
 * uses, on 2026-08-26:
 *
 *   $ idevicebackup2 --version                      # 1.4.0 (Homebrew, macOS)
 *   $ export USBMUXD_SOCKET_ADDRESS=127.0.0.1:1     # forces the connect to fail
 *                                                   # AFTER argv is fully parsed,
 *                                                   # so no device is touched
 *   $ idevicebackup2 -d -u <fake> backup            <dir>   # exit 255
 *   $ idevicebackup2 -d -u <fake> backup --skip-apps <dir>  # exit 255
 *
 *   stdout sha256 dd1bedf5d68aa0358f2abe756ff634cd952b187d2b16d4a0bbb8cd8d89b22db1
 *   for BOTH; stderr empty (e3b0c442…) for BOTH; exit code equal.
 *
 * The discriminating control — proving the flag is a RECOGNISED global option the
 * backup path never reads, rather than unknown junk the parser happens to ignore:
 *
 *   $ idevicebackup2 -d -u <fake> backup --not-a-real-flag <dir>
 *   idevicebackup2: unrecognized option `--not-a-real-flag'   → exit 2
 *
 * The parser DOES reject unknown long options. It does not reject --skip-apps,
 * and the invocation is byte-identical with and without it.
 *
 * Corroborated in the binary this repo actually ships to users —
 * `strings resources/win/libimobiledevice/idevicebackup2.exe` places --skip-apps
 * inside the restore CMDOPTIONS group (--no-reboot, --copy, --settings, --remove,
 * --skip-apps, --password), and its help text lists it under `restore`, never
 * under `backup`. The `backup` command accepts only `--full`.
 *
 * These asserts are exact-array identity, not `not.toContain`, so they pin BOTH
 * halves of the claim at once: the flag is gone, and nothing else moved.
 */
describe("BackupService - buildBackupArgs argv identity (BACKLOG-2910)", () => {
  let backupService: BackupService;

  const buildArgs = (options: object) => {
    const fn = (backupService as any).buildBackupArgs.bind(backupService);
    return fn(options, "/backup/path", TEST_UDID) as string[];
  };

  beforeEach(() => {
    backupService = new BackupService();
  });

  // BACKLOG-2915 updated both arrays: `-d` is gone. The exact-array form is KEPT, and
  // that is the point of touching these rather than deleting them — the BACKLOG-2910
  // claim is "we ask the device for exactly one thing and nothing else moved", and it
  // is only worth anything if the array is pinned whole through a change like this one.
  it("builds a default backup invocation with no --skip-apps, no -d, and nothing else changed", () => {
    expect(buildArgs({ udid: TEST_UDID })).toEqual([
      "-u",
      TEST_UDID,
      "backup",
      "/backup/path",
    ]);
  });

  it("builds a forced full backup invocation with no --skip-apps, no -d, and nothing else changed", () => {
    expect(buildArgs({ udid: TEST_UDID, forceFullBackup: true })).toEqual([
      "-u",
      TEST_UDID,
      "backup",
      "--full",
      "/backup/path",
    ]);
  });
});
