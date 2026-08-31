/**
 * Sync Orchestrator Tests
 *
 * Tests for the main integration service that orchestrates iPhone sync on Windows.
 * Uses comprehensive mock infrastructure for all dependencies.
 *
 * TASK-203: Fixed with proper mock infrastructure for:
 * - BackupService
 * - BackupDecryptionService
 * - DeviceDetectionService
 * - iOSMessagesParser
 * - iOSContactsParser
 * - check-disk-space
 */

import { EventEmitter } from "events";

// Mock data for tests
const mockDevice = {
  udid: "00000000-0000000000000000",
  name: "Mock iPhone",
  productType: "iPhone14,2",
  productVersion: "17.0",
  serialNumber: "MOCK123456789",
  isConnected: true,
};

const mockContact = {
  id: 1,
  firstName: "John",
  lastName: "Doe",
  displayName: "John Doe",
  organization: null,
  phones: [{ label: "mobile", value: "+15555550112" }],
  emails: [{ label: "home", value: "john@example.com" }],
};

const mockMessage = {
  id: 1,
  guid: "test-guid-1",
  text: "Test message",
  handle: "+15555550112",
  isFromMe: false,
  date: new Date("2024-01-01T10:00:00Z"),
  dateRead: new Date("2024-01-01T10:01:00Z"),
  dateDelivered: new Date("2024-01-01T10:00:01Z"),
  isRead: true,
  attachments: [],
  chatId: 1,
};

const mockConversation = {
  chatId: 1,
  guid: "chat-guid-1",
  displayName: "John Doe",
  participants: ["+15555550112"],
  lastMessageDate: new Date("2024-01-01T10:00:00Z"),
  messageCount: 1,
  isGroupChat: false,
  messages: [mockMessage],
};

// Create mock classes that extend EventEmitter for proper event handling
class MockBackupService extends EventEmitter {
  private shouldSucceed = true;
  private isEncrypted = false;

  // BACKLOG-2915: the orchestrator opens a sync scope where it builds a fresh
  // AbortController, so the cancel latch is cleared per SYNC rather than per run. A
  // mock without this throws — which is the wiring being pinned rather than assumed.
  beginSyncScope = jest.fn();

  setMockBehavior(succeed: boolean, encrypted: boolean = false) {
    this.shouldSucceed = succeed;
    this.isEncrypted = encrypted;
  }

  async checkBackupStatus(_udid: string) {
    // BACKLOG-2917: three-state report. A measured 100 MB prior backup.
    return {
      state: "present" as const,
      isComplete: true,
      isInterrupted: false,
      snapshotState: "finished" as const,
      size: { measured: true as const, bytes: 1024 * 1024 * 100 }, // 100MB
      lastModified: new Date(),
    };
  }

