/**
 * Sync Orchestrator Tests (CI-Safe)
 *
 * Unit tests for DeviceSyncOrchestrator that can run in CI without timer issues.
 * Tests exported types, utility methods, and synchronous behaviors.
 *
 * TASK-1054: Add coverage for deviceSyncOrchestrator critical paths
 */

import { EventEmitter } from "events";

// Mock all dependencies before importing
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

jest.mock("better-sqlite3-multiple-ciphers", () => {
  return jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({
      all: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(null),
      run: jest.fn(),
    }),
    close: jest.fn(),
  }));
});

jest.mock("check-disk-space", () => {
  return jest.fn().mockResolvedValue({
    diskPath: "C:",
    free: 500 * 1024 * 1024 * 1024,
    size: 1000 * 1024 * 1024 * 1024,
  });
});

// Mock service modules with minimal implementations
jest.mock("../backupService", () => ({
  BackupService: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    emit: jest.fn(),
    removeAllListeners: jest.fn(),
    // BACKLOG-2917: three-state report; `sizeBytes` is now a `size` reading.
    checkBackupStatus: jest.fn().mockResolvedValue({
      state: "present",
      isComplete: true,
      isInterrupted: false,
      size: { measured: true, bytes: 100 * 1024 * 1024 },
      lastModified: new Date(),
    }),
    startBackup: jest.fn(),
    cancelBackup: jest.fn(),
  })),
}));

jest.mock("../backupDecryptionService", () => ({
  BackupDecryptionService: jest.fn().mockImplementation(() => ({
    isBackupEncrypted: jest.fn().mockResolvedValue(false),
    decryptBackup: jest.fn(),
    cleanup: jest.fn(),
  })),
}));

