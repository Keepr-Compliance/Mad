/**
 * @jest-environment node
 *
 * Permission Handlers — relaunch-app IPC (BACKLOG-1842, BACKLOG-2173b)
 *
 * Pins the clean-relaunch contract used to recover from the FDA-grant force-quit:
 *   - Packaged build: `relaunch-app` calls app.relaunch() then app.exit(0)
 *     (non-destructive — NO data wipe, mirrors resetService.relaunchApp).
 *   - E2E/dev harness (!app.isPackaged && KEEPR_E2E=1): suppressed — must NOT
 *     call relaunch/exit (that would kill the QA driver). Returns relaunched:false.
 *   - BACKLOG-2173b: the handler now AWAITS ensureSessionPersistedBeforeRelaunch()
 *     before relaunching, so no relaunch can outrun session persistence on a
 *     fresh macOS profile (see systemHandlers.ts persistSessionForUser for the
 *     primary fix this backstops).
 *
 * permissionHandlers uses a module-level `handlersRegistered` guard, so each test
 * isolates the module to re-register against a fresh electron mock + env.
 */

const mockRelaunch = jest.fn();
const mockExit = jest.fn();

interface AppMock {
  isPackaged: boolean;
  relaunch: jest.Mock;
  exit: jest.Mock;
  getPath: jest.Mock;
  getName: jest.Mock;
}

const appMock: AppMock = {
  isPackaged: true,
  relaunch: mockRelaunch,
  exit: mockExit,
  getPath: jest.fn(() => "/Applications/Keepr.app/Contents/MacOS/Keepr"),
  getName: jest.fn(() => "Keepr"),
};

// BACKLOG-2173b: session-persistence collaborators used by
// ensureSessionPersistedBeforeRelaunch(). Default to "already persisted"
// (the expected post-fix common case) so existing relaunch-contract tests
// don't need to know about the safety-net internals.
const mockLoadSession = jest.fn();
const mockSaveSession = jest.fn().mockResolvedValue(true);
const mockGetSessionExpirationMs = jest.fn(() => 24 * 60 * 60 * 1000);
const mockGetAuthSession = jest.fn();
const mockGetUserById = jest.fn();
const mockCreateSession = jest.fn();

const EXISTING_PERSISTED_SESSION = {
  user: { id: "user-1" },
  sessionToken: "tok",
  provider: "google",
  supabaseTokens: { access_token: "at", refresh_token: "rt" },
};

/**
 * Register the handlers fresh against the current appMock/env and return the
 * captured `relaunch-app` handler.
 */
function loadRelaunchHandler(): () => Promise<{ relaunched: boolean }> {
  const registered: Record<string, (...a: unknown[]) => unknown> = {};

  jest.doMock("electron", () => ({
    ipcMain: {
      handle: (channel: string, handler: (...a: unknown[]) => unknown) => {
        registered[channel] = handler;
      },
    },
    app: appMock,
    shell: { openExternal: jest.fn() },
  }));

  jest.doMock("../../services/logService", () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));

  jest.doMock("../../services/sessionService", () => ({
    __esModule: true,
    default: {
      loadSession: mockLoadSession,
      saveSession: mockSaveSession,
      getSessionExpirationMs: mockGetSessionExpirationMs,
    },
  }));

  jest.doMock("../../services/supabaseService", () => ({
    __esModule: true,
    default: {
      getPreferences: jest.fn(),
      syncPreferences: jest.fn(),
      getAuthSession: mockGetAuthSession,
    },
  }));

  jest.doMock("../../services/databaseService", () => ({
    __esModule: true,
    default: {
      getUserById: mockGetUserById,
      createSession: mockCreateSession,
    },
  }));

  let handler!: () => Promise<{ relaunched: boolean }>;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerPermissionHandlers } = require("../permissionHandlers");
    registerPermissionHandlers();
    handler = registered["relaunch-app"] as () => Promise<{ relaunched: boolean }>;
  });
  return handler;
}

