/**
 * Shared Auth Handlers Tests
 * TASK-2254: Test handler registration and exported function shapes
 */

// Track registered handlers
const registeredHandlers: Record<string, Function> = {};
const mockIpcHandle = jest.fn((channel: string, handler: Function) => {
  registeredHandlers[channel] = handler;
});

jest.mock("electron", () => ({
  ipcMain: {
    // Tuple rest so the spread matches mockIpcHandle's (channel, handler) arity.
    handle: (...args: [string, Function]) => mockIpcHandle(...args),
  },
  BrowserWindow: jest.fn(),
  app: {
    getVersion: jest.fn().mockReturnValue("1.0.0"),
  },
}));

jest.mock("os", () => ({
  hostname: jest.fn().mockReturnValue("test-host"),
  platform: jest.fn().mockReturnValue("darwin"),
  release: jest.fn().mockReturnValue("21.0.0"),
}));

jest.mock("crypto", () => ({
  randomUUID: jest.fn().mockReturnValue("mock-device-uuid"),
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
}));

const mockLogService = {
  info: jest.fn().mockResolvedValue(undefined),
  warn: jest.fn().mockResolvedValue(undefined),
  error: jest.fn().mockResolvedValue(undefined),
  debug: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: mockLogService,
}));

const mockDatabaseService = {
  getUserByOAuthId: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  getUserById: jest.fn(),
  updateLastLogin: jest.fn(),
  saveOAuthToken: jest.fn(),
  createSession: jest.fn(),
  getOAuthToken: jest.fn(),
  updateOAuthToken: jest.fn(),
  deleteOAuthToken: jest.fn(),
  getRawDatabase: jest.fn().mockReturnValue({
    prepare: jest.fn().mockReturnValue({ run: jest.fn() }),
  }),
};

jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: mockDatabaseService,
}));

const mockSupabaseService = {
  registerDevice: jest.fn().mockResolvedValue(undefined),
  trackEvent: jest.fn().mockResolvedValue(undefined),
  syncTermsAcceptance: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: mockSupabaseService,
}));

const mockAuditService = {
  log: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../../services/auditService", () => ({
  __esModule: true,
  default: mockAuditService,
}));

const mockSessionService = {
  saveSession: jest.fn().mockResolvedValue(undefined),
  getSessionExpirationMs: jest.fn().mockReturnValue(86400000),
};

jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: mockSessionService,
}));

jest.mock("../syncHandlers", () => ({
  setSyncUserId: jest.fn(),
}));

jest.mock("../../utils/userIdHelper", () => ({
  getValidUserId: jest.fn().mockResolvedValue("validated-user-id"),
}));

jest.mock("../../constants/legalVersions", () => ({
  CURRENT_TERMS_VERSION: "1.0",
  CURRENT_PRIVACY_POLICY_VERSION: "1.0",
}));

import {
  registerSharedAuthHandlers,
  handleCompletePendingLogin,
  handleSavePendingMailboxTokens,
  handleDisconnectMailbox,
} from "../sharedAuthHandlers";

