/**
 * DeviceService Tests
 *
 * TASK-1020: Comprehensive unit tests for deviceService.ts
 *
 * Mock Pattern for Service Layer Tests:
 * =====================================
 * 1. Mock window.api at module level using Object.defineProperty
 * 2. Create individual mock functions for each API method
 * 3. Reset all mocks in beforeEach with jest.clearAllMocks()
 * 4. Configure mock return values per test case
 * 5. Test both success and error paths for each method
 *
 * This service covers 4 API domains:
 * - window.api.device (device detection - 5 methods + 2 event handlers)
 * - window.api.backup (backup operations - 12 methods + 3 event handlers)
 * - window.api.drivers (driver management - 4 methods)
 * - window.api.sync (iPhone sync - 10 methods + 9 event handlers)
 *
 * Key Testing Strategies:
 * - Each method checks if API exists first (API availability guards)
 * - Test BOTH scenarios: API available and API not available
 * - Event handlers return unsubscribe functions or no-op () => {}
 */

import { deviceService } from "../deviceService";
import type {
  Device,
  BackupCapabilities,
  BackupProgress,
  BackupStatus,
  BackupResult,
  BackupListEntry,
  AppleDriverStatus,
  SyncResult,
  SyncStatus,
} from "../deviceService";

// ============================================
// MOCK SETUP - DEVICE API
// ============================================
const mockDeviceList = jest.fn();
const mockDeviceStartDetection = jest.fn();
const mockDeviceStopDetection = jest.fn();
const mockDeviceCheckAvailability = jest.fn();
const mockDeviceOnConnected = jest.fn();
const mockDeviceOnDisconnected = jest.fn();

// ============================================
// MOCK SETUP - BACKUP API
// ============================================
const mockBackupGetCapabilities = jest.fn();
const mockBackupGetStatus = jest.fn();
const mockBackupStart = jest.fn();
const mockBackupStartWithPassword = jest.fn();
const mockBackupCancel = jest.fn();
const mockBackupList = jest.fn();
const mockBackupDelete = jest.fn();
const mockBackupCleanup = jest.fn();
const mockBackupCheckEncryption = jest.fn();
const mockBackupVerifyPassword = jest.fn();
const mockBackupIsEncrypted = jest.fn();
const mockBackupOnProgress = jest.fn();
const mockBackupOnComplete = jest.fn();
const mockBackupOnError = jest.fn();

// ============================================
// MOCK SETUP - DRIVERS API
// ============================================
const mockDriversCheckApple = jest.fn();
const mockDriversHasBundled = jest.fn();
const mockDriversInstallApple = jest.fn();
const mockDriversOpenITunesStore = jest.fn();

// ============================================
// MOCK SETUP - SYNC API
// ============================================
const mockSyncStart = jest.fn();
const mockSyncCancel = jest.fn();
const mockSyncStatus = jest.fn();
const mockSyncDevices = jest.fn();
const mockSyncStartDetection = jest.fn();
const mockSyncStopDetection = jest.fn();
const mockSyncOnProgress = jest.fn();
const mockSyncOnPhase = jest.fn();
const mockSyncOnDeviceConnected = jest.fn();
const mockSyncOnDeviceDisconnected = jest.fn();
const mockSyncOnPasswordRequired = jest.fn();
const mockSyncOnError = jest.fn();
const mockSyncOnComplete = jest.fn();
const mockSyncOnWaitingForPasscode = jest.fn();
const mockSyncOnPasscodeEntered = jest.fn();

// Helper to set up full API mock
function setupFullApiMock() {
  Object.defineProperty(window, "api", {
    value: {
      device: {
        list: mockDeviceList,
        startDetection: mockDeviceStartDetection,
        stopDetection: mockDeviceStopDetection,
        checkAvailability: mockDeviceCheckAvailability,
        onConnected: mockDeviceOnConnected,
        onDisconnected: mockDeviceOnDisconnected,
      },
      backup: {
        getCapabilities: mockBackupGetCapabilities,
        getStatus: mockBackupGetStatus,
        start: mockBackupStart,
        startWithPassword: mockBackupStartWithPassword,
        cancel: mockBackupCancel,
        list: mockBackupList,
        delete: mockBackupDelete,
        cleanup: mockBackupCleanup,
        checkEncryption: mockBackupCheckEncryption,
        verifyPassword: mockBackupVerifyPassword,
        isEncrypted: mockBackupIsEncrypted,
        onProgress: mockBackupOnProgress,
        onComplete: mockBackupOnComplete,
        onError: mockBackupOnError,
      },
      drivers: {
        checkApple: mockDriversCheckApple,
        hasBundled: mockDriversHasBundled,
        installApple: mockDriversInstallApple,
        openITunesStore: mockDriversOpenITunesStore,
      },
      sync: {
        start: mockSyncStart,
        cancel: mockSyncCancel,
        status: mockSyncStatus,
        devices: mockSyncDevices,
        startDetection: mockSyncStartDetection,
        stopDetection: mockSyncStopDetection,
        onProgress: mockSyncOnProgress,
        onPhase: mockSyncOnPhase,
        onDeviceConnected: mockSyncOnDeviceConnected,
        onDeviceDisconnected: mockSyncOnDeviceDisconnected,
        onPasswordRequired: mockSyncOnPasswordRequired,
        onError: mockSyncOnError,
        onComplete: mockSyncOnComplete,
        onWaitingForPasscode: mockSyncOnWaitingForPasscode,
        onPasscodeEntered: mockSyncOnPasscodeEntered,
      },
    },
    writable: true,
    configurable: true,
  });
}

