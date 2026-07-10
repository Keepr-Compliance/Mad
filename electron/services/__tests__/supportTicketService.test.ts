/**
 * Support Ticket Service Tests
 * TASK-2180: Desktop In-App Support Ticket Dialog with Diagnostics
 */

import { collectDiagnostics, captureScreenshot } from "../supportTicketService";

// Mock electron
jest.mock("electron", () => ({
  app: {
    getVersion: jest.fn().mockReturnValue("2.9.5"),
  },
  BrowserWindow: {
    getFocusedWindow: jest.fn(),
  },
}));

// Mock os module
jest.mock("os", () => ({
  release: jest.fn().mockReturnValue("24.6.0"),
  homedir: jest.fn().mockReturnValue("/Users/testuser"),
}));

// Mock databaseService
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: jest.fn().mockReturnValue(true),
  },
}));

// Mock databaseEncryptionService
jest.mock("../databaseEncryptionService", () => ({
  __esModule: true,
  default: {
    isEncryptionAvailable: jest.fn().mockReturnValue(true),
  },
}));

// Mock syncStatusService
jest.mock("../syncStatusService", () => ({
  syncStatusService: {
    getStatus: jest.fn().mockReturnValue({
      isAnyOperationRunning: false,
      currentOperation: null,
    }),
  },
}));

// Mock deviceService
jest.mock("../deviceService", () => ({
  getDeviceId: jest.fn().mockReturnValue("device-abc-123"),
}));

// Mock failureLogService
jest.mock("../failureLogService", () => ({
  __esModule: true,
  default: {
    getRecentFailures: jest.fn().mockResolvedValue([
      {
        id: 1,
        timestamp: "2026-03-13T10:00:00Z",
        operation: "outlook_sync",
        error_message: "Connection timeout after 30s",
        metadata: null,
        acknowledged: 0,
      },
      {
        id: 2,
        timestamp: "2026-03-13T09:00:00Z",
        operation: "gmail_sync",
        error_message: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.long_token_here was invalid",
        metadata: null,
        acknowledged: 0,
      },
    ]),
  },
}));

// Mock sessionService
jest.mock("../sessionService", () => ({
  __esModule: true,
  default: {
    loadSession: jest.fn().mockResolvedValue({
      user: { id: "user-123" },
    }),
  },
}));

// Mock connectionStatusService
jest.mock("../connectionStatusService", () => ({
  __esModule: true,
  default: {
    checkAllConnections: jest.fn().mockResolvedValue({
      google: { connected: false, lastCheck: Date.now(), error: null },
      microsoft: { connected: false, lastCheck: Date.now(), error: null },
      allConnected: false,
      anyConnected: false,
    }),
  },
}));

// BACKLOG-1918: iPhone-sync diagnostics sources.
jest.mock("../deviceDetectionService", () => ({
  deviceDetectionService: {
    collectIphoneSyncDiagnostics: jest.fn().mockResolvedValue({
      libimobiledeviceAvailable: true,
      libimobiledeviceInPath: true,
      connectedDeviceCount: 0,
      deviceMounted: false,
      deviceDetected: false,
      driverMissingSuspected: false,
      trustState: null,
      windows: null,
    }),
  },
}));

jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: jest.fn().mockResolvedValue({
    isInstalled: true,
    version: "1.2.3",
    serviceRunning: true,
    error: null,
  }),
}));

jest.mock("../pairingService", () => ({
  pairingService: {
    getStatus: jest.fn().mockReturnValue({ isPaired: false, devices: [] }),
  },
}));

jest.mock("../localSyncService", () => ({
  __esModule: true,
  default: {
    getStatus: jest.fn().mockReturnValue({
      running: false,
      port: null,
      address: null,
      totalMessagesReceived: 0,
      lastSyncTimestamp: null,
    }),
  },
}));

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getPreferences: jest.fn().mockResolvedValue({}),
  },
}));

