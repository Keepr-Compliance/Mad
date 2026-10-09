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
let mockStoredSession: { sessionToken: string } | null = null;
let mockDbRow: { created_at: string; last_accessed_at: string } | null = null;
const mockDeleteSession = jest.fn(async () => {
  mockDbRow = null;
});
const mockClearSession = jest.fn(async () => {
  mockStoredSession = null;
});
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: () => true,
    validateSession: async (token: string) =>
      mockStoredSession && token === mockStoredSession.sessionToken ? mockDbRow : null,
    deleteSession: (...a: unknown[]) => mockDeleteSession(...(a as [])),
  },
}));
jest.mock("../sessionService", () => ({
  __esModule: true,
  default: {
    loadSession: async () => mockStoredSession,
    clearSession: () => mockClearSession(),
  },
}));
const mockSendToMainWindow = jest.fn((..._a: unknown[]) => true);
jest.mock("../../windowRegistry", () => ({
  sendToMainWindow: (...a: unknown[]) => mockSendToMainWindow(...a),
}));

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

describe("session idle enforcement (BACKLOG-3833)", () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    sessionSecurityService.clearAllActivity();
    mockStoredSession = { sessionToken: TOKEN };
    mockDbRow = { created_at: sqliteTs(T0), last_accessed_at: sqliteTs(T0) };
    mockDeleteSession.mockClear();
    mockClearSession.mockClear();
    mockSendToMainWindow.mockClear();
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
});