describe("SharedAuthHandlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(registeredHandlers).forEach((key) => delete registeredHandlers[key]);
  });

  describe("registerSharedAuthHandlers", () => {
    it("should register all expected IPC channels", () => {
      registerSharedAuthHandlers(null);

      expect(mockIpcHandle).toHaveBeenCalledWith(
        "auth:complete-pending-login",
        expect.any(Function)
      );
      expect(mockIpcHandle).toHaveBeenCalledWith(
        "auth:save-pending-mailbox-tokens",
        expect.any(Function)
      );
      expect(mockIpcHandle).toHaveBeenCalledWith(
        "auth:google:disconnect-mailbox",
        expect.any(Function)
      );
      expect(mockIpcHandle).toHaveBeenCalledWith(
        "auth:microsoft:disconnect-mailbox",
        expect.any(Function)
      );
      expect(mockIpcHandle).toHaveBeenCalledWith(
        "auth:dev:expire-mailbox-token",
        expect.any(Function)
      );
      expect(mockIpcHandle).toHaveBeenCalledWith(
        "auth:dev:reset-onboarding",
        expect.any(Function)
      );
    });

    it("should register exactly 6 handlers", () => {
      registerSharedAuthHandlers(null);
      expect(mockIpcHandle).toHaveBeenCalledTimes(6);
    });
  });

  describe("handleCompletePendingLogin", () => {
    const baseOauthData = {
      provider: "google" as const,
      userInfo: {
        id: "oauth-id-123",
        email: "test@example.com",
        given_name: "Test",
        family_name: "User",
        name: "Test User",
      },
      tokens: {
        access_token: "mock-access-token",
        refresh_token: "mock-refresh-token",
        expires_in: 3600,
      },
      cloudUser: {
        id: "cloud-user-id",
        subscription_tier: "free" as const,
        subscription_status: "trial" as const,
        terms_accepted_at: "2024-01-01T00:00:00Z",
        terms_version_accepted: "1.0",
        privacy_policy_version_accepted: "1.0",
      },
    };

    it("should return success with user for new user login", async () => {
      const mockUser = {
        id: "cloud-user-id",
        email: "test@example.com",
        display_name: "Test User",
        is_active: true,
        terms_accepted_at: "2024-01-01T00:00:00Z",
        terms_version_accepted: "1.0",
        privacy_policy_version_accepted: "1.0",
      };

      mockDatabaseService.getUserByOAuthId.mockResolvedValue(null);
      mockDatabaseService.createUser.mockResolvedValue(mockUser);
      mockDatabaseService.getUserById.mockResolvedValue(mockUser);
      mockDatabaseService.updateLastLogin.mockResolvedValue(undefined);
      mockDatabaseService.createSession.mockResolvedValue("mock-session-token");

      const result = await handleCompletePendingLogin(
        {} as any,
        baseOauthData
      );

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.sessionToken).toBe("mock-session-token");
    });

    it("should return success for existing user login", async () => {
      const existingUser = {
        id: "existing-user-id",
        email: "test@example.com",
        display_name: "Test User",
        is_active: true,
        terms_accepted_at: "2024-01-01T00:00:00Z",
        terms_version_accepted: "1.0",
        privacy_policy_version_accepted: "1.0",
      };

      mockDatabaseService.getUserByOAuthId.mockResolvedValue(existingUser);
      mockDatabaseService.getUserById.mockResolvedValue(existingUser);
      mockDatabaseService.updateLastLogin.mockResolvedValue(undefined);
      mockDatabaseService.createSession.mockResolvedValue("mock-session-token");

      const result = await handleCompletePendingLogin(
        {} as any,
        baseOauthData
      );

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
    });

    it("should return error on database failure", async () => {
      mockDatabaseService.getUserByOAuthId.mockRejectedValue(
        new Error("Database connection lost")
      );

      const result = await handleCompletePendingLogin(
        {} as any,
        baseOauthData
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Database connection lost");
    });
  });

  describe("handleSavePendingMailboxTokens", () => {
    const tokenData = {
      userId: "user-123",
      provider: "google" as const,
      email: "user@gmail.com",
      tokens: {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_at: "2024-12-31T00:00:00Z",
        scopes: "mail.read",
      },
    };

    it("should return success when tokens saved successfully", async () => {
      mockDatabaseService.saveOAuthToken.mockResolvedValue(undefined);

      const result = await handleSavePendingMailboxTokens(
        {} as any,
        tokenData
      );

      expect(result.success).toBe(true);
    });

    it("should return error when user not found", async () => {
      const { getValidUserId } = require("../../utils/userIdHelper");
      (getValidUserId as jest.Mock).mockResolvedValueOnce(null);

      const result = await handleSavePendingMailboxTokens(
        {} as any,
        tokenData
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No user found");
    });
  });

  describe("handleDisconnectMailbox", () => {
    it("should return success when mailbox disconnected", async () => {
      mockDatabaseService.deleteOAuthToken.mockResolvedValue(undefined);

      const result = await handleDisconnectMailbox(
        null,
        "user-123",
        "google"
      );

      expect(result.success).toBe(true);
    });

    it("should return error when user not found", async () => {
      const { getValidUserId } = require("../../utils/userIdHelper");
      (getValidUserId as jest.Mock).mockResolvedValueOnce(null);

      const result = await handleDisconnectMailbox(
        null,
        "user-123",
        "microsoft"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No user found");
    });

    it("should return error on database failure", async () => {
      mockDatabaseService.deleteOAuthToken.mockRejectedValue(
        new Error("Delete failed")
      );

      const result = await handleDisconnectMailbox(
        null,
        "user-123",
        "google"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Delete failed");
    });

    it("should log audit entry on success", async () => {
      mockDatabaseService.deleteOAuthToken.mockResolvedValue(undefined);

      await handleDisconnectMailbox(null, "user-123", "google");

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "MAILBOX_DISCONNECT",
          resourceType: "MAILBOX",
          success: true,
        })
      );
    });
  });
});