// Mock logService
jest.mock("../logService", () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock process
const originalProcess = process;
beforeAll(() => {
  Object.defineProperty(process, "versions", {
    value: { ...process.versions, electron: "35.7.5", node: "20.18.0" },
    configurable: true,
  });
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  Object.defineProperty(process, "arch", {
    value: "arm64",
    configurable: true,
  });
});

afterAll(() => {
  Object.defineProperty(process, "versions", {
    value: originalProcess.versions,
    configurable: true,
  });
});

describe("supportTicketService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("collectDiagnostics", () => {
    it("should return all expected diagnostic fields", async () => {
      const diagnostics = await collectDiagnostics();

      expect(diagnostics).toBeDefined();
      expect(diagnostics.app_version).toBe("2.9.5");
      expect(diagnostics.electron_version).toBe("35.7.5");
      expect(diagnostics.os_platform).toBe("darwin");
      expect(diagnostics.os_version).toBe("24.6.0");
      expect(diagnostics.os_arch).toBe("arm64");
      expect(diagnostics.node_version).toBe("20.18.0");
      expect(diagnostics.db_initialized).toBe(true);
      expect(diagnostics.db_encrypted).toBe(true);
      expect(diagnostics.sync_status).toEqual({
        is_running: false,
        current_operation: null,
      });
      expect(diagnostics.device_id).toBe("device-abc-123");
      expect(typeof diagnostics.uptime_seconds).toBe("number");
      expect(diagnostics.collected_at).toBeDefined();
      expect(diagnostics.memory_usage).toBeDefined();
      expect(diagnostics.memory_usage.rss).toBeGreaterThan(0);
    });

    it("should include sanitized recent errors", async () => {
      const diagnostics = await collectDiagnostics();

      expect(diagnostics.recent_errors).toHaveLength(2);
      expect(diagnostics.recent_errors[0].operation).toBe("outlook_sync");
      expect(diagnostics.recent_errors[0].error_message).toBe(
        "Connection timeout after 30s"
      );
    });

    it("should sanitize bearer tokens from error messages", async () => {
      const diagnostics = await collectDiagnostics();

      // The second error had a Bearer token that should be redacted
      const secondError = diagnostics.recent_errors[1];
      expect(secondError.error_message).not.toContain("eyJhbGciOiJSUzI1NiI");
      expect(secondError.error_message).toContain("[REDACTED]");
    });

    it("should replace home directory paths with ~", async () => {
      const os = require("os");
      os.homedir.mockReturnValue("/Users/testuser");

      // Mock failureLogService to return an error with a path
      const failureLogService = require("../failureLogService").default;
      failureLogService.getRecentFailures.mockResolvedValue([
        {
          id: 3,
          timestamp: "2026-03-13T10:00:00Z",
          operation: "file_access",
          error_message: "Cannot read /Users/testuser/Documents/secret.txt",
          metadata: null,
          acknowledged: 0,
        },
      ]);

      const diagnostics = await collectDiagnostics();

      expect(diagnostics.recent_errors[0].error_message).not.toContain(
        "/Users/testuser"
      );
      expect(diagnostics.recent_errors[0].error_message).toContain("~");
    });

    it("should handle partial failure gracefully", async () => {
      // Make one service throw
      const databaseService = require("../databaseService").default;
      databaseService.isInitialized.mockImplementation(() => {
        throw new Error("DB not ready");
      });

      const diagnostics = await collectDiagnostics();

      // Should still return diagnostics, just with default value for db_initialized
      expect(diagnostics).toBeDefined();
      expect(diagnostics.db_initialized).toBe(false); // Default/fallback
      expect(diagnostics.app_version).toBe("2.9.5"); // Other fields still work
    });

    it("should handle failureLogService errors gracefully", async () => {
      const failureLogService = require("../failureLogService").default;
      failureLogService.getRecentFailures.mockRejectedValue(
        new Error("DB locked")
      );

      const diagnostics = await collectDiagnostics();

      expect(diagnostics).toBeDefined();
      expect(diagnostics.recent_errors).toEqual([]); // Empty array on failure
    });

    it("should sanitize email addresses from error messages", async () => {
      const failureLogService = require("../failureLogService").default;
      failureLogService.getRecentFailures.mockResolvedValue([
        {
          id: 4,
          timestamp: "2026-03-13T10:00:00Z",
          operation: "email_sync",
          error_message: "Failed to sync for user@example.com",
          metadata: null,
          acknowledged: 0,
        },
      ]);

      const diagnostics = await collectDiagnostics();

      expect(diagnostics.recent_errors[0].error_message).not.toContain(
        "user@example.com"
      );
      expect(diagnostics.recent_errors[0].error_message).toContain(
        "[REDACTED_EMAIL]"
      );
    });

    it("should truncate long error messages", async () => {
      const failureLogService = require("../failureLogService").default;
      const longMessage = "A".repeat(500);
      failureLogService.getRecentFailures.mockResolvedValue([
        {
          id: 5,
          timestamp: "2026-03-13T10:00:00Z",
          operation: "sync",
          error_message: longMessage,
          metadata: null,
          acknowledged: 0,
        },
      ]);

      const diagnostics = await collectDiagnostics();

      // Should be truncated to 200 chars + "..."
      expect(diagnostics.recent_errors[0].error_message.length).toBeLessThanOrEqual(203);
    });
  });

  // BACKLOG-1918: iPhone-sync / Apple-driver diagnostics section.
  describe("collectDiagnostics - iphone_sync section", () => {
    it("should include the iphone_sync section with device + driver signals", async () => {
      const diagnostics = await collectDiagnostics();

      expect(diagnostics.iphone_sync).toBeDefined();
      expect(diagnostics.iphone_sync.libimobiledevice_available).toBe(true);
      expect(diagnostics.iphone_sync.connected_device_count).toBe(0);
      expect(diagnostics.iphone_sync.device_detected).toBe(false);
      // Apple driver wired from checkAppleDrivers mock
      expect(diagnostics.iphone_sync.apple_driver).toEqual({
        is_installed: true,
        service_running: true,
        version: "1.2.3",
      });
    });

    it("should surface driver_missing_suspected for Zoe's fingerprint (mounted, not detected)", async () => {
      const { deviceDetectionService } = require("../deviceDetectionService");
      // Windows: device visible to PnP but idevice_id -l returns 0 →
      // libimobiledevice available but no device detected → driver missing.
      deviceDetectionService.collectIphoneSyncDiagnostics.mockResolvedValueOnce({
        libimobiledeviceAvailable: true,
        libimobiledeviceInPath: true,
        connectedDeviceCount: 0,
        deviceMounted: true,
        deviceDetected: false,
        driverMissingSuspected: true,
        trustState: null,
        windows: {
          appleUsbDriverService: "not_found",
          pnpDeviceFound: true,
          pnpStatus: "Apple iPhone",
        },
      });

      const diagnostics = await collectDiagnostics();

      expect(diagnostics.iphone_sync.device_mounted).toBe(true);
      expect(diagnostics.iphone_sync.device_detected).toBe(false);
      expect(diagnostics.iphone_sync.driver_missing_suspected).toBe(true);
      expect(diagnostics.iphone_sync.windows).toEqual({
        apple_mobile_device_service: "not_found",
        apple_usb_driver_present: false,
        pnp_iphone_present: true,
      });
    });

    it("should surface trust_state when a device is present-but-unusable", async () => {
      const { deviceDetectionService } = require("../deviceDetectionService");
      deviceDetectionService.collectIphoneSyncDiagnostics.mockResolvedValueOnce({
        libimobiledeviceAvailable: true,
        libimobiledeviceInPath: true,
        connectedDeviceCount: 1,
        deviceMounted: true,
        deviceDetected: true,
        driverMissingSuspected: false,
        trustState: "trust_pending",
        windows: null,
      });

      const diagnostics = await collectDiagnostics();

      expect(diagnostics.iphone_sync.trust_state).toBe("trust_pending");
      expect(diagnostics.iphone_sync.connected_device_count).toBe(1);
    });

    it("should reflect macOS libimobiledevice availability and device count", async () => {
      const { deviceDetectionService } = require("../deviceDetectionService");
      deviceDetectionService.collectIphoneSyncDiagnostics.mockResolvedValueOnce({
        libimobiledeviceAvailable: true,
        libimobiledeviceInPath: true,
        connectedDeviceCount: 2,
        deviceMounted: true,
        deviceDetected: true,
        driverMissingSuspected: false,
        trustState: null,
        windows: null, // non-Windows → no windows block
      });

      const diagnostics = await collectDiagnostics();

      expect(diagnostics.iphone_sync.libimobiledevice_in_path).toBe(true);
      expect(diagnostics.iphone_sync.connected_device_count).toBe(2);
      expect(diagnostics.iphone_sync.windows).toBeNull();
    });

    it("should reflect Android companion state and phone_type from user settings", async () => {
      const { pairingService } = require("../pairingService");
      const supabaseService = require("../supabaseService").default;
      const localSyncService = require("../localSyncService").default;

      const now = new Date().toISOString();
      pairingService.getStatus.mockReturnValueOnce({
        isPaired: true,
        devices: [{ deviceId: "d1", deviceName: "Pixel", pairedAt: now, lastSeen: now }],
      });
      localSyncService.getStatus.mockReturnValueOnce({
        running: true,
        port: 8080,
        address: "0.0.0.0",
        totalMessagesReceived: 5,
        lastSyncTimestamp: Date.now(),
      });
      supabaseService.getPreferences.mockResolvedValueOnce({
        phone_type: "android",
        contactSources: { direct: { googleContacts: true } },
        integrations: { iphoneSyncEnabled: false },
      });

      const diagnostics = await collectDiagnostics();

      expect(diagnostics.iphone_sync.phone_type).toBe("android");
      expect(diagnostics.iphone_sync.android_companion.paired).toBe(true);
      expect(diagnostics.iphone_sync.android_companion.connected).toBe(true);
      expect(diagnostics.iphone_sync.android_companion.device_count).toBe(1);
      expect(diagnostics.iphone_sync.android_companion.server_running).toBe(true);
      expect(diagnostics.iphone_sync.user_settings.phone_type).toBe("android");
      expect(diagnostics.iphone_sync.user_settings.contact_sources_configured).toBe(true);
      expect(diagnostics.iphone_sync.user_settings.iphone_sync_enabled).toBe(false);
    });

    it("should NOT leak any UDID/serial into the payload (PII check)", async () => {
      const supabaseService = require("../supabaseService").default;
      supabaseService.getPreferences.mockResolvedValueOnce({ phone_type: "iphone" });

      const diagnostics = await collectDiagnostics();
      const serialized = JSON.stringify(diagnostics.iphone_sync);

      // No udid/serial keys, and no field named after them.
      expect(serialized.toLowerCase()).not.toContain("udid");
      expect(serialized.toLowerCase()).not.toContain("serial");
    });

    it("should keep the default section when collection throws", async () => {
      const { deviceDetectionService } = require("../deviceDetectionService");
      const { checkAppleDrivers } = require("../appleDriverService");
      const { pairingService } = require("../pairingService");
      const supabaseService = require("../supabaseService").default;

      deviceDetectionService.collectIphoneSyncDiagnostics.mockRejectedValueOnce(
        new Error("device probe failed")
      );
      checkAppleDrivers.mockRejectedValueOnce(new Error("driver check failed"));
      pairingService.getStatus.mockImplementationOnce(() => {
        throw new Error("pairing unavailable");
      });
      supabaseService.getPreferences.mockRejectedValueOnce(new Error("no prefs"));

      const diagnostics = await collectDiagnostics();

      // Still returns a well-formed default section, not undefined.
      expect(diagnostics.iphone_sync).toBeDefined();
      expect(diagnostics.iphone_sync.phone_type).toBe("unknown");
      expect(diagnostics.iphone_sync.apple_driver.is_installed).toBe(false);
    });
  });

  describe("captureScreenshot", () => {
    it("should return null when no focused window", async () => {
      const { BrowserWindow } = require("electron");
      BrowserWindow.getFocusedWindow.mockReturnValue(null);

      const result = await captureScreenshot();
      expect(result).toBeNull();
    });

    it("should return base64 PNG when window is available", async () => {
      const { BrowserWindow } = require("electron");
      const mockPngBuffer = Buffer.from("fake-png-data");
      BrowserWindow.getFocusedWindow.mockReturnValue({
        webContents: {
          capturePage: jest.fn().mockResolvedValue({
            toPNG: jest.fn().mockReturnValue(mockPngBuffer),
          }),
          executeJavaScript: jest.fn().mockResolvedValue(undefined),
        },
      });

      const result = await captureScreenshot();
      expect(result).toBe(mockPngBuffer.toString("base64"));
    });

    it("should return null on error", async () => {
      const { BrowserWindow } = require("electron");
      BrowserWindow.getFocusedWindow.mockImplementation(() => {
        throw new Error("Permission denied");
      });

      const result = await captureScreenshot();
      expect(result).toBeNull();
    });
  });
});
