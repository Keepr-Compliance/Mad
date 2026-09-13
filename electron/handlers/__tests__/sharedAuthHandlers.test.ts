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

/**
 * BACKLOG-3206 — SECOND LINE OF DEFENCE, and the reason it is needed.
 *
 * This suite calls the real `handleDisconnectMailbox`, which now calls
 * `googleAuthService.revokeToken`, which POSTs to Google's revocation endpoint.
 * Before this change the suite mocked no auth service at all, so an unmocked
 * `revokeToken` would have made a real outbound request to Google from inside
 * jest — against whichever account the machine's credentials belong to.
 *
 * The `googleAuthService` mock below is what stops that. This line is the belt
 * to its braces: nothing in this repository blocks a jest run from making a
 * real network call (there is no `axios` entry in `jest.config.js`'s
 * `moduleNameMapper` and no guard in `tests/setup.js`), so the only thing
 * standing between this suite and a live request is a mock somebody remembered
 * to write. Mocks get under-specified — the sibling suite's `googleAuthService`
 * factory went stale for exactly this method — and this one does not depend on
 * that going right. Filed repo-wide as BACKLOG-3284.
 */
jest.mock("axios");

const mockGoogleAuthService = {
  revokeToken: jest.fn(),
};

jest.mock("../../services/googleAuthService", () => ({
  __esModule: true,
  default: mockGoogleAuthService,
}));

const mockMicrosoftAuthService = {
  revokeToken: jest.fn(),
};

jest.mock("../../services/microsoftAuthService", () => ({
  __esModule: true,
  default: mockMicrosoftAuthService,
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
  // `saveSession` resolves a BOOLEAN — true on success, false when the session
  // could not be encrypted or written (sessionService.ts:287). It never resolves
  // `undefined` and never rejects. BACKLOG-3299.
  saveSession: jest.fn().mockResolvedValue(true),
  getSessionExpirationMs: jest.fn().mockReturnValue(86400000),
};

jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: mockSessionService,
}));

jest.mock("../syncHandlers", () => ({
  setSyncUserId: jest.fn(),
}));

// BACKLOG-2546: the login write chain no longer runs as separate
// `databaseService` calls — it is one transaction owned by
// `loginProvisioningService.provisionLogin`, so that is the interception point
// now. What a partial failure leaves behind is asserted against the REAL driver
// in `db/__tests__/loginProvisioningAtomicity-2546.test.ts`; these cases are
// about the handler's own response shape.
const mockProvisionLogin = jest.fn();