describe("permissionHandlers — relaunch-app (BACKLOG-1842, BACKLOG-2173b)", () => {
  const ORIGINAL_E2E = process.env.KEEPR_E2E;

  beforeEach(() => {
    jest.resetModules();
    mockRelaunch.mockReset();
    mockExit.mockReset();
    mockLoadSession.mockReset().mockResolvedValue(EXISTING_PERSISTED_SESSION);
    mockSaveSession.mockClear().mockResolvedValue(true);
    mockGetAuthSession.mockReset();
    mockGetUserById.mockReset();
    mockCreateSession.mockReset();
    appMock.isPackaged = true;
    delete process.env.KEEPR_E2E;
  });

  afterAll(() => {
    if (ORIGINAL_E2E === undefined) delete process.env.KEEPR_E2E;
    else process.env.KEEPR_E2E = ORIGINAL_E2E;
  });

  it("registers a relaunch-app handler", () => {
    const handler = loadRelaunchHandler();
    expect(typeof handler).toBe("function");
  });

  it("packaged build relaunches: app.relaunch() then app.exit(0)", async () => {
    appMock.isPackaged = true;
    const handler = loadRelaunchHandler();

    const result = await handler();

    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(result).toEqual({ relaunched: true });
  });

  it("E2E/dev harness (!isPackaged && KEEPR_E2E=1): suppressed — never kills the process", async () => {
    appMock.isPackaged = false;
    process.env.KEEPR_E2E = "1";
    const handler = loadRelaunchHandler();

    const result = await handler();

    expect(mockRelaunch).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
    expect(result).toEqual({ relaunched: false });
  });

  it("plain dev (!isPackaged, KEEPR_E2E unset) still relaunches — flow stays testable", async () => {
    appMock.isPackaged = false;
    delete process.env.KEEPR_E2E;
    const handler = loadRelaunchHandler();

    const result = await handler();

    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(result).toEqual({ relaunched: true });
  });

  it("BACKLOG-2173b: session already persisted on disk — relaunch proceeds without a flush write", async () => {
    mockLoadSession.mockResolvedValue(EXISTING_PERSISTED_SESSION);
    const handler = loadRelaunchHandler();

    await handler();

    expect(mockSaveSession).not.toHaveBeenCalled();
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("BACKLOG-2173b: no session on disk (deferred-DB race) — flushes one BEFORE relaunching", async () => {
    mockLoadSession.mockResolvedValue(null);
    mockGetAuthSession.mockResolvedValue({
      userId: "user-1",
      accessToken: "access-tok",
      refreshToken: "refresh-tok",
    });
    mockGetUserById.mockResolvedValue({
      id: "user-1",
      email: "user@example.com",
      oauth_provider: "google",
      subscription_tier: "free",
      subscription_status: "trial",
    });
    mockCreateSession.mockResolvedValue("session-token-123");

    const callOrder: string[] = [];
    mockSaveSession.mockImplementation(async () => {
      callOrder.push("saveSession");
      return true;
    });
    mockRelaunch.mockImplementation(() => {
      callOrder.push("relaunch");
    });

    const handler = loadRelaunchHandler();
    const result = await handler();

    expect(mockSaveSession).toHaveBeenCalledTimes(1);
    expect(mockSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionToken: "session-token-123",
        supabaseTokens: { access_token: "access-tok", refresh_token: "refresh-tok" },
      }),
    );
    // The flush must complete BEFORE app.relaunch() fires -- no relaunch may
    // outrun session persistence.
    expect(callOrder).toEqual(["saveSession", "relaunch"]);
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(result).toEqual({ relaunched: true });
  });

  it("BACKLOG-2173b: no session AND no Supabase auth session — logs and still relaunches (best-effort)", async () => {
    mockLoadSession.mockResolvedValue(null);
    mockGetAuthSession.mockResolvedValue(null);

    const handler = loadRelaunchHandler();
    const result = await handler();

    expect(mockSaveSession).not.toHaveBeenCalled();
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ relaunched: true });
  });
});
