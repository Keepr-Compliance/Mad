/**
 * SystemService Tests
 *
 * TASK-1019: Comprehensive unit tests for systemService.ts
 *
 * Mock Pattern (from TASK-1017/1018):
 * =====================================
 * 1. Mock window.api at module level using Object.defineProperty
 * 2. Create individual mock functions for each API method
 * 3. Reset all mocks in beforeEach with jest.clearAllMocks()
 * 4. Configure mock return values per test case
 * 5. Test both success and error paths for each method
 *
 * API Surface Tested (18 methods):
 * - Permissions: runPermissionSetup, requestContactsPermission, setupFullDiskAccess,
 *   openPrivacyPane, checkFullDiskAccessStatus, checkFullDiskAccess, checkContactsPermission, checkAllPermissions
 * - Connections: checkGoogleConnection, checkMicrosoftConnection, checkAllConnections, healthCheck
 * - Secure Storage: getSecureStorageStatus, initializeSecureStorage, hasEncryptionKeyStore
 * - Database: initializeDatabase, isDatabaseInitialized
 * - Support: contactSupport, getDiagnostics
 */

import { systemService } from "../systemService";
import type { OAuthProvider } from "@/types";

// ============================================
// MOCK SETUP
// ============================================

// Permission method mocks
const mockRunPermissionSetup = jest.fn();
const mockRequestContactsPermission = jest.fn();
const mockSetupFullDiskAccess = jest.fn();
const mockOpenPrivacyPane = jest.fn();
const mockCheckFullDiskAccessStatus = jest.fn();
const mockCheckFullDiskAccess = jest.fn();
const mockCheckContactsPermission = jest.fn();
const mockCheckAllPermissions = jest.fn();

// Connection method mocks
const mockCheckGoogleConnection = jest.fn();
const mockCheckMicrosoftConnection = jest.fn();
const mockCheckAllConnections = jest.fn();
const mockHealthCheck = jest.fn();

// Secure storage method mocks
const mockGetSecureStorageStatus = jest.fn();
const mockInitializeSecureStorage = jest.fn();
const mockHasEncryptionKeyStore = jest.fn();

// Database method mocks
const mockInitializeDatabase = jest.fn();
const mockIsDatabaseInitialized = jest.fn();

// Support method mocks
const mockContactSupport = jest.fn();
const mockGetDiagnostics = jest.fn();

// Shell method mocks (BACKLOG-2126)
const mockOpenExternal = jest.fn();

// Setup window.api mock before tests
beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      system: {
        // Permission methods
        runPermissionSetup: mockRunPermissionSetup,
        requestContactsPermission: mockRequestContactsPermission,
        setupFullDiskAccess: mockSetupFullDiskAccess,
        openPrivacyPane: mockOpenPrivacyPane,
        checkFullDiskAccessStatus: mockCheckFullDiskAccessStatus,
        checkFullDiskAccess: mockCheckFullDiskAccess,
        checkContactsPermission: mockCheckContactsPermission,
        checkAllPermissions: mockCheckAllPermissions,
        // Connection methods
        checkGoogleConnection: mockCheckGoogleConnection,
        checkMicrosoftConnection: mockCheckMicrosoftConnection,
        checkAllConnections: mockCheckAllConnections,
        healthCheck: mockHealthCheck,
        // Secure storage methods
        getSecureStorageStatus: mockGetSecureStorageStatus,
        initializeSecureStorage: mockInitializeSecureStorage,
        hasEncryptionKeyStore: mockHasEncryptionKeyStore,
        // Database methods
        initializeDatabase: mockInitializeDatabase,
        isDatabaseInitialized: mockIsDatabaseInitialized,
        // Support methods
        contactSupport: mockContactSupport,
        getDiagnostics: mockGetDiagnostics,
      },
      // Shell namespace (BACKLOG-2126)
      shell: {
        openExternal: mockOpenExternal,
      },
    },
    writable: true,
    configurable: true,
  });
});

