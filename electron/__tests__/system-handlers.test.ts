/**
 * Unit tests for System Handlers
 * Tests system and permission IPC handlers including:
 * - Permission setup and checks
 * - OAuth connection status
 * - System health monitoring
 */

import type { IpcMainInvokeEvent } from "electron";

// Mock electron module
const mockIpcHandle = jest.fn();
const mockShellOpenExternal = jest.fn();
const mockShellShowItemInFolder = jest.fn();

// Mock os module to simulate macOS for health check tests
jest.mock("os", () => ({
  ...jest.requireActual("os"),
  platform: jest.fn().mockReturnValue("darwin"),
}));

jest.mock("electron", () => ({
  ipcMain: {
    handle: mockIpcHandle,
    on: jest.fn(),
  },
  app: {
    getPath: jest.fn().mockReturnValue("/tmp/test-user-data"),
    setAsDefaultProtocolClient: jest.fn(),
    requestSingleInstanceLock: jest.fn().mockReturnValue(true),
    isPackaged: false,
    quit: jest.fn(),
    on: jest.fn(),
    whenReady: jest.fn().mockResolvedValue(undefined),
  },
  shell: {
    openExternal: mockShellOpenExternal,
    showItemInFolder: mockShellShowItemInFolder,
  },
  BrowserWindow: jest.fn(),
  dialog: { showErrorBox: jest.fn() },
  session: { defaultSession: { webRequest: { onHeadersReceived: jest.fn() } } },
  Notification: jest.fn(),
}));

// Mock services
const mockPermissionService = {
  checkFullDiskAccess: jest.fn(),
  checkContactsPermission: jest.fn(),
  checkAllPermissions: jest.fn(),
  checkContactsLoading: jest.fn(),
  getPermissionError: jest.fn().mockImplementation((error: Error) => ({
    type: "PERMISSION_ERROR",
    userMessage: error.message,
  })),
};

const mockConnectionStatusService = {
  checkGoogleConnection: jest.fn(),
  checkMicrosoftConnection: jest.fn(),
  checkAllConnections: jest.fn(),
};

const mockMacOSPermissionHelper = {
  runPermissionSetupFlow: jest.fn(),
  requestContactsPermission: jest.fn(),
  setupFullDiskAccess: jest.fn(),
  openPrivacyPane: jest.fn(),
  checkFullDiskAccessStatus: jest.fn(),
};

jest.mock("../services/permissionService", () => ({
  default: mockPermissionService,
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
    isInitialized: jest.fn().mockReturnValue(true),
    clearAllSessions: jest.fn(),
    clearAllOAuthTokens: jest.fn(),
  },
}));

jest.mock("../services/databaseEncryptionService", () => ({
  databaseEncryptionService: {
    hasKeyStore: jest.fn().mockReturnValue(true),
  },
}));

jest.mock("../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../handlers/authHandlers", () => ({
  initializeDatabase: jest.fn(),
}));

// Import after mocks
import databaseService from "../services/databaseService";
const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;

jest.mock("../services/connectionStatusService", () => ({
  default: mockConnectionStatusService,
}));

jest.mock("../services/macOSPermissionHelper", () => ({
  default: mockMacOSPermissionHelper,
}));

// Mock supabaseService (imported by system-handlers)
jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(),
    syncUser: jest.fn(),
    trackEvent: jest.fn(),
  },
}));

// Mock initializationBroadcaster (BACKLOG-1381 / BACKLOG-2149)
const mockBroadcast = jest.fn();
// BACKLOG-2149: whenDbReady is awaited by the verify-user handler. Default it to
// "timed out, not ready" so tests that keep the DB uninitialized don't hang on
// the real 30s bound; individual tests override as needed.
const mockWhenDbReady = jest.fn().mockResolvedValue({ ready: false, timedOut: true });
jest.mock("../services/initializationBroadcaster", () => ({
  initializationBroadcaster: {
    broadcast: mockBroadcast,
    getCurrentStage: jest.fn().mockReturnValue({ stage: "idle" }),
    whenDbReady: mockWhenDbReady,
    setWindow: jest.fn(),
    reset: jest.fn(),
  },
}));

// Mock main module to prevent top-level side effects (deep link registration, etc.)
jest.mock("../main", () => ({
  getAndClearPendingDeepLinkUser: jest.fn().mockReturnValue(null),
}));

// Import after mocks are set up
import { registerSystemHandlers } from "../handlers/systemHandlersCompat";