jest.mock("../../services/loginProvisioningService", () => ({
  __esModule: true,
  provisionLogin: (...args: unknown[]) => mockProvisionLogin(...args),
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

      mockProvisionLogin.mockReturnValue({
        user: mockUser,
        sessionToken: "mock-session-token",
        isNewUser: true,
        existingBefore: null,
      });

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

      mockProvisionLogin.mockReturnValue({
        user: existingUser,
        sessionToken: "mock-session-token",
        isNewUser: false,
        existingBefore: existingUser,
      });

      const result = await handleCompletePendingLogin(
        {} as any,
        baseOauthData
      );

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
    });

    it("should return error on database failure", async () => {
      mockProvisionLogin.mockImplementation(() => {
        throw new Error("Database connection lost");
      });

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
    beforeEach(() => {
      // Set explicitly rather than inherited. `jest.clearAllMocks()` clears
      // CALLS, not implementations, so a default set in one test would leak
      // into the next and the leak would read as the handler's own behaviour.
      mockDatabaseService.getOAuthToken.mockResolvedValue(null);
      mockDatabaseService.deleteOAuthToken.mockResolvedValue(undefined);
      mockGoogleAuthService.revokeToken.mockResolvedValue({
        outcome: "revoked",
      });
      mockMicrosoftAuthService.revokeToken.mockResolvedValue({
        outcome: "unsupported",
        message: "Microsoft publishes no revocation endpoint for app grants",
      });
    });

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

    /**
     * BACKLOG-3206 — the disconnect ends the provider's grant, not just the
     * local row.
     *
     * Deleting the row stops this computer reading the mailbox. It does not
     * touch the access the user granted at the provider, so before this the app
     * still held access the user believed they had just taken away. These
     * assertions are the ones that would go green again if the revoke were
     * quietly dropped in a future refactor.
     */
    describe("BACKLOG-3206: revoking the provider grant", () => {
      const googleToken = {
        id: "token-id",
        user_id: "validated-user-id",
        provider: "google" as const,
        purpose: "mailbox" as const,
        access_token: "the-access-token",
        refresh_token: "the-refresh-token",
        mailbox_connected: true,
        token_refresh_failed_count: 0,
        is_active: true,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      };

      // H1
      it("revokes the REFRESH token, once, when one is stored", async () => {
        mockDatabaseService.getOAuthToken.mockResolvedValue(googleToken);

        const result = await handleDisconnectMailbox(
          null,
          "user-123",
          "google"
        );

        expect(mockGoogleAuthService.revokeToken).toHaveBeenCalledTimes(1);
        expect(mockGoogleAuthService.revokeToken).toHaveBeenCalledWith(
          "the-refresh-token"
        );
        expect(result.revokeOutcome).toBe("revoked");
      });

      // H2 — order is the whole point of the design, so it is pinned rather
      // than left to be inferred from the two calls both happening.
      it("revokes BEFORE it deletes the row", async () => {
        mockDatabaseService.getOAuthToken.mockResolvedValue(googleToken);

        await handleDisconnectMailbox(null, "user-123", "google");

        const revokedAt =
          mockGoogleAuthService.revokeToken.mock.invocationCallOrder[0];
        const deletedAt =
          mockDatabaseService.deleteOAuthToken.mock.invocationCallOrder[0];

        expect(revokedAt).toBeDefined();
        expect(deletedAt).toBeDefined();
        expect(revokedAt).toBeLessThan(deletedAt);
      });

      // H3 — the user pressed Disconnect. Whatever the provider does, this
      // computer gets disconnected.
      it("still disconnects, and still deletes, when the revoke throws", async () => {
        mockDatabaseService.getOAuthToken.mockResolvedValue(googleToken);
        mockGoogleAuthService.revokeToken.mockRejectedValue(
          new Error("socket hang up")
        );

        const result = await handleDisconnectMailbox(
          null,
          "user-123",
          "google"
        );

        expect(result.success).toBe(true);
        expect(result.revokeOutcome).toBe("failed");
        expect(mockDatabaseService.deleteOAuthToken).toHaveBeenCalledTimes(1);
      });

      // H4 — the `finally` is the riskiest structural choice in this handler.
      // A throwing read must not skip the delete, and it must not be reported
      // as "there was no token": there may well have been one.
      it("deletes the row and reports read-failed when the token READ throws", async () => {
        mockDatabaseService.getOAuthToken.mockRejectedValue(
          new Error("database is locked")
        );

        const result = await handleDisconnectMailbox(
          null,
          "user-123",
          "google"
        );

        expect(result.success).toBe(true);
        expect(mockDatabaseService.deleteOAuthToken).toHaveBeenCalledTimes(1);
        expect(result.revokeOutcome).toBe("read-failed");
        // Stated as a NEITHER, not just a positive: without this the control
        // passes on the bug it exists to catch.
        expect(result.revokeOutcome).not.toBe("no-token");
        expect(result.revokeOutcome).not.toBe("revoked");
        expect(mockGoogleAuthService.revokeToken).not.toHaveBeenCalled();
      });

      // H5
      it("sends nothing to Google when the row holds no token", async () => {
        mockDatabaseService.getOAuthToken.mockResolvedValue(null);

        const result = await handleDisconnectMailbox(
          null,
          "user-123",
          "google"
        );

        expect(mockGoogleAuthService.revokeToken).not.toHaveBeenCalled();
        expect(mockDatabaseService.deleteOAuthToken).toHaveBeenCalledTimes(1);
        expect(result.revokeOutcome).toBe("no-token");
      });

      // H6 — `refresh_token` is nullable, so this fallback is reachable, not
      // theoretical.
      it("falls back to the access token when no refresh token is stored", async () => {
        mockDatabaseService.getOAuthToken.mockResolvedValue({
          ...googleToken,
          refresh_token: undefined,
        });

        await handleDisconnectMailbox(null, "user-123", "google");

        expect(mockGoogleAuthService.revokeToken).toHaveBeenCalledWith(
          "the-access-token"
        );
      });

      // H7 — Microsoft publishes no revocation endpoint, so the honest report
      // is `unsupported`. It must never come back looking like a success, and
      // it must not read the token row it cannot act on.
      it("reports unsupported for Microsoft, reads no token, calls no Google revoke", async () => {
        const result = await handleDisconnectMailbox(
          null,
          "user-123",
          "microsoft"
        );

        expect(result.success).toBe(true);
        expect(result.revokeOutcome).toBe("unsupported");
        expect(mockGoogleAuthService.revokeToken).not.toHaveBeenCalled();
        expect(mockDatabaseService.getOAuthToken).not.toHaveBeenCalled();
        expect(mockDatabaseService.deleteOAuthToken).toHaveBeenCalledTimes(1);
      });

      // H8 — the audit record is where this is answerable months later.
      it("writes the revoke outcome into the audit metadata", async () => {
        mockDatabaseService.getOAuthToken.mockResolvedValue(googleToken);
        mockGoogleAuthService.revokeToken.mockResolvedValue({
          outcome: "failed",
          reason: "network",
        });

        await handleDisconnectMailbox(null, "user-123", "google");

        expect(mockAuditService.log).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "MAILBOX_DISCONNECT",
            success: true,
            metadata: expect.objectContaining({
              provider: "google",
              revokeOutcome: "failed",
              revokeReason: "network",
            }),
          })
        );
      });

      // A grant Google says is already dead is the state we were asking for,
      // so it is reported as such rather than as a failure.
      it("passes an already-invalid grant through as its own outcome", async () => {
        mockDatabaseService.getOAuthToken.mockResolvedValue(googleToken);
        mockGoogleAuthService.revokeToken.mockResolvedValue({
          outcome: "already-invalid",
          status: 400,
        });

        const result = await handleDisconnectMailbox(
          null,
          "user-123",
          "google"
        );

        expect(result.revokeOutcome).toBe("already-invalid");
      });
    });
  });
});
