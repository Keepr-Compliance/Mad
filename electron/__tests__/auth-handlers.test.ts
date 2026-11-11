/**
 * Unit tests for Auth Handlers
 * Tests authentication IPC handlers including:
 * - Google and Microsoft login flows
 * - Session management
 * - Terms acceptance
 * - Logout
 */

import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
  type RegisteredIpcHandler,
} from "../../tests/support/ipcHandlerRegistry";
import type { IpcMainInvokeEvent } from "electron";

// Mock electron module - must be defined before jest.mock for hoisting
const mockIpcHandle = jest.fn();
const mockShellOpenExternal = jest.fn();

jest.mock("electron", () => ({
  ipcMain: {
    handle: mockIpcHandle,
  },
  app: {
    getVersion: jest.fn().mockReturnValue("1.0.0"),
  },
  shell: {
    openExternal: mockShellOpenExternal,
  },
  BrowserWindow: jest.fn().mockImplementation(() => ({
    loadURL: jest.fn(),
    close: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
    on: jest.fn(), // For 'closed' event listener
    isDestroyed: jest.fn().mockReturnValue(false),
    webContents: {
      on: jest.fn(),
      send: jest.fn(),
      session: {
        webRequest: {
          onHeadersReceived: jest.fn(),
        },
      },
    },
  })),
}));

// Mock crypto
jest.mock("crypto", () => ({
  randomUUID: jest.fn().mockReturnValue("test-uuid"),
}));

// Mock os
jest.mock("os", () => ({
  hostname: jest.fn().mockReturnValue("test-host"),
  platform: jest.fn().mockReturnValue("darwin"),
  release: jest.fn().mockReturnValue("21.0.0"),
}));

// Mock services with inline factories (hoisting-safe)
jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    initialize: jest.fn().mockResolvedValue(undefined),
    isInitialized: jest.fn().mockReturnValue(true),
    getUserByOAuthId: jest.fn(),
    createUser: jest.fn(),
    updateUser: jest.fn(),
    updateLastLogin: jest.fn(),
    getUserById: jest.fn(),
    saveOAuthToken: jest.fn(),
    deleteOAuthToken: jest.fn().mockResolvedValue(undefined),
    createSession: jest.fn(),
    validateSession: jest.fn(),
    deleteSession: jest.fn(),
    acceptTerms: jest.fn(),
    hasCompletedEmailOnboarding: jest.fn(),
    completeEmailOnboarding: jest.fn().mockResolvedValue(undefined),
    getOAuthToken: jest.fn(),
  },
}));

/**
 * BACKLOG-3206 — SECOND LINE OF DEFENCE.
 *
 * The disconnect handlers registered by this suite now call
 * `googleAuthService.revokeToken`, which POSTs to Google's revocation endpoint.
 * The factory below mocks that service — but the factory is a WHITELIST, and
 * this one had already gone stale for `revokeToken` before the method had a
 * caller: every method it does not list resolves to `undefined`, so the call
 * would have thrown a `TypeError`, been swallowed by the handler's catch, and
 * the suite would have passed on the failure path without anybody noticing.
 *
 * Nothing in this repository blocks a jest run from making a real outbound
 * request — `jest.config.js`'s `moduleNameMapper` has no `axios` entry and
 * `tests/setup.js` installs no network guard — so the whitelist going stale in
 * the other direction (a future edit dropping the service mock) would put a
 * live request to Google inside a unit test. This line makes that impossible
 * independently of the factory below. Filed repo-wide as BACKLOG-3284.
 */
jest.mock("axios");

jest.mock("../services/googleAuthService", () => ({
  __esModule: true,
  default: {
    authenticateForMailbox: jest.fn(),
    exchangeCodeForTokens: jest.fn(),
    getUserInfo: jest.fn(),
    stopLocalServer: jest.fn(),
    revokeToken: jest.fn().mockResolvedValue({ outcome: "revoked" }),
  },
}));

