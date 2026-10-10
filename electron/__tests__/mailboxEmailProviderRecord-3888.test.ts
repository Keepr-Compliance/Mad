/**
 * BACKLOG-3888 — a successful mailbox connect records its provider in the
 * cloud preferences set (preferences.emailProviders), and recording can never
 * fail the connect.
 *
 * Harness copied from mailboxConnectFocus-3394.test.ts (the real handlers,
 * registered through registerAuthHandlers; services mocked). The preferences
 * row semantics are transcribed from supabaseService.ts:1492-1538.
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
    getPreferences: jest.fn(),
    syncPreferences: jest.fn(),
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
  default: {
    initialize: jest.fn(),
    log: jest.fn().mockResolvedValue(undefined),
  },
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
import { setMainWindow } from "../windowRegistry";
import databaseService from "../services/databaseService";
import googleAuthService from "../services/googleAuthService";
import microsoftAuthService from "../services/microsoftAuthService";
import supabaseService from "../services/supabaseService";

const mockDatabaseService = databaseService as jest.Mocked<
  typeof databaseService
>;
const mockGoogleAuthService = googleAuthService as jest.Mocked<
  typeof googleAuthService
>;
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

const mockSupabase = supabaseService as jest.Mocked<typeof supabaseService>;
const prefsRow: { preferences: Record<string, unknown> } = { preferences: {} };

/** Lets the fire-and-forget record call settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("BACKLOG-3888: recording the connected email provider", () => {
  let registeredHandlers: IpcHandlerRegistry;
  const mockEvent = {} as IpcMainInvokeEvent;
  const mockSend = jest.fn();
  const mockMainWindow = {
    isDestroyed: jest.fn().mockReturnValue(false),
    isMinimized: jest.fn().mockReturnValue(false),
    isVisible: jest.fn().mockReturnValue(true),
    restore: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
    setAlwaysOnTop: jest.fn(),
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
    setMainWindow(mockMainWindow as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAuthHandlers(mockMainWindow as any);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prefsRow.preferences = {};
    mockDatabaseService.getUserById.mockResolvedValue(
      fixture({ id: TEST_USER_ID, email: "broker@example.com" }),
    );
    mockDatabaseService.saveOAuthToken.mockResolvedValue("oauth-token-row-id");
    mockSupabase.getPreferences.mockImplementation(
      async () => prefsRow.preferences,
    );
    mockSupabase.syncPreferences.mockImplementation(async (_u, prefs) => {
      prefsRow.preferences = JSON.parse(JSON.stringify(prefs));
    });

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
  });

  async function connect(provider: "google" | "microsoft"): Promise<unknown> {
    mockSend.mockClear();
    const handler = registeredHandlers.get(`auth:${provider}:connect-mailbox`);
    const result = await handler(mockEvent, TEST_USER_ID);
    expect(result.success).toBe(true);
    await waitForSend(mockSend, `${provider}:mailbox-connected`);
    await settle();
    return mockSend.mock.calls.find(
      (c) => c[0] === `${provider}:mailbox-connected`,
    )?.[1];
  }

  it('Outlook connect writes ["outlook"]; then Gmail -> ["outlook","gmail"]; a duplicate leaves it unchanged', async () => {
    await connect("microsoft");
    expect(prefsRow.preferences.emailProviders).toEqual(["outlook"]);

    await connect("google");
    expect(prefsRow.preferences.emailProviders).toEqual(["outlook", "gmail"]);
    expect(mockSupabase.syncPreferences).toHaveBeenCalledTimes(2);

    await connect("microsoft");
    expect(prefsRow.preferences.emailProviders).toEqual(["outlook", "gmail"]);
    expect(mockSupabase.syncPreferences).toHaveBeenCalledTimes(2);
  });

  it.each<["google" | "microsoft"]>([["google"], ["microsoft"]])(
    "%s: a preferences save failure does not break the connect",
    async (provider) => {
      mockSupabase.getPreferences.mockRejectedValue(
        new Error("supabase unreachable"),
      );
      const payload = (await connect(provider)) as { success?: boolean };
      expect(payload?.success).toBe(true);
      expect(mockSupabase.syncPreferences).not.toHaveBeenCalled();

      mockSupabase.getPreferences.mockResolvedValue({});
      mockSupabase.syncPreferences.mockRejectedValue(
        new Error("upsert failed"),
      );
      const again = (await connect(provider)) as { success?: boolean };
      expect(again?.success).toBe(true);
    },
  );

  it.each<["google" | "microsoft"]>([["google"], ["microsoft"]])(
    "%s: a FAILED connect (token save failed) records nothing",
    async (provider) => {
      mockDatabaseService.saveOAuthToken.mockRejectedValue(
        new Error("disk full"),
      );
      const handler = registeredHandlers.get(
        `auth:${provider}:connect-mailbox`,
      );
      await handler(mockEvent, TEST_USER_ID);
      await waitForSend(mockSend, `${provider}:mailbox-connected`);
      expect(
        mockSend.mock.calls.find(
          (c) => c[0] === `${provider}:mailbox-connected`,
        )?.[1]?.success,
      ).toBe(false);
      await settle();
      expect(mockSupabase.getPreferences).not.toHaveBeenCalled();
      expect(mockSupabase.syncPreferences).not.toHaveBeenCalled();
    },
  );
});
