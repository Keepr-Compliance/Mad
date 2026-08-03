/**
 * Unit tests for SyncStatusService
 * Tests the unified sync status aggregation (TASK-904)
 */

// Mock better-sqlite3-multiple-ciphers native module (required by backupService chain)
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
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
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
  spawn: jest.fn(),
}));

// Mock check-disk-space (used by deviceSyncOrchestrator)
jest.mock("check-disk-space", () => ({
  default: jest.fn().mockResolvedValue({ free: 10 * 1024 * 1024 * 1024 }),
}));

// Mock backupService with controllable status
const mockBackupStatus: BackupStatus = {
  isRunning: false,
  currentDeviceUdid: null,
  progress: null,
};

jest.mock("../backupService", () => ({
  backupService: {
    getStatus: jest.fn(() => mockBackupStatus),
  },
}));

// Mock deviceSyncOrchestrator with controllable status
const mockOrchestratorStatus: { isRunning: boolean; phase: SyncPhase } = {
  isRunning: false,
  phase: "idle",
};

jest.mock("../deviceSyncOrchestrator", () => ({
  deviceSyncOrchestrator: {
    getStatus: jest.fn(() => mockOrchestratorStatus),
  },
}));

// Import after mocks are set up
// Type-only imports (erased at runtime, so they do not defeat the jest.mock hoisting above)
import type { BackupStatus } from "../../types/backup";
import type { SyncPhase } from "../deviceSyncOrchestrator";
import { syncStatusService } from "../syncStatusService";
import { backupService } from "../backupService";
import { deviceSyncOrchestrator } from "../deviceSyncOrchestrator";

describe("SyncStatusService", () => {
  beforeEach(() => {
    // Reset mock status before each test
    mockBackupStatus.isRunning = false;
    mockBackupStatus.currentDeviceUdid = null;
    mockBackupStatus.progress = null;
    mockOrchestratorStatus.isRunning = false;
    mockOrchestratorStatus.phase = "idle";
  });

  describe("getStatus", () => {
    it("should return idle state when nothing is running", () => {
      const status = syncStatusService.getStatus();

      expect(status.isAnyOperationRunning).toBe(false);
      expect(status.backupInProgress).toBe(false);
      expect(status.emailSyncInProgress).toBe(false);
      expect(status.currentOperation).toBeNull();
      expect(status.syncPhase).toBe("idle");
    });

    it("should detect backup in progress from backupService", () => {
      mockBackupStatus.isRunning = true;
      mockBackupStatus.currentDeviceUdid = "test-udid";

      const status = syncStatusService.getStatus();

      expect(status.isAnyOperationRunning).toBe(true);
      expect(status.backupInProgress).toBe(true);
      expect(status.emailSyncInProgress).toBe(false);
      expect(status.currentOperation).toBe("iPhone backup in progress");
    });

    it("should detect sync in progress from orchestrator", () => {
      mockOrchestratorStatus.isRunning = true;
      mockOrchestratorStatus.phase = "parsing-messages";

      const status = syncStatusService.getStatus();

      expect(status.isAnyOperationRunning).toBe(true);
      expect(status.backupInProgress).toBe(false);
      expect(status.emailSyncInProgress).toBe(true);
      expect(status.currentOperation).toBe("Parsing messages");
      expect(status.syncPhase).toBe("parsing-messages");
    });

    it("should prioritize backup status over orchestrator", () => {
      // Both running - backup takes precedence for currentOperation
      mockBackupStatus.isRunning = true;
      mockOrchestratorStatus.isRunning = true;
      mockOrchestratorStatus.phase = "backup";

      const status = syncStatusService.getStatus();

      expect(status.isAnyOperationRunning).toBe(true);
      expect(status.backupInProgress).toBe(true);
      expect(status.emailSyncInProgress).toBe(false); // False because backup is running
      expect(status.currentOperation).toBe("iPhone backup in progress");
    });

    it("should return correct labels for each sync phase", () => {
      const phaseLabels: Record<string, string> = {
        backup: "iPhone backup in progress",
        decrypting: "Decrypting backup data",
        "parsing-contacts": "Parsing contacts",
        "parsing-messages": "Parsing messages",
        resolving: "Resolving contact names",
        cleanup: "Cleaning up",
      };

      for (const [phase, expectedLabel] of Object.entries(phaseLabels)) {
        mockOrchestratorStatus.isRunning = true;
        mockOrchestratorStatus.phase = phase as typeof mockOrchestratorStatus.phase;

        const status = syncStatusService.getStatus();
        expect(status.currentOperation).toBe(expectedLabel);
      }
    });

    it("should return null operation for complete phase", () => {
      mockOrchestratorStatus.isRunning = true;
      mockOrchestratorStatus.phase = "complete";

      const status = syncStatusService.getStatus();

      expect(status.currentOperation).toBeNull();
    });

    it("should return null operation for error phase", () => {
      mockOrchestratorStatus.isRunning = true;
      mockOrchestratorStatus.phase = "error";

      const status = syncStatusService.getStatus();

      expect(status.currentOperation).toBeNull();
    });

    it("should call underlying services", () => {
      syncStatusService.getStatus();

      expect(backupService.getStatus).toHaveBeenCalled();
      expect(deviceSyncOrchestrator.getStatus).toHaveBeenCalled();
    });
  });
});