// Test UUIDs
const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("System Handlers", () => {
  let registeredHandlers: Map<string, Function>;
  const mockEvent = {} as IpcMainInvokeEvent;

  beforeAll(() => {
    // Capture registered handlers
    registeredHandlers = new Map();
    mockIpcHandle.mockImplementation((channel: string, handler: Function) => {
      registeredHandlers.set(channel, handler);
    });

    // Register all handlers
    registerSystemHandlers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Permission Setup (Onboarding)", () => {
    describe("system:run-permission-setup", () => {
      it("should run permission setup flow successfully", async () => {
        mockMacOSPermissionHelper.runPermissionSetupFlow.mockResolvedValue({
          overallSuccess: true,
          contacts: { granted: true },
          fullDiskAccess: { granted: true },
        });

        const handler = registeredHandlers.get("system:run-permission-setup");
        const result = await handler(mockEvent);

        expect(result.success).toBe(true);
        expect(result.overallSuccess).toBe(true);
      });

      it("should handle partial permission grant", async () => {
        mockMacOSPermissionHelper.runPermissionSetupFlow.mockResolvedValue({
          overallSuccess: false,
          contacts: { granted: true },
          fullDiskAccess: { granted: false },
        });

        const handler = registeredHandlers.get("system:run-permission-setup");
        const result = await handler(mockEvent);

        expect(result.success).toBe(false);
        expect(result.overallSuccess).toBe(false);
      });

      it("should handle setup failure", async () => {
        mockMacOSPermissionHelper.runPermissionSetupFlow.mockRejectedValue(
          new Error("Setup failed"),
        );

        const handler = registeredHandlers.get("system:run-permission-setup");
        const result = await handler(mockEvent);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Setup failed");
      });
    });

    describe("system:request-contacts-permission", () => {
      it("should request contacts permission successfully", async () => {
        mockMacOSPermissionHelper.requestContactsPermission.mockResolvedValue({
          success: true,
          granted: true,
        });

        const handler = registeredHandlers.get(
          "system:request-contacts-permission",
        );
        const result = await handler(mockEvent);

        expect(result.success).toBe(true);
        expect(result.granted).toBe(true);
      });

      it("should handle permission denial", async () => {
        mockMacOSPermissionHelper.requestContactsPermission.mockResolvedValue({
          success: true,
          granted: false,
        });

        const handler = registeredHandlers.get(
          "system:request-contacts-permission",
        );
        const result = await handler(mockEvent);

        expect(result.success).toBe(true);
        expect(result.granted).toBe(false);
      });

      it("should handle request failure", async () => {
        mockMacOSPermissionHelper.requestContactsPermission.mockRejectedValue(
          new Error("Request failed"),
        );

        const handler = registeredHandlers.get(
          "system:request-contacts-permission",
        );
        const result = await handler(mockEvent);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Request failed");
      });
    });

    describe("system:setup-full-disk-access", () => {
      it("should open System Preferences for Full Disk Access", async () => {
        mockMacOSPermissionHelper.setupFullDiskAccess.mockResolvedValue({
          success: true,
        });

        const handler = registeredHandlers.get("system:setup-full-disk-access");
        const result = await handler(mockEvent);

        expect(result.success).toBe(true);
      });

      it("should handle setup failure", async () => {
        mockMacOSPermissionHelper.setupFullDiskAccess.mockRejectedValue(
          new Error("Could not open System Preferences"),
        );

        const handler = registeredHandlers.get("system:setup-full-disk-access");
        const result = await handler(mockEvent);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Could not open");
      });
    });

    describe("system:open-privacy-pane", () => {
      it("should open specific privacy pane", async () => {
        mockMacOSPermissionHelper.openPrivacyPane.mockResolvedValue({
          success: true,
        });

        const handler = registeredHandlers.get("system:open-privacy-pane");
        const result = await handler(mockEvent, "Contacts");

        expect(result.success).toBe(true);
        expect(mockMacOSPermissionHelper.openPrivacyPane).toHaveBeenCalledWith(
          "Contacts",
        );
      });

      it("should handle invalid pane parameter", async () => {
        const handler = registeredHandlers.get("system:open-privacy-pane");
        const result = await handler(mockEvent, "");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Validation error");
      });

      it("should handle open failure", async () => {
        mockMacOSPermissionHelper.openPrivacyPane.mockRejectedValue(
          new Error("Pane not found"),
        );

        const handler = registeredHandlers.get("system:open-privacy-pane");
        const result = await handler(mockEvent, "InvalidPane");

        expect(result.success).toBe(false);
      });
    });

    describe("system:check-full-disk-access-status", () => {
      it("should return full disk access status", async () => {
        mockMacOSPermissionHelper.checkFullDiskAccessStatus.mockResolvedValue({
          granted: true,
        });

        const handler = registeredHandlers.get(
          "system:check-full-disk-access-status",
        );
        const result = await handler(mockEvent);

        expect(result.success).toBe(true);
        expect(result.granted).toBe(true);
      });

      it("should handle check failure", async () => {
        mockMacOSPermissionHelper.checkFullDiskAccessStatus.mockRejectedValue(
          new Error("Check failed"),
        );

        const handler = registeredHandlers.get(
          "system:check-full-disk-access-status",
        );
        const result = await handler(mockEvent);

        expect(result.success).toBe(false);
        expect(result.granted).toBe(false);
      });
    });
  });

  describe("Permission Checks", () => {
    describe("system:check-full-disk-access", () => {
      it("should return true when permission is granted", async () => {
        mockPermissionService.checkFullDiskAccess.mockResolvedValue({
          hasPermission: true,
        });

        const handler = registeredHandlers.get("system:check-full-disk-access");
        const result = await handler(mockEvent);

        expect(result.success).toBe(true);
        expect(result.hasPermission).toBe(true);
      });

      it("should return false when permission is denied", async () => {
        mockPermissionService.checkFullDiskAccess.mockResolvedValue({
          hasPermission: false,
        });

        const handler = registeredHandlers.get("system:check-full-disk-access");
        const result = await handler(mockEvent);

        expect(result.success).toBe(true);
        expect(result.hasPermission).toBe(false);
      });

      it("should handle check failure", async () => {
        mockPermissionService.checkFullDiskAccess.mockRejectedValue(
          new Error("Permission check failed"),
        );

        const handler = registeredHandlers.get("system:check-full-disk-access");
        const result = await handler(mockEvent);

        expect(result.success).toBe(false);
        expect(result.hasPermission).toBe(false);
        expect(mockPermissionService.getPermissionError).toHaveBeenCalled();
      });
    });

    describe("system:check-contacts-permission", () => {
      it("should return true when permission is granted", async () => {
        mockPermissionService.checkContactsPermission.mockResolvedValue({
          hasPermission: true,
        });

        const handler = registeredHandlers.get(
          "system:check-contacts-permission",
        );
        const result = await handler(mockEvent);

        expect(result.success).toBe(true);
        expect(result.hasPermission).toBe(true);
      });

      it("should handle check failure", async () => {
        mockPermissionService.checkContactsPermission.mockRejectedValue(
          new Error("Permission check failed"),
        );

        const handler = registeredHandlers.get(
          "system:check-contacts-permission",
        );
        const result = await handler(mockEvent);

        expect(result.success).toBe(false);
        expect(result.hasPermission).toBe(false);
      });
    });

    describe("system:check-all-permissions", () => {
      it("should return all permissions status", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: true,
          fullDiskAccess: { hasPermission: true },
          contacts: { hasPermission: true },
          errors: [],
        });

        const handler = registeredHandlers.get("system:check-all-permissions");
        const result = await handler(mockEvent);

        expect(result.success).toBe(true);
        expect(result.allGranted).toBe(true);
      });

      it("should handle partial permissions", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: false,
          fullDiskAccess: { hasPermission: true },
          contacts: { hasPermission: false },
          errors: ["Contacts permission not granted"],
        });

        const handler = registeredHandlers.get("system:check-all-permissions");
        const result = await handler(mockEvent);

        expect(result.success).toBe(true);
        expect(result.allGranted).toBe(false);
      });

      it("should handle check failure", async () => {
        mockPermissionService.checkAllPermissions.mockRejectedValue(
          new Error("Check failed"),
        );

        const handler = registeredHandlers.get("system:check-all-permissions");
        const result = await handler(mockEvent);

        expect(result.success).toBe(false);
      });
    });
  });

  describe("Connection Status", () => {
    describe("system:check-google-connection", () => {
      it("should return connected status for valid user", async () => {
        mockConnectionStatusService.checkGoogleConnection.mockResolvedValue({
          connected: true,
          email: "user@gmail.com",
        });

        const handler = registeredHandlers.get(
          "system:check-google-connection",
        );
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.connected).toBe(true);
      });

      it("should handle invalid user ID", async () => {
        const handler = registeredHandlers.get(
          "system:check-google-connection",
        );
        const result = await handler(mockEvent, "");

        expect(result.success).toBe(false);
        expect(result.connected).toBe(false);
        expect(result.error?.type).toBe("VALIDATION_ERROR");
      });

      it("should handle connection check failure", async () => {
        mockConnectionStatusService.checkGoogleConnection.mockRejectedValue(
          new Error("Connection check failed"),
        );

        const handler = registeredHandlers.get(
          "system:check-google-connection",
        );
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(false);
        expect(result.connected).toBe(false);
        expect(result.error?.type).toBe("CHECK_FAILED");
      });
    });

    describe("system:check-microsoft-connection", () => {
      it("should return connected status for valid user", async () => {
        mockConnectionStatusService.checkMicrosoftConnection.mockResolvedValue({
          connected: true,
          email: "user@outlook.com",
        });

        const handler = registeredHandlers.get(
          "system:check-microsoft-connection",
        );
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.connected).toBe(true);
      });

      it("should handle invalid user ID", async () => {
        const handler = registeredHandlers.get(
          "system:check-microsoft-connection",
        );
        const result = await handler(mockEvent, "");

        expect(result.success).toBe(false);
        expect(result.error?.type).toBe("VALIDATION_ERROR");
      });

      it("should handle connection check failure", async () => {
        mockConnectionStatusService.checkMicrosoftConnection.mockRejectedValue(
          new Error("Connection check failed"),
        );

        const handler = registeredHandlers.get(
          "system:check-microsoft-connection",
        );
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(false);
        expect(result.error?.type).toBe("CHECK_FAILED");
      });
    });

    describe("system:check-all-connections", () => {
      it("should return all connection statuses", async () => {
        mockConnectionStatusService.checkAllConnections.mockResolvedValue({
          google: { connected: true },
          microsoft: { connected: false },
        });

        const handler = registeredHandlers.get("system:check-all-connections");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.google.connected).toBe(true);
        expect(result.microsoft.connected).toBe(false);
      });

      it("should handle invalid user ID", async () => {
        const handler = registeredHandlers.get("system:check-all-connections");
        const result = await handler(mockEvent, "");

        expect(result.success).toBe(false);
        expect(result.error?.type).toBe("VALIDATION_ERROR");
      });
    });
  });

  describe("Health Check", () => {
    describe("system:health-check", () => {
      it("should return healthy status when all checks pass", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: true,
          errors: [],
        });
        // BACKLOG-2127: health-check now uses checkAllConnections.
        mockConnectionStatusService.checkAllConnections.mockResolvedValue({
          google: { connected: true, error: null },
          microsoft: { connected: true, error: null },
        });
        mockPermissionService.checkContactsLoading.mockResolvedValue({
          canLoadContacts: true,
        });

        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, TEST_USER_ID, "google");

        expect(result.success).toBe(true);
        expect(result.healthy).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("should report permission issues", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: false,
          errors: [
            {
              type: "PERMISSION_MISSING",
              message: "Full Disk Access required",
            },
          ],
        });
        mockPermissionService.checkContactsLoading.mockResolvedValue({
          canLoadContacts: true,
        });

        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, null, null);

        expect(result.success).toBe(true);
        expect(result.healthy).toBe(false);
        expect(result.issues.length).toBeGreaterThan(0);
      });

      it("should report connection issues for Google", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: true,
          errors: [],
        });
        mockConnectionStatusService.checkAllConnections.mockResolvedValue({
          google: {
            connected: false,
            error: { type: "TOKEN_EXPIRED", userMessage: "Token expired" },
          },
          microsoft: { connected: true, error: null },
        });
        mockPermissionService.checkContactsLoading.mockResolvedValue({
          canLoadContacts: true,
        });

        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, TEST_USER_ID, "google");

        expect(result.success).toBe(true);
        expect(result.healthy).toBe(false);
        // The issue type matches the error type from the connection check
        expect(result.issues).toContainEqual(
          expect.objectContaining({
            type: "TOKEN_EXPIRED",
            provider: "google",
          }),
        );
      });

      it("should report connection issues for Microsoft", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: true,
          errors: [],
        });
        mockConnectionStatusService.checkAllConnections.mockResolvedValue({
          google: { connected: true, error: null },
          microsoft: {
            connected: false,
            error: { type: "TOKEN_EXPIRED", userMessage: "Token expired" },
          },
        });
        mockPermissionService.checkContactsLoading.mockResolvedValue({
          canLoadContacts: true,
        });

        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, TEST_USER_ID, "microsoft");

        expect(result.success).toBe(true);
        expect(result.healthy).toBe(false);
        // The issue type matches the error type from the connection check
        expect(result.issues).toContainEqual(
          expect.objectContaining({
            type: "TOKEN_EXPIRED",
            provider: "microsoft",
          }),
        );
      });

      // BACKLOG-2127: the critical fix — a broken Outlook mailbox must raise a
      // reconnect issue EVEN WHEN the user logged in with Google.
      it("reports a broken Outlook mailbox even when the login provider is Google", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: true,
          errors: [],
        });
        mockConnectionStatusService.checkAllConnections.mockResolvedValue({
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
        mockPermissionService.checkContactsLoading.mockResolvedValue({
          canLoadContacts: true,
        });

        const handler = registeredHandlers.get("system:health-check");
        // Login provider is Google, but Outlook is broken.
        const result = await handler(mockEvent, TEST_USER_ID, "google");

        expect(result.success).toBe(true);
        expect(result.healthy).toBe(false);
        expect(result.issues).toContainEqual(
          expect.objectContaining({
            type: "TOKEN_REFRESH_FAILED",
            provider: "microsoft",
            actionHandler: "reconnect-microsoft",
          }),
        );
      });

      // BACKLOG-2142: a broken-token issue gains a "No email captured since
      // <date>" subtitle (issue.message) when the provider has a prior
      // successful email sync (lastSyncAt). Display-only; discriminator stays
      // `type`.
      it("adds a 'No email captured since <date>' subtitle when lastSyncAt is present", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: true,
          errors: [],
        });
        mockConnectionStatusService.checkAllConnections.mockResolvedValue({
          google: { connected: true, error: null },
          microsoft: {
            connected: false,
            error: {
              type: "TOKEN_REFRESH_FAILED",
              userMessage: "Your Outlook connection expired. Reconnect to keep capturing email.",
              actionHandler: "reconnect-microsoft",
            },
            lastSyncAt: "2026-07-10T12:00:00.000Z",
          },
        });
        mockPermissionService.checkContactsLoading.mockResolvedValue({
          canLoadContacts: true,
        });

        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, TEST_USER_ID, "google");

        expect(result.success).toBe(true);
        const oauthIssue = (result.issues as Array<Record<string, unknown>>).find(
          (i) => i.type === "TOKEN_REFRESH_FAILED" && i.provider === "microsoft",
        );
        expect(oauthIssue).toBeDefined();
        expect(oauthIssue?.message).toEqual(
          expect.stringContaining("No email captured since"),
        );
      });

      it("omits the since-date subtitle cleanly when lastSyncAt is null", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: true,
          errors: [],
        });
        mockConnectionStatusService.checkAllConnections.mockResolvedValue({
          google: { connected: true, error: null },
          microsoft: {
            connected: false,
            error: {
              type: "TOKEN_REFRESH_FAILED",
              userMessage: "Your Outlook connection expired. Reconnect to keep capturing email.",
              actionHandler: "reconnect-microsoft",
            },
            lastSyncAt: null,
          },
        });
        mockPermissionService.checkContactsLoading.mockResolvedValue({
          canLoadContacts: true,
        });

        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, TEST_USER_ID, "google");

        const oauthIssue = (result.issues as Array<Record<string, unknown>>).find(
          (i) => i.type === "TOKEN_REFRESH_FAILED" && i.provider === "microsoft",
        );
        expect(oauthIssue).toBeDefined();
        expect(oauthIssue?.message).toBeUndefined();
      });

      // BACKLOG-2127: a provider that was never connected (NOT_CONNECTED) is the
      // setup prompt's job — it must NOT raise a health/reconnect issue.
      it("does NOT raise an issue for a NOT_CONNECTED provider", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: true,
          errors: [],
        });
        mockConnectionStatusService.checkAllConnections.mockResolvedValue({
          google: { connected: true, error: null },
          microsoft: {
            connected: false,
            error: { type: "NOT_CONNECTED", userMessage: "Outlook is not connected" },
          },
        });
        mockPermissionService.checkContactsLoading.mockResolvedValue({
          canLoadContacts: true,
        });

        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, TEST_USER_ID, "google");

        expect(result.success).toBe(true);
        expect(result.healthy).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("should handle azure provider by normalizing to microsoft", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: true,
          errors: [],
        });
        mockConnectionStatusService.checkAllConnections.mockResolvedValue({
          google: { connected: true, error: null },
          microsoft: { connected: true, error: null },
        });
        mockPermissionService.checkContactsLoading.mockResolvedValue({
          canLoadContacts: true,
        });

        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, TEST_USER_ID, "azure");

        expect(result.success).toBe(true);
        expect(result.healthy).toBe(true);
        // BACKLOG-2127: all connections are checked regardless of login provider.
        expect(
          mockConnectionStatusService.checkAllConnections,
        ).toHaveBeenCalledWith(TEST_USER_ID);
      });

      it("should handle empty string provider gracefully", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: true,
          errors: [],
        });
        mockConnectionStatusService.checkAllConnections.mockResolvedValue({
          google: { connected: true, error: null },
          microsoft: { connected: true, error: null },
        });
        mockPermissionService.checkContactsLoading.mockResolvedValue({
          canLoadContacts: true,
        });

        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, TEST_USER_ID, "");

        expect(result.success).toBe(true);
        expect(result.healthy).toBe(true);
      });

      it("should report contacts loading issues", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: true,
          errors: [],
        });
        mockPermissionService.checkContactsLoading.mockResolvedValue({
          canLoadContacts: false,
          error: {
            type: "CONTACTS_UNAVAILABLE",
            message: "Cannot load contacts",
          },
        });

        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, null, null);

        expect(result.success).toBe(true);
        expect(result.healthy).toBe(false);
      });

      it("should handle invalid user ID", async () => {
        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, "invalid", "google");

        // Should fail validation since invalid isn't a proper UUID
        expect(result.success).toBe(false);
        expect(result.healthy).toBe(false);
        expect(result.error?.type).toBe("VALIDATION_ERROR");
      });

      it("should handle invalid provider", async () => {
        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(
          mockEvent,
          TEST_USER_ID,
          "invalid-provider",
        );

        expect(result.success).toBe(false);
        expect(result.error?.type).toBe("VALIDATION_ERROR");
      });

      it("should handle health check failure", async () => {
        mockPermissionService.checkAllPermissions.mockRejectedValue(
          new Error("Health check failed"),
        );

        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, null, null);

        expect(result.success).toBe(false);
        expect(result.healthy).toBe(false);
        expect(result.error?.type).toBe("HEALTH_CHECK_FAILED");
      });

      it("should include summary of issues", async () => {
        mockPermissionService.checkAllPermissions.mockResolvedValue({
          allGranted: false,
          errors: [
            { type: "ERROR", severity: "error", message: "Critical issue" },
            { type: "WARNING", severity: "warning", message: "Minor issue" },
          ],
        });
        mockPermissionService.checkContactsLoading.mockResolvedValue({
          canLoadContacts: true,
        });

        const handler = registeredHandlers.get("system:health-check");
        const result = await handler(mockEvent, null, null);

        expect(result.success).toBe(true);
        expect(result.summary).toBeDefined();
        expect(result.summary.totalIssues).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe("User Phone Type Preferences", () => {
    describe("user:get-phone-type", () => {
      it("should return phone type for user with iphone", async () => {
        mockDatabaseService.getUserById.mockResolvedValue({
          id: TEST_USER_ID,
          mobile_phone_type: "iphone",
        });

        const handler = registeredHandlers.get("user:get-phone-type");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.phoneType).toBe("iphone");
        expect(mockDatabaseService.getUserById).toHaveBeenCalledWith(
          TEST_USER_ID,
        );
      });

      it("should return phone type for user with android", async () => {
        mockDatabaseService.getUserById.mockResolvedValue({
          id: TEST_USER_ID,
          mobile_phone_type: "android",
        });

        const handler = registeredHandlers.get("user:get-phone-type");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.phoneType).toBe("android");
      });

      it("should return null phone type when user has not selected", async () => {
        mockDatabaseService.getUserById.mockResolvedValue({
          id: TEST_USER_ID,
          mobile_phone_type: null,
        });

        const handler = registeredHandlers.get("user:get-phone-type");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.phoneType).toBe(null);
      });

      it("should return null phone type when user not found", async () => {
        mockDatabaseService.getUserById.mockResolvedValue(null);

        const handler = registeredHandlers.get("user:get-phone-type");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(true);
        expect(result.phoneType).toBe(null);
      });

      it("should handle invalid user ID", async () => {
        const handler = registeredHandlers.get("user:get-phone-type");
        const result = await handler(mockEvent, "");

        expect(result.success).toBe(false);
        expect(result.phoneType).toBe(null);
        expect(result.error).toContain("Validation error");
      });

      it("should handle database errors", async () => {
        mockDatabaseService.getUserById.mockRejectedValue(
          new Error("Database connection failed"),
        );

        const handler = registeredHandlers.get("user:get-phone-type");
        const result = await handler(mockEvent, TEST_USER_ID);

        expect(result.success).toBe(false);
        expect(result.phoneType).toBe(null);
        expect(result.error).toContain("Database connection failed");
      });
    });

    describe("user:set-phone-type", () => {
      it("should set phone type to iphone", async () => {
        mockDatabaseService.updateUser.mockResolvedValue(undefined);

        const handler = registeredHandlers.get("user:set-phone-type");
        const result = await handler(mockEvent, TEST_USER_ID, "iphone");

        expect(result.success).toBe(true);
        expect(mockDatabaseService.updateUser).toHaveBeenCalledWith(
          TEST_USER_ID,
          { mobile_phone_type: "iphone" },
        );
      });

      it("should set phone type to android", async () => {
        mockDatabaseService.updateUser.mockResolvedValue(undefined);

        const handler = registeredHandlers.get("user:set-phone-type");
        const result = await handler(mockEvent, TEST_USER_ID, "android");

        expect(result.success).toBe(true);
        expect(mockDatabaseService.updateUser).toHaveBeenCalledWith(
          TEST_USER_ID,
          { mobile_phone_type: "android" },
        );
      });

      it("should reject invalid phone type", async () => {
        const handler = registeredHandlers.get("user:set-phone-type");
        const result = await handler(mockEvent, TEST_USER_ID, "blackberry");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid phone type");
        expect(mockDatabaseService.updateUser).not.toHaveBeenCalled();
      });

      it("should handle invalid user ID", async () => {
        const handler = registeredHandlers.get("user:set-phone-type");
        const result = await handler(mockEvent, "", "iphone");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Validation error");
        expect(mockDatabaseService.updateUser).not.toHaveBeenCalled();
      });

      it("should handle database errors", async () => {
        mockDatabaseService.updateUser.mockRejectedValue(
          new Error("Database update failed"),
        );

        const handler = registeredHandlers.get("user:set-phone-type");
        const result = await handler(mockEvent, TEST_USER_ID, "iphone");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Database update failed");
      });
    });
  });

  describe("Shell Operations", () => {
    describe("shell:open-external", () => {
      beforeEach(() => {
        mockShellOpenExternal.mockReset();
      });

      it("should open valid HTTPS URL", async () => {
        mockShellOpenExternal.mockResolvedValue(undefined);

        const handler = registeredHandlers.get("shell:open-external");
        const result = await handler(mockEvent, "https://example.com");

        expect(result.success).toBe(true);
        expect(mockShellOpenExternal).toHaveBeenCalledWith(
          "https://example.com",
        );
      });

      it("should open valid HTTP URL", async () => {
        mockShellOpenExternal.mockResolvedValue(undefined);

        const handler = registeredHandlers.get("shell:open-external");
        const result = await handler(mockEvent, "http://example.com");

        expect(result.success).toBe(true);
        expect(mockShellOpenExternal).toHaveBeenCalledWith(
          "http://example.com",
        );
      });

      it("should open valid mailto URL", async () => {
        mockShellOpenExternal.mockResolvedValue(undefined);

        const handler = registeredHandlers.get("shell:open-external");
        const result = await handler(mockEvent, "mailto:test@example.com");

        expect(result.success).toBe(true);
        expect(mockShellOpenExternal).toHaveBeenCalledWith(
          "mailto:test@example.com",
        );
      });

      it("should reject javascript URLs", async () => {
        const handler = registeredHandlers.get("shell:open-external");
        const result = await handler(mockEvent, "javascript:alert(1)");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Protocol not allowed");
        expect(mockShellOpenExternal).not.toHaveBeenCalled();
      });

      it("should reject file URLs", async () => {
        const handler = registeredHandlers.get("shell:open-external");
        const result = await handler(mockEvent, "file:///etc/passwd");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Protocol not allowed");
        expect(mockShellOpenExternal).not.toHaveBeenCalled();
      });

      it("should handle shell open failure", async () => {
        mockShellOpenExternal.mockRejectedValue(new Error("Shell error"));

        const handler = registeredHandlers.get("shell:open-external");
        const result = await handler(mockEvent, "https://example.com");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Shell error");
      });
    });

    describe("system:show-in-folder", () => {
      beforeEach(() => {
        mockShellShowItemInFolder.mockReset();
      });

      it("should show file in folder successfully", async () => {
        mockShellShowItemInFolder.mockReturnValue(undefined);

        const handler = registeredHandlers.get("system:show-in-folder");
        const result = await handler(
          mockEvent,
          "/Users/test/Documents/export.pdf",
        );

        expect(result.success).toBe(true);
        expect(mockShellShowItemInFolder).toHaveBeenCalledWith(
          "/Users/test/Documents/export.pdf",
        );
      });

      it("should handle empty file path", async () => {
        const handler = registeredHandlers.get("system:show-in-folder");
        const result = await handler(mockEvent, "");

        expect(result.success).toBe(false);
        expect(result.error).toContain("Validation error");
        expect(mockShellShowItemInFolder).not.toHaveBeenCalled();
      });

      it("should handle Windows-style paths", async () => {
        mockShellShowItemInFolder.mockReturnValue(undefined);

        const handler = registeredHandlers.get("system:show-in-folder");
        const result = await handler(
          mockEvent,
          "C:\\Users\\test\\Documents\\export.pdf",
        );

        expect(result.success).toBe(true);
        expect(mockShellShowItemInFolder).toHaveBeenCalledWith(
          "C:\\Users\\test\\Documents\\export.pdf",
        );
      });

      it("should handle paths with spaces", async () => {
        mockShellShowItemInFolder.mockReturnValue(undefined);

        const handler = registeredHandlers.get("system:show-in-folder");
        const result = await handler(
          mockEvent,
          "/Users/test/My Documents/export file.pdf",
        );

        expect(result.success).toBe(true);
        expect(mockShellShowItemInFolder).toHaveBeenCalledWith(
          "/Users/test/My Documents/export file.pdf",
        );
      });
    });
  });

  // BACKLOG-1381: InitializationBroadcaster integration tests
  describe("InitializationBroadcaster integration", () => {
    describe("system:get-init-stage", () => {
      it("should be registered as a handler", () => {
        const handler = registeredHandlers.get("system:get-init-stage");
        expect(handler).toBeDefined();
      });
    });

    describe("system:verify-user-in-local-db", () => {
      it("returns a TRANSIENT/retryable result (not a hard error) when DB never becomes ready (BACKLOG-2149)", async () => {
        // DB not initialized and whenDbReady times out.
        mockDatabaseService.isInitialized.mockReturnValue(false);
        mockWhenDbReady.mockResolvedValueOnce({ ready: false, timedOut: true });

        const handler = registeredHandlers.get("system:verify-user-in-local-db");
        expect(handler).toBeDefined();
        const result = await handler(mockEvent);

        expect(result.success).toBe(false);
        // No longer the terminal "Database not initialized" that surfaced as
        // "Setup failed" — it's a transient/retryable "starting up" state.
        expect(result.transient).toBe(true);
        expect(result.retryable).toBe(true);
        expect(result.error).not.toBe("Database not initialized");
        // Handler must have awaited the db-ready signal.
        expect(mockWhenDbReady).toHaveBeenCalled();
      });

      it("awaits db-ready and proceeds when the DB comes up during the wait (BACKLOG-2149)", async () => {
        // Not initialized at first, but whenDbReady resolves ready.
        mockDatabaseService.isInitialized.mockReturnValue(false);
        mockWhenDbReady.mockResolvedValueOnce({ ready: true, timedOut: false });

        const handler = registeredHandlers.get("system:verify-user-in-local-db");
        const result = await handler(mockEvent);

        // It proceeded to ensureUserInLocalDb (no transient short-circuit).
        expect(result.transient).toBeUndefined();
        expect(result.error).not.toBe("Database not initialized");
        expect(mockWhenDbReady).toHaveBeenCalled();
      });

      it("should allow access when DB is initialized even if full init not complete", async () => {
        // DB is initialized (ready for queries) but full init may not be complete
        mockDatabaseService.isInitialized.mockReturnValue(true);

        const handler = registeredHandlers.get("system:verify-user-in-local-db");
        // Handler will try to ensureUserInLocalDb which needs supabase
        // Just verify it doesn't fail on the guard check
        const result = await handler(mockEvent);

        // Should not fail with "Database not initialized" error
        expect(result.error).not.toBe("Database not initialized");
        // Fast path: no db-ready wait needed.
        expect(result.transient).toBeUndefined();
      });
    });
  });
});
