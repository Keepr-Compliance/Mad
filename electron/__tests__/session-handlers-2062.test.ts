/**
 * Unit tests for TASK-2062 session handler additions:
 * - session:validate-remote (handleValidateRemoteSession)
 * - session:get-active-devices (handleGetActiveDevices)
 */

// Mock electron
const mockIpcHandle = jest.fn();
jest.mock("electron", () => ({
  ipcMain: {
    handle: mockIpcHandle,
  },
  shell: {
    openExternal: jest.fn(),
  },
}));

// Mock supabaseService
const mockGetClient = jest.fn();
const mockSignOutGlobal = jest.fn();
const mockGetAuthUserId = jest.fn();
const mockGetUserById = jest.fn();
const mockSyncTermsAcceptance = jest.fn();
const mockCompleteEmailOnboarding = jest.fn();

jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: mockGetClient,
    signOut: jest.fn(),
    signOutGlobal: mockSignOutGlobal,
    getAuthUserId: mockGetAuthUserId,
    getUserById: mockGetUserById,
    syncTermsAcceptance: mockSyncTermsAcceptance,
    completeEmailOnboarding: mockCompleteEmailOnboarding,
  },
}));

// Mock deviceService
const mockGetDeviceId = jest.fn();
jest.mock("../services/deviceService", () => ({
  getDeviceId: mockGetDeviceId,
  registerDevice: jest.fn().mockResolvedValue({ success: true }),
}));

// Mock databaseService
jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: jest.fn().mockReturnValue(true),
    validateSession: jest.fn(),
    deleteSession: jest.fn(),
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    getUserByOAuthId: jest.fn(),
    createUser: jest.fn(),
    updateUser: jest.fn(),
    acceptTerms: jest.fn(),
    completeEmailOnboarding: jest.fn(),
    hasCompletedEmailOnboarding: jest.fn(),
    getOAuthToken: jest.fn(),
    clearAllSessions: jest.fn(),
    getRawDatabase: jest.fn(),
  },
}));

// Mock sessionService
jest.mock("../services/sessionService", () => ({
  __esModule: true,
  default: {
    loadSession: jest.fn(),
    clearSession: jest.fn(),
    updateSession: jest.fn(),
  },
}));

// Mock sessionSecurityService
jest.mock("../services/sessionSecurityService", () => ({
  __esModule: true,
  default: {
    checkSessionValidity: jest.fn(),
    recordActivity: jest.fn(),
    cleanupSession: jest.fn(),
  },
}));

// Mock auditService
jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
  },
}));

// Mock logService
jest.mock("../services/logService", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock sync-handlers
jest.mock("../handlers/syncHandlers", () => ({
  setSyncUserId: jest.fn(),
}));

// Mock failureLogService
jest.mock("../services/failureLogService", () => ({
  __esModule: true,
  default: {
    logFailure: jest.fn(),
  },
}));

// Mock @sentry/electron/main
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
}));

// Mock validation utilities
jest.mock("../utils/validation", () => ({
  ValidationError: class ValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ValidationError";
    }
  },
  validateUserId: jest.fn((id: string) => id),
  validateSessionToken: jest.fn((token: string) => token),
}));

// Mock constants
jest.mock("../constants/legalVersions", () => ({
  CURRENT_TERMS_VERSION: "1.0",
  CURRENT_PRIVACY_POLICY_VERSION: "1.0",
}));

import { registerSessionHandlers } from "../handlers/sessionHandlers";

