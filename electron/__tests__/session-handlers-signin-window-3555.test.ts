/**
 * @jest-environment node
 */

/**
 * BACKLOG-3555: get-current-user must not read a PREVIOUS session.json while a
 * deep-link sign-in's session is not written yet.
 *
 * Harness = session-handlers-network-3768.test.ts, with ONE change: the
 * initializationBroadcaster is the REAL module. whenDbReady() answers
 * {ready:false} at once from `idle` (BACKLOG-2171), so a call only parks while
 * the stage is starting / db-opening / db-waiting / migrating / creating-user.
 * Mocking it as "parked from launch" is the fixture error this file replaces.
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
const mockGetUser = jest.fn();
const mockSetSession = jest.fn();
// BACKLOG-2149: the DB-not-ready fallback reads the Supabase session directly.
const mockGetSession = jest.fn().mockResolvedValue({ data: { session: null } });
const mockGetClient = jest.fn(() => ({
  auth: {
    getUser: mockGetUser,
    setSession: mockSetSession,
    getSession: mockGetSession,
  },
}));
const mockGetAuthUserId = jest.fn();
const mockGetUserById = jest.fn();

jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: mockGetClient,
    signOut: jest.fn(),
    signOutGlobal: jest.fn(),
    getAuthUserId: mockGetAuthUserId,
    getUserById: mockGetUserById,
    syncTermsAcceptance: jest.fn(),
    completeEmailOnboarding: jest.fn(),
  },
}));

// Mock deviceService
jest.mock("../services/deviceService", () => ({
  getDeviceId: jest.fn().mockReturnValue("test-device-id"),
  registerDevice: jest.fn().mockResolvedValue({ success: true }),
}));

// Mock databaseService
const mockDbIsInitialized = jest.fn().mockReturnValue(true);
const mockDbValidateSession = jest.fn();
const mockDbDeleteSession = jest.fn();
const mockDbGetUserById = jest.fn();
const mockDbGetUserByEmail = jest.fn();
const mockDbGetUserByOAuthId = jest.fn();
const mockDbCreateUser = jest.fn();
const mockDbUpdateUser = jest.fn();

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: mockDbIsInitialized,
    validateSession: mockDbValidateSession,
    deleteSession: mockDbDeleteSession,
    getUserById: mockDbGetUserById,
    getUserByEmail: mockDbGetUserByEmail,
    getUserByOAuthId: mockDbGetUserByOAuthId,
    createUser: mockDbCreateUser,
    updateUser: mockDbUpdateUser,
    acceptTerms: jest.fn(),
    completeEmailOnboarding: jest.fn(),
    hasCompletedEmailOnboarding: jest.fn(),
    getOAuthToken: jest.fn(),
    clearAllSessions: jest.fn(),
    getRawDatabase: jest.fn(),
  },
}));

// Mock sessionService
const mockLoadSession = jest.fn();
const mockClearSession = jest.fn();
const mockUpdateSession = jest.fn();

jest.mock("../services/sessionService", () => ({
  __esModule: true,
  default: {
    loadSession: mockLoadSession,
    clearSession: mockClearSession,
    updateSession: mockUpdateSession,
  },
}));

// Mock sessionSecurityService
const mockCheckSessionValidity = jest.fn();
const mockCleanupSession = jest.fn();

jest.mock("../services/sessionSecurityService", () => ({
  __esModule: true,
  default: {
    checkSessionValidity: mockCheckSessionValidity,
    recordActivity: jest.fn(),
    cleanupSession: mockCleanupSession,
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
const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();

jest.mock("../services/logService", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: mockLogInfo,
    warn: mockLogWarn,
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
  setUser: jest.fn(),
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
import {
  apiError400Refresh,
  apiError401,
  retryable503Error,
  retryableCertError,
  sessionMissingAfterFailedRestore,
} from "./helpers/realAuthJsErrors";

// Helper to create a mock session object
function createMockSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionToken: "test-session-token",
    user: {
      id: "user-123",
      email: "test@example.com",
      first_name: "Test",
      last_name: "User",
      display_name: "Test User",
      avatar_url: null,
      oauth_provider: "google",
      oauth_id: "oauth-123",
      subscription_tier: "free",
      subscription_status: "trial",
      trial_ends_at: null,
      terms_accepted_at: "2024-01-01T00:00:00Z",
      terms_version_accepted: "1.0",
      privacy_policy_accepted_at: "2024-01-01T00:00:00Z",
      privacy_policy_version_accepted: "1.0",
    },
    subscription: null,
    provider: "google",
    supabaseTokens: {
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
    },
    ...overrides,
  };
}

// Helper to create a mock DB user
function createMockDbUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-123",
    email: "test@example.com",
    first_name: "Test",
    last_name: "User",
    display_name: "Test User",
    avatar_url: null,
    oauth_provider: "google",
    oauth_id: "oauth-123",
    subscription_tier: "free",
    subscription_status: "trial",
    trial_ends_at: null,
    terms_accepted_at: "2024-01-01T00:00:00Z",
    terms_version_accepted: "1.0",
    privacy_policy_accepted_at: "2024-01-01T00:00:00Z",
    privacy_policy_version_accepted: "1.0",
    created_at: "2024-01-01T00:00:00Z",
    last_login_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}


import * as G from "../services/signInState";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { initializationBroadcaster: b } = require("../services/initializationBroadcaster");

// PendingDeepLinkUser as main.ts builds it (main.ts deepLinkUserData).
const PENDING = { supabaseId: "new-user", email: "new@example.com", displayName: "New", provider: "google" as const };
/** main.ts handleDeepLinkCallback, DB closed branch: bump, then store the pending user (which marks the file stale). */
function signInWhileDbClosed() { G.noteSignIn(); G.setPendingDeepLinkUser(PENDING); }
/** main.ts handleDeepLinkCallback, DB open branch: bump only; the session is written in the same call. */
function signInWhileDbOpen() { G.noteSignIn(); }