jest.mock("../services/microsoftAuthService", () => ({
  __esModule: true,
  default: {
    authenticateForMailbox: jest.fn(),
    exchangeCodeForTokens: jest.fn(),
    getUserInfo: jest.fn(),
    stopLocalServer: jest.fn(),
    revokeToken: jest.fn().mockResolvedValue({
      outcome: "unsupported",
      message: "Microsoft publishes no revocation endpoint for app grants",
    }),
  },
}));

jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: {
    syncUser: jest.fn(),
    validateSubscription: jest.fn(),
    registerDevice: jest.fn(),
    trackEvent: jest.fn(),
    syncTermsAcceptance: jest.fn(),
    // TASK-1507G: Add getAuthUserId for unified ID handling
    getAuthUserId: jest.fn().mockReturnValue(null),
  },
}));

jest.mock("../services/tokenEncryptionService", () => ({
  __esModule: true,
  default: {
    encrypt: jest.fn().mockReturnValue("encrypted-token"),
  },
}));

jest.mock("../services/sessionService", () => ({
  __esModule: true,
  default: {
    saveSession: jest.fn(),
    loadSession: jest.fn(),
    clearSession: jest.fn(),
    getSessionExpirationMs: jest.fn().mockReturnValue(86400000),
  },
}));

jest.mock("../services/rateLimitService", () => ({
  __esModule: true,
  default: {
    recordAttempt: jest.fn(),
  },
}));

jest.mock("../services/sessionSecurityService", () => ({
  __esModule: true,
  default: {
    checkSessionValidity: jest.fn(),
    recordActivity: jest.fn(),
    cleanupSession: jest.fn(),
  },
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(),
    log: jest.fn().mockResolvedValue(undefined),
    // BACKLOG-3052: initializeDatabase now wires the support-access gate as
    // well as initializing the service. A mock that stops at `initialize`
    // describes an auditService that no longer exists, and the handler dies
    // on `setSupportAccessGate is not a function` before it reaches anything
    // this suite is actually asserting.
    setSupportAccessGate: jest.fn(),
  },
}));

// BACKLOG-3052: `authHandlers` imports the support-access barrel, which
// reaches keychainGate, the encryption service and the diagnostics collector.
// None of that belongs in a handler unit suite, and the gate closure is never
// invoked here — only handed to the (mocked) audit service.
jest.mock("../services/supportAccess", () => ({
  getSupportAccess: jest.fn(() => ({
    access: { isActive: jest.fn(() => false) },
  })),
}));

