/**
 * BACKLOG-3833: idle timeout is enforced while the window stays open, and real
 * user input (the renderer heartbeat) keeps an active session alive.
 *
 * Uses the REAL sessionSecurityService; only storage and the window are mocked.
 */
const mockLogService = {
  info: jest.fn().mockResolvedValue(undefined),
  warn: jest.fn().mockResolvedValue(undefined),
  error: jest.fn().mockResolvedValue(undefined),
  debug: jest.fn().mockResolvedValue(undefined),
};
jest.mock("../logService", () => ({ __esModule: true, default: mockLogService }));

const TOKEN = "session-token-3833";
const USER_ID = "user-local-3833";
let mockStoredSession: { sessionToken: string } | null = null;
let mockDbRow: {
  user_id: string;
  created_at: string;
  last_accessed_at: string;
  expires_at: string;
} | null = null;
const mockDeleteSession = jest.fn(async () => {
  mockDbRow = null;
});
const mockClearSession = jest.fn(async () => {
  mockStoredSession = null;
});
// R4: the idle check must not use validateSession (it UPDATEs last_accessed_at).
const mockValidateSession = jest.fn();
const mockGetSessionTimes = jest.fn((token: string) =>
  mockStoredSession && token === mockStoredSession.sessionToken ? mockDbRow : null,
);
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: () => true,
    validateSession: (...a: unknown[]) => mockValidateSession(...a),
    getSessionTimes: (t: string) => mockGetSessionTimes(t),
    deleteSession: (...a: unknown[]) => mockDeleteSession(...(a as [])),
  },
}));
let mockPeekStatus: "ok" | "unreadable" = "ok";
jest.mock("../sessionService", () => ({
  __esModule: true,
  default: {
    peekSession: async () =>
      mockPeekStatus === "unreadable"
        ? { status: "unreadable" }
        : mockStoredSession
          ? { status: "ok", session: mockStoredSession }
          : { status: "none" },
    clearSession: () => mockClearSession(),
  },
}));
// Window closed (macOS keeps running with no window): the push is dropped.
const mockSendToMainWindow = jest.fn((..._a: unknown[]) => false);
jest.mock("../../windowRegistry", () => ({
  sendToMainWindow: (...a: unknown[]) => mockSendToMainWindow(...a),
}));

// Everything the shared sign-out touches (electron/handlers/sessionSignOut.ts, used for real).
const mockSetSyncUserId = jest.fn();
jest.mock("../../handlers/syncHandlers", () => ({
  setSyncUserId: (...a: unknown[]) => mockSetSyncUserId(...a),
}));
const mockAuditLog = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("../auditService", () => ({
  __esModule: true,
  default: { log: (...a: unknown[]) => mockAuditLog(...a) },
}));
const mockShadowStop = jest.fn();
jest.mock("../shadowDeltaSyncService", () => ({
  __esModule: true,
  default: { stop: () => mockShadowStop() },
}));
const mockContactReset = jest.fn();
jest.mock("../../handlers/contactHandlers", () => ({
  resetContactSessionState: () => mockContactReset(),
}));
const mockFeatureGateInvalidate = jest.fn();
jest.mock("../featureGateService", () => ({
  __esModule: true,
  default: { invalidateCache: () => mockFeatureGateInvalidate() },
}));
const mockChecklistInvalidate = jest.fn();
jest.mock("../checklistTemplateService", () => ({
  __esModule: true,
  default: { invalidate: () => mockChecklistInvalidate() },
}));
import * as Sentry from "@sentry/electron/main";

import sessionSecurityService from "../sessionSecurityService";
import {
  enforceSessionIdle,
  startSessionIdleEnforcement,
  stopSessionIdleEnforcement,
  SESSION_IDLE_EXPIRED_CHANNEL,
} from "../sessionIdleEnforcer";

const MIN = 60 * 1000;
const T0 = Date.parse("2026-10-08T12:00:00Z");
const sqliteTs = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

/** The renderer heartbeat: what IPC `session:user-activity` runs. */
const heartbeat = () => enforceSessionIdle({ recordActivity: true });
const signedOut = () =>
  mockStoredSession === null &&
  mockSendToMainWindow.mock.calls.some((c) => c[0] === SESSION_IDLE_EXPIRED_CHANNEL);
/** Let the sign-out's dynamic-import resets settle. */
const flushImports = async () => {
  for (let i = 0; i < 5; i++) await jest.advanceTimersByTimeAsync(0);
  await new Promise((r) => jest.requireActual<typeof import("timers")>("timers").setImmediate(r));
};