// Helper to remove specific API domain
function removeApiDomain(domain: "device" | "backup" | "drivers" | "sync") {
  const currentApi = (window as unknown as { api: Record<string, unknown> }).api;
  Object.defineProperty(window, "api", {
    value: {
      ...currentApi,
      [domain]: undefined,
    },
    writable: true,
    configurable: true,
  });
}

// Setup full API mock before all tests
beforeAll(() => {
  setupFullApiMock();
});

// Reset all mocks and restore full API before each test
beforeEach(() => {
  jest.clearAllMocks();
  setupFullApiMock();
});

// ============================================
// TEST FIXTURES
// ============================================

const mockDevice: Device = {
  udid: "device-udid-123",
  name: "Test iPhone",
  productType: "iPhone14,2",
  productVersion: "17.0",
  serialNumber: "SERIAL123",
  isConnected: true,
};

const mockBackupCapabilities: BackupCapabilities = {
  supportsDomainFiltering: true,
  supportsIncremental: true,
  supportsEncryption: true,
  availableDomains: ["HomeDomain", "CameraRollDomain", "MediaDomain"],
};

const mockBackupProgress: BackupProgress = {
  phase: "transferring",
  percentComplete: 45,
  currentFile: "Photos/IMG_001.jpg",
  filesTransferred: 150,
  totalFiles: 500,
  bytesTransferred: 1024000,
  totalBytes: 5120000,
  estimatedTimeRemaining: 120,
};

const mockBackupStatus: BackupStatus = {
  isRunning: true,
  currentDeviceUdid: "device-udid-123",
  progress: mockBackupProgress,
};

const mockBackupResult: BackupResult = {
  backupPath: "/backups/device-udid-123/2024-01-01",
  duration: 300,
  deviceUdid: "device-udid-123",
  isIncremental: false,
  backupSize: 5120000,
};

const mockBackupListEntry: BackupListEntry = {
  path: "/backups/device-udid-123/2024-01-01",
  deviceUdid: "device-udid-123",
  createdAt: new Date("2024-01-01T00:00:00Z"),
  size: 5120000,
  isEncrypted: false,
  iosVersion: "17.0",
  deviceName: "Test iPhone",
};

const mockAppleDriverStatus: AppleDriverStatus = {
  isInstalled: true,
  version: "12.0.0.0",
  serviceRunning: true,
  error: null,
};

const mockSyncResult: SyncResult = {
  messages: [{ id: "msg1" }, { id: "msg2" }],
  contacts: [{ id: "contact1" }],
  conversations: [{ id: "conv1" }],
  duration: 60,
};

const mockSyncStatusData: SyncStatus = {
  isRunning: true,
  phase: "extracting",
};

// ============================================
// DEVICE DETECTION TESTS
// ============================================