  async startBackup(_options: { udid: string; password?: string; forceFullBackup?: boolean }) {
    // Emit progress events
    this.emit("progress", {
      phase: "preparing",
      percentComplete: 0,
      filesTransferred: 0,
      bytesTransferred: 0,
    });

    // Simulate some async work
    await new Promise((resolve) => setTimeout(resolve, 10));

    this.emit("progress", {
      phase: "transferring",
      percentComplete: 50,
      filesTransferred: 100,
      bytesTransferred: 50 * 1024 * 1024,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    this.emit("progress", {
      phase: "finishing",
      percentComplete: 100,
      filesTransferred: 200,
      bytesTransferred: 100 * 1024 * 1024,
    });

    if (!this.shouldSucceed) {
      return {
        success: false,
        error: "Mock backup failure",
        backupPath: null,
        isEncrypted: false,
      };
    }

    return {
      success: true,
      error: null,
      backupPath: "/tmp/mock-backup",
      isEncrypted: this.isEncrypted,
    };
  }

  cancelBackup() {
    // No-op for mock
  }
}

class MockBackupDecryptionService {
  async isBackupEncrypted(_backupPath: string) {
    return false;
  }

  async decryptBackup(_backupPath: string, _password: string) {
    return {
      success: true,
      error: null,
      decryptedPath: "/tmp/mock-backup/decrypted",
    };
  }

  async cleanup(_path: string) {
    // No-op for mock
  }
}

class MockDeviceDetectionService extends EventEmitter {
  private devices: typeof mockDevice[] = [];

  start(_intervalMs?: number) {
    // Simulate device detection
    setTimeout(() => {
      this.devices = [mockDevice];
      this.emit("device-connected", mockDevice);
    }, 50);
  }

  stop() {
    // No-op for mock
  }

  getConnectedDevices() {
    return this.devices;
  }

  async getDeviceStorageInfo(_udid: string) {
    return {
      totalSpace: 256 * 1024 * 1024 * 1024, // 256GB
      usedSpace: 128 * 1024 * 1024 * 1024, // 128GB
      freeSpace: 128 * 1024 * 1024 * 1024,
      estimatedBackupSize: 50 * 1024 * 1024 * 1024, // 50GB estimated
    };
  }
}

class MockMessagesParser {
  private isOpen = false;

  open(_backupPath: string) {
    this.isOpen = true;
  }

  close() {
    this.isOpen = false;
  }

  async getConversationsAsync(progressCallback?: (current: number, total: number) => void) {
    if (progressCallback) {
      progressCallback(1, 1);
    }
    return [{ ...mockConversation, messages: [] }];
  }

  async getMessagesAsync(_chatId: number) {
    return [mockMessage];
  }
}

class MockContactsParser {
  private isOpen = false;

  open(_backupPath: string) {
    this.isOpen = true;
  }

  close() {
    this.isOpen = false;
  }

  getAllContacts() {
    return [mockContact];
  }

  lookupByHandle(handle: string) {
    if (handle === "+15555550112") {
      return { contact: mockContact, matchType: "phone" as const };
    }
    return { contact: null, matchType: null };
  }
}

// Create mock instances
const mockBackupService = new MockBackupService();
const mockDecryptionService = new MockBackupDecryptionService();
const mockDeviceService = new MockDeviceDetectionService();
const mockMessagesParser = new MockMessagesParser();
const mockContactsParser = new MockContactsParser();

// Mock @sentry/electron/main before any imports
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  setContext: jest.fn(),
  setTag: jest.fn(),
}));

// Mock appleDriverService to prevent real driver checks in tests
jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: jest.fn().mockResolvedValue({
    isInstalled: true,
    version: "12.0.0",
    serviceRunning: true,
    error: null,
  }),
  installAppleDrivers: jest.fn(),
  classifyInstallFailure: jest.fn(),
  reportInstallFailure: jest.fn(),
}));

// Mock better-sqlite3-multiple-ciphers before any imports
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

// Mock electron modules
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

// Mock check-disk-space
jest.mock("check-disk-space", () => {
  return jest.fn().mockResolvedValue({
    diskPath: "C:",
    free: 500 * 1024 * 1024 * 1024, // 500GB free
    size: 1000 * 1024 * 1024 * 1024, // 1TB total
  });
});

// Mock the service modules
jest.mock("../backupService", () => ({
  BackupService: jest.fn().mockImplementation(() => mockBackupService),
}));

jest.mock("../backupDecryptionService", () => ({
  BackupDecryptionService: jest.fn().mockImplementation(() => mockDecryptionService),
  backupDecryptionService: mockDecryptionService,
}));

jest.mock("../deviceDetectionService", () => ({
  DeviceDetectionService: jest.fn().mockImplementation(() => mockDeviceService),
  deviceDetectionService: mockDeviceService,
}));

jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: jest.fn().mockImplementation(() => mockMessagesParser),
}));

jest.mock("../iosContactsParser", () => ({
  iOSContactsParser: jest.fn().mockImplementation(() => mockContactsParser),
}));

// Now import the module under test
import {
  DeviceSyncOrchestrator,
  SyncPhase,
  SyncProgress,
} from "../deviceSyncOrchestrator";

// Enable mock mode for testing
process.env.MOCK_DEVICE = "true";

/**
 * NOTE: Skipped in CI - these tests use async operations with setTimeout
 * that cause Jest to hang even with --forceExit. The sync functionality is
 * tested locally and the services are validated by integration tests.
 *
 * TODO: Investigate proper timer cleanup or refactor mock implementations
 * to not rely on real timers.
 */