describe("session idle enforcement (BACKLOG-3833)", () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    sessionSecurityService.clearAllActivity();
    mockStoredSession = { sessionToken: TOKEN };
    mockPeekStatus = "ok";
    mockDbRow = {
      user_id: USER_ID,
      created_at: sqliteTs(T0),
      last_accessed_at: sqliteTs(T0),
      expires_at: new Date(T0 + 24 * 60 * MIN).toISOString(),
    };
    jest.clearAllMocks();
    // App load: the get-current-user path starts idle tracking.
    await heartbeat();
    startSessionIdleEnforcement();
  });

  afterEach(() => {
    stopSessionIdleEnforcement();
    jest.useRealTimers();
  });

  it("an active user (input every 4 min for 2 h, window open, no syncs) is never signed out", async () => {
    for (let elapsed = 0; elapsed < 120; elapsed += 4) {
      await jest.advanceTimersByTimeAsync(4 * MIN); // periodic checks run in here
      expect(await heartbeat()).toBe("active");
    }
    expect(signedOut()).toBe(false);
    expect(mockDeleteSession).not.toHaveBeenCalled();
  });

  it("no input for 31 min: the periodic check signs the user out and tells the renderer", async () => {
    await jest.advanceTimersByTimeAsync(30 * MIN);
    expect(signedOut()).toBe(false);
    await jest.advanceTimersByTimeAsync(2 * MIN);
    expect(signedOut()).toBe(true);
    expect(mockDeleteSession).toHaveBeenCalledWith(TOKEN);
    expect(mockClearSession).toHaveBeenCalled();
  });

  it("input after 31 min idle does not revive the session: it signs out instead", async () => {
    stopSessionIdleEnforcement(); // isolate the heartbeat path from the periodic check
    jest.setSystemTime(T0 + 31 * MIN);
    expect(await heartbeat()).toBe("expired");
    expect(signedOut()).toBe(true);
    expect(sessionSecurityService.getLastActivity(TOKEN)).toBeNull();
  });

  it("is a no-op when signed out", async () => {
    mockStoredSession = null;
    expect(await heartbeat()).toBe("signed-out");
    expect(mockSendToMainWindow).not.toHaveBeenCalled();
  });

  it("idle expiry with no window runs every sign-out step, audit has the real account id", async () => {
    stopSessionIdleEnforcement();
    jest.setSystemTime(T0 + 31 * MIN);
    expect(await enforceSessionIdle({ recordActivity: false })).toBe("expired");
    await flushImports();

    expect(mockSetSyncUserId).toHaveBeenCalledWith(null);
    expect(Sentry.setUser).toHaveBeenCalledWith(null);
    expect(mockShadowStop).toHaveBeenCalledTimes(1);
    expect(mockContactReset).toHaveBeenCalledTimes(1);
    expect(mockFeatureGateInvalidate).toHaveBeenCalledTimes(1);
    expect(mockChecklistInvalidate).toHaveBeenCalledTimes(1);
    expect(mockAuditLog).toHaveBeenCalledTimes(1);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        action: "LOGOUT",
        sessionId: TOKEN,
        metadata: { reason: "idle" },
      }),
    );
    expect(sessionSecurityService.getLastActivity(TOKEN)).toBeNull();
    expect(mockDeleteSession).toHaveBeenCalledWith(TOKEN);
    expect(mockClearSession).toHaveBeenCalledTimes(1);
    expect(mockStoredSession).toBeNull();
  });

  it("the renderer is told only after the session is cleared", async () => {
    stopSessionIdleEnforcement();
    jest.setSystemTime(T0 + 31 * MIN);
    await enforceSessionIdle({ recordActivity: false });
    expect(mockSendToMainWindow).toHaveBeenCalledWith(SESSION_IDLE_EXPIRED_CHANNEL);
    const notified = mockSendToMainWindow.mock.invocationCallOrder[0];
    expect(mockClearSession.mock.invocationCallOrder[0]).toBeLessThan(notified);
    expect(mockDeleteSession.mock.invocationCallOrder[0]).toBeLessThan(notified);
    expect(mockAuditLog.mock.invocationCallOrder[0]).toBeLessThan(notified);
  });

  it("an unreadable session file never signs out; the next tick still works", async () => {
    mockPeekStatus = "unreadable";
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(await heartbeat()).toBe("unreadable");
    expect(mockDeleteSession).not.toHaveBeenCalled();
    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockSendToMainWindow).not.toHaveBeenCalled();
    mockPeekStatus = "ok";
    expect(await heartbeat()).toBe("active");
  });

  it("idle ticks are read-only: no validateSession (it writes last_accessed_at)", async () => {
    await jest.advanceTimersByTimeAsync(10 * MIN); // ten idle ticks
    expect(mockGetSessionTimes.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(mockValidateSession).not.toHaveBeenCalled();
    expect(await heartbeat()).toBe("active");
    expect(mockValidateSession).not.toHaveBeenCalled();
  });
});
