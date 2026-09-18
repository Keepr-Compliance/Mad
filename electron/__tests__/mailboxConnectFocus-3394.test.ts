/**
 * BACKLOG-3394 — the app brings ITSELF to the front when a mailbox connects.
 *
 * ============================================================================
 * WHAT THIS PROVES, AND WHY EACH HALF IS NEEDED
 * ============================================================================
 *
 * Removing the served page's "Return to Application" button only helps if
 * something else brings the window forward. That something is
 * `bringAppToFront()`, called by both mailbox handlers on the success branch.
 *
 * Three claims, and none of them is provable by the others:
 *
 *  1. **It fires.** `app.focus({ steal: true })` is called on a successful
 *     connect. Asserted against the REAL `bringAppToFront` (only Electron's
 *     `app` is mocked), so the util's own body is under test too — a mock of
 *     our own module would assert that we called our own function, which is
 *     not the claim.
 *
 *  2. **It fires BEFORE the renderer is notified.** `mock.invocationCallOrder`
 *     is compared, not merely "both were called". What this pins is CALL ORDER
 *     IN THE MAIN PROCESS, and nothing more. It does NOT establish that the
 *     renderer is foreground when the send happens: `app.focus({ steal: true })`
 *     is an ASYNCHRONOUS OS activation request, and no unit test can observe
 *     the window server acting on it.
 *
 *     The BACKLOG-1709 connection is an UNTRACED LEAD, not the thing being
 *     proved. 1709's pass 2 wrote the backgrounded-`webContents` candidate down
 *     as "Offered as a lead, not a finding … n = 3. Do not build on it."
 *     (pm_comments 7ae840b3), and the ordering cannot touch 1709's lost-REPLY
 *     branch at all — the invoke reply is dispatched when the handler returns,
 *     before `codePromise` resolves and long before `processLoginInBackground`
 *     reaches this focus call. The order is pinned because it is free and
 *     directionally right, not because it is known to affect delivery.
 *
 *  3. **It fires EXACTLY ONCE, and only on success.** Without the failure-path
 *     partner, claim 1 passes for a handler that focuses unconditionally — and
 *     a connect that FAILED yanking the user out of their browser is a
 *     regression, not a fix. The `success: false` cases below are what make
 *     claim 1 non-vacuous.
 */

import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
  type RegisteredIpcHandler,
} from "../../tests/support/ipcHandlerRegistry";
import type { IpcMainInvokeEvent } from "electron";

const mockIpcHandle = jest.fn();
const mockShellOpenExternal = jest.fn();
const mockAppFocus = jest.fn();

jest.mock("electron", () => ({
  ipcMain: { handle: mockIpcHandle },
  app: {
    getVersion: jest.fn().mockReturnValue("1.0.0"),
    focus: mockAppFocus,
  },
  shell: { openExternal: mockShellOpenExternal },
  BrowserWindow: jest.fn().mockImplementation(() => ({
    loadURL: jest.fn(),
    close: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
    on: jest.fn(),
    isDestroyed: jest.fn().mockReturnValue(false),
    webContents: { on: jest.fn(), send: jest.fn() },
  })),
}));

jest.mock("crypto", () => ({
  randomUUID: jest.fn().mockReturnValue("test-uuid"),
}));

jest.mock("os", () => ({
  hostname: jest.fn().mockReturnValue("test-host"),
  platform: jest.fn().mockReturnValue("darwin"),
  release: jest.fn().mockReturnValue("21.0.0"),
}));

