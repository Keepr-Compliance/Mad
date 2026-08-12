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
        supportsSkipApps: true,
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

    it("should use skip-apps by default", async () => {
      const options: BackupOptions = {
        udid: TEST_UDID, // Use valid UDID format (TASK-601)
        // skipApps defaults to true
      };

      // In mock mode, we just verify the service accepts the option
      const result = await backupService.startBackup(options);
      expect(result.success).toBe(true);
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

  // BACKLOG-1628: Verify -d flag is present as the first argument
  it("should include -d flag as the first argument", () => {
    const buildArgs = (backupService as any).buildBackupArgs.bind(
      backupService,
    );
    const args = buildArgs({ udid: TEST_UDID }, "/backup/path", TEST_UDID);

    expect(args[0]).toBe("-d");
  });

  // TASK-601: buildBackupArgs now takes validatedUdid as third parameter
  // The method signature is: buildBackupArgs(options, backupPath, validatedUdid)
  it("should include -u flag with UDID", () => {
    // Access private method via type assertion for testing
    const buildArgs = (backupService as any).buildBackupArgs.bind(
      backupService,
    );
    // Pass validated UDID as third parameter (TASK-601 security change)
    const args = buildArgs({ udid: TEST_UDID, skipApps: true }, "/backup/path", TEST_UDID);

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

  it("should include --skip-apps by default", () => {
    const buildArgs = (backupService as any).buildBackupArgs.bind(
      backupService,
    );
    const args = buildArgs({ udid: TEST_UDID }, "/backup/path", TEST_UDID);

    expect(args).toContain("--skip-apps");
  });

  it("should not include --skip-apps when disabled", () => {
    const buildArgs = (backupService as any).buildBackupArgs.bind(
      backupService,
    );
    const args = buildArgs({ udid: TEST_UDID, skipApps: false }, "/backup/path", TEST_UDID);

    expect(args).not.toContain("--skip-apps");
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

describe("BackupService - parseProgress", () => {
  let backupService: BackupService;

  beforeEach(() => {
    backupService = new BackupService();
  });

  it("should parse progress bar format", () => {
    const parseProgress = (backupService as any).parseProgress.bind(
      backupService,
    );

    // Progress bar format: "[====...] XX% (X.X MB/Y.Y MB)"
    const progress = parseProgress("[====      ] 50% (25.0 MB/50.0 MB)");
    expect(progress).not.toBeNull();
    expect(progress?.phase).toBe("transferring");
    expect(progress?.bytesTransferred).toBeGreaterThan(0);
  });

  it("should parse file count at end of backup", () => {
    const parseProgress = (backupService as any).parseProgress.bind(
      backupService,
    );

    // File count pattern indicates finishing phase
    const progress = parseProgress("Received 500 files");
    expect(progress).not.toBeNull();
    expect(progress?.filesTransferred).toBe(500);
    expect(progress?.phase).toBe("finishing");
  });

  it("should detect preparing phase", () => {
    const parseProgress = (backupService as any).parseProgress.bind(
      backupService,
    );

    const progress = parseProgress("Requesting backup from device");
    expect(progress).not.toBeNull();
    expect(progress?.phase).toBe("preparing");
  });

  it("should detect waiting phase", () => {
    const parseProgress = (backupService as any).parseProgress.bind(
      backupService,
    );

    const progress = parseProgress("Waiting for device to respond");
    expect(progress).not.toBeNull();
    expect(progress?.phase).toBe("preparing");
  });

  it("should return null for unrecognized output", () => {
    const parseProgress = (backupService as any).parseProgress.bind(
      backupService,
    );

    const progress = parseProgress("Some random output");
    expect(progress).toBeNull();
  });
});

describe("BackupService - parseStderrLine", () => {
  let backupService: BackupService;

  beforeEach(() => {
    backupService = new BackupService();
  });

  afterEach(() => {
    backupService.removeAllListeners();
  });

  it("should detect Manifest.db upload pattern and emit progress with size", () => {
    const parseStderrLine = (backupService as any).parseStderrLine.bind(
      backupService,
    );
    const progressEvents: any[] = [];
    backupService.on("progress", (p: any) => progressEvents.push(p));

    parseStderrLine(
      "Sending '00008140-1234ABCD5678/Manifest.db' (563.0 MB)",
      TEST_UDID,
    );

    expect(progressEvents.length).toBe(1);
    expect(progressEvents[0].phase).toBe("preparing");
    expect(progressEvents[0].message).toContain("563.0 MB");
  });

  it("should silently skip SSL_write lines (activity signal, no log)", () => {
    const parseStderrLine = (backupService as any).parseStderrLine.bind(
      backupService,
    );
    const progressEvents: any[] = [];
    backupService.on("progress", (p: any) => progressEvents.push(p));

    parseStderrLine("SSL_write 32768, sent 32768", TEST_UDID);

    // SSL_write should not emit any progress events
    expect(progressEvents.length).toBe(0);
  });

  it("should silently skip service_send lines (activity signal, no log)", () => {
    const parseStderrLine = (backupService as any).parseStderrLine.bind(
      backupService,
    );
    const progressEvents: any[] = [];
    backupService.on("progress", (p: any) => progressEvents.push(p));

    parseStderrLine("service_send(): sending 32768 bytes", TEST_UDID);

    // service_send should not emit any progress events
    expect(progressEvents.length).toBe(0);
  });

  it("should detect 'Requesting backup from device...' phase transition", () => {
    const parseStderrLine = (backupService as any).parseStderrLine.bind(
      backupService,
    );
    // Set manifestUploadPhase to true to test transition
    (backupService as any).manifestUploadPhase = true;

    const progressEvents: any[] = [];
    backupService.on("progress", (p: any) => progressEvents.push(p));

    parseStderrLine("Requesting backup from device...", TEST_UDID);

    expect(progressEvents.length).toBe(1);
    expect(progressEvents[0].phase).toBe("preparing");
    expect(progressEvents[0].message).toContain("Waiting for iPhone");
  });

  it("should return early for empty or short lines", () => {
    const parseStderrLine = (backupService as any).parseStderrLine.bind(
      backupService,
    );
    const progressEvents: any[] = [];
    backupService.on("progress", (p: any) => progressEvents.push(p));

    // Empty string
    parseStderrLine("", TEST_UDID);
    // Short string (< 5 chars)
    parseStderrLine("abc", TEST_UDID);

    // Neither should emit progress events
    expect(progressEvents.length).toBe(0);
  });
});