// Reset all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================
// TEST FIXTURES
// ============================================

const mockUserId = "user-123";

// ============================================
// PERMISSION METHODS TESTS
// ============================================

describe("systemService", () => {
  describe("runPermissionSetup", () => {
    it("should run permission setup successfully", async () => {
      mockRunPermissionSetup.mockResolvedValue({ success: true });

      const result = await systemService.runPermissionSetup();

      expect(result.success).toBe(true);
      expect(mockRunPermissionSetup).toHaveBeenCalledTimes(1);
    });

    it("should return error when API returns failure", async () => {
      mockRunPermissionSetup.mockResolvedValue({ success: false });

      const result = await systemService.runPermissionSetup();

      expect(result.success).toBe(false);
    });

    it("should catch and return error when API throws exception", async () => {
      mockRunPermissionSetup.mockRejectedValue(new Error("Permission wizard failed"));

      const result = await systemService.runPermissionSetup();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Permission wizard failed");
    });
  });

  describe("requestContactsPermission", () => {
    it("should return granted when permission is granted", async () => {
      mockRequestContactsPermission.mockResolvedValue({ granted: true });

      const result = await systemService.requestContactsPermission();

      expect(result.success).toBe(true);
      expect(result.data?.granted).toBe(true);
      expect(mockRequestContactsPermission).toHaveBeenCalledTimes(1);
    });

    it("should return not granted when permission is denied", async () => {
      mockRequestContactsPermission.mockResolvedValue({ granted: false });

      const result = await systemService.requestContactsPermission();

      expect(result.success).toBe(true);
      expect(result.data?.granted).toBe(false);
    });

    it("should catch and return error when API throws exception", async () => {
      mockRequestContactsPermission.mockRejectedValue(new Error("Contacts access denied"));

      const result = await systemService.requestContactsPermission();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Contacts access denied");
    });
  });

  describe("setupFullDiskAccess", () => {
    it("should setup full disk access successfully", async () => {
      mockSetupFullDiskAccess.mockResolvedValue({ success: true });

      const result = await systemService.setupFullDiskAccess();

      expect(result.success).toBe(true);
      expect(mockSetupFullDiskAccess).toHaveBeenCalledTimes(1);
    });

    it("should return error when API returns failure", async () => {
      mockSetupFullDiskAccess.mockResolvedValue({ success: false });

      const result = await systemService.setupFullDiskAccess();

      expect(result.success).toBe(false);
    });

    it("should catch and return error when API throws exception", async () => {
      mockSetupFullDiskAccess.mockRejectedValue(new Error("Full disk access denied"));

      const result = await systemService.setupFullDiskAccess();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Full disk access denied");
    });
  });

  describe("openPrivacyPane", () => {
    it("should open privacy pane successfully", async () => {
      mockOpenPrivacyPane.mockResolvedValue({ success: true });

      const result = await systemService.openPrivacyPane("FullDiskAccess");

      expect(result.success).toBe(true);
      expect(mockOpenPrivacyPane).toHaveBeenCalledWith("FullDiskAccess");
    });

    it("should return error when API returns failure", async () => {
      mockOpenPrivacyPane.mockResolvedValue({ success: false });

      const result = await systemService.openPrivacyPane("Contacts");

      expect(result.success).toBe(false);
    });

    it("should catch and return error when API throws exception", async () => {
      mockOpenPrivacyPane.mockRejectedValue(new Error("Cannot open privacy pane"));

      const result = await systemService.openPrivacyPane("FullDiskAccess");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot open privacy pane");
    });
  });

  describe("checkFullDiskAccessStatus", () => {
    it("should return has access when granted", async () => {
      mockCheckFullDiskAccessStatus.mockResolvedValue({ hasAccess: true });

      const result = await systemService.checkFullDiskAccessStatus();

      expect(result.success).toBe(true);
      expect(result.data?.hasAccess).toBe(true);
      expect(mockCheckFullDiskAccessStatus).toHaveBeenCalledTimes(1);
    });

    it("should return no access when not granted", async () => {
      mockCheckFullDiskAccessStatus.mockResolvedValue({ hasAccess: false });

      const result = await systemService.checkFullDiskAccessStatus();

      expect(result.success).toBe(true);
      expect(result.data?.hasAccess).toBe(false);
    });

    it("should catch and return error when API throws exception", async () => {
      mockCheckFullDiskAccessStatus.mockRejectedValue(new Error("Status check failed"));

      const result = await systemService.checkFullDiskAccessStatus();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Status check failed");
    });
  });

  describe("checkFullDiskAccess", () => {
    it("should return has access when granted", async () => {
      mockCheckFullDiskAccess.mockResolvedValue({ hasAccess: true });

      const result = await systemService.checkFullDiskAccess();

      expect(result.success).toBe(true);
      expect(result.data?.hasAccess).toBe(true);
      expect(mockCheckFullDiskAccess).toHaveBeenCalledTimes(1);
    });

    it("should return no access when not granted", async () => {
      mockCheckFullDiskAccess.mockResolvedValue({ hasAccess: false });

      const result = await systemService.checkFullDiskAccess();

      expect(result.success).toBe(true);
      expect(result.data?.hasAccess).toBe(false);
    });

    it("should catch and return error when API throws exception", async () => {
      mockCheckFullDiskAccess.mockRejectedValue(new Error("Access check failed"));

      const result = await systemService.checkFullDiskAccess();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Access check failed");
    });
  });

  describe("checkContactsPermission", () => {
    it("should return has permission when granted", async () => {
      mockCheckContactsPermission.mockResolvedValue({ hasPermission: true });

      const result = await systemService.checkContactsPermission();

      expect(result.success).toBe(true);
      expect(result.data?.hasPermission).toBe(true);
      expect(mockCheckContactsPermission).toHaveBeenCalledTimes(1);
    });

    it("should return no permission when not granted", async () => {
      mockCheckContactsPermission.mockResolvedValue({ hasPermission: false });

      const result = await systemService.checkContactsPermission();

      expect(result.success).toBe(true);
      expect(result.data?.hasPermission).toBe(false);
    });

    it("should catch and return error when API throws exception", async () => {
      mockCheckContactsPermission.mockRejectedValue(new Error("Permission check failed"));

      const result = await systemService.checkContactsPermission();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Permission check failed");
    });
  });

  describe("checkAllPermissions", () => {
    it("should return all permissions when all granted", async () => {
      mockCheckAllPermissions.mockResolvedValue({
        allGranted: true,
        permissions: {
          fullDiskAccess: { hasPermission: true },
          contacts: { hasPermission: true },
        },
        errors: [],
      });

      const result = await systemService.checkAllPermissions();

      expect(result.success).toBe(true);
      expect(result.data?.fullDiskAccess).toBe(true);
      expect(result.data?.contactsAccess).toBe(true);
      expect(result.data?.allGranted).toBe(true);
      expect(mockCheckAllPermissions).toHaveBeenCalledTimes(1);
    });

    it("should return partial permissions when some denied", async () => {
      mockCheckAllPermissions.mockResolvedValue({
        allGranted: false,
        permissions: {
          fullDiskAccess: { hasPermission: true },
          contacts: { hasPermission: false },
        },
        errors: [],
      });

      const result = await systemService.checkAllPermissions();

      expect(result.success).toBe(true);
      expect(result.data?.fullDiskAccess).toBe(true);
      expect(result.data?.contactsAccess).toBe(false);
      expect(result.data?.allGranted).toBe(false);
    });

    it("should handle undefined permissions gracefully", async () => {
      mockCheckAllPermissions.mockResolvedValue({
        allGranted: false,
        permissions: {},
        errors: [],
      });

      const result = await systemService.checkAllPermissions();

      expect(result.success).toBe(true);
      expect(result.data?.fullDiskAccess).toBe(false);
      expect(result.data?.contactsAccess).toBe(false);
      expect(result.data?.allGranted).toBe(false);
    });

    it("should handle null permissions object gracefully", async () => {
      mockCheckAllPermissions.mockResolvedValue({
        allGranted: false,
        permissions: null,
        errors: [],
      });

      const result = await systemService.checkAllPermissions();

      expect(result.success).toBe(true);
      expect(result.data?.fullDiskAccess).toBe(false);
      expect(result.data?.contactsAccess).toBe(false);
    });

    it("should catch and return error when API throws exception", async () => {
      mockCheckAllPermissions.mockRejectedValue(new Error("Permissions check failed"));

      const result = await systemService.checkAllPermissions();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Permissions check failed");
    });
  });

  // ============================================
  // CONNECTION METHODS TESTS
  // ============================================

  describe("checkGoogleConnection", () => {
    it("should return connected status with email", async () => {
      mockCheckGoogleConnection.mockResolvedValue({
        connected: true,
        email: "user@gmail.com",
      });

      const result = await systemService.checkGoogleConnection(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data?.connected).toBe(true);
      expect(result.data?.email).toBe("user@gmail.com");
      expect(mockCheckGoogleConnection).toHaveBeenCalledWith(mockUserId);
    });

    it("should return disconnected status", async () => {
      mockCheckGoogleConnection.mockResolvedValue({
        connected: false,
      });

      const result = await systemService.checkGoogleConnection(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data?.connected).toBe(false);
      expect(result.data?.email).toBeUndefined();
    });

    it("should catch and return error when API throws exception", async () => {
      mockCheckGoogleConnection.mockRejectedValue(new Error("Google API error"));

      const result = await systemService.checkGoogleConnection(mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Google API error");
    });
  });

  describe("checkMicrosoftConnection", () => {
    it("should return connected status with email", async () => {
      mockCheckMicrosoftConnection.mockResolvedValue({
        connected: true,
        email: "user@outlook.com",
      });

      const result = await systemService.checkMicrosoftConnection(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data?.connected).toBe(true);
      expect(result.data?.email).toBe("user@outlook.com");
      expect(mockCheckMicrosoftConnection).toHaveBeenCalledWith(mockUserId);
    });

    it("should return disconnected status", async () => {
      mockCheckMicrosoftConnection.mockResolvedValue({
        connected: false,
      });

      const result = await systemService.checkMicrosoftConnection(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data?.connected).toBe(false);
      expect(result.data?.email).toBeUndefined();
    });

    it("should catch and return error when API throws exception", async () => {
      mockCheckMicrosoftConnection.mockRejectedValue(new Error("Microsoft Graph error"));

      const result = await systemService.checkMicrosoftConnection(mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Microsoft Graph error");
    });
  });

  describe("checkAllConnections", () => {
    it("should return all connections successfully", async () => {
      mockCheckAllConnections.mockResolvedValue({
        success: true,
        google: { connected: true, email: "user@gmail.com" },
        microsoft: { connected: false },
      });

      const result = await systemService.checkAllConnections(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data?.google?.connected).toBe(true);
      expect(result.data?.google?.email).toBe("user@gmail.com");
      expect(result.data?.microsoft?.connected).toBe(false);
      expect(mockCheckAllConnections).toHaveBeenCalledWith(mockUserId);
    });

    // BACKLOG-2127: the structured `error` must be preserved through the
    // wrapper so useAutoRefresh can read error.type (broken token vs absent).
    it("preserves the structured connection error (BACKLOG-2127)", async () => {
      mockCheckAllConnections.mockResolvedValue({
        success: true,
        google: { connected: true, error: null },
        microsoft: {
          connected: false,
          error: {
            type: "TOKEN_REFRESH_FAILED",
            userMessage: "Your Outlook connection expired. Reconnect to keep capturing email.",
            actionHandler: "reconnect-microsoft",
          },
        },
      });

      const result = await systemService.checkAllConnections(mockUserId);

      expect(result.success).toBe(true);
      expect(result.data?.microsoft?.error?.type).toBe("TOKEN_REFRESH_FAILED");
      expect(result.data?.google?.error).toBeNull();
    });

    it("should return error when API returns failure", async () => {
      mockCheckAllConnections.mockResolvedValue({ success: false });

      const result = await systemService.checkAllConnections(mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to check connections");
    });

    it("should catch and return error when API throws exception", async () => {
      mockCheckAllConnections.mockRejectedValue(new Error("Connection check failed"));

      const result = await systemService.checkAllConnections(mockUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Connection check failed");
    });
  });

  describe("healthCheck", () => {
    it("should return healthy status for Google provider", async () => {
      const provider: OAuthProvider = "google";
      mockHealthCheck.mockResolvedValue({
        healthy: true,
        provider: "google",
        issues: [],
      });

      const result = await systemService.healthCheck(mockUserId, provider);

      expect(result.success).toBe(true);
      expect(result.data?.healthy).toBe(true);
      expect(result.data?.provider).toBe("google");
      expect(result.data?.issues).toEqual([]);
      expect(mockHealthCheck).toHaveBeenCalledWith(mockUserId, provider);
    });

    it("should return unhealthy status with issues", async () => {
      const provider: OAuthProvider = "microsoft";
      mockHealthCheck.mockResolvedValue({
        healthy: false,
        provider: "microsoft",
        issues: ["Token expired", "Refresh failed"],
      });

      const result = await systemService.healthCheck(mockUserId, provider);

      expect(result.success).toBe(true);
      expect(result.data?.healthy).toBe(false);
      expect(result.data?.provider).toBe("microsoft");
      expect(result.data?.issues).toEqual(["Token expired", "Refresh failed"]);
    });

    it("should catch and return error when API throws exception", async () => {
      mockHealthCheck.mockRejectedValue(new Error("Health check failed"));

      const result = await systemService.healthCheck(mockUserId, "google");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Health check failed");
    });
  });

  // ============================================
  // SECURE STORAGE METHODS TESTS
  // ============================================

  describe("getSecureStorageStatus", () => {
    it("should return available storage status with platform info", async () => {
      mockGetSecureStorageStatus.mockResolvedValue({
        success: true,
        available: true,
        platform: "darwin",
        guidance: "Using macOS Keychain",
      });

      const result = await systemService.getSecureStorageStatus();

      expect(result.success).toBe(true);
      expect(result.data?.available).toBe(true);
      expect(result.data?.platform).toBe("darwin");
      expect(result.data?.guidance).toBe("Using macOS Keychain");
      expect(mockGetSecureStorageStatus).toHaveBeenCalledTimes(1);
    });

    it("should return unavailable storage status", async () => {
      mockGetSecureStorageStatus.mockResolvedValue({
        success: true,
        available: false,
        platform: "linux",
        guidance: "Install libsecret for secure storage",
      });

      const result = await systemService.getSecureStorageStatus();

      expect(result.success).toBe(true);
      expect(result.data?.available).toBe(false);
    });

    it("should return error when API returns failure", async () => {
      mockGetSecureStorageStatus.mockResolvedValue({
        success: false,
        error: "Keychain access denied",
      });

      const result = await systemService.getSecureStorageStatus();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Keychain access denied");
    });

    it("should catch and return error when API throws exception", async () => {
      mockGetSecureStorageStatus.mockRejectedValue(new Error("Secure storage error"));

      const result = await systemService.getSecureStorageStatus();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Secure storage error");
    });
  });

  describe("initializeSecureStorage", () => {
    it("should initialize secure storage successfully", async () => {
      mockInitializeSecureStorage.mockResolvedValue({
        success: true,
        available: true,
        platform: "darwin",
        guidance: "Keychain initialized",
      });

      const result = await systemService.initializeSecureStorage();

      expect(result.success).toBe(true);
      expect(result.data?.available).toBe(true);
      expect(result.data?.platform).toBe("darwin");
      expect(mockInitializeSecureStorage).toHaveBeenCalledTimes(1);
    });

    it("should return error when API returns failure", async () => {
      mockInitializeSecureStorage.mockResolvedValue({
        success: false,
        error: "Keychain initialization failed",
      });

      const result = await systemService.initializeSecureStorage();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Keychain initialization failed");
    });

    it("should catch and return error when API throws exception", async () => {
      mockInitializeSecureStorage.mockRejectedValue(new Error("Init failed"));

      const result = await systemService.initializeSecureStorage();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Init failed");
    });
  });

  describe("hasEncryptionKeyStore", () => {
    it("should return true when key store exists", async () => {
      mockHasEncryptionKeyStore.mockResolvedValue({
        success: true,
        hasKeyStore: true,
      });

      const result = await systemService.hasEncryptionKeyStore();

      expect(result.success).toBe(true);
      expect(result.data?.hasKeyStore).toBe(true);
      expect(mockHasEncryptionKeyStore).toHaveBeenCalledTimes(1);
    });

    it("should return false when key store does not exist", async () => {
      mockHasEncryptionKeyStore.mockResolvedValue({
        success: true,
        hasKeyStore: false,
      });

      const result = await systemService.hasEncryptionKeyStore();

      expect(result.success).toBe(true);
      expect(result.data?.hasKeyStore).toBe(false);
    });

    it("should return error when API returns failure", async () => {
      mockHasEncryptionKeyStore.mockResolvedValue({
        success: false,
      });

      const result = await systemService.hasEncryptionKeyStore();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to check key store");
    });

    it("should catch and return error when API throws exception", async () => {
      mockHasEncryptionKeyStore.mockRejectedValue(new Error("Key store check failed"));

      const result = await systemService.hasEncryptionKeyStore();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Key store check failed");
    });
  });

  // ============================================
  // DATABASE METHODS TESTS
  // ============================================

  describe("initializeDatabase", () => {
    it("should initialize database successfully", async () => {
      mockInitializeDatabase.mockResolvedValue({ success: true });

      const result = await systemService.initializeDatabase();

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockInitializeDatabase).toHaveBeenCalledTimes(1);
    });

    it("should return error when API returns failure", async () => {
      mockInitializeDatabase.mockResolvedValue({
        success: false,
        error: "Database initialization failed",
      });

      const result = await systemService.initializeDatabase();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Database initialization failed");
    });

    it("should catch and return error when API throws exception", async () => {
      mockInitializeDatabase.mockRejectedValue(new Error("SQLite error"));

      const result = await systemService.initializeDatabase();

      expect(result.success).toBe(false);
      expect(result.error).toBe("SQLite error");
    });
  });

  describe("isDatabaseInitialized", () => {
    it("should return true when database is initialized", async () => {
      mockIsDatabaseInitialized.mockResolvedValue({
        success: true,
        initialized: true,
      });

      const result = await systemService.isDatabaseInitialized();

      expect(result.success).toBe(true);
      expect(result.data?.initialized).toBe(true);
      expect(mockIsDatabaseInitialized).toHaveBeenCalledTimes(1);
    });

    it("should return false when database is not initialized", async () => {
      mockIsDatabaseInitialized.mockResolvedValue({
        success: true,
        initialized: false,
      });

      const result = await systemService.isDatabaseInitialized();

      expect(result.success).toBe(true);
      expect(result.data?.initialized).toBe(false);
    });

    it("should return error when API returns failure", async () => {
      mockIsDatabaseInitialized.mockResolvedValue({
        success: false,
      });

      const result = await systemService.isDatabaseInitialized();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to check database status");
    });

    it("should catch and return error when API throws exception", async () => {
      mockIsDatabaseInitialized.mockRejectedValue(new Error("Database status check failed"));

      const result = await systemService.isDatabaseInitialized();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Database status check failed");
    });
  });

  // ============================================
  // SUPPORT METHODS TESTS
  // ============================================

  describe("contactSupport", () => {
    it("should contact support successfully without error details", async () => {
      mockContactSupport.mockResolvedValue({ success: true });

      const result = await systemService.contactSupport();

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockContactSupport).toHaveBeenCalledWith(undefined);
    });

    it("should contact support successfully with error details", async () => {
      mockContactSupport.mockResolvedValue({ success: true });

      const result = await systemService.contactSupport("Login failed with error XYZ");

      expect(result.success).toBe(true);
      expect(mockContactSupport).toHaveBeenCalledWith("Login failed with error XYZ");
    });

    it("should return error when API returns failure", async () => {
      mockContactSupport.mockResolvedValue({
        success: false,
        error: "Email client not available",
      });

      const result = await systemService.contactSupport();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Email client not available");
    });

    it("should catch and return error when API throws exception", async () => {
      mockContactSupport.mockRejectedValue(new Error("Cannot open mailto link"));

      const result = await systemService.contactSupport();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot open mailto link");
    });
  });

  // ============================================
  // SHELL METHODS TESTS (BACKLOG-2126)
  // ============================================

  describe("openExternalUrl", () => {
    it("should open the exact URL via window.api.shell.openExternal", async () => {
      // The IPC handler resolves with { success: true } on a valid open.
      mockOpenExternal.mockResolvedValue({ success: true });

      const result = await systemService.openExternalUrl(
        "https://keeprcompliance.com/privacy",
      );

      expect(result.success).toBe(true);
      expect(mockOpenExternal).toHaveBeenCalledTimes(1);
      expect(mockOpenExternal).toHaveBeenCalledWith(
        "https://keeprcompliance.com/privacy",
      );
    });

    // BACKLOG-2126/1898: the handler NEVER rejects — a blocked protocol / invalid
    // URL comes back as a RESOLVED { success: false, error }. The service must
    // propagate that so consumers' `if (!result.success)` handlers actually fire.
    it("propagates a resolved failure payload from the shell handler", async () => {
      mockOpenExternal.mockResolvedValue({
        success: false,
        error: "Protocol not allowed: ftp:",
      });

      const result = await systemService.openExternalUrl("ftp://example.com");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Protocol not allowed: ftp:");
    });

    it("should catch and return error when the shell bridge throws", async () => {
      mockOpenExternal.mockRejectedValue(new Error("bridge exploded"));

      const result = await systemService.openExternalUrl(
        "https://keeprcompliance.com/terms",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("bridge exploded");
    });
  });

  describe("getDiagnostics", () => {
    it("should return diagnostics successfully", async () => {
      const diagnosticsData = "App Version: 1.0.0\nPlatform: darwin\nMemory: 512MB";
      mockGetDiagnostics.mockResolvedValue({
        success: true,
        diagnostics: diagnosticsData,
      });

      const result = await systemService.getDiagnostics();

      expect(result.success).toBe(true);
      expect(result.data?.diagnostics).toBe(diagnosticsData);
      expect(mockGetDiagnostics).toHaveBeenCalledTimes(1);
    });

    it("should return error when API returns failure", async () => {
      mockGetDiagnostics.mockResolvedValue({
        success: false,
        error: "Cannot collect diagnostics",
      });

      const result = await systemService.getDiagnostics();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot collect diagnostics");
    });

    it("should return error when diagnostics is missing", async () => {
      mockGetDiagnostics.mockResolvedValue({
        success: true,
        // diagnostics field missing
      });

      const result = await systemService.getDiagnostics();

      expect(result.success).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it("should catch and return error when API throws exception", async () => {
      mockGetDiagnostics.mockRejectedValue(new Error("Diagnostics collection failed"));

      const result = await systemService.getDiagnostics();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Diagnostics collection failed");
    });
  });
});