jest.mock("../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock sync-handlers for setSyncUserId
jest.mock("../handlers/syncHandlers", () => ({
  setSyncUserId: jest.fn(),
}));

// NOTE: We do NOT mock the handler modules (googleAuthHandlers, microsoftAuthHandlers, etc.)
// because the tests need to exercise the real handler registration functions.
// The individual handlers use services (databaseService, googleAuthService, etc.) which
// ARE mocked above, so the handlers will work with mocked dependencies.

// Import after mocks are set up
import { registerAuthHandlers, initializeDatabase } from "../handlers/authHandlers";
import { setMainWindow } from "../windowRegistry";
import databaseService from "../services/databaseService";
import googleAuthService from "../services/googleAuthService";
import microsoftAuthService from "../services/microsoftAuthService";
import supabaseService from "../services/supabaseService";
import sessionService from "../services/sessionService";
import sessionSecurityService from "../services/sessionSecurityService";
import auditService from "../services/auditService";
import logService from "../services/logService";

// Get typed references to mocked services
const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;
const mockGoogleAuthService = googleAuthService as jest.Mocked<
  typeof googleAuthService
>;
const mockMicrosoftAuthService = microsoftAuthService as jest.Mocked<
  typeof microsoftAuthService
>;
const mockSupabaseService = supabaseService as jest.Mocked<
  typeof supabaseService
>;
const mockSessionService = sessionService as jest.Mocked<typeof sessionService>;
const mockSessionSecurityService = sessionSecurityService as jest.Mocked<
  typeof sessionSecurityService
>;
const mockAuditService = auditService as jest.Mocked<typeof auditService>;
const mockLogService = logService as jest.Mocked<typeof logService>;

/**
 * Type-level only — returns its argument completely unchanged (BACKLOG-2414).
 *
 * This suite mocks service reads with PARTIAL fixtures: each one carries only
 * the fields the handler under test actually reads. Now that the suite is
 * type-checked, every fixture would otherwise have to be padded with invented
 * values to satisfy the full production model (`User`, `OAuthToken`, `Session`,
 * `AuthFlowResult`, …) — which would change what the handlers see and what the
 * assertions mean.
 *
 * `fixture()` reconciles the types instead, so every mocked payload stays
 * exactly what the test wrote. `T` is inferred from the call site, so each use
 * is still checked against the real production type of that mock; the single
 * cast lives here rather than being repeated at ~40 call sites.
 *
 * Note: the types involved (`AuthFlowResult`, `DeviceRecord`, `SessionData`)
 * are not exported by their modules, so they cannot be named directly here.
 */
function fixture<T>(value: unknown): T {
  return value as T;
}

// Test UUIDs
const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_SESSION_TOKEN = "550e8400-e29b-41d4-a716-446655440001-session-token";

describe("Auth Handlers", () => {
  let registeredHandlers: IpcHandlerRegistry;
  const mockEvent = {} as IpcMainInvokeEvent;
  const mockMainWindow = {
    isDestroyed: jest.fn().mockReturnValue(false),
    webContents: {
      send: jest.fn(),
    },
  };

  beforeAll(() => {
    // Capture registered handlers
    registeredHandlers = createIpcHandlerRegistry();
    mockIpcHandle.mockImplementation((channel: string, handler: RegisteredIpcHandler) => {
      registeredHandlers.set(channel, handler);
    });

    // Register all handlers
    // BACKLOG-3454: the window is no longer captured at registration — every
    // push resolves the live one through the registry, so the stand-in has to
    // be the registered window rather than an argument.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMainWindow(mockMainWindow as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAuthHandlers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("initializeDatabase", () => {
    it("should initialize database and audit service", async () => {
      await initializeDatabase();

      expect(mockDatabaseService.initialize).toHaveBeenCalledTimes(1);
      expect(mockAuditService.initialize).toHaveBeenCalledWith(
        mockDatabaseService,
        mockSupabaseService,
      );
      // BACKLOG-3052: initializing the audit service is only half the job —
      // without the gate, `supportAccessGate` stays null, the service reads
      // "no grant" forever, and contact names are stripped from every upload
      // even during a live support window. The gate's own behaviour (lazy
      // read, singleton untouched) is pinned in
      // handlers/__tests__/authHandlers.initOptions-2999.test.ts.
      expect(mockAuditService.setSupportAccessGate).toHaveBeenCalledTimes(1);
      expect(mockLogService.debug).toHaveBeenCalledWith(
        "Database initialized",
        "AuthHandlers",
      );
    });

    it("should handle database initialization failure", async () => {
      mockDatabaseService.initialize.mockRejectedValueOnce(
        new Error("DB init failed"),
      );

      await expect(initializeDatabase()).rejects.toThrow("DB init failed");
      expect(mockLogService.error).toHaveBeenCalled();
    });
  });

  describe("auth:google:connect-mailbox", () => {
    const mockUser = {
      id: TEST_USER_ID,
      email: "test@example.com",
    };

    beforeEach(() => {
      mockDatabaseService.getUserById.mockResolvedValue(fixture(mockUser));
      mockGoogleAuthService.authenticateForMailbox.mockResolvedValue(fixture({
        authUrl: "https://accounts.google.com/oauth/mailbox",
        codePromise: new Promise(() => {}), // Never resolves in test
        scopes: ["gmail.readonly"],
      }));
    });

    it("should start mailbox connection flow", async () => {
      const handler = registeredHandlers.get("auth:google:connect-mailbox");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.authUrl).toBe("https://accounts.google.com/oauth/mailbox");
      expect(result.scopes).toContain("gmail.readonly");
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("auth:google:connect-mailbox");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("auth:microsoft:connect-mailbox", () => {
    beforeEach(() => {
      mockDatabaseService.getUserById.mockResolvedValue(fixture({
        id: TEST_USER_ID,
        email: "test@example.com",
      }));
      mockMicrosoftAuthService.authenticateForMailbox.mockResolvedValue({
        authUrl: "https://login.microsoftonline.com/oauth/mailbox",
        codePromise: new Promise(() => {}),
        codeVerifier: "verifier-123",
        scopes: ["Mail.Read"],
      });
    });

    it("should start Microsoft mailbox connection flow", async () => {
      const handler = registeredHandlers.get("auth:microsoft:connect-mailbox");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.authUrl).toContain("microsoftonline");
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("auth:microsoft:connect-mailbox");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
    });
  });

  describe("auth:logout", () => {
    // BACKLOG-2132: after the validateSession JOIN de-collision, `id` is the
    // SESSION uuid while `user_id` is the account id. The logout audit entry
    // must record the ACCOUNT id, so give the mock a distinct session id to
    // pin the correct field.
    const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440099-session-id";
    beforeEach(() => {
      mockDatabaseService.validateSession.mockResolvedValue(fixture({
        id: TEST_SESSION_ID,
        user_id: TEST_USER_ID,
      }));
    });

    it("should logout user successfully", async () => {
      const handler = registeredHandlers.get("auth:logout");
      const result = await handler(mockEvent, TEST_SESSION_TOKEN);

      expect(result.success).toBe(true);
      expect(mockDatabaseService.deleteSession).toHaveBeenCalledWith(
        TEST_SESSION_TOKEN,
      );
      expect(mockSessionService.clearSession).toHaveBeenCalled();
      expect(mockSessionSecurityService.cleanupSession).toHaveBeenCalled();
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "LOGOUT",
          success: true,
        }),
      );
    });

    it("records the ACCOUNT id (user_id), not the session id, in the logout audit entry (BACKLOG-2132)", async () => {
      const handler = registeredHandlers.get("auth:logout");
      await handler(mockEvent, TEST_SESSION_TOKEN);

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "LOGOUT",
          userId: TEST_USER_ID,
        }),
      );
      // Guard against regressing to session.id (the collision-era behavior).
      expect(mockAuditService.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: TEST_SESSION_ID }),
      );
    });

    it("should handle invalid session token", async () => {
      const handler = registeredHandlers.get("auth:logout");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });

    it("should handle logout failure gracefully", async () => {
      mockDatabaseService.deleteSession.mockRejectedValue(
        new Error("DB error"),
      );

      const handler = registeredHandlers.get("auth:logout");
      const result = await handler(mockEvent, TEST_SESSION_TOKEN);

      expect(result.success).toBe(false);
      expect(result.error).toContain("DB error");
    });
  });

  describe("auth:accept-terms", () => {
    it("should accept terms successfully", async () => {
      const updatedUser = {
        id: TEST_USER_ID,
        terms_accepted_at: new Date().toISOString(),
      };
      mockDatabaseService.acceptTerms.mockResolvedValue(fixture(updatedUser));
      mockSupabaseService.syncTermsAcceptance.mockResolvedValue(fixture(undefined));

      const handler = registeredHandlers.get("auth:accept-terms");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(mockLogService.info).toHaveBeenCalled();
    });

    it("should handle Supabase sync failure gracefully", async () => {
      mockDatabaseService.acceptTerms.mockResolvedValue(fixture({ id: TEST_USER_ID }));
      mockSupabaseService.syncTermsAcceptance.mockRejectedValue(
        new Error("Sync failed"),
      );

      const handler = registeredHandlers.get("auth:accept-terms");
      const result = await handler(mockEvent, TEST_USER_ID);

      // Should still succeed even if sync fails
      expect(result.success).toBe(true);
      expect(mockLogService.warn).toHaveBeenCalled();
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("auth:accept-terms");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });
  });

  describe("auth:validate-session", () => {
    const mockSession = {
      user_id: TEST_USER_ID,
      created_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString(),
    };

    beforeEach(() => {
      mockDatabaseService.validateSession.mockResolvedValue(fixture(mockSession));
      mockSessionSecurityService.checkSessionValidity.mockResolvedValue({
        valid: true,
      });
    });

    it("should validate session successfully", async () => {
      const handler = registeredHandlers.get("auth:validate-session");
      const result = await handler(mockEvent, TEST_SESSION_TOKEN);

      expect(result.success).toBe(true);
      expect(result.valid).toBe(true);
      expect(mockSessionSecurityService.recordActivity).toHaveBeenCalled();
    });

    it("should return invalid for non-existent session", async () => {
      mockDatabaseService.validateSession.mockResolvedValue(null);

      const handler = registeredHandlers.get("auth:validate-session");
      const result = await handler(mockEvent, TEST_SESSION_TOKEN);

      expect(result.success).toBe(false);
      expect(result.valid).toBe(false);
    });

    it("should clean up expired session", async () => {
      // Reset deleteSession mock to resolve (it might be set to reject from previous tests)
      mockDatabaseService.deleteSession.mockResolvedValue(undefined);
      mockSessionSecurityService.checkSessionValidity.mockResolvedValue({
        valid: false,
        reason: "expired",
      });

      const handler = registeredHandlers.get("auth:validate-session");
      const result = await handler(mockEvent, TEST_SESSION_TOKEN);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Session expired");
      expect(mockDatabaseService.deleteSession).toHaveBeenCalled();
      // sessionSecurityService.cleanupSession is a sync function, verify it was called
      expect(mockSessionSecurityService.cleanupSession).toHaveBeenCalledWith(
        TEST_SESSION_TOKEN,
      );
    });

    it("should handle invalid session token format", async () => {
      const handler = registeredHandlers.get("auth:validate-session");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Validation error");
    });
  });

  describe("auth:get-current-user", () => {
    const mockSessionData = {
      user: { id: TEST_USER_ID, email: "test@example.com" },
      sessionToken: "session-token-123",
      provider: "google",
      subscription: { tier: "pro" },
    };

    const mockDbSession = {
      user_id: TEST_USER_ID,
      created_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString(),
    };

    beforeEach(() => {
      mockSessionService.loadSession.mockResolvedValue(fixture(mockSessionData));
      mockDatabaseService.validateSession.mockResolvedValue(fixture(mockDbSession));
      mockSessionSecurityService.checkSessionValidity.mockResolvedValue({
        valid: true,
      });
      mockDatabaseService.getUserById.mockResolvedValue(fixture({
        id: TEST_USER_ID,
        email: "test@example.com",
        terms_accepted_at: new Date().toISOString(),
      }));
    });

    it("should return current user successfully", async () => {
      const handler = registeredHandlers.get("auth:get-current-user");
      const result = await handler(mockEvent);

      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.sessionToken).toBe("session-token-123");
      expect(result.provider).toBe("google");
    });

    it("should return error when no active session", async () => {
      mockSessionService.loadSession.mockResolvedValue(null);

      const handler = registeredHandlers.get("auth:get-current-user");
      const result = await handler(mockEvent);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No active session");
    });

    it("should clear session when database validation fails", async () => {
      mockDatabaseService.validateSession.mockResolvedValue(null);

      const handler = registeredHandlers.get("auth:get-current-user");
      const result = await handler(mockEvent);

      expect(result.success).toBe(false);
      expect(mockSessionService.clearSession).toHaveBeenCalled();
    });

    it("should handle expired session", async () => {
      // Reset mocks and set up this test specifically
      mockDatabaseService.deleteSession.mockResolvedValue(undefined);
      // SessionValidityResult.reason is typed `"expired" | "idle" | "invalid"`,
      // but this test pins the rendered error string "Session idle timeout", so
      // the fixture keeps the literal the assertion depends on.
      mockSessionSecurityService.checkSessionValidity.mockResolvedValue(
        fixture({
          valid: false,
          reason: "idle timeout",
        }),
      );

      const handler = registeredHandlers.get("auth:get-current-user");
      const result = await handler(mockEvent);

      expect(result.success).toBe(false);
      // Error format is "Session {reason}"
      expect(result.error).toBe("Session idle timeout");
    });
  });

  // Note: shell:open-external handler tests are in system-handlers.test.ts

  describe("auth:google:disconnect-mailbox", () => {
    it("should disconnect Google mailbox successfully", async () => {
      const handler = registeredHandlers.get("auth:google:disconnect-mailbox");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(mockDatabaseService.deleteOAuthToken).toHaveBeenCalledWith(
        TEST_USER_ID,
        "google",
        "mailbox",
      );
      // BACKLOG-3206: `expect.objectContaining` is loose only at the TOP
      // level — a nested object is compared exactly — so this had to be
      // loosened for `revokeOutcome` to be admitted. The positive assertion
      // moves down a line rather than disappearing: no token row is stored in
      // this fixture, so nothing was sent to Google and `no-token` is the
      // honest report.
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "MAILBOX_DISCONNECT",
          resourceType: "MAILBOX",
          metadata: expect.objectContaining({
            provider: "google",
            revokeOutcome: "no-token",
          }),
          success: true,
        }),
      );
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        "google:mailbox-disconnected",
        { success: true },
      );
    });

    /**
     * BACKLOG-3156 stage C — THE DISCONNECT DIALOG'S CLAIM, CHECKED WHERE IT
     * CAN BE.
     *
     * The confirmation added to Settings > Emails tells the user that emails
     * and contacts already stored on this computer are KEPT. That is a claim
     * about this handler, and no renderer test can see it, so it is asserted
     * here: the whole disconnect path makes exactly one database WRITE, the
     * token delete.
     *
     * BACKLOG-3206 admitted a third name, `getOAuthToken`. The claim this pin
     * guards is about what gets thrown away, and a read cannot throw anything
     * away — the handler now reads the token row so it can ask Google to end
     * the grant before the row goes. Moving that read somewhere else to keep
     * the set at two would have been fixing the measurement instead of the
     * claim.
     *
     * So the pin gets a second half rather than a wider allowance: exactly one
     * of the called methods may be write-shaped. A future change that added a
     * second write — a second `DELETE`, an `UPDATE`, anything that removes or
     * rewrites stored data — reds the write assertion even though the name set
     * was updated to admit it.
     *
     * Enumerated from the mock by execution rather than compared against a list
     * written by hand, so a mutation that added a second write shows up as a
     * new NAME in the failure rather than having to be predicted.
     *
     * The set is small because the mock is a partial one: a call to a
     * databaseService method it does not define would throw, the handler would
     * catch it, and `success` would come back false — so that shape is caught
     * too, by the assertion on the line above.
     */
    it("touches the database exactly twice: resolve the user, delete the token", async () => {
      // Set explicitly rather than inherited. `jest.clearAllMocks()` in this
      // file's `beforeEach` clears CALLS but not implementations, so the
      // sibling disconnect tests only pass because an earlier test in the file
      // left `getUserById` resolving — each of them fails when run alone with
      // `-t`. This one does not rely on that.
      mockDatabaseService.getUserById.mockResolvedValue({
        id: TEST_USER_ID,
      } as never);

      const handler = registeredHandlers.get("auth:google:disconnect-mailbox");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);

      const called = Object.entries(
        mockDatabaseService as unknown as Record<string, unknown>,
      )
        .filter(
          ([, value]) =>
            typeof value === "function" &&
            ((value as jest.Mock).mock?.calls.length ?? 0) > 0,
        )
        .map(([name]) => name)
        .sort();

      expect(called).toEqual([
        "deleteOAuthToken",
        "getOAuthToken",
        "getUserById",
      ]);

      // The half that keeps enforcing the docstring now that a third name is
      // admitted. Matched on the name, because that is what the enumeration
      // above yields — a method whose name starts with one of these verbs
      // changes stored data.
      const writeShaped = called.filter((name) =>
        /^(accept|clear|complete|create|delete|drop|insert|purge|remove|reset|save|set|update|upsert|write)/.test(
          name,
        ),
      );

      expect(writeShaped).toEqual(["deleteOAuthToken"]);
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get("auth:google:disconnect-mailbox");
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    /**
     * BACKLOG-3206 — THIS ALSO GUARDS THE `finally`. Do not delete it as a
     * duplicate of the sibling error tests.
     *
     * The disconnect handler deletes the token row in a `finally`, so the row
     * goes whatever the revoke does. That makes this test load-bearing in a way
     * its name does not say: rejecting `deleteOAuthToken` is now a rejection
     * raised INSIDE a `finally`, and what this asserts is that it still
     * propagates out of the handler as `success: false` with the message
     * intact.
     *
     * The mutation that reds it is the "let's be safe" refactor a future author
     * will reach for: wrap the `finally`'s delete in its own try/catch. Run
     * 2026-09-12 against the real implementation — 2 failed, this test and its
     * Microsoft twin below.
     */
    it("should handle database error during disconnect", async () => {
      mockDatabaseService.deleteOAuthToken.mockRejectedValueOnce(
        new Error("Database error"),
      );

      const handler = registeredHandlers.get("auth:google:disconnect-mailbox");
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Database error");
      expect(mockLogService.error).toHaveBeenCalled();
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "MAILBOX_DISCONNECT",
          success: false,
        }),
      );
    });

    it("should log disconnect operation", async () => {
      const handler = registeredHandlers.get("auth:google:disconnect-mailbox");
      await handler(mockEvent, TEST_USER_ID);

      expect(mockLogService.info).toHaveBeenCalledWith(
        "Starting google mailbox disconnect",
        "AuthHandlers",
        { userId: TEST_USER_ID },
      );
      expect(mockLogService.info).toHaveBeenCalledWith(
        "google mailbox disconnected successfully",
        "AuthHandlers",
        { userId: TEST_USER_ID },
      );
    });
  });

  describe("auth:microsoft:disconnect-mailbox", () => {
    it("should disconnect Microsoft mailbox successfully", async () => {
      const handler = registeredHandlers.get(
        "auth:microsoft:disconnect-mailbox",
      );
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(true);
      expect(mockDatabaseService.deleteOAuthToken).toHaveBeenCalledWith(
        TEST_USER_ID,
        "microsoft",
        "mailbox",
      );
      // BACKLOG-3206: as above. `unsupported` is the whole Microsoft story —
      // Microsoft publishes no revocation endpoint, and asserting it here is
      // what stops that path ever reporting a success it did not earn.
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "MAILBOX_DISCONNECT",
          resourceType: "MAILBOX",
          metadata: expect.objectContaining({
            provider: "microsoft",
            revokeOutcome: "unsupported",
          }),
          success: true,
        }),
      );
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        "microsoft:mailbox-disconnected",
        { success: true },
      );
    });

    it("should handle invalid user ID", async () => {
      const handler = registeredHandlers.get(
        "auth:microsoft:disconnect-mailbox",
      );
      const result = await handler(mockEvent, "");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    /**
     * BACKLOG-3206 — THIS ALSO GUARDS THE `finally`. Do not delete it as a
     * duplicate of the sibling error tests.
     *
     * The disconnect handler deletes the token row in a `finally`, so the row
     * goes whatever the revoke does. That makes this test load-bearing in a way
     * its name does not say: rejecting `deleteOAuthToken` is now a rejection
     * raised INSIDE a `finally`, and what this asserts is that it still
     * propagates out of the handler as `success: false` with the message
     * intact.
     *
     * The mutation that reds it is the "let's be safe" refactor a future author
     * will reach for: wrap the `finally`'s delete in its own try/catch. Run
     * 2026-09-12 against the real implementation — 2 failed, this test and its
     * Google twin above.
     */
    it("should handle database error during disconnect", async () => {
      mockDatabaseService.deleteOAuthToken.mockRejectedValueOnce(
        new Error("Database error"),
      );

      const handler = registeredHandlers.get(
        "auth:microsoft:disconnect-mailbox",
      );
      const result = await handler(mockEvent, TEST_USER_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Database error");
      expect(mockLogService.error).toHaveBeenCalled();
    });

    it("should log disconnect operation", async () => {
      const handler = registeredHandlers.get(
        "auth:microsoft:disconnect-mailbox",
      );
      await handler(mockEvent, TEST_USER_ID);

      expect(mockLogService.info).toHaveBeenCalledWith(
        "Starting microsoft mailbox disconnect",
        "AuthHandlers",
        { userId: TEST_USER_ID },
      );
      expect(mockLogService.info).toHaveBeenCalledWith(
        "microsoft mailbox disconnected successfully",
        "AuthHandlers",
        { userId: TEST_USER_ID },
      );
    });
  });

  describe("Mailbox Connection via System Browser (BACKLOG-1570)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockDatabaseService.getUserById.mockResolvedValue(fixture({
        id: TEST_USER_ID,
        email: "test@example.com",
      }));
    });

    it("should open system browser for Google mailbox connect", async () => {
      mockGoogleAuthService.authenticateForMailbox.mockResolvedValue(fixture({
        authUrl: "https://accounts.google.com/oauth/mailbox",
        codePromise: new Promise(() => {}),
        scopes: ["gmail.readonly"],
      }));

      const handler = registeredHandlers.get("auth:google:connect-mailbox");
      await handler(mockEvent, TEST_USER_ID);

      // System browser used instead of BrowserWindow popup (RFC 8252)
      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "https://accounts.google.com/oauth/mailbox",
      );
    });

    it("should open system browser for Microsoft mailbox connect", async () => {
      mockMicrosoftAuthService.authenticateForMailbox.mockResolvedValue({
        authUrl: "https://login.microsoftonline.com/oauth/mailbox",
        codePromise: new Promise(() => {}),
        codeVerifier: "verifier-123",
        scopes: ["Mail.Read"],
      });

      const handler = registeredHandlers.get("auth:microsoft:connect-mailbox");
      await handler(mockEvent, TEST_USER_ID);

      // System browser used instead of BrowserWindow popup (RFC 8252)
      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "https://login.microsoftonline.com/oauth/mailbox",
      );
    });
  });

  describe("OAuth Popup Window Security Configuration", () => {
    const { BrowserWindow } = require("electron");

    beforeEach(() => {
      jest.clearAllMocks();
      // Track BrowserWindow constructor calls
      BrowserWindow.mockClear();
    });

    it("should use system browser for Google mailbox connect (RFC 8252)", async () => {
      mockDatabaseService.getUserById.mockResolvedValue(fixture({
        id: TEST_USER_ID,
        email: "test@example.com",
      }));

      mockGoogleAuthService.authenticateForMailbox.mockResolvedValue(fixture({
        authUrl: "https://accounts.google.com/oauth/mailbox",
        codePromise: new Promise<string>(() => {}),
        scopes: ["gmail.readonly"],
      }));

      const handler = registeredHandlers.get("auth:google:connect-mailbox");
      await handler(mockEvent, TEST_USER_ID);

      // Verify system browser is used instead of BrowserWindow (BACKLOG-1570)
      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "https://accounts.google.com/oauth/mailbox",
      );
    });

    it("should use system browser for Microsoft mailbox connect (RFC 8252)", async () => {
      mockDatabaseService.getUserById.mockResolvedValue(fixture({
        id: TEST_USER_ID,
        email: "test@example.com",
      }));

      mockMicrosoftAuthService.authenticateForMailbox.mockResolvedValue({
        authUrl: "https://login.microsoftonline.com/oauth/mailbox",
        codePromise: new Promise<string>(() => {}),
        codeVerifier: "verifier-456",
        scopes: ["Mail.Read"],
      });

      const handler = registeredHandlers.get("auth:microsoft:connect-mailbox");
      await handler(mockEvent, TEST_USER_ID);

      // Verify system browser is used instead of BrowserWindow (BACKLOG-1570)
      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        "https://login.microsoftonline.com/oauth/mailbox",
      );
    });
  });
});
