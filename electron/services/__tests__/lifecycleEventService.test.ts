/**
 * @jest-environment node
 */

/**
 * Unit tests for LifecycleEventService (BACKLOG-2113)
 *
 * Verifies the best-effort contract:
 *   - success path inserts the exact expected field set
 *   - timeout path resolves within the timeout budget (never hangs the wipe)
 *   - error path resolves and warns (never throws)
 *   - offline / rejection path resolves and warns
 *   - no-session path skips the remote write and warns
 */

import { jest } from "@jest/globals";

// ---- Mocks -----------------------------------------------------------------

const mockInsert = jest.fn<(row: unknown) => Promise<{ error: unknown }>>();
const mockFrom = jest.fn(() => ({ insert: mockInsert }));
const mockGetSession =
  jest.fn<() => Promise<{ data: { session: { user: { id: string } } | null } }>>();
const mockGetClient = jest.fn(() => ({
  from: mockFrom,
  auth: { getSession: mockGetSession },
}));

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: mockGetClient },
}));

const mockGetDeviceId = jest.fn<() => string>();
jest.mock("../deviceService", () => ({
  __esModule: true,
  getDeviceId: mockGetDeviceId,
}));

const mockWarn = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    warn: mockWarn,
    info: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("electron", () => ({
  app: { getVersion: jest.fn(() => "9.9.9") },
}));

// Import after mocks are registered.
import {
  logLifecycleEvent,
  logResetEvent,
  logUninstallEvent,
} from "../lifecycleEventService";

const AUTH_USER_ID = "auth-user-123";
const DEVICE_ID = "device-abc";

describe("LifecycleEventService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: AUTH_USER_ID } } },
    });
    mockGetDeviceId.mockReturnValue(DEVICE_ID);
    mockInsert.mockResolvedValue({ error: null });
  });

  describe("success path", () => {
    it("inserts a row with the exact expected field set", async () => {
      await logLifecycleEvent({ event_type: "reset", reason: "user requested" });

      expect(mockFrom).toHaveBeenCalledWith("app_lifecycle_events");
      expect(mockInsert).toHaveBeenCalledTimes(1);

      const row = mockInsert.mock.calls[0][0] as Record<string, unknown>;
      // Assert EXACT field set — no more, no less.
      expect(Object.keys(row).sort()).toEqual(
        [
          "app_version",
          "device_id",
          "event_type",
          "platform",
          "reason",
          "user_id",
        ].sort(),
      );
      expect(row).toEqual({
        user_id: AUTH_USER_ID,
        event_type: "reset",
        app_version: "9.9.9",
        platform: process.platform,
        device_id: DEVICE_ID,
        reason: "user requested",
      });
      // Never warns on the happy path.
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it("omits reason and device_id when not available", async () => {
      mockGetDeviceId.mockImplementation(() => {
        throw new Error("no machine id");
      });

      await logLifecycleEvent({ event_type: "uninstall" });

      const row = mockInsert.mock.calls[0][0] as Record<string, unknown>;
      expect(row).toEqual({
        user_id: AUTH_USER_ID,
        event_type: "uninstall",
        app_version: "9.9.9",
        platform: process.platform,
      });
      expect(row).not.toHaveProperty("device_id");
      expect(row).not.toHaveProperty("reason");
    });

    it("includes metadata when provided", async () => {
      await logLifecycleEvent({
        event_type: "reinstall",
        metadata: { source: "test" },
      });
      const row = mockInsert.mock.calls[0][0] as Record<string, unknown>;
      expect(row.metadata).toEqual({ source: "test" });
    });
  });

  describe("timeout path", () => {
    it("resolves within the timeout budget when the insert hangs", async () => {
      jest.useFakeTimers();
      try {
        // Insert never settles -> the 3s timeout must win.
        mockInsert.mockReturnValue(new Promise(() => {}));

        const promise = logLifecycleEvent({ event_type: "reset" });

        // Advance past the 3s ceiling.
        await jest.advanceTimersByTimeAsync(3000);

        // Must resolve (not hang, not reject).
        await expect(promise).resolves.toBeUndefined();
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn.mock.calls[0][0]).toMatch(/timed out/i);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("error path", () => {
    it("resolves and warns when the DB returns an error", async () => {
      mockInsert.mockResolvedValue({ error: { message: "rls violation" } });

      await expect(
        logLifecycleEvent({ event_type: "reset" }),
      ).resolves.toBeUndefined();

      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn.mock.calls[0][0]).toMatch(/failed/i);
    });

    it("resolves and warns when getClient throws", async () => {
      mockGetClient.mockImplementationOnce(() => {
        throw new Error("client not initialized");
      });

      await expect(
        logLifecycleEvent({ event_type: "uninstall" }),
      ).resolves.toBeUndefined();

      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn.mock.calls[0][0]).toMatch(/failed/i);
    });
  });

  describe("offline path", () => {
    it("resolves and warns when the network request rejects", async () => {
      mockInsert.mockRejectedValue(new Error("fetch failed"));

      await expect(
        logLifecycleEvent({ event_type: "reset" }),
      ).resolves.toBeUndefined();

      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn.mock.calls[0][0]).toMatch(/failed/i);
    });
  });

  describe("no session path", () => {
    it("skips the remote write and warns when unauthenticated", async () => {
      mockGetSession.mockResolvedValue({ data: { session: null } });

      await expect(
        logLifecycleEvent({ event_type: "reset" }),
      ).resolves.toBeUndefined();

      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn.mock.calls[0][0]).toMatch(/no authenticated session/i);
    });
  });

  describe("injectable beforeWipe helpers", () => {
    it("logResetEvent records a reset with the reason", async () => {
      await logResetEvent("cli reset");
      const row = mockInsert.mock.calls[0][0] as Record<string, unknown>;
      expect(row.event_type).toBe("reset");
      expect(row.reason).toBe("cli reset");
    });

    it("logUninstallEvent records an uninstall", async () => {
      await logUninstallEvent();
      const row = mockInsert.mock.calls[0][0] as Record<string, unknown>;
      expect(row.event_type).toBe("uninstall");
      expect(row).not.toHaveProperty("reason");
    });

    it("both helpers match the () => Promise<void> beforeWipe shape", () => {
      const resetHook: () => Promise<void> = () => logResetEvent();
      const uninstallHook: () => Promise<void> = () => logUninstallEvent();
      expect(typeof resetHook).toBe("function");
      expect(typeof uninstallHook).toBe("function");
    });
  });
});