const tick = () => new Promise((r) => setImmediate(r));

describe("BACKLOG-3555: get-current-user vs a sign-in whose session is not written yet (REAL broadcaster)", () => {
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const sql: string[] = [];
  const fakeDb = {
    prepare: (s: string) => { sql.push(s.replace(/\s+/g, " ").trim().slice(0, 60)); return { run: jest.fn(), get: jest.fn(), all: jest.fn(() => []) }; },
    transaction: (fn: () => unknown) => fn,
  };
  beforeAll(() => {
    registerSessionHandlers();
    for (const [channel, handler] of mockIpcHandle.mock.calls) handlers[channel] = handler;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    sql.length = 0;
    b.reset();
    G.getAndClearPendingDeepLinkUser();
    G.markSignInSessionWritten();
  });
  const OLD = createMockSession({ user: { ...createMockSession().user, id: "old-user", email: "old@example.com", oauth_id: "old-oauth" } });
  const migrationSql = () => sql.filter((s) => /INSERT INTO users_local|SET user_id/.test(s));
  type Res = { success: boolean; user?: { id: string }; error?: string; transient?: boolean };
  const run = () => handlers["auth:get-current-user"]() as Promise<Res>;

  /** session.json = the OLD session; the DB handle is not set yet. */
  function oldFile(sdkUserId: string) {
    mockDbIsInitialized.mockReturnValue(false);
    mockLoadSession.mockResolvedValue(OLD);
    mockDbValidateSession.mockResolvedValue(createMockDbUser({ id: "old-user" }));
    mockGetAuthUserId.mockReturnValue(sdkUserId);
    mockDbGetUserById.mockImplementation(async (id: string) => (id === "old-user" ? createMockDbUser({ id: "old-user", email: "old@example.com" }) : null));
    mockGetUserById.mockResolvedValue(createMockDbUser({ id: sdkUserId }));
    (jest.requireMock("../services/databaseService").default.getRawDatabase as jest.Mock).mockReturnValue(fakeDb);
  }
  /** databaseService.ts:354 sets this.db: isInitialized() is true from here, db-ready not yet broadcast. */
  const dbHandleSet = () => mockDbIsInitialized.mockReturnValue(true);
  /** databaseService.ts:377 broadcast, after the handle is set. */
  function dbReady() { dbHandleSet(); b.broadcast({ stage: "db-ready" }); }
  /** Issue the call and prove it PARKED on the real broadcaster (still pending after two ticks). */
  async function parkedCall() {
    let done = false;
    const p = run().then((r) => { done = true; return r; });
    await tick(); await tick();
    expect(done).toBe(false);
    return { p };
  }
  async function unparkedCall() {
    let done = false;
    const p = run().then((r) => { done = true; return r; });
    await tick(); await tick();
    expect(done).toBe(true);
    return p;
  }
  const touchedNothing = () => {
    expect(mockLoadSession).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockDbDeleteSession).not.toHaveBeenCalled();
    expect(migrationSql()).toEqual([]);
  };

  // ---- SR's two real-broadcaster controls (plan v2 review, section 0) ----
  it("R-IDLE: a call at stage idle does not park; a later open never reaches loadSession", async () => {
    oldFile("old-user");
    const r = await unparkedCall();
    b.broadcast({ stage: "starting" });
    dbReady();
    expect(r).toEqual({ success: false, transient: true, retryable: true, error: "Database is starting up" });
    expect(mockLoadSession).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("R-INFLIGHT: a call issued while the open is in flight (stage starting) parks and, on db-ready, reads session.json", async () => {
    oldFile("old-user");
    mockCheckSessionValidity.mockResolvedValue({ valid: true });
    b.broadcast({ stage: "starting" });
    const h = await parkedCall();
    dbReady();
    await h.p;
    expect(mockLoadSession).toHaveBeenCalledTimes(1);
  });

  it("KEEP-4: stage idle, closed-DB sign-in pending -> the Supabase fallback still answers with the NEW user (fallback sits outside the check)", async () => {
    oldFile("new-user");
    signInWhileDbClosed();
    expect(G.isSignInAwaitingSessionWrite()).toBe(true);
    // main.ts setSession() has put the NEW user in the SDK; buildSupabaseFallbackUserResponse reads these fields.
    mockGetSession.mockResolvedValueOnce({
      data: {
        session: {
          user: { id: "new-user", email: "new@example.com", user_metadata: { full_name: "New" }, app_metadata: { provider: "google" } },
        },
      },
    });
    const r = await unparkedCall();
    expect(r).toEqual({ success: true, user: { id: "new-user", email: "new@example.com", display_name: "New" }, provider: "google" });
    expect(mockLoadSession).not.toHaveBeenCalled();
  });

  // ---- W-a: a call that PARKS during the open (stage in DB_IN_PROGRESS_STAGES) ----
  it("Wa-1: different person signs in (DB closed) while the call is parked -> no restore with the file's tokens, no migration, no old identity", async () => {
    oldFile("new-user");
    mockCheckSessionValidity.mockResolvedValue({ valid: true });
    mockSetSession.mockResolvedValue({ data: { session: null, user: null }, error: await retryableCertError() });
    b.broadcast({ stage: "starting" });
    const h = await parkedCall();
    signInWhileDbClosed();
    dbReady();
    const r = await h.p;
    touchedNothing();
    expect(r.user?.id).not.toBe("old-user");
  });

  it("Wa-2: same person signs in again while the call is parked, old file >24h -> the call clears nothing", async () => {
    oldFile("old-user");
    mockCheckSessionValidity.mockResolvedValue({ valid: false, reason: "expired" });
    b.broadcast({ stage: "migrating" });
    const h = await parkedCall();
    signInWhileDbClosed();
    dbReady();
    await h.p;
    touchedNothing();
  });

  it("Wa-2b: different person signs in while the call is parked, old file >24h -> the call clears nothing", async () => {
    oldFile("new-user");
    mockCheckSessionValidity.mockResolvedValue({ valid: false, reason: "expired" });
    b.broadcast({ stage: "db-opening" });
    const h = await parkedCall();
    signInWhileDbClosed();
    dbReady();
    await h.p;
    touchedNothing();
  });

  it("Wa-3: the call ARRIVES during the open, after the closed-DB sign-in (SupportWidget opened), and parks -> touches nothing", async () => {
    oldFile("new-user");
    mockCheckSessionValidity.mockResolvedValue({ valid: false, reason: "expired" });
    signInWhileDbClosed();
    b.broadcast({ stage: "starting" });
    const h = await parkedCall();
    dbReady(); // the persist has not run yet
    const r = await h.p;
    touchedNothing();
    expect(r.user?.id).not.toBe("old-user");
  });

  it("Wa-4: a sign-in takes the DB-OPEN branch while the call is parked (handle set, db-ready not yet broadcast) -> touches nothing", async () => {
    oldFile("new-user");
    mockCheckSessionValidity.mockResolvedValue({ valid: false, reason: "expired" });
    b.broadcast({ stage: "migrating" });
    const h = await parkedCall();
    dbHandleSet();
    signInWhileDbOpen();
    b.broadcast({ stage: "db-ready" });
    const r = await h.p;
    touchedNothing();
    expect(r.user?.id).not.toBe("old-user");
  });

  it("Wa-I0: the open fails while the call is parked (stage error) -> session.json never read (today's behaviour)", async () => {
    oldFile("new-user");
    b.broadcast({ stage: "starting" });
    const h = await parkedCall();
    b.broadcast({ stage: "error", message: "open failed", error: { message: "open failed", retryable: true } });
    await h.p;
    expect(mockLoadSession).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();
  });

  // ---- W-b: a call that does NOT park (this.db set, databaseService.ts:354) before the session is written ----
  it("Wb-1: DB handle set, stage migrating, closed-DB sign-in pending -> answers at once, touches nothing", async () => {
    oldFile("new-user");
    mockCheckSessionValidity.mockResolvedValue({ valid: false, reason: "expired" });
    signInWhileDbClosed();
    dbHandleSet();
    b.broadcast({ stage: "migrating" });
    const r = await unparkedCall();
    touchedNothing();
    expect(r.user?.id).not.toBe("old-user");
  });

  it("Wb-2: db-ready broadcast, deferred persist has not run -> answers at once, touches nothing (different person, token restore would fail)", async () => {
    oldFile("new-user");
    mockCheckSessionValidity.mockResolvedValue({ valid: true });
    mockSetSession.mockResolvedValue({ data: { session: null, user: null }, error: await retryableCertError() });
    signInWhileDbClosed();
    dbReady();
    const r = await unparkedCall();
    touchedNothing();
    expect(r.user?.id).not.toBe("old-user");
  });

  it("Wb-3 KEEP: the deferred persist wrote the session (flag cleared) -> the call reads session.json again", async () => {
    oldFile("old-user");
    mockCheckSessionValidity.mockResolvedValue({ valid: true });
    mockSetSession.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: { id: "old-user" } }, error: null });
    signInWhileDbClosed();
    dbReady();
    G.markSignInSessionWritten();
    const r = await unparkedCall();
    expect(mockLoadSession).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(true);
  });

  // ---- KEEP: a normal launch, no sign-in ----
  it("KEEP-1: a call in flight during a normal open (no sign-in), same user -> today's result (restore + validated user)", async () => {
    oldFile("old-user");
    mockCheckSessionValidity.mockResolvedValue({ valid: true });
    mockSetSession.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: { id: "old-user" } }, error: null });
    b.broadcast({ stage: "starting" });
    const h = await parkedCall();
    dbReady();
    const r = await h.p;
    expect(mockLoadSession).toHaveBeenCalledTimes(1);
    expect(mockSetSession).toHaveBeenCalledWith({ access_token: "test-access-token", refresh_token: "test-refresh-token" });
    expect(r.success).toBe(true);
    expect(r.user?.id).toBe("old-user");
    expect(migrationSql()).toEqual([]);
  });

  it("KEEP-2: a call in flight during a normal open, TASK-1507G legacy local id -> the migration still runs", async () => {
    const LEGACY = createMockSession({ user: { ...createMockSession().user, id: "legacy-local-id", email: "same@example.com" } });
    oldFile("supa-uuid");
    mockLoadSession.mockResolvedValue(LEGACY);
    mockDbValidateSession.mockResolvedValue(createMockDbUser({ id: "legacy-local-id" }));
    // stateful: the Supabase-id row exists only after the migration INSERT ran (sessionHandlers.ts migrateUserToSupabaseId)
    mockDbGetUserById.mockImplementation(async (id: string) => {
      if (id === "legacy-local-id") return createMockDbUser({ id: "legacy-local-id", email: "same@example.com" });
      if (id === "supa-uuid" && migrationSql().length > 0) return createMockDbUser({ id: "supa-uuid", email: "same@example.com" });
      return null;
    });
    mockCheckSessionValidity.mockResolvedValue({ valid: true });
    mockSetSession.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: { id: "supa-uuid" } }, error: null });
    b.broadcast({ stage: "starting" });
    const h = await parkedCall();
    dbReady();
    const r = await h.p;
    expect(r.success).toBe(true);
    expect(r.user?.id).toBe("supa-uuid");
    expect(migrationSql().length).toBeGreaterThan(0);
  });

  it("KEEP-3: DB already open at entry, no sign-in pending -> today's path, flag false on a normal launch", async () => {
    oldFile("old-user");
    dbReady();
    mockCheckSessionValidity.mockResolvedValue({ valid: true });
    mockSetSession.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: { id: "old-user" } }, error: null });
    expect(G.isSignInAwaitingSessionWrite()).toBe(false);
    const r = await unparkedCall();
    expect(mockLoadSession).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(true);
  });
});
