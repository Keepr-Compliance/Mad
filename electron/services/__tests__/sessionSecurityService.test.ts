/**
 * Unit tests for SessionSecurityService
 * Tests session validity, idle timeout, and absolute timeout functionality
 */

// Mock logService before importing sessionSecurityService
const mockLogService = {
  info: jest.fn().mockResolvedValue(undefined),
  warn: jest.fn().mockResolvedValue(undefined),
  error: jest.fn().mockResolvedValue(undefined),
  debug: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../logService", () => mockLogService);

import { sessionSecurityService } from "../sessionSecurityService";

describe("SessionSecurityService", () => {
  const testSessionToken = "test-session-token-123";

  beforeEach(() => {
    // Clear all activity tracking before each test
    sessionSecurityService.clearAllActivity();
    jest.clearAllMocks();
  });

  describe("checkSessionValidity", () => {
    it("should return valid for a fresh session", async () => {
      const session = {
        created_at: new Date().toISOString(),
      };

      const result = await sessionSecurityService.checkSessionValidity(
        session,
        testSessionToken,
      );

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should expire session after 24 hours", async () => {
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const session = {
        created_at: twentyFiveHoursAgo.toISOString(),
      };

      const result = await sessionSecurityService.checkSessionValidity(
        session,
        testSessionToken,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("expired");
    });

    it("should be valid just before 24 hour expiration", async () => {
      const twentyThreeHoursAgo = new Date(Date.now() - 23 * 60 * 60 * 1000);
      const session = {
        created_at: twentyThreeHoursAgo.toISOString(),
      };

      // Record recent activity so idle timeout doesn't trigger
      sessionSecurityService.recordActivity(testSessionToken);

      const result = await sessionSecurityService.checkSessionValidity(
        session,
        testSessionToken,
      );

      expect(result.valid).toBe(true);
    });

    it("does not count a stale last_accessed_at as idle on a fresh process (BACKLOG-3297)", async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const session = {
        created_at: oneHourAgo.toISOString(),
        last_accessed_at: oneHourAgo.toISOString(),
      };

      // No in-process activity for this token: the previous lookup time is not
      // idle time. Idle tracking starts at this check.
      const result = await sessionSecurityService.checkSessionValidity(
        session,
        testSessionToken,
      );

      expect(result).toEqual({ valid: true });
      expect(sessionSecurityService.getLastActivity(testSessionToken)).not.toBeNull();
    });

    it("should be valid within idle timeout", async () => {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      const session = {
        created_at: fifteenMinutesAgo.toISOString(),
      };

      // Record recent activity
      sessionSecurityService.recordActivity(testSessionToken);

      const result = await sessionSecurityService.checkSessionValidity(
        session,
        testSessionToken,
      );

      expect(result.valid).toBe(true);
    });
  });

  describe("recordActivity", () => {
    it("should track activity for a session", () => {
      sessionSecurityService.recordActivity(testSessionToken);

      const lastActivity =
        sessionSecurityService.getLastActivity(testSessionToken);

      expect(lastActivity).not.toBeNull();
      expect(lastActivity).toBeGreaterThan(Date.now() - 1000);
    });

    it("should update activity time on subsequent calls", async () => {
      sessionSecurityService.recordActivity(testSessionToken);
      const firstActivity =
        sessionSecurityService.getLastActivity(testSessionToken);

      // Wait a small amount
      await new Promise((resolve) => setTimeout(resolve, 10));

      sessionSecurityService.recordActivity(testSessionToken);
      const secondActivity =
        sessionSecurityService.getLastActivity(testSessionToken);

      expect(secondActivity).toBeGreaterThanOrEqual(firstActivity!);
    });
  });

  describe("getLastActivity", () => {
    it("should return null for untracked session", () => {
      const lastActivity =
        sessionSecurityService.getLastActivity("unknown-session");

      expect(lastActivity).toBeNull();
    });

    it("should return timestamp for tracked session", () => {
      sessionSecurityService.recordActivity(testSessionToken);

      const lastActivity =
        sessionSecurityService.getLastActivity(testSessionToken);

      expect(lastActivity).not.toBeNull();
      expect(typeof lastActivity).toBe("number");
    });
  });

  describe("cleanupSession", () => {
    it("should remove session from activity tracking", () => {
      sessionSecurityService.recordActivity(testSessionToken);
      expect(
        sessionSecurityService.getLastActivity(testSessionToken),
      ).not.toBeNull();

      sessionSecurityService.cleanupSession(testSessionToken);

      expect(
        sessionSecurityService.getLastActivity(testSessionToken),
      ).toBeNull();
    });
  });

  describe("getRemainingSessionTime", () => {
    it("should return positive time for valid session", () => {
      const session = {
        created_at: new Date().toISOString(),
      };

      const remainingTime =
        sessionSecurityService.getRemainingSessionTime(session);

      expect(remainingTime).toBeGreaterThan(0);
      // Should be close to 24 hours (86400 seconds)
      expect(remainingTime).toBeLessThanOrEqual(24 * 60 * 60);
    });

    it("should return 0 for expired session", () => {
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const session = {
        created_at: twentyFiveHoursAgo.toISOString(),
      };

      const remainingTime =
        sessionSecurityService.getRemainingSessionTime(session);

      expect(remainingTime).toBe(0);
    });
  });

  describe("getRemainingIdleTime", () => {
    it("should return full idle time for untracked session", () => {
      const remainingTime =
        sessionSecurityService.getRemainingIdleTime("unknown-session");

      // Should be close to 30 minutes (1800 seconds)
      expect(remainingTime).toBe(30 * 60);
    });

    it("should return remaining idle time for tracked session", () => {
      sessionSecurityService.recordActivity(testSessionToken);

      const remainingTime =
        sessionSecurityService.getRemainingIdleTime(testSessionToken);

      expect(remainingTime).toBeGreaterThan(0);
      expect(remainingTime).toBeLessThanOrEqual(30 * 60);
    });
  });

  describe("getConfig", () => {
    it("should return configuration values", () => {
      const config = sessionSecurityService.getConfig();

      expect(config.idleTimeoutMs).toBe(30 * 60 * 1000); // 30 minutes
      expect(config.sessionTimeoutMs).toBe(24 * 60 * 60 * 1000); // 24 hours
    });
  });

  /**
   * BACKLOG-3297 — time the app spends closed is not idle time.
   *
   * Timestamps are in the shape the real producer writes: `sessions.created_at`
   * and `last_accessed_at` are `DEFAULT CURRENT_TIMESTAMP` / `SET ... =
   * CURRENT_TIMESTAMP`, which SQLite stores as "YYYY-MM-DD HH:MM:SS" in UTC with
   * no zone marker (transcribed from `createSession` + a raw SELECT:
   * `{"created_at":"2026-09-13 18:15:21","last_accessed_at":"2026-09-13 18:15:21",
   * "expires_at":"2026-09-14T18:15:21.549Z"}`). Only `Date` is faked.
   */
  describe("closed time and the idle rule (BACKLOG-3297)", () => {
    const MIN = 60 * 1000;
    const HOUR = 60 * MIN;
    const T0 = Date.UTC(2026, 8, 13, 18, 15, 21);
    const TOKEN = "token-3297";
    /** "2026-09-13 18:15:21" — the SQLite CURRENT_TIMESTAMP shape. */
    const sqliteUtc = (ms: number): string =>
      new Date(ms).toISOString().replace("T", " ").slice(0, 19);

    beforeEach(() => {
      jest.useFakeTimers({
        now: T0,
        doNotFake: [
          "nextTick",
          "queueMicrotask",
          "setImmediate",
          "clearImmediate",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
        ],
      });
      sessionSecurityService.clearAllActivity();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    /** A fresh process checks a session last looked up `closedFor` ago. */
    async function relaunchAfter(closedFor: number, createdBeforeLastLookup = 0) {
      const lastLookup = T0 - closedFor;
      return sessionSecurityService.checkSessionValidity(
        {
          created_at: sqliteUtc(lastLookup - createdBeforeLastLookup),
          last_accessed_at: sqliteUtc(lastLookup),
        },
        TOKEN,
      );
    }

    /** First check in this process at T0, then activity recorded at T0. */
    async function startRunningSession(createdAt = T0) {
      const session = { created_at: sqliteUtc(createdAt), last_accessed_at: sqliteUtc(T0) };
      await expect(sessionSecurityService.checkSessionValidity(session, TOKEN)).resolves.toEqual({
        valid: true,
      });
      sessionSecurityService.recordActivity(TOKEN);
      return session;
    }

    it("C1 relaunch after 13h closed -> still signed in", async () => {
      await expect(relaunchAfter(13 * HOUR)).resolves.toEqual({ valid: true });
    });

    it("C1b relaunch after 31m closed -> still signed in", async () => {
      await expect(relaunchAfter(31 * MIN)).resolves.toEqual({ valid: true });
    });

    it("C4 relaunch after a crash (no shutdown record of any kind), 13h later -> still signed in", async () => {
      await expect(relaunchAfter(13 * HOUR, 10 * MIN)).resolves.toEqual({ valid: true });
    });

    it("C2 running process: activity at T, check at T+31m -> idle", async () => {
      const session = await startRunningSession();
      jest.setSystemTime(T0 + 31 * MIN);
      await expect(sessionSecurityService.checkSessionValidity(session, TOKEN)).resolves.toEqual({
        valid: false,
        reason: "idle",
      });
    });

    it("C2b running process: activity at T, check at T+29m -> valid", async () => {
      const session = await startRunningSession();
      jest.setSystemTime(T0 + 29 * MIN);
      await expect(sessionSecurityService.checkSessionValidity(session, TOKEN)).resolves.toEqual({
        valid: true,
      });
    });

    it("C3 relaunch, session created 24h10m ago -> expired", async () => {
      await expect(relaunchAfter(10 * MIN, 24 * HOUR)).resolves.toEqual({
        valid: false,
        reason: "expired",
      });
    });

    it("C3b running process with recent activity, session created 24h10m ago -> expired", async () => {
      sessionSecurityService.recordActivity(TOKEN);
      await expect(
        sessionSecurityService.checkSessionValidity(
          { created_at: sqliteUtc(T0 - 24 * HOUR - 10 * MIN), last_accessed_at: sqliteUtc(T0) },
          TOKEN,
        ),
      ).resolves.toEqual({ valid: false, reason: "expired" });
    });

    it("C3c relaunch, session created 23h50m ago -> still signed in", async () => {
      await expect(relaunchAfter(10 * MIN, 23 * HOUR + 40 * MIN)).resolves.toEqual({ valid: true });
    });

    it("C7 unparseable created_at -> invalid", async () => {
      await expect(
        sessionSecurityService.checkSessionValidity(
          { created_at: "not a date", last_accessed_at: sqliteUtc(T0) },
          TOKEN,
        ),
      ).resolves.toEqual({ valid: false, reason: "invalid" });
    });
  });

  describe("clearAllActivity", () => {
    it("should clear all activity tracking", () => {
      sessionSecurityService.recordActivity("session1");
      sessionSecurityService.recordActivity("session2");
      sessionSecurityService.recordActivity("session3");

      sessionSecurityService.clearAllActivity();

      expect(sessionSecurityService.getLastActivity("session1")).toBeNull();
      expect(sessionSecurityService.getLastActivity("session2")).toBeNull();
      expect(sessionSecurityService.getLastActivity("session3")).toBeNull();
    });
  });
});