describe("TASK-2062: Session Management Handlers", () => {
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  beforeAll(() => {
    registerSessionHandlers();

    // Capture registered handlers
    for (const call of mockIpcHandle.mock.calls) {
      const [channel, handler] = call;
      handlers[channel] = handler;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("session:validate-remote", () => {
    it("should be registered as a handler", () => {
      expect(handlers["session:validate-remote"]).toBeDefined();
    });

    it("should return { valid: true } when session is valid", async () => {
      mockGetClient.mockReturnValue({
        auth: {
          getUser: jest.fn().mockResolvedValue({
            data: { user: { id: "user-123" } },
            error: null,
          }),
        },
      });

      const result = await handlers["session:validate-remote"]();
      expect(result).toEqual({ valid: true });
    });

    it("should return { valid: false } when session is genuinely revoked (getUser + refresh both fail with auth error)", async () => {
      // BACKLOG-2346: getUser failing is no longer sufficient — the handler now
      // attempts a refresh first. A genuine remote revocation (Sign Out All
      // Devices / reused refresh token) also fails the refresh with a 4xx auth
      // error, which is the ONLY thing that should still log the user out.
      mockGetClient.mockReturnValue({
        auth: {
          getUser: jest.fn().mockResolvedValue({
            data: { user: null },
            error: { message: "Invalid Refresh Token", status: 401 },
          }),
          refreshSession: jest.fn().mockResolvedValue({
            data: { session: null },
            error: { message: "refresh_token_not_found", status: 400 },
          }),
        },
      });

      const result = await handlers["session:validate-remote"]();
      expect(result).toEqual({ valid: false });
    });

    it("should return { valid: false } when user is null and refresh cannot recover", async () => {
      mockGetClient.mockReturnValue({
        auth: {
          getUser: jest.fn().mockResolvedValue({
            data: { user: null },
            error: null,
          }),
          refreshSession: jest.fn().mockResolvedValue({
            data: { session: null },
            error: { message: "Auth session missing", status: 401 },
          }),
        },
      });

      const result = await handlers["session:validate-remote"]();
      expect(result).toEqual({ valid: false });
    });

    // BACKLOG-2346: an expired-but-refreshable access token must NOT force a
    // false logout — getUser() does not refresh, so the handler retries via
    // refreshSession() and treats a successful refresh as a valid session.
    it("should return { valid: true } when the access token was merely expired (refresh succeeds)", async () => {
      const refreshSession = jest.fn().mockResolvedValue({
        data: { session: { access_token: "new", refresh_token: "new" } },
        error: null,
      });
      mockGetClient.mockReturnValue({
        auth: {
          getUser: jest.fn().mockResolvedValue({
            data: { user: null },
            error: { message: "invalid JWT: token is expired", status: 401 },
          }),
          refreshSession,
        },
      });

      const result = await handlers["session:validate-remote"]();
      expect(result).toEqual({ valid: true });
      expect(refreshSession).toHaveBeenCalledTimes(1);
    });

    // BACKLOG-2346: a refresh that fails with a network / 5xx error is NOT proof
    // of invalidation — assume valid so a connectivity blip never logs the user out.
    it("should return { valid: true } when the refresh hits a network / 5xx error", async () => {
      mockGetClient.mockReturnValue({
        auth: {
          getUser: jest.fn().mockResolvedValue({
            data: { user: null },
            error: { message: "invalid JWT: token is expired", status: 401 },
          }),
          refreshSession: jest.fn().mockResolvedValue({
            data: { session: null },
            error: { message: "service unavailable", status: 503 },
          }),
        },
      });

      const result = await handlers["session:validate-remote"]();
      expect(result).toEqual({ valid: true });
    });

    it("should return { valid: true } when the refresh throws (network exception)", async () => {
      mockGetClient.mockReturnValue({
        auth: {
          getUser: jest.fn().mockResolvedValue({
            data: { user: null },
            error: { message: "invalid JWT: token is expired", status: 401 },
          }),
          refreshSession: jest.fn().mockRejectedValue(new Error("Network error")),
        },
      });

      const result = await handlers["session:validate-remote"]();
      expect(result).toEqual({ valid: true });
    });

    it("should return { valid: true } on network error (catch block)", async () => {
      mockGetClient.mockReturnValue({
        auth: {
          getUser: jest.fn().mockRejectedValue(new Error("Network error")),
        },
      });

      const result = await handlers["session:validate-remote"]();
      expect(result).toEqual({ valid: true });
    });
  });

  describe("session:get-active-devices", () => {
    it("should be registered as a handler", () => {
      expect(handlers["session:get-active-devices"]).toBeDefined();
    });

    it("should return devices with isCurrentDevice flag", async () => {
      const mockDevices = [
        { device_id: "device-1", device_name: "MacBook Pro", os: "macOS 14", platform: "macos", last_seen_at: "2024-01-01T00:00:00Z" },
        { device_id: "device-2", device_name: "Windows PC", os: "Windows 11", platform: "windows", last_seen_at: "2024-01-01T00:00:00Z" },
      ];

      mockGetClient.mockReturnValue({
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                order: jest.fn().mockResolvedValue({
                  data: mockDevices,
                  error: null,
                }),
              }),
            }),
          }),
        }),
      });

      mockGetDeviceId.mockReturnValue("device-1");

      const result = await handlers["session:get-active-devices"]({} as unknown, "user-123") as {
        success: boolean;
        devices: Array<{ device_id: string; isCurrentDevice: boolean }>;
      };

      expect(result.success).toBe(true);
      expect(result.devices).toHaveLength(2);
      expect(result.devices[0].isCurrentDevice).toBe(true);
      expect(result.devices[1].isCurrentDevice).toBe(false);
    });

    it("should return error when Supabase query fails", async () => {
      mockGetClient.mockReturnValue({
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                order: jest.fn().mockResolvedValue({
                  data: null,
                  error: { message: "Table not found" },
                }),
              }),
            }),
          }),
        }),
      });

      const result = await handlers["session:get-active-devices"]({} as unknown, "user-123") as {
        success: boolean;
        error: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Table not found");
    });

    it("should return empty devices array when no devices found", async () => {
      mockGetClient.mockReturnValue({
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                order: jest.fn().mockResolvedValue({
                  data: [],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      });

      mockGetDeviceId.mockReturnValue("device-1");

      const result = await handlers["session:get-active-devices"]({} as unknown, "user-123") as {
        success: boolean;
        devices: unknown[];
      };

      expect(result.success).toBe(true);
      expect(result.devices).toHaveLength(0);
    });
  });
});