jest.mock("../services/loginProvisioningService", () => ({
  __esModule: true,
  provisionLogin: jest.fn(),
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    initialize: jest.fn().mockResolvedValue(undefined),
    isInitialized: jest.fn().mockReturnValue(true),
    getUserById: jest.fn(),
    saveOAuthToken: jest.fn().mockResolvedValue(undefined),
    getOAuthToken: jest.fn(),
    deleteOAuthToken: jest.fn().mockResolvedValue(undefined),
    createSession: jest.fn(),
    validateSession: jest.fn(),
    deleteSession: jest.fn(),
    updateLastLogin: jest.fn(),
    getUserByOAuthId: jest.fn(),
    createUser: jest.fn(),
    updateUser: jest.fn(),
    acceptTerms: jest.fn(),
    hasCompletedEmailOnboarding: jest.fn(),
    completeEmailOnboarding: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("axios");

jest.mock("../services/googleAuthService", () => ({
  __esModule: true,
  default: {
    authenticateForLogin: jest.fn(),
    authenticateForMailbox: jest.fn(),
    exchangeCodeForTokens: jest.fn(),
    getUserInfo: jest.fn(),
    stopLocalServer: jest.fn(),
    resolveCodeDirectly: jest.fn(),
    rejectCodeDirectly: jest.fn(),
    revokeToken: jest.fn().mockResolvedValue({ outcome: "revoked" }),
  },
}));

jest.mock("../services/microsoftAuthService", () => ({
  __esModule: true,
  default: {
    authenticateForLogin: jest.fn(),
    authenticateForMailbox: jest.fn(),
    exchangeCodeForTokens: jest.fn(),
    getUserInfo: jest.fn(),
    stopLocalServer: jest.fn(),
    resolveCodeDirectly: jest.fn(),
    rejectCodeDirectly: jest.fn(),
    revokeToken: jest.fn().mockResolvedValue({ outcome: "unsupported" }),
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
    getAuthUserId: jest.fn().mockReturnValue(null),
  },
}));

jest.mock("../services/tokenEncryptionService", () => ({
  __esModule: true,
  default: { encrypt: jest.fn().mockReturnValue("encrypted-token") },
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
  default: { recordAttempt: jest.fn() },
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
  default: { initialize: jest.fn(), log: jest.fn().mockResolvedValue(undefined) },
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

jest.mock("../handlers/syncHandlers", () => ({ setSyncUserId: jest.fn() }));

// Fire-and-forget post-connect work that runs AFTER the send. Mocked so it
// cannot reach the database or leave a pending promise behind the assertions.
jest.mock("../services/postConnectContactImport", () => ({
  __esModule: true,
  importEnabledEmptyContactSources: jest.fn().mockResolvedValue([]),
}));

import { registerAuthHandlers } from "../handlers/authHandlers";
import databaseService from "../services/databaseService";
import googleAuthService from "../services/googleAuthService";
import microsoftAuthService from "../services/microsoftAuthService";

const mockDatabaseService = databaseService as jest.Mocked<typeof databaseService>;
const mockGoogleAuthService = googleAuthService as jest.Mocked<typeof googleAuthService>;
const mockMicrosoftAuthService = microsoftAuthService as jest.Mocked<
  typeof microsoftAuthService
>;

function fixture<T>(value: unknown): T {
  return value as T;
}

// The RFC 4122 specimen UUID, and the same constant the existing auth handler
// suites in this directory already use.
const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000"; // pii-allow-uuid: invented, the RFC 4122 specimen value, not from any live row

/**
 * The handlers run the completion in `setTimeout(…, 0)`, so the assertions have
 * to wait for a real macrotask chain rather than a fixed sleep. Poll until the
 * renderer has been notified, then fail loudly if it never is — a silent
 * timeout here would make every assertion below vacuous.
 */
async function waitForSend(send: jest.Mock, channel: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (send.mock.calls.some((call) => call[0] === channel)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `The handler never sent "${channel}" — the background completion did not reach its notify step, so nothing below is being tested.`,
  );
}

describe("BACKLOG-3394: focusing the app on a mailbox connect", () => {
  let registeredHandlers: IpcHandlerRegistry;
  const mockEvent = {} as IpcMainInvokeEvent;
  const mockSend = jest.fn();
  const mockWindowFocus = jest.fn();
  const mockMainWindow = {
    isDestroyed: jest.fn().mockReturnValue(false),
    isMinimized: jest.fn().mockReturnValue(false),
    isVisible: jest.fn().mockReturnValue(true),
    restore: jest.fn(),
    show: jest.fn(),
    focus: mockWindowFocus,
    webContents: { send: mockSend },
  };

  beforeAll(() => {
    registeredHandlers = createIpcHandlerRegistry();
    mockIpcHandle.mockImplementation(
      (channel: string, handler: RegisteredIpcHandler) => {
        registeredHandlers.set(channel, handler);
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAuthHandlers(mockMainWindow as any);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseService.getUserById.mockResolvedValue(
      fixture({ id: TEST_USER_ID, email: "broker@example.com" }),
    );
    // Returns the row id; the handler ignores it, but the mock is typed.
    mockDatabaseService.saveOAuthToken.mockResolvedValue("oauth-token-row-id");
    mockMainWindow.isDestroyed.mockReturnValue(false);
    mockMainWindow.isMinimized.mockReturnValue(false);
    mockMainWindow.isVisible.mockReturnValue(true);
  });

  // --------------------------------------------------------------------------
  // Google
  // --------------------------------------------------------------------------
  describe("Google", () => {
    function arrangeSuccess(): void {
      mockGoogleAuthService.authenticateForMailbox.mockResolvedValue(
        fixture({
          authUrl: "https://accounts.google.com/oauth/mailbox",
          codePromise: Promise.resolve("google-auth-code"),
          codeVerifier: "verifier-123",
          scopes: ["gmail.readonly"],
        }),
      );
      mockGoogleAuthService.exchangeCodeForTokens.mockResolvedValue(
        fixture({
          tokens: {
            access_token: "google-access",
            refresh_token: "google-refresh",
            expires_at: "2030-01-01T00:00:00.000Z",
            scopes: ["gmail.readonly"],
          },
        }),
      );
      mockGoogleAuthService.getUserInfo.mockResolvedValue(
        fixture({ id: "g1", email: "broker@example.com", verified_email: true }),
      );
    }

    it("brings the app to the front exactly once, before notifying the renderer", async () => {
      arrangeSuccess();

      const handler = registeredHandlers.get("auth:google:connect-mailbox");
      const result = await handler(mockEvent, TEST_USER_ID);
      expect(result.success).toBe(true);

      await waitForSend(mockSend, "google:mailbox-connected");

      const successSend = mockSend.mock.calls.find(
        (call) => call[0] === "google:mailbox-connected" && call[1]?.success === true,
      );
      expect(successSend).toBeDefined();

      // 1. It fires, and with the option that actually pulls the app in front
      //    of the browser on macOS.
      expect(mockAppFocus).toHaveBeenCalledTimes(1);
      expect(mockAppFocus).toHaveBeenCalledWith({ steal: true });

      // 2. It fires BEFORE the renderer is notified.
      const focusOrder = mockAppFocus.mock.invocationCallOrder[0];
      const sendOrder = mockSend.mock.invocationCallOrder[0];
      expect(focusOrder).toBeLessThan(sendOrder);
    });

    it("does NOT bring the app to the front when saving the token fails", async () => {
      arrangeSuccess();
      mockDatabaseService.saveOAuthToken.mockRejectedValue(
        new Error("disk full"),
      );

      const handler = registeredHandlers.get("auth:google:connect-mailbox");
      await handler(mockEvent, TEST_USER_ID);

      await waitForSend(mockSend, "google:mailbox-connected");

      expect(
        mockSend.mock.calls.find((call) => call[0] === "google:mailbox-connected")?.[1]
          ?.success,
      ).toBe(false);
      expect(mockAppFocus).not.toHaveBeenCalled();
    });

    it("does NOT bring the app to the front when the OAuth exchange fails", async () => {
      arrangeSuccess();
      mockGoogleAuthService.exchangeCodeForTokens.mockRejectedValue(
        new Error("invalid_grant"),
      );

      const handler = registeredHandlers.get("auth:google:connect-mailbox");
      await handler(mockEvent, TEST_USER_ID);

      await waitForSend(mockSend, "google:mailbox-connected");

      expect(mockAppFocus).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Microsoft
  // --------------------------------------------------------------------------
  describe("Microsoft", () => {
    function arrangeSuccess(): void {
      mockMicrosoftAuthService.authenticateForMailbox.mockResolvedValue(
        fixture({
          authUrl: "https://login.microsoftonline.com/oauth/mailbox",
          codePromise: Promise.resolve("ms-auth-code"),
          codeVerifier: "verifier-456",
          scopes: ["Mail.Read"],
        }),
      );
      mockMicrosoftAuthService.exchangeCodeForTokens.mockResolvedValue(
        fixture({
          access_token: "ms-access",
          refresh_token: "ms-refresh",
          expires_in: 3600,
          scope: "Mail.Read",
        }),
      );
      mockMicrosoftAuthService.getUserInfo.mockResolvedValue(
        fixture({ id: "m1", email: "broker@example.net" }),
      );
    }

    it("brings the app to the front exactly once, before notifying the renderer", async () => {
      arrangeSuccess();

      const handler = registeredHandlers.get("auth:microsoft:connect-mailbox");
      const result = await handler(mockEvent, TEST_USER_ID);
      expect(result.success).toBe(true);

      await waitForSend(mockSend, "microsoft:mailbox-connected");

      const successSend = mockSend.mock.calls.find(
        (call) =>
          call[0] === "microsoft:mailbox-connected" && call[1]?.success === true,
      );
      expect(successSend).toBeDefined();

      expect(mockAppFocus).toHaveBeenCalledTimes(1);
      expect(mockAppFocus).toHaveBeenCalledWith({ steal: true });

      const focusOrder = mockAppFocus.mock.invocationCallOrder[0];
      const sendOrder = mockSend.mock.invocationCallOrder[0];
      expect(focusOrder).toBeLessThan(sendOrder);
    });

    it("does NOT bring the app to the front when saving the token fails", async () => {
      arrangeSuccess();
      mockDatabaseService.saveOAuthToken.mockRejectedValue(
        new Error("disk full"),
      );

      const handler = registeredHandlers.get("auth:microsoft:connect-mailbox");
      await handler(mockEvent, TEST_USER_ID);

      await waitForSend(mockSend, "microsoft:mailbox-connected");

      expect(
        mockSend.mock.calls.find(
          (call) => call[0] === "microsoft:mailbox-connected",
        )?.[1]?.success,
      ).toBe(false);
      expect(mockAppFocus).not.toHaveBeenCalled();
    });

    it("does NOT bring the app to the front when the OAuth exchange fails", async () => {
      arrangeSuccess();
      mockMicrosoftAuthService.exchangeCodeForTokens.mockRejectedValue(
        new Error("invalid_grant"),
      );

      const handler = registeredHandlers.get("auth:microsoft:connect-mailbox");
      await handler(mockEvent, TEST_USER_ID);

      await waitForSend(mockSend, "microsoft:mailbox-connected");

      expect(mockAppFocus).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // The window itself
  // --------------------------------------------------------------------------
  it("restores a minimised window rather than only activating the application", async () => {
    mockMainWindow.isMinimized.mockReturnValue(true);
    mockGoogleAuthService.authenticateForMailbox.mockResolvedValue(
      fixture({
        authUrl: "https://accounts.google.com/oauth/mailbox",
        codePromise: Promise.resolve("google-auth-code"),
        codeVerifier: "verifier-123",
        scopes: ["gmail.readonly"],
      }),
    );
    mockGoogleAuthService.exchangeCodeForTokens.mockResolvedValue(
      fixture({
        tokens: {
          access_token: "google-access",
          refresh_token: "google-refresh",
          expires_at: "2030-01-01T00:00:00.000Z",
          scopes: ["gmail.readonly"],
        },
      }),
    );
    mockGoogleAuthService.getUserInfo.mockResolvedValue(
      fixture({ id: "g1", email: "broker@example.com", verified_email: true }),
    );

    const handler = registeredHandlers.get("auth:google:connect-mailbox");
    await handler(mockEvent, TEST_USER_ID);
    await waitForSend(mockSend, "google:mailbox-connected");

    expect(mockMainWindow.restore).toHaveBeenCalledTimes(1);
    expect(mockWindowFocus).toHaveBeenCalledTimes(1);
  });
});