describe("deviceService", () => {
  describe("Device Detection Methods", () => {
    describe("listDevices", () => {
      it("should return list of devices on success", async () => {
        mockDeviceList.mockResolvedValue({
          success: true,
          devices: [mockDevice],
        });

        const result = await deviceService.listDevices();

        expect(result.success).toBe(true);
        expect(result.data).toEqual([mockDevice]);
        expect(mockDeviceList).toHaveBeenCalledTimes(1);
      });

      it("should return empty array when no devices", async () => {
        mockDeviceList.mockResolvedValue({
          success: true,
          devices: [],
        });

        const result = await deviceService.listDevices();

        expect(result.success).toBe(true);
        expect(result.data).toEqual([]);
      });

      it("should return empty array when devices is undefined", async () => {
        mockDeviceList.mockResolvedValue({
          success: true,
        });

        const result = await deviceService.listDevices();

        expect(result.success).toBe(true);
        expect(result.data).toEqual([]);
      });

      it("should return error when API returns failure", async () => {
        mockDeviceList.mockResolvedValue({
          success: false,
          error: "Device detection failed",
        });

        const result = await deviceService.listDevices();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Device detection failed");
      });

      it("should catch and return error when API throws exception", async () => {
        mockDeviceList.mockRejectedValue(new Error("USB connection error"));

        const result = await deviceService.listDevices();

        expect(result.success).toBe(false);
        expect(result.error).toBe("USB connection error");
      });

      it("should return error when device API is not available", async () => {
        removeApiDomain("device");

        const result = await deviceService.listDevices();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Device API not available");
      });
    });

    describe("startDetection", () => {
      it("should start detection successfully", async () => {
        mockDeviceStartDetection.mockResolvedValue({ success: true });

        const result = await deviceService.startDetection();

        expect(result.success).toBe(true);
        expect(mockDeviceStartDetection).toHaveBeenCalledTimes(1);
      });

      it("should return error when API returns failure", async () => {
        mockDeviceStartDetection.mockResolvedValue({
          success: false,
          error: "Detection already running",
        });

        const result = await deviceService.startDetection();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Detection already running");
      });

      it("should catch and return error when API throws exception", async () => {
        mockDeviceStartDetection.mockRejectedValue(new Error("USB init failed"));

        const result = await deviceService.startDetection();

        expect(result.success).toBe(false);
        expect(result.error).toBe("USB init failed");
      });

      it("should return error when device API is not available", async () => {
        removeApiDomain("device");

        const result = await deviceService.startDetection();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Device API not available");
      });
    });

    describe("stopDetection", () => {
      it("should stop detection successfully", async () => {
        mockDeviceStopDetection.mockResolvedValue({ success: true });

        const result = await deviceService.stopDetection();

        expect(result.success).toBe(true);
        expect(mockDeviceStopDetection).toHaveBeenCalledTimes(1);
      });

      it("should return error when API returns failure", async () => {
        mockDeviceStopDetection.mockResolvedValue({
          success: false,
          error: "Detection not running",
        });

        const result = await deviceService.stopDetection();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Detection not running");
      });

      it("should catch and return error when API throws exception", async () => {
        mockDeviceStopDetection.mockRejectedValue(new Error("Stop failed"));

        const result = await deviceService.stopDetection();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Stop failed");
      });

      it("should return error when device API is not available", async () => {
        removeApiDomain("device");

        const result = await deviceService.stopDetection();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Device API not available");
      });
    });

    describe("checkAvailability", () => {
      it("should return available true when device detection is available", async () => {
        mockDeviceCheckAvailability.mockResolvedValue({
          success: true,
          available: true,
        });

        const result = await deviceService.checkAvailability();

        expect(result.success).toBe(true);
        expect(result.data?.available).toBe(true);
      });

      it("should return available false when device detection is not available", async () => {
        mockDeviceCheckAvailability.mockResolvedValue({
          success: true,
          available: false,
        });

        const result = await deviceService.checkAvailability();

        expect(result.success).toBe(true);
        expect(result.data?.available).toBe(false);
      });

      it("should return available false when available is undefined", async () => {
        mockDeviceCheckAvailability.mockResolvedValue({
          success: true,
        });

        const result = await deviceService.checkAvailability();

        expect(result.success).toBe(true);
        expect(result.data?.available).toBe(false);
      });

      it("should return error when API returns failure", async () => {
        mockDeviceCheckAvailability.mockResolvedValue({
          success: false,
          error: "Platform not supported",
        });

        const result = await deviceService.checkAvailability();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Platform not supported");
      });

      it("should catch and return error when API throws exception", async () => {
        mockDeviceCheckAvailability.mockRejectedValue(new Error("Check failed"));

        const result = await deviceService.checkAvailability();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Check failed");
      });

      it("should return available false when device API is not available", async () => {
        removeApiDomain("device");

        const result = await deviceService.checkAvailability();

        expect(result.success).toBe(true);
        expect(result.data?.available).toBe(false);
      });
    });

    describe("onDeviceConnected", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockDeviceOnConnected.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onDeviceConnected(callback);

        expect(mockDeviceOnConnected).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when device API is not available", () => {
        removeApiDomain("device");
        const callback = jest.fn();

        const unsubscribe = deviceService.onDeviceConnected(callback);

        expect(typeof unsubscribe).toBe("function");
        // Should not throw when called
        unsubscribe();
      });
    });

    describe("onDeviceDisconnected", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockDeviceOnDisconnected.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onDeviceDisconnected(callback);

        expect(mockDeviceOnDisconnected).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when device API is not available", () => {
        removeApiDomain("device");
        const callback = jest.fn();

        const unsubscribe = deviceService.onDeviceDisconnected(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });
  });

  // ============================================
  // BACKUP METHODS TESTS
  // ============================================

  describe("Backup Methods", () => {
    describe("getBackupCapabilities", () => {
      it("should return backup capabilities on success", async () => {
        mockBackupGetCapabilities.mockResolvedValue(mockBackupCapabilities);

        const result = await deviceService.getBackupCapabilities();

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockBackupCapabilities);
      });

      it("should catch and return error when API throws exception", async () => {
        mockBackupGetCapabilities.mockRejectedValue(new Error("Capabilities check failed"));

        const result = await deviceService.getBackupCapabilities();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Capabilities check failed");
      });

      it("should return error when backup API is not available", async () => {
        removeApiDomain("backup");

        const result = await deviceService.getBackupCapabilities();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup API not available");
      });
    });

    describe("getBackupStatus", () => {
      it("should return backup status on success", async () => {
        mockBackupGetStatus.mockResolvedValue(mockBackupStatus);

        const result = await deviceService.getBackupStatus();

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockBackupStatus);
      });

      it("should catch and return error when API throws exception", async () => {
        mockBackupGetStatus.mockRejectedValue(new Error("Status check failed"));

        const result = await deviceService.getBackupStatus();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Status check failed");
      });

      it("should return error when backup API is not available", async () => {
        removeApiDomain("backup");

        const result = await deviceService.getBackupStatus();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup API not available");
      });
    });

    describe("startBackup", () => {
      const backupOptions = { udid: "device-udid-123" };

      it("should start backup and return result on success", async () => {
        mockBackupStart.mockResolvedValue({
          success: true,
          ...mockBackupResult,
        });

        const result = await deviceService.startBackup(backupOptions);

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockBackupResult);
        expect(mockBackupStart).toHaveBeenCalledWith(backupOptions);
      });

      it("should pass all options to API", async () => {
        const fullOptions = {
          udid: "device-udid-123",
          outputDir: "/custom/path",
          forceFullBackup: true,
        };
        mockBackupStart.mockResolvedValue({
          success: true,
          ...mockBackupResult,
        });

        await deviceService.startBackup(fullOptions);

        expect(mockBackupStart).toHaveBeenCalledWith(fullOptions);
      });

      it("should return error when API returns failure", async () => {
        mockBackupStart.mockResolvedValue({
          success: false,
          error: "Device locked",
        });

        const result = await deviceService.startBackup(backupOptions);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Device locked");
      });

      it("should return 'Backup failed' when success but error is undefined", async () => {
        mockBackupStart.mockResolvedValue({
          success: false,
        });

        const result = await deviceService.startBackup(backupOptions);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup failed");
      });

      it("should catch and return error when API throws exception", async () => {
        mockBackupStart.mockRejectedValue(new Error("Disk full"));

        const result = await deviceService.startBackup(backupOptions);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Disk full");
      });

      it("should return error when backup API is not available", async () => {
        removeApiDomain("backup");

        const result = await deviceService.startBackup(backupOptions);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup API not available");
      });
    });

    describe("startBackupWithPassword", () => {
      const passwordOptions = {
        udid: "device-udid-123",
        password: "backup-password",
      };

      it("should start encrypted backup on success", async () => {
        mockBackupStartWithPassword.mockResolvedValue({
          success: true,
          backupPath: "/backups/encrypted/2024-01-01",
        });

        const result = await deviceService.startBackupWithPassword(passwordOptions);

        expect(result.success).toBe(true);
        expect(result.data?.backupPath).toBe("/backups/encrypted/2024-01-01");
        expect(mockBackupStartWithPassword).toHaveBeenCalledWith(passwordOptions);
      });

      it("should return error when API returns failure", async () => {
        mockBackupStartWithPassword.mockResolvedValue({
          success: false,
          error: "Invalid password",
        });

        const result = await deviceService.startBackupWithPassword(passwordOptions);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Invalid password");
      });

      it("should catch and return error when API throws exception", async () => {
        mockBackupStartWithPassword.mockRejectedValue(new Error("Encryption failed"));

        const result = await deviceService.startBackupWithPassword(passwordOptions);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Encryption failed");
      });

      it("should return error when backup API is not available", async () => {
        removeApiDomain("backup");

        const result = await deviceService.startBackupWithPassword(passwordOptions);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup API not available");
      });
    });

    describe("cancelBackup", () => {
      it("should cancel backup successfully", async () => {
        mockBackupCancel.mockResolvedValue({ success: true });

        const result = await deviceService.cancelBackup();

        expect(result.success).toBe(true);
      });

      it("should catch and return error when API throws exception", async () => {
        mockBackupCancel.mockRejectedValue(new Error("Cancel failed"));

        const result = await deviceService.cancelBackup();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Cancel failed");
      });

      it("should return error when backup API is not available", async () => {
        removeApiDomain("backup");

        const result = await deviceService.cancelBackup();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup API not available");
      });
    });

    describe("listBackups", () => {
      it("should return list of backups on success", async () => {
        mockBackupList.mockResolvedValue([mockBackupListEntry]);

        const result = await deviceService.listBackups();

        expect(result.success).toBe(true);
        expect(result.data).toEqual([mockBackupListEntry]);
      });

      it("should return empty array when no backups", async () => {
        mockBackupList.mockResolvedValue([]);

        const result = await deviceService.listBackups();

        expect(result.success).toBe(true);
        expect(result.data).toEqual([]);
      });

      it("should catch and return error when API throws exception", async () => {
        mockBackupList.mockRejectedValue(new Error("List failed"));

        const result = await deviceService.listBackups();

        expect(result.success).toBe(false);
        expect(result.error).toBe("List failed");
      });

      it("should return error when backup API is not available", async () => {
        removeApiDomain("backup");

        const result = await deviceService.listBackups();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup API not available");
      });
    });

    describe("deleteBackup", () => {
      it("should delete backup successfully", async () => {
        mockBackupDelete.mockResolvedValue({ success: true });

        const result = await deviceService.deleteBackup("/backups/old");

        expect(result.success).toBe(true);
        expect(mockBackupDelete).toHaveBeenCalledWith("/backups/old");
      });

      it("should return error when API returns failure", async () => {
        mockBackupDelete.mockResolvedValue({
          success: false,
          error: "Backup not found",
        });

        const result = await deviceService.deleteBackup("/backups/nonexistent");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup not found");
      });

      it("should catch and return error when API throws exception", async () => {
        mockBackupDelete.mockRejectedValue(new Error("Delete failed"));

        const result = await deviceService.deleteBackup("/backups/old");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Delete failed");
      });

      it("should return error when backup API is not available", async () => {
        removeApiDomain("backup");

        const result = await deviceService.deleteBackup("/backups/old");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup API not available");
      });
    });

    describe("cleanupBackups", () => {
      it("should cleanup backups with default keep count", async () => {
        mockBackupCleanup.mockResolvedValue({ success: true });

        const result = await deviceService.cleanupBackups();

        expect(result.success).toBe(true);
        expect(mockBackupCleanup).toHaveBeenCalledWith(undefined);
      });

      it("should cleanup backups with specified keep count", async () => {
        mockBackupCleanup.mockResolvedValue({ success: true });

        const result = await deviceService.cleanupBackups(3);

        expect(result.success).toBe(true);
        expect(mockBackupCleanup).toHaveBeenCalledWith(3);
      });

      it("should return error when API returns failure", async () => {
        mockBackupCleanup.mockResolvedValue({
          success: false,
          error: "Cleanup failed",
        });

        const result = await deviceService.cleanupBackups();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Cleanup failed");
      });

      it("should catch and return error when API throws exception", async () => {
        mockBackupCleanup.mockRejectedValue(new Error("Cleanup error"));

        const result = await deviceService.cleanupBackups();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Cleanup error");
      });

      it("should return error when backup API is not available", async () => {
        removeApiDomain("backup");

        const result = await deviceService.cleanupBackups();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup API not available");
      });
    });

    describe("checkBackupEncryption", () => {
      it("should return encryption status on success", async () => {
        mockBackupCheckEncryption.mockResolvedValue({
          success: true,
          isEncrypted: true,
          needsPassword: true,
        });

        const result = await deviceService.checkBackupEncryption("device-udid-123");

        expect(result.success).toBe(true);
        expect(result.data?.isEncrypted).toBe(true);
        expect(result.data?.needsPassword).toBe(true);
      });

      it("should return error when API returns failure", async () => {
        mockBackupCheckEncryption.mockResolvedValue({
          success: false,
          error: "Device not found",
        });

        const result = await deviceService.checkBackupEncryption("invalid-udid");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Device not found");
      });

      it("should catch and return error when API throws exception", async () => {
        mockBackupCheckEncryption.mockRejectedValue(new Error("Check failed"));

        const result = await deviceService.checkBackupEncryption("device-udid-123");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Check failed");
      });

      it("should return error when backup API is not available", async () => {
        removeApiDomain("backup");

        const result = await deviceService.checkBackupEncryption("device-udid-123");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup API not available");
      });
    });

    describe("verifyBackupPassword", () => {
      it("should verify password successfully", async () => {
        mockBackupVerifyPassword.mockResolvedValue({
          success: true,
          valid: true,
        });

        const result = await deviceService.verifyBackupPassword("/backups/encrypted", "password");

        expect(result.success).toBe(true);
        expect(result.data?.valid).toBe(true);
        expect(mockBackupVerifyPassword).toHaveBeenCalledWith("/backups/encrypted", "password");
      });

      it("should return valid false for incorrect password", async () => {
        mockBackupVerifyPassword.mockResolvedValue({
          success: true,
          valid: false,
        });

        const result = await deviceService.verifyBackupPassword("/backups/encrypted", "wrong");

        expect(result.success).toBe(true);
        expect(result.data?.valid).toBe(false);
      });

      it("should return error when API returns failure", async () => {
        mockBackupVerifyPassword.mockResolvedValue({
          success: false,
          error: "Backup not found",
        });

        const result = await deviceService.verifyBackupPassword("/invalid/path", "password");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup not found");
      });

      it("should catch and return error when API throws exception", async () => {
        mockBackupVerifyPassword.mockRejectedValue(new Error("Verify failed"));

        const result = await deviceService.verifyBackupPassword("/backups/encrypted", "password");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Verify failed");
      });

      it("should return error when backup API is not available", async () => {
        removeApiDomain("backup");

        const result = await deviceService.verifyBackupPassword("/backups/encrypted", "password");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup API not available");
      });
    });

    describe("isBackupEncrypted", () => {
      it("should return encrypted true for encrypted backup", async () => {
        mockBackupIsEncrypted.mockResolvedValue({
          success: true,
          isEncrypted: true,
        });

        const result = await deviceService.isBackupEncrypted("/backups/encrypted");

        expect(result.success).toBe(true);
        expect(result.data?.isEncrypted).toBe(true);
      });

      it("should return encrypted false for unencrypted backup", async () => {
        mockBackupIsEncrypted.mockResolvedValue({
          success: true,
          isEncrypted: false,
        });

        const result = await deviceService.isBackupEncrypted("/backups/plain");

        expect(result.success).toBe(true);
        expect(result.data?.isEncrypted).toBe(false);
      });

      it("should return error when API returns failure", async () => {
        mockBackupIsEncrypted.mockResolvedValue({
          success: false,
          error: "Backup not found",
        });

        const result = await deviceService.isBackupEncrypted("/invalid/path");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup not found");
      });

      it("should catch and return error when API throws exception", async () => {
        mockBackupIsEncrypted.mockRejectedValue(new Error("Check failed"));

        const result = await deviceService.isBackupEncrypted("/backups/encrypted");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Check failed");
      });

      it("should return error when backup API is not available", async () => {
        removeApiDomain("backup");

        const result = await deviceService.isBackupEncrypted("/backups/encrypted");

        expect(result.success).toBe(false);
        expect(result.error).toBe("Backup API not available");
      });
    });

    describe("onBackupProgress", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockBackupOnProgress.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onBackupProgress(callback);

        expect(mockBackupOnProgress).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when backup API is not available", () => {
        removeApiDomain("backup");
        const callback = jest.fn();

        const unsubscribe = deviceService.onBackupProgress(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });

    describe("onBackupComplete", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockBackupOnComplete.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onBackupComplete(callback);

        expect(mockBackupOnComplete).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when backup API is not available", () => {
        removeApiDomain("backup");
        const callback = jest.fn();

        const unsubscribe = deviceService.onBackupComplete(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });

    describe("onBackupError", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockBackupOnError.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onBackupError(callback);

        expect(mockBackupOnError).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when backup API is not available", () => {
        removeApiDomain("backup");
        const callback = jest.fn();

        const unsubscribe = deviceService.onBackupError(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });
  });

  // ============================================
  // DRIVER METHODS TESTS
  // ============================================

  describe("Driver Methods", () => {
    describe("checkAppleDriver", () => {
      it("should return driver status on success", async () => {
        mockDriversCheckApple.mockResolvedValue(mockAppleDriverStatus);

        const result = await deviceService.checkAppleDriver();

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockAppleDriverStatus);
      });

      it("should handle driver not installed", async () => {
        const notInstalledStatus = {
          isInstalled: false,
          version: null,
          serviceRunning: false,
          error: null,
        };
        mockDriversCheckApple.mockResolvedValue(notInstalledStatus);

        const result = await deviceService.checkAppleDriver();

        expect(result.success).toBe(true);
        expect(result.data?.isInstalled).toBe(false);
      });

      it("should catch and return error when API throws exception", async () => {
        mockDriversCheckApple.mockRejectedValue(new Error("Driver check failed"));

        const result = await deviceService.checkAppleDriver();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Driver check failed");
      });

      it("should return error when drivers API is not available", async () => {
        removeApiDomain("drivers");

        const result = await deviceService.checkAppleDriver();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Drivers API not available");
      });
    });

    describe("hasBundledDrivers", () => {
      it("should return available true when bundled drivers exist", async () => {
        mockDriversHasBundled.mockResolvedValue({ available: true });

        const result = await deviceService.hasBundledDrivers();

        expect(result.success).toBe(true);
        expect(result.data?.available).toBe(true);
      });

      it("should return available false when no bundled drivers", async () => {
        mockDriversHasBundled.mockResolvedValue({ available: false });

        const result = await deviceService.hasBundledDrivers();

        expect(result.success).toBe(true);
        expect(result.data?.available).toBe(false);
      });

      it("should catch and return error when API throws exception", async () => {
        mockDriversHasBundled.mockRejectedValue(new Error("Check failed"));

        const result = await deviceService.hasBundledDrivers();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Check failed");
      });

      it("should return error when drivers API is not available", async () => {
        removeApiDomain("drivers");

        const result = await deviceService.hasBundledDrivers();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Drivers API not available");
      });
    });

    describe("installAppleDriver", () => {
      it("should install driver and return result on success", async () => {
        mockDriversInstallApple.mockResolvedValue({
          success: true,
          rebootRequired: true,
        });

        const result = await deviceService.installAppleDriver();

        expect(result.success).toBe(true);
        expect(result.data?.rebootRequired).toBe(true);
      });

      it("should return reboot not required when applicable", async () => {
        mockDriversInstallApple.mockResolvedValue({
          success: true,
          rebootRequired: false,
        });

        const result = await deviceService.installAppleDriver();

        expect(result.success).toBe(true);
        expect(result.data?.rebootRequired).toBe(false);
      });

      it("should return error when API returns failure", async () => {
        mockDriversInstallApple.mockResolvedValue({
          success: false,
          error: "Admin rights required",
        });

        const result = await deviceService.installAppleDriver();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Admin rights required");
      });

      it("should return 'Driver installation failed' when error is undefined", async () => {
        mockDriversInstallApple.mockResolvedValue({
          success: false,
        });

        const result = await deviceService.installAppleDriver();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Driver installation failed");
      });

      it("should catch and return error when API throws exception", async () => {
        mockDriversInstallApple.mockRejectedValue(new Error("Install failed"));

        const result = await deviceService.installAppleDriver();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Install failed");
      });

      it("should return error when drivers API is not available", async () => {
        removeApiDomain("drivers");

        const result = await deviceService.installAppleDriver();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Drivers API not available");
      });
    });

    describe("openITunesStore", () => {
      it("should open iTunes store successfully", async () => {
        mockDriversOpenITunesStore.mockResolvedValue({ success: true });

        const result = await deviceService.openITunesStore();

        expect(result.success).toBe(true);
      });

      it("should return error when API returns failure", async () => {
        mockDriversOpenITunesStore.mockResolvedValue({
          success: false,
          error: "Store unavailable",
        });

        const result = await deviceService.openITunesStore();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Store unavailable");
      });

      it("should catch and return error when API throws exception", async () => {
        mockDriversOpenITunesStore.mockRejectedValue(new Error("Open failed"));

        const result = await deviceService.openITunesStore();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Open failed");
      });

      it("should return error when drivers API is not available", async () => {
        removeApiDomain("drivers");

        const result = await deviceService.openITunesStore();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Drivers API not available");
      });
    });
  });

  // ============================================
  // SYNC METHODS TESTS
  // ============================================

  describe("Sync Methods", () => {
    describe("startSync", () => {
      const syncOptions = { udid: "device-udid-123" };

      it("should start sync and return result on success", async () => {
        mockSyncStart.mockResolvedValue({
          success: true,
          ...mockSyncResult,
        });

        const result = await deviceService.startSync(syncOptions);

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockSyncResult);
        expect(mockSyncStart).toHaveBeenCalledWith(syncOptions);
      });

      it("should pass all options to API", async () => {
        const fullOptions = {
          udid: "device-udid-123",
          password: "backup-password",
          forceFullBackup: true,
        };
        mockSyncStart.mockResolvedValue({
          success: true,
          ...mockSyncResult,
        });

        await deviceService.startSync(fullOptions);

        expect(mockSyncStart).toHaveBeenCalledWith(fullOptions);
      });

      it("should return error when API returns failure", async () => {
        mockSyncStart.mockResolvedValue({
          success: false,
          error: "Device locked",
        });

        const result = await deviceService.startSync(syncOptions);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Device locked");
      });

      it("should return 'Sync failed' when error is undefined", async () => {
        mockSyncStart.mockResolvedValue({
          success: false,
        });

        const result = await deviceService.startSync(syncOptions);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Sync failed");
      });

      it("should catch and return error when API throws exception", async () => {
        mockSyncStart.mockRejectedValue(new Error("Sync error"));

        const result = await deviceService.startSync(syncOptions);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Sync error");
      });

      it("should return error when sync API is not available", async () => {
        removeApiDomain("sync");

        const result = await deviceService.startSync(syncOptions);

        expect(result.success).toBe(false);
        expect(result.error).toBe("Sync API not available");
      });
    });

    describe("cancelSync", () => {
      it("should cancel sync successfully", async () => {
        mockSyncCancel.mockResolvedValue({ success: true });

        const result = await deviceService.cancelSync();

        expect(result.success).toBe(true);
      });

      it("should catch and return error when API throws exception", async () => {
        mockSyncCancel.mockRejectedValue(new Error("Cancel failed"));

        const result = await deviceService.cancelSync();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Cancel failed");
      });

      it("should return error when sync API is not available", async () => {
        removeApiDomain("sync");

        const result = await deviceService.cancelSync();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Sync API not available");
      });
    });

    describe("getSyncStatus", () => {
      it("should return sync status on success", async () => {
        mockSyncStatus.mockResolvedValue(mockSyncStatusData);

        const result = await deviceService.getSyncStatus();

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockSyncStatusData);
      });

      it("should catch and return error when API throws exception", async () => {
        mockSyncStatus.mockRejectedValue(new Error("Status failed"));

        const result = await deviceService.getSyncStatus();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Status failed");
      });

      it("should return error when sync API is not available", async () => {
        removeApiDomain("sync");

        const result = await deviceService.getSyncStatus();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Sync API not available");
      });
    });

    describe("getSyncDevices", () => {
      it("should return list of devices on success", async () => {
        mockSyncDevices.mockResolvedValue([mockDevice]);

        const result = await deviceService.getSyncDevices();

        expect(result.success).toBe(true);
        expect(result.data).toEqual([mockDevice]);
      });

      it("should return empty array when no devices", async () => {
        mockSyncDevices.mockResolvedValue([]);

        const result = await deviceService.getSyncDevices();

        expect(result.success).toBe(true);
        expect(result.data).toEqual([]);
      });

      it("should catch and return error when API throws exception", async () => {
        mockSyncDevices.mockRejectedValue(new Error("Devices failed"));

        const result = await deviceService.getSyncDevices();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Devices failed");
      });

      it("should return error when sync API is not available", async () => {
        removeApiDomain("sync");

        const result = await deviceService.getSyncDevices();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Sync API not available");
      });
    });

    describe("startSyncDetection", () => {
      it("should start sync detection with default interval", async () => {
        mockSyncStartDetection.mockResolvedValue({ success: true });

        const result = await deviceService.startSyncDetection();

        expect(result.success).toBe(true);
        expect(mockSyncStartDetection).toHaveBeenCalledWith(undefined);
      });

      it("should start sync detection with custom interval", async () => {
        mockSyncStartDetection.mockResolvedValue({ success: true });

        const result = await deviceService.startSyncDetection(5000);

        expect(result.success).toBe(true);
        expect(mockSyncStartDetection).toHaveBeenCalledWith(5000);
      });

      it("should catch and return error when API throws exception", async () => {
        mockSyncStartDetection.mockRejectedValue(new Error("Start failed"));

        const result = await deviceService.startSyncDetection();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Start failed");
      });

      it("should return error when sync API is not available", async () => {
        removeApiDomain("sync");

        const result = await deviceService.startSyncDetection();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Sync API not available");
      });
    });

    describe("stopSyncDetection", () => {
      it("should stop sync detection successfully", async () => {
        mockSyncStopDetection.mockResolvedValue({ success: true });

        const result = await deviceService.stopSyncDetection();

        expect(result.success).toBe(true);
      });

      it("should catch and return error when API throws exception", async () => {
        mockSyncStopDetection.mockRejectedValue(new Error("Stop failed"));

        const result = await deviceService.stopSyncDetection();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Stop failed");
      });

      it("should return error when sync API is not available", async () => {
        removeApiDomain("sync");

        const result = await deviceService.stopSyncDetection();

        expect(result.success).toBe(false);
        expect(result.error).toBe("Sync API not available");
      });
    });

    // ============================================
    // SYNC EVENT HANDLERS TESTS
    // ============================================

    describe("onSyncProgress", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockSyncOnProgress.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onSyncProgress(callback);

        expect(mockSyncOnProgress).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when sync API is not available", () => {
        removeApiDomain("sync");
        const callback = jest.fn();

        const unsubscribe = deviceService.onSyncProgress(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });

    describe("onSyncPhase", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockSyncOnPhase.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onSyncPhase(callback);

        expect(mockSyncOnPhase).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when sync API is not available", () => {
        removeApiDomain("sync");
        const callback = jest.fn();

        const unsubscribe = deviceService.onSyncPhase(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });

    describe("onSyncDeviceConnected", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockSyncOnDeviceConnected.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onSyncDeviceConnected(callback);

        expect(mockSyncOnDeviceConnected).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when sync API is not available", () => {
        removeApiDomain("sync");
        const callback = jest.fn();

        const unsubscribe = deviceService.onSyncDeviceConnected(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });

    describe("onSyncDeviceDisconnected", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockSyncOnDeviceDisconnected.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onSyncDeviceDisconnected(callback);

        expect(mockSyncOnDeviceDisconnected).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when sync API is not available", () => {
        removeApiDomain("sync");
        const callback = jest.fn();

        const unsubscribe = deviceService.onSyncDeviceDisconnected(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });

    describe("onPasswordRequired", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockSyncOnPasswordRequired.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onPasswordRequired(callback);

        expect(mockSyncOnPasswordRequired).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when sync API is not available", () => {
        removeApiDomain("sync");
        const callback = jest.fn();

        const unsubscribe = deviceService.onPasswordRequired(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });

    describe("onSyncError", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockSyncOnError.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onSyncError(callback);

        expect(mockSyncOnError).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when sync API is not available", () => {
        removeApiDomain("sync");
        const callback = jest.fn();

        const unsubscribe = deviceService.onSyncError(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });

    describe("onSyncComplete", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockSyncOnComplete.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onSyncComplete(callback);

        expect(mockSyncOnComplete).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when sync API is not available", () => {
        removeApiDomain("sync");
        const callback = jest.fn();

        const unsubscribe = deviceService.onSyncComplete(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });

    describe("onWaitingForPasscode", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockSyncOnWaitingForPasscode.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onWaitingForPasscode(callback);

        expect(mockSyncOnWaitingForPasscode).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when sync API is not available", () => {
        removeApiDomain("sync");
        const callback = jest.fn();

        const unsubscribe = deviceService.onWaitingForPasscode(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });

    describe("onPasscodeEntered", () => {
      it("should return unsubscribe function when API is available", () => {
        const mockUnsubscribe = jest.fn();
        mockSyncOnPasscodeEntered.mockReturnValue(mockUnsubscribe);
        const callback = jest.fn();

        const unsubscribe = deviceService.onPasscodeEntered(callback);

        expect(mockSyncOnPasscodeEntered).toHaveBeenCalledWith(callback);
        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("should return no-op function when sync API is not available", () => {
        removeApiDomain("sync");
        const callback = jest.fn();

        const unsubscribe = deviceService.onPasscodeEntered(callback);

        expect(typeof unsubscribe).toBe("function");
        unsubscribe();
      });
    });
  });
});