jest.mock("../deviceDetectionService", () => {
  const mockService = new EventEmitter();
  Object.assign(mockService, {
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

// Import after mocks
import {
  DeviceSyncOrchestrator,
  SyncPhase,
  SyncResult,
  SyncProgress,
  SyncOptions,
} from "../deviceSyncOrchestrator";

describe("DeviceSyncOrchestrator - Type Exports", () => {
  it("should export SyncPhase type with expected values", () => {
    const phases: SyncPhase[] = [
      "idle",
      "backup",
      "decrypting",
      "parsing-contacts",
      "parsing-messages",
      "resolving",
      "cleanup",
      "complete",
      "error",
    ];

    expect(phases).toHaveLength(9);
    expect(phases).toContain("idle");
    expect(phases).toContain("complete");
  });

  it("should export SyncResult type with required fields", () => {
    const mockResult: SyncResult = {
      success: true,
      messages: [],
      contacts: [],
      conversations: [],
      error: null,
      duration: 100,
    };

    expect(mockResult.success).toBe(true);
    expect(mockResult.error).toBeNull();
    expect(Array.isArray(mockResult.messages)).toBe(true);
  });

  it("should export SyncResult with optional skip fields", () => {
    const skippedResult: SyncResult = {
      success: true,
      messages: [],
      contacts: [],
      conversations: [],
      error: null,
      duration: 0,
      skipped: true,
      skipReason: "unchanged",
    };

    expect(skippedResult.skipped).toBe(true);
    expect(skippedResult.skipReason).toBe("unchanged");
  });

  it("should export SyncProgress type", () => {
    const mockProgress: SyncProgress = {
      phase: "backup",
      phaseProgress: 50,
      overallProgress: 25,
      message: "Backing up device...",
    };

    expect(mockProgress.phase).toBe("backup");
    expect(mockProgress.phaseProgress).toBe(50);
  });

  it("should export SyncOptions type", () => {
    const options: SyncOptions = {
      udid: "test-udid",
      password: "optional-password",
      forceFullBackup: true,
    };

    expect(options.udid).toBe("test-udid");
    expect(options.password).toBe("optional-password");
    expect(options.forceFullBackup).toBe(true);
  });
});

describe("DeviceSyncOrchestrator - Instance Creation", () => {
  it("should create an instance", () => {
    const orchestrator = new DeviceSyncOrchestrator();
    expect(orchestrator).toBeDefined();
    expect(orchestrator).toBeInstanceOf(EventEmitter);
  });

  it("should have initial state as not running", () => {
    const orchestrator = new DeviceSyncOrchestrator();
    const status = orchestrator.getStatus();

    expect(status.isRunning).toBe(false);
    expect(status.phase).toBe("idle");
  });
});

describe("DeviceSyncOrchestrator - getStatus", () => {
  let orchestrator: DeviceSyncOrchestrator;

  beforeEach(() => {
    orchestrator = new DeviceSyncOrchestrator();
  });

  afterEach(() => {
    orchestrator.stopDeviceDetection();
    orchestrator.removeAllListeners();
  });

  it("should return status object with required fields", () => {
    const status = orchestrator.getStatus();

    expect(status).toHaveProperty("isRunning");
    expect(status).toHaveProperty("phase");
    expect(typeof status.isRunning).toBe("boolean");
    expect(typeof status.phase).toBe("string");
  });

  it("should report idle phase initially", () => {
    expect(orchestrator.getStatus().phase).toBe("idle");
  });

  it("should report not running initially", () => {
    expect(orchestrator.getStatus().isRunning).toBe(false);
  });
});

describe("DeviceSyncOrchestrator - Device Detection Management", () => {
  let orchestrator: DeviceSyncOrchestrator;

  beforeEach(() => {
    orchestrator = new DeviceSyncOrchestrator();
  });

  afterEach(() => {
    orchestrator.stopDeviceDetection();
    orchestrator.removeAllListeners();
  });

  it("should start device detection without throwing", () => {
    expect(() => {
      orchestrator.startDeviceDetection(5000);
    }).not.toThrow();
  });

  it("should stop device detection without throwing", () => {
    orchestrator.startDeviceDetection();
    expect(() => {
      orchestrator.stopDeviceDetection();
    }).not.toThrow();
  });

  it("should get connected devices as an array", () => {
    const devices = orchestrator.getConnectedDevices();
    expect(Array.isArray(devices)).toBe(true);
  });

  it("should handle multiple start/stop cycles", () => {
    expect(() => {
      orchestrator.startDeviceDetection();
      orchestrator.stopDeviceDetection();
      orchestrator.startDeviceDetection();
      orchestrator.stopDeviceDetection();
    }).not.toThrow();
  });
});

describe("DeviceSyncOrchestrator - Event Emitter Functionality", () => {
  let orchestrator: DeviceSyncOrchestrator;

  beforeEach(() => {
    orchestrator = new DeviceSyncOrchestrator();
  });

  afterEach(() => {
    orchestrator.stopDeviceDetection();
    orchestrator.removeAllListeners();
  });

  it("should be an EventEmitter", () => {
    expect(typeof orchestrator.on).toBe("function");
    expect(typeof orchestrator.emit).toBe("function");
    expect(typeof orchestrator.removeAllListeners).toBe("function");
  });

  it("should allow adding and removing listeners", () => {
    const handler = jest.fn();

    orchestrator.on("progress", handler);
    expect(orchestrator.listenerCount("progress")).toBe(1);

    orchestrator.removeListener("progress", handler);
    expect(orchestrator.listenerCount("progress")).toBe(0);
  });

  it("should emit events to listeners", () => {
    const handler = jest.fn();
    orchestrator.on("custom-event", handler);

    orchestrator.emit("custom-event", { test: "data" });

    expect(handler).toHaveBeenCalledWith({ test: "data" });
  });
});

describe("DeviceSyncOrchestrator - forceReset", () => {
  let orchestrator: DeviceSyncOrchestrator;

  beforeEach(() => {
    orchestrator = new DeviceSyncOrchestrator();
  });

  afterEach(() => {
    orchestrator.stopDeviceDetection();
    orchestrator.removeAllListeners();
  });

  it("should reset state to idle", () => {
    orchestrator.forceReset();

    const status = orchestrator.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.phase).toBe("idle");
  });

  it("should be callable multiple times", () => {
    expect(() => {
      orchestrator.forceReset();
      orchestrator.forceReset();
      orchestrator.forceReset();
    }).not.toThrow();
  });
});

describe("DeviceSyncOrchestrator - Skip Logic (TASK-908)", () => {
  let orchestrator: DeviceSyncOrchestrator;

  beforeEach(() => {
    orchestrator = new DeviceSyncOrchestrator();
  });

  afterEach(() => {
    orchestrator.stopDeviceDetection();
    orchestrator.removeAllListeners();
  });

  describe("shouldProcessBackup", () => {
    it("should return true when no previous sync recorded", async () => {
      const result = await orchestrator.shouldProcessBackup("/some/backup/path");
      expect(result).toBe(true);
    });

    it("should return true for nonexistent path", async () => {
      const result = await orchestrator.shouldProcessBackup("/nonexistent/path");
      expect(result).toBe(true);
    });
  });

  describe("recordBackupSync", () => {
    it("should not throw when recording sync metadata", () => {
      expect(() => {
        orchestrator.recordBackupSync("/test/backup/path", "a".repeat(64));
      }).not.toThrow();
    });

    it("should accept valid path and hash", () => {
      const backupPath = "/test/backup/path";
      const manifestHash = "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234";

      expect(() => {
        orchestrator.recordBackupSync(backupPath, manifestHash);
      }).not.toThrow();
    });
  });

  describe("clearLastBackupSync", () => {
    it("should not throw when clearing", () => {
      expect(() => {
        orchestrator.clearLastBackupSync();
      }).not.toThrow();
    });

    it("should be callable after recording", () => {
      orchestrator.recordBackupSync("/test/path", "hash123");

      expect(() => {
        orchestrator.clearLastBackupSync();
      }).not.toThrow();
    });

    it("should be callable multiple times", () => {
      expect(() => {
        orchestrator.clearLastBackupSync();
        orchestrator.clearLastBackupSync();
      }).not.toThrow();
    });
  });
});

describe("DeviceSyncOrchestrator - cancel", () => {
  let orchestrator: DeviceSyncOrchestrator;

  beforeEach(() => {
    orchestrator = new DeviceSyncOrchestrator();
  });

  afterEach(() => {
    orchestrator.stopDeviceDetection();
    orchestrator.removeAllListeners();
  });

  it("should be callable when not running", () => {
    expect(() => {
      orchestrator.cancel();
    }).not.toThrow();
  });

  it("should set cancelled state", () => {
    orchestrator.cancel();
    // The cancelled state is internal, but we can verify through subsequent operations
    expect(orchestrator.getStatus().isRunning).toBe(false);
  });
});

describe("DeviceSyncOrchestrator - Progress Calculation", () => {
  it("should have phase progress between 0-100", () => {
    const progress: SyncProgress = {
      phase: "backup",
      phaseProgress: 50,
      overallProgress: 25,
      message: "Test",
    };

    expect(progress.phaseProgress).toBeGreaterThanOrEqual(0);
    expect(progress.phaseProgress).toBeLessThanOrEqual(100);
  });

  it("should have overall progress between 0-100", () => {
    const progress: SyncProgress = {
      phase: "parsing-messages",
      phaseProgress: 75,
      overallProgress: 60,
      message: "Parsing messages...",
    };

    expect(progress.overallProgress).toBeGreaterThanOrEqual(0);
    expect(progress.overallProgress).toBeLessThanOrEqual(100);
  });

  it("should include optional backupProgress", () => {
    const progressWithBackup: SyncProgress = {
      phase: "backup",
      phaseProgress: 50,
      overallProgress: 25,
      message: "Backing up...",
      backupProgress: {
        phase: "transferring",
        percentComplete: 50,
        // Required-but-nullable BackupProgress fields; null is the "not known yet"
        // value the producer uses, and no assertion in this test reads them.
        currentFile: null,
        filesTransferred: 1000,
        totalFiles: null,
        bytesTransferred: 500 * 1024 * 1024,
        totalBytes: null,
        estimatedTimeRemaining: null,
      },
    };

    expect(progressWithBackup.backupProgress).toBeDefined();
    expect(progressWithBackup.backupProgress?.filesTransferred).toBe(1000);
  });

  it("should include optional estimatedTotalBytes", () => {
    const progressWithEstimate: SyncProgress = {
      phase: "backup",
      phaseProgress: 25,
      overallProgress: 12,
      message: "Backing up...",
      estimatedTotalBytes: 50 * 1024 * 1024 * 1024,
    };

    expect(progressWithEstimate.estimatedTotalBytes).toBe(50 * 1024 * 1024 * 1024);
  });
});
