/**
 * BACKLOG-3283 — mailbox-connect pushes after a macOS Dock reopen, and a
 * replaced attempt staying silent.
 *
 * PATH 4 (proof of already-done, BACKLOG-3454): `registerAuthHandlers` runs once
 * in `whenReady` against window A. The user closes A; `activate` builds B and
 * `createWindow()` hands B to the registry (`setMainWindow`, pinned by
 * `windowRecreation-3454.test.ts`). A connect started after that must push to B
 * — and nothing re-registers. `main.ts` cannot load in jest, so the registry
 * swap stands in for `createWindow()`; the AST half lives in the 3454 suite.
 *
 * PATH 3: the handler must not push when its codePromise rejects with
 * AuthAttemptSupersededError — the renderer's listener belongs to the newer
 * attempt.
 *
 * Mock block transcribed from `mailboxConnectFocus-3394.test.ts`.
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
import { setMainWindow } from "../windowRegistry";
import { AuthAttemptSupersededError } from "../services/authAttemptSuperseded";
import auditService from "../services/auditService";
import databaseService from "../services/databaseService";
import googleAuthService from "../services/googleAuthService";
import microsoftAuthService from "../services/microsoftAuthService";

function fixture<T>(value: unknown): T {
  return value as T;
}

const TEST_USER_ID = "550e8400-e29b-41d4-a716-446655440000"; // pii-allow-uuid: invented, the RFC 4122 specimen value, not from any live row

interface FakeWindow {
  destroyed: boolean;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  restore: jest.Mock;
  show: jest.Mock;
  focus: jest.Mock;
  setAlwaysOnTop: jest.Mock;
  webContents: { send: jest.Mock };
}

function fakeWindow(): FakeWindow {
  const w: FakeWindow = {
    destroyed: false,
    isDestroyed: () => w.destroyed,
    isMinimized: () => false,
    isVisible: () => true,
    restore: jest.fn(),
    show: jest.fn(),
    focus: jest.fn(),
    setAlwaysOnTop: jest.fn(),
    webContents: { send: jest.fn() },
  };
  return w;
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never happened: ${what}`);
}

/** Lets every queued macrotask (the handler's setTimeout(0) completion) run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

function sends(win: FakeWindow, channel: string): unknown[][] {
  return win.webContents.send.mock.calls.filter((c) => c[0] === channel);
}

const mockDatabaseService = databaseService as jest.Mocked<typeof databaseService>;
const mockGoogle = googleAuthService as jest.Mocked<typeof googleAuthService>;
const mockMicrosoft = microsoftAuthService as jest.Mocked<typeof microsoftAuthService>;
const mockAudit = auditService as jest.Mocked<typeof auditService>;

function arrangeGoogle(codePromise: Promise<string>): void {
  mockGoogle.authenticateForMailbox.mockResolvedValueOnce(
    fixture({ authUrl: "https://accounts.google.com/oauth/mailbox", codePromise, codeVerifier: "v", scopes: ["gmail.readonly"] }),
  );
  mockGoogle.exchangeCodeForTokens.mockResolvedValue(
    fixture({ tokens: { access_token: "a", refresh_token: "r", expires_at: "2030-01-01T00:00:00.000Z", scopes: ["gmail.readonly"] } }),
  );
  mockGoogle.getUserInfo.mockResolvedValue(fixture({ id: "g1", email: "broker@example.com", verified_email: true }));
}

function arrangeMicrosoft(codePromise: Promise<string>): void {
  mockMicrosoft.authenticateForMailbox.mockResolvedValueOnce(
    fixture({ authUrl: "https://login.microsoftonline.com/oauth/mailbox", codePromise, codeVerifier: "v", scopes: ["Mail.Read"] }),
  );
  mockMicrosoft.exchangeCodeForTokens.mockResolvedValue(
    fixture({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "Mail.Read" }),
  );
  mockMicrosoft.getUserInfo.mockResolvedValue(fixture({ id: "m1", email: "broker@example.net" }));
}

const PROVIDERS = [
  ["google", "auth:google:connect-mailbox", arrangeGoogle],
  ["microsoft", "auth:microsoft:connect-mailbox", arrangeMicrosoft],
] as const;

describe("BACKLOG-3283", () => {
  let handlers: IpcHandlerRegistry;
  const event = {} as IpcMainInvokeEvent;
  let windowA: FakeWindow;

  beforeAll(() => {
    handlers = createIpcHandlerRegistry();
    mockIpcHandle.mockImplementation((channel: string, handler: RegisteredIpcHandler) => {
      handlers.set(channel, handler);
    });
    // Registration happens ONCE, against window A, exactly as whenReady does.
    windowA = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMainWindow(windowA as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAuthHandlers(windowA as any);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabaseService.getUserById.mockResolvedValue(fixture({ id: TEST_USER_ID, email: "broker@example.com" }));
    mockDatabaseService.saveOAuthToken.mockResolvedValue("row");
  });

  describe.each(PROVIDERS)("Path 4 — %s connect after a Dock reopen", (provider, channel, arrange) => {
    it("pushes the result to the window that exists now, not the one registration saw", async () => {
      windowA.destroyed = true; // user closed the last window
      const windowB = fakeWindow(); // activate -> createWindow -> setMainWindow(B)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setMainWindow(windowB as any);

      arrange(Promise.resolve("code"));
      const result = await handlers.get(channel)(event, TEST_USER_ID);
      expect(result.success).toBe(true);

      await waitFor(() => sends(windowB, `${provider}:mailbox-connected`).length > 0, "push to window B");
      expect(sends(windowB, `${provider}:mailbox-connected`)[0][1]).toMatchObject({ success: true });
      expect(windowA.webContents.send).not.toHaveBeenCalled();
    });

    it("does not throw and still answers the invoke when no window is open", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setMainWindow(null as any);
      arrange(Promise.resolve("code"));
      const result = await handlers.get(channel)(event, TEST_USER_ID);
      expect(result.success).toBe(true);
      await waitFor(() => mockDatabaseService.saveOAuthToken.mock.calls.length > 0, "token saved");
      await drain();
      expect(windowA.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe.each(PROVIDERS)("Path 3 — %s connect pressed twice", (provider, channel, arrange) => {
    it("the replaced attempt pushes nothing; the newer one pushes exactly one success", async () => {
      const win = fakeWindow();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setMainWindow(win as any);

      let rejectFirst!: (e: Error) => void;
      arrange(new Promise<string>((_resolve, reject) => { rejectFirst = reject; }));
      await handlers.get(channel)(event, TEST_USER_ID);

      let resolveSecond!: (code: string) => void;
      arrange(new Promise<string>((resolve) => { resolveSecond = resolve; }));
      await handlers.get(channel)(event, TEST_USER_ID);
      await drain(); // both background tasks are now awaiting their codePromise

      // What startLocalServer does to the first attempt when the second starts.
      rejectFirst(new AuthAttemptSupersededError());
      await drain();
      expect(sends(win, `${provider}:mailbox-connected`)).toHaveLength(0);
      expect(mockAudit.log).not.toHaveBeenCalledWith(expect.objectContaining({ success: false }));

      resolveSecond("code");
      await waitFor(() => sends(win, `${provider}:mailbox-connected`).length > 0, "second attempt push");
      await drain();
      const pushes = sends(win, `${provider}:mailbox-connected`);
      expect(pushes).toHaveLength(1);
      expect(pushes[0][1]).toMatchObject({ success: true });
    });

    it("a real failure still pushes { success: false } (the silence is only for supersede)", async () => {
      const win = fakeWindow();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setMainWindow(win as any);
      let rejectCode!: (e: Error) => void;
      arrange(new Promise<string>((_resolve, reject) => { rejectCode = reject; }));
      await handlers.get(channel)(event, TEST_USER_ID);
      await drain();
      rejectCode(new Error("access_denied"));
      await waitFor(() => sends(win, `${provider}:mailbox-connected`).length > 0, "failure push");
      expect(sends(win, `${provider}:mailbox-connected`)[0][1]).toMatchObject({ success: false });
    });
  });
});
