/**
 * Unit tests for InitializationBroadcaster
 *
 * Tests the singleton service that tracks initialization stages
 * and broadcasts stage transitions to renderer processes.
 *
 * BACKLOG-1379: Event-driven initialization protocol
 */

import {
  InitializationBroadcaster,
  INIT_STAGE_CHANNEL,
} from "../initializationBroadcaster";
import type { InitStageEvent, InitStage } from "../initializationBroadcaster";

// Mock electron
jest.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: jest.fn(() => []),
  },
}));

// Mock electron-log
jest.mock("electron-log", () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Import after mocks
const { BrowserWindow } = require("electron");

describe("InitializationBroadcaster", () => {
  let broadcaster: InitializationBroadcaster;

  beforeEach(() => {
    broadcaster = new InitializationBroadcaster();
    jest.clearAllMocks();
  });

  describe("getCurrentStage", () => {
    it("should return idle stage by default", () => {
      const stage = broadcaster.getCurrentStage();
      expect(stage).toEqual({ stage: "idle" });
    });

    it("should return a copy (not a reference) to prevent external mutation", () => {
      const stage1 = broadcaster.getCurrentStage();
      const stage2 = broadcaster.getCurrentStage();
      expect(stage1).toEqual(stage2);
      expect(stage1).not.toBe(stage2);
    });
  });

  describe("getHistory", () => {
    it("should return empty array initially", () => {
      expect(broadcaster.getHistory()).toEqual([]);
    });

    it("should return a copy to prevent external mutation", () => {
      broadcaster.broadcast({ stage: "db-opening" });
      const history1 = broadcaster.getHistory();
      const history2 = broadcaster.getHistory();
      expect(history1).toEqual(history2);
      expect(history1).not.toBe(history2);
    });
  });

  describe("broadcast", () => {
    it("should update current stage", () => {
      broadcaster.broadcast({ stage: "db-opening", message: "Opening database" });
      const current = broadcaster.getCurrentStage();
      expect(current.stage).toBe("db-opening");
      expect(current.message).toBe("Opening database");
    });

    it("should record stage transitions in history", () => {
      broadcaster.broadcast({ stage: "db-opening" });
      broadcaster.broadcast({ stage: "migrating", progress: 0 });
      broadcaster.broadcast({ stage: "db-ready" });

      const history = broadcaster.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0].stage).toBe("db-opening");
      expect(history[1].stage).toBe("migrating");
      expect(history[2].stage).toBe("db-ready");
    });

    it("should include timestamps in history entries", () => {
      const before = new Date().toISOString();
      broadcaster.broadcast({ stage: "db-opening" });
      const after = new Date().toISOString();

      const history = broadcaster.getHistory();
      expect(history[0].timestamp).toBeDefined();
      expect(history[0].timestamp >= before).toBe(true);
      expect(history[0].timestamp <= after).toBe(true);
    });

    it("should include detail (message) in history entries", () => {
      broadcaster.broadcast({ stage: "migrating", message: "Running v34" });

      const history = broadcaster.getHistory();
      expect(history[0].detail).toBe("Running v34");
    });

    it("should broadcast to all BrowserWindows", () => {
      const mockSend = jest.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend },
      };
      (BrowserWindow.getAllWindows as jest.Mock).mockReturnValue([mockWindow]);

      const event: InitStageEvent = { stage: "db-ready", message: "Database ready" };
      broadcaster.broadcast(event);

      expect(mockSend).toHaveBeenCalledWith(INIT_STAGE_CHANNEL, event);
    });

    it("should broadcast to multiple windows", () => {
      const mockSend1 = jest.fn();
      const mockSend2 = jest.fn();
      const mockWindow1 = {
        isDestroyed: () => false,
        webContents: { send: mockSend1 },
      };
      const mockWindow2 = {
        isDestroyed: () => false,
        webContents: { send: mockSend2 },
      };
      (BrowserWindow.getAllWindows as jest.Mock).mockReturnValue([
        mockWindow1,
        mockWindow2,
      ]);

      const event: InitStageEvent = { stage: "complete" };
      broadcaster.broadcast(event);

      expect(mockSend1).toHaveBeenCalledWith(INIT_STAGE_CHANNEL, event);
      expect(mockSend2).toHaveBeenCalledWith(INIT_STAGE_CHANNEL, event);
    });

    it("should skip destroyed windows without crashing", () => {
      const mockSend = jest.fn();
      const destroyedWindow = {
        isDestroyed: () => true,
        webContents: { send: mockSend },
      };
      const activeWindow = {
        isDestroyed: () => false,
        webContents: { send: jest.fn() },
      };
      (BrowserWindow.getAllWindows as jest.Mock).mockReturnValue([
        destroyedWindow,
        activeWindow,
      ]);

      broadcaster.broadcast({ stage: "db-ready" });

      expect(mockSend).not.toHaveBeenCalled();
      expect(activeWindow.webContents.send).toHaveBeenCalled();
    });

    it("should not crash when no windows exist", () => {
      (BrowserWindow.getAllWindows as jest.Mock).mockReturnValue([]);

      expect(() => {
        broadcaster.broadcast({ stage: "db-opening" });
      }).not.toThrow();

      // Stage should still be updated even without windows
      expect(broadcaster.getCurrentStage().stage).toBe("db-opening");
    });

    it("should not crash when getAllWindows throws", () => {
      (BrowserWindow.getAllWindows as jest.Mock).mockImplementation(() => {
        throw new Error("No windows available");
      });

      expect(() => {
        broadcaster.broadcast({ stage: "db-opening" });
      }).not.toThrow();

      // Stage should still be recorded
      expect(broadcaster.getCurrentStage().stage).toBe("db-opening");
      expect(broadcaster.getHistory()).toHaveLength(1);
    });
  });

  describe("error stage", () => {
    it("should include error details in the event", () => {
      const errorEvent: InitStageEvent = {
        stage: "error",
        message: "Migration failed",
        error: { message: "Column already exists", retryable: true },
      };

      broadcaster.broadcast(errorEvent);

      const current = broadcaster.getCurrentStage();
      expect(current.stage).toBe("error");
      expect(current.error).toEqual({
        message: "Column already exists",
        retryable: true,
      });
    });

    it("should support non-retryable errors", () => {
      broadcaster.broadcast({
        stage: "error",
        error: { message: "Encryption key invalid", retryable: false },
      });

      const current = broadcaster.getCurrentStage();
      expect(current.error?.retryable).toBe(false);
    });
  });

  describe("migration progress", () => {
    it("should include progress during migrating stage", () => {
      broadcaster.broadcast({
        stage: "migrating",
        progress: 50,
        message: "Running migration 5 of 10",
      });

      const current = broadcaster.getCurrentStage();
      expect(current.stage).toBe("migrating");
      expect(current.progress).toBe(50);
      expect(current.message).toBe("Running migration 5 of 10");
    });

    it("should track progress updates in history", () => {
      broadcaster.broadcast({ stage: "migrating", progress: 0 });
      broadcaster.broadcast({ stage: "migrating", progress: 50 });
      broadcaster.broadcast({ stage: "migrating", progress: 100 });

      const history = broadcaster.getHistory();
      expect(history).toHaveLength(3);
      // All three are "migrating" stage entries
      expect(history.every((h) => h.stage === "migrating")).toBe(true);
    });
  });

  describe("full lifecycle", () => {
    it("should track complete initialization sequence", () => {
      const stages: InitStage[] = [
        "idle",
        "db-opening",
        "migrating",
        "db-ready",
        "creating-user",
        "complete",
      ];

      for (const stage of stages) {
        broadcaster.broadcast({ stage });
      }

      expect(broadcaster.getCurrentStage().stage).toBe("complete");
      expect(broadcaster.getHistory()).toHaveLength(6);

      const historyStages = broadcaster.getHistory().map((h) => h.stage);
      expect(historyStages).toEqual(stages);
    });
  });

  describe("reset", () => {
    it("should reset to idle state", () => {
      broadcaster.broadcast({ stage: "complete" });
      broadcaster.reset();

      expect(broadcaster.getCurrentStage()).toEqual({ stage: "idle" });
      expect(broadcaster.getHistory()).toEqual([]);
    });
  });

  // BACKLOG-2149: awaitable db-ready gate for post-auth consumers.
  describe("whenDbReady", () => {
    it("resolves immediately with ready when already db-ready", async () => {
      broadcaster.broadcast({ stage: "db-ready" });
      const result = await broadcaster.whenDbReady();
      expect(result).toEqual({ ready: true, timedOut: false });
    });

    it("resolves immediately with ready when already complete", async () => {
      broadcaster.broadcast({ stage: "complete" });
      const result = await broadcaster.whenDbReady();
      expect(result).toEqual({ ready: true, timedOut: false });
    });

    it("resolves when db-ready is broadcast later", async () => {
      // Not ready yet (idle).
      const pending = broadcaster.whenDbReady(1000);
      // Simulate the init sequence reaching db-ready.
      broadcaster.broadcast({ stage: "db-opening" });
      broadcaster.broadcast({ stage: "migrating", progress: 0 });
      broadcaster.broadcast({ stage: "db-ready" });

      const result = await pending;
      expect(result).toEqual({ ready: true, timedOut: false });
    });

    it("resolves ready when a later 'complete' arrives", async () => {
      const pending = broadcaster.whenDbReady(1000);
      broadcaster.broadcast({ stage: "creating-user" });
      broadcaster.broadcast({ stage: "complete" });
      const result = await pending;
      expect(result.ready).toBe(true);
    });

    it("resolves not-ready with error details when init errors", async () => {
      const pending = broadcaster.whenDbReady(1000);
      broadcaster.broadcast({
        stage: "error",
        error: { message: "Migration failed", retryable: true },
      });
      const result = await pending;
      expect(result.ready).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.error).toEqual({ message: "Migration failed", retryable: true });
    });

    it("times out when db-ready never arrives", async () => {
      jest.useFakeTimers();
      try {
        const pending = broadcaster.whenDbReady(5000);
        // Advance past the timeout without any db-ready broadcast.
        jest.advanceTimersByTime(5001);
        const result = await pending;
        expect(result).toEqual({ ready: false, timedOut: true });
      } finally {
        jest.useRealTimers();
      }
    });

    it("does not resolve on non-terminal stages (db-opening/migrating)", async () => {
      jest.useFakeTimers();
      try {
        let settled = false;
        const pending = broadcaster.whenDbReady(5000).then((r) => {
          settled = true;
          return r;
        });

        broadcaster.broadcast({ stage: "db-opening" });
        broadcaster.broadcast({ stage: "migrating", progress: 50 });
        // Flush microtasks — should still be pending.
        await Promise.resolve();
        expect(settled).toBe(false);

        broadcaster.broadcast({ stage: "db-ready" });
        const result = await pending;
        expect(result.ready).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it("resolves multiple concurrent waiters on a single db-ready", async () => {
      const p1 = broadcaster.whenDbReady(1000);
      const p2 = broadcaster.whenDbReady(1000);
      const p3 = broadcaster.whenDbReady(1000);

      broadcaster.broadcast({ stage: "db-ready" });

      const results = await Promise.all([p1, p2, p3]);
      expect(results.every((r) => r.ready)).toBe(true);
    });

    it("releases pending waiters on reset (as not-ready)", async () => {
      const pending = broadcaster.whenDbReady(60000);
      broadcaster.reset();
      const result = await pending;
      expect(result.ready).toBe(false);
    });

    it("treats timeoutMs<=0 as no timeout (waits for broadcast)", async () => {
      jest.useFakeTimers();
      try {
        let settled = false;
        const pending = broadcaster.whenDbReady(0).then((r) => {
          settled = true;
          return r;
        });
        // Even a large advance should not resolve it (no timer armed).
        jest.advanceTimersByTime(10 * 60 * 1000);
        await Promise.resolve();
        expect(settled).toBe(false);

        broadcaster.broadcast({ stage: "db-ready" });
        const result = await pending;
        expect(result.ready).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("setWindow", () => {
    it("should accept a BrowserWindow reference", () => {
      const mockWindow = {} as Electron.BrowserWindow;
      expect(() => broadcaster.setWindow(mockWindow)).not.toThrow();
    });

    it("should accept null to clear window reference", () => {
      expect(() => broadcaster.setWindow(null)).not.toThrow();
    });
  });
});