const skipInCI = process.env.CI ? describe.skip : describe;

skipInCI("DeviceSyncOrchestrator", () => {
  let orchestrator: DeviceSyncOrchestrator;

  beforeEach(() => {
    // Reset mock states
    mockBackupService.setMockBehavior(true, false);
    mockBackupService.removeAllListeners();
    mockDeviceService.removeAllListeners();

    // Create fresh orchestrator
    orchestrator = new DeviceSyncOrchestrator();
  });

  afterEach(() => {
    // Clean up orchestrator and listeners to prevent Jest from hanging
    orchestrator.stopDeviceDetection();
    orchestrator.removeAllListeners();
    mockBackupService.removeAllListeners();
    mockDeviceService.removeAllListeners();
  });

  describe("initialization", () => {
    it("should create an orchestrator instance", () => {
      expect(orchestrator).toBeDefined();
      expect(orchestrator.getStatus().isRunning).toBe(false);
      expect(orchestrator.getStatus().phase).toBe("idle");
    });

    it("should emit events", () => {
      expect(typeof orchestrator.on).toBe("function");
      expect(typeof orchestrator.emit).toBe("function");
    });

    it("should be an EventEmitter", () => {
      expect(orchestrator).toBeInstanceOf(EventEmitter);
    });
  });

  describe("getStatus", () => {
    it("should return initial status", () => {
      const status = orchestrator.getStatus();

      expect(status.isRunning).toBe(false);
      expect(status.phase).toBe("idle");
    });

    it("should return correct status structure", () => {
      const status = orchestrator.getStatus();

      expect(status).toHaveProperty("isRunning");
      expect(status).toHaveProperty("phase");
      expect(typeof status.isRunning).toBe("boolean");
      expect(typeof status.phase).toBe("string");
    });
  });

  describe("device detection", () => {
    it("should start device detection", () => {
      const startSpy = jest.fn();
      orchestrator.on("device-connected", startSpy);

      orchestrator.startDeviceDetection(5000);

      // Should not throw
      expect(orchestrator.getStatus().isRunning).toBe(false);
    });

    it("should stop device detection", () => {
      orchestrator.startDeviceDetection();
      orchestrator.stopDeviceDetection();

      // Should not throw
      expect(true).toBe(true);
    });

    it("should get connected devices as array", () => {
      const devices = orchestrator.getConnectedDevices();
      expect(Array.isArray(devices)).toBe(true);
    });
  });

  describe("sync operation", () => {
    it("should reject starting sync when already running", async () => {
      // Start a sync but don't await it
      const syncPromise = orchestrator.sync({ udid: "test-udid" });

      // Immediately try to start another sync
      const result = await orchestrator.sync({ udid: "test-udid-2" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("already in progress");

      // Clean up the first sync
      orchestrator.cancel();
      await syncPromise;
    });

    it("should emit progress events during sync", async () => {
      const progressEvents: SyncProgress[] = [];

      orchestrator.on("progress", (progress: SyncProgress) => {
        progressEvents.push(progress);
      });

      await orchestrator.sync({ udid: "mock-udid" });

      // Should have received progress events
      expect(progressEvents.length).toBeGreaterThan(0);
    });

    it("should emit phase change events", async () => {
      const phases: SyncPhase[] = [];

      orchestrator.on("phase", (phase: SyncPhase) => {
        phases.push(phase);
      });

      await orchestrator.sync({ udid: "mock-udid" });

      // Should have started with backup phase
      expect(phases.length).toBeGreaterThan(0);
      expect(phases[0]).toBe("backup");
    });

    it("should handle cancellation", async () => {
      const syncPromise = orchestrator.sync({ udid: "test-udid" });

      // Cancel immediately
      orchestrator.cancel();

      const result = await syncPromise;

      // Result should indicate cancellation
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error).toContain("cancelled");
    });

    it("should complete successfully with mock data", async () => {
      const result = await orchestrator.sync({ udid: "mock-udid" });

      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
      expect(Array.isArray(result.messages)).toBe(true);
      expect(Array.isArray(result.contacts)).toBe(true);
      expect(Array.isArray(result.conversations)).toBe(true);
      expect(typeof result.duration).toBe("number");
    });
  });

  describe("error handling", () => {
    it("should return error result on backup failure", async () => {
      mockBackupService.setMockBehavior(false, false);

      const result = await orchestrator.sync({ udid: "test-udid" });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.messages).toEqual([]);
      expect(result.contacts).toEqual([]);
      expect(result.conversations).toEqual([]);
    });

    it("should emit error events on failure", async () => {
      mockBackupService.setMockBehavior(false, false);

      const errorHandler = jest.fn();
      orchestrator.on("error", errorHandler);

      const result = await orchestrator.sync({ udid: "test-udid" });

      // Verify the result indicates failure
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should reset status after error", async () => {
      mockBackupService.setMockBehavior(false, false);

      const result = await orchestrator.sync({ udid: "test-udid" });

      // Verify result first
      expect(result.success).toBe(false);
      // Status should be reset after error result is returned
      const status = orchestrator.getStatus();
      expect(status.isRunning).toBe(false);
    });
  });

  describe("result structure", () => {
    it("should return proper result structure on success", async () => {
      const result = await orchestrator.sync({ udid: "mock-udid" });

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("messages");
      expect(result).toHaveProperty("contacts");
      expect(result).toHaveProperty("conversations");
      expect(result).toHaveProperty("error");
      expect(result).toHaveProperty("duration");

      expect(result.success).toBe(true);
      expect(Array.isArray(result.messages)).toBe(true);
      expect(Array.isArray(result.contacts)).toBe(true);
      expect(Array.isArray(result.conversations)).toBe(true);
      expect(typeof result.duration).toBe("number");
    });

    it("should return proper result structure on failure", async () => {
      mockBackupService.setMockBehavior(false, false);

      const result = await orchestrator.sync({ udid: "" });

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("messages");
      expect(result).toHaveProperty("contacts");
      expect(result).toHaveProperty("conversations");
      expect(result).toHaveProperty("error");
      expect(result).toHaveProperty("duration");

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe("encrypted backup handling", () => {
    it("should require password for encrypted backups", async () => {
      mockBackupService.setMockBehavior(true, true);

      const result = await orchestrator.sync({ udid: "mock-udid" });

      // Without password, should fail for encrypted backup
      expect(result.success).toBe(false);
      expect(result.error).toContain("Password required");
    });

    it("should accept password for encrypted backup", async () => {
      mockBackupService.setMockBehavior(true, true);

      const result = await orchestrator.sync({
        udid: "mock-udid",
        password: "test-password",
      });

      // With password, should succeed
      expect(result.success).toBe(true);
    });
  });

  describe("progress calculation", () => {
    it("should calculate overall progress correctly", async () => {
      const progressValues: number[] = [];

      orchestrator.on("progress", (progress: SyncProgress) => {
        progressValues.push(progress.overallProgress);
      });

      await orchestrator.sync({ udid: "mock-udid" });

      // Progress should be between 0 and 100
      for (const value of progressValues) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    });

    it("should include phase progress in events", async () => {
      const progressEvents: SyncProgress[] = [];

      orchestrator.on("progress", (progress: SyncProgress) => {
        progressEvents.push(progress);
      });

      await orchestrator.sync({ udid: "mock-udid" });

      // All progress events should have required properties
      for (const progress of progressEvents) {
        expect(progress).toHaveProperty("phase");
        expect(progress).toHaveProperty("phaseProgress");
        expect(progress).toHaveProperty("overallProgress");
        expect(progress).toHaveProperty("message");
      }
    });
  });

  describe("forceReset", () => {
    it("should reset sync state", async () => {
      // Start a sync
      const syncPromise = orchestrator.sync({ udid: "test-udid" });

      // Force reset
      orchestrator.forceReset();

      // Status should be reset
      const status = orchestrator.getStatus();
      expect(status.isRunning).toBe(false);
      expect(status.phase).toBe("idle");

      // Clean up
      await syncPromise;
    });
  });
});

describe("DeviceSyncOrchestrator E2E Flow", () => {
  let orchestrator: DeviceSyncOrchestrator;

  beforeEach(() => {
    mockBackupService.setMockBehavior(true, false);
    mockBackupService.removeAllListeners();
    mockDeviceService.removeAllListeners();
    orchestrator = new DeviceSyncOrchestrator();
  });

  afterEach(() => {
    orchestrator.stopDeviceDetection();
    orchestrator.removeAllListeners();
  });

  it("should complete full sync flow with mock device", async () => {
    const phases: SyncPhase[] = [];

    orchestrator.on("phase", (phase: SyncPhase) => {
      phases.push(phase);
    });

    const result = await orchestrator.sync({
      udid: "00000000-0000000000000000",
    });

    expect(result.success).toBe(true);
    // Verify phases were visited
    expect(phases).toContain("backup");
    expect(phases).toContain("parsing-contacts");
    expect(phases).toContain("parsing-messages");
    expect(phases).toContain("resolving");
    expect(phases).toContain("cleanup");
    expect(phases).toContain("complete");
  });

  it("should handle device disconnection during sync", async () => {
    let disconnectionHandled = false;

    orchestrator.on("device-disconnected", () => {
      disconnectionHandled = true;
      orchestrator.cancel();
    });

    // Start sync
    const syncPromise = orchestrator.sync({ udid: "mock-udid" });

    // Simulate disconnection
    mockDeviceService.emit("device-disconnected", mockDevice);

    const result = await syncPromise;

    // Either completed or was cancelled
    expect(result).toBeDefined();
  });

  it("should clean up resources on completion", async () => {
    await orchestrator.sync({ udid: "mock-udid" });

    // Verify status is reset
    const status = orchestrator.getStatus();
    expect(status.isRunning).toBe(false);
  });

  it("should emit complete event with result", async () => {
    const completeHandler = jest.fn();
    orchestrator.on("complete", completeHandler);

    const result = await orchestrator.sync({ udid: "mock-udid" });

    expect(result.success).toBe(true);
    expect(completeHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        messages: expect.any(Array),
        contacts: expect.any(Array),
        conversations: expect.any(Array),
      })
    );
  });
});

describe("DeviceSyncOrchestrator Skip Logic (TASK-908)", () => {
  let orchestrator: DeviceSyncOrchestrator;

  beforeEach(() => {
    mockBackupService.setMockBehavior(true, false);
    mockBackupService.removeAllListeners();
    mockDeviceService.removeAllListeners();
    orchestrator = new DeviceSyncOrchestrator();
  });

  afterEach(() => {
    orchestrator.stopDeviceDetection();
    orchestrator.removeAllListeners();
  });

  describe("shouldProcessBackup", () => {
    it("should return true when no previous sync recorded", async () => {
      // No previous sync, so should always process
      const result = await orchestrator.shouldProcessBackup("/some/backup/path");
      expect(result).toBe(true);
    });

    it("should return true when metadata cannot be retrieved", async () => {
      // Backup service will return null for non-existent path
      const result = await orchestrator.shouldProcessBackup("/nonexistent/path");
      expect(result).toBe(true);
    });
  });

  describe("recordBackupSync", () => {
    it("should record sync metadata", () => {
      const backupPath = "/test/backup/path";
      const manifestHash = "a".repeat(64);

      // Should not throw
      expect(() => {
        orchestrator.recordBackupSync(backupPath, manifestHash);
      }).not.toThrow();
    });
  });

  describe("clearLastBackupSync", () => {
    it("should clear recorded sync", () => {
      // Record a sync
      orchestrator.recordBackupSync("/test/path", "hash123");

      // Clear it
      expect(() => {
        orchestrator.clearLastBackupSync();
      }).not.toThrow();
    });
  });

  describe("SyncResult skipped field", () => {
    it("should have skipped field in result type", () => {
      // Type check: result should allow skipped and skipReason fields
      const mockResult = {
        success: true,
        messages: [],
        contacts: [],
        conversations: [],
        error: null,
        duration: 100,
        skipped: true,
        skipReason: "unchanged" as const,
      };

      expect(mockResult.skipped).toBe(true);
      expect(mockResult.skipReason).toBe("unchanged");
    });
  });
});
