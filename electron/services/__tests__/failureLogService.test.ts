/**
 * Failure Log Service Tests
 * TASK-2254: Tests for the failure log service (network error persistence)
 */

const mockDbRun = jest.fn().mockReturnValue({ changes: 0 });
const mockDbAll = jest.fn().mockReturnValue([]);
const mockDbGet = jest.fn().mockReturnValue(null);
const mockDbExec = jest.fn();
const mockEnsureDb = jest.fn();

jest.mock("../db/core/dbConnection", () => ({
  dbRun: (...args: unknown[]) => mockDbRun(...args),
  dbAll: (...args: unknown[]) => mockDbAll(...args),
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbExec: (...args: unknown[]) => mockDbExec(...args),
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
  // BACKLOG-3319: pruneOldEntries runs in one transaction. This mock cannot see
  // transaction placement; failureLogService.pruneAtomicity-3319.test.ts can.
  dbTransaction: (fn: () => unknown) => fn(),
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
}));

import failureLogService from "../failureLogService";

describe("FailureLogService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("logFailure", () => {
    it("should insert failure entry into database", async () => {
      await failureLogService.logFailure("outlook_sync", "Network timeout");

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO failure_log"),
        ["outlook_sync", "Network timeout", null]
      );
    });

    it("should serialize metadata as JSON", async () => {
      const metadata = { endpoint: "/api/sync", retries: 3 };
      await failureLogService.logFailure("api_call", "500 error", metadata);

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO failure_log"),
        ["api_call", "500 error", JSON.stringify(metadata)]
      );
    });

    it("should not throw when database insert fails", async () => {
      mockDbRun.mockImplementationOnce(() => {
        throw new Error("DB locked");
      });

      // Should not throw
      await expect(
        failureLogService.logFailure("test_op", "some error")
      ).resolves.not.toThrow();
    });
  });

  describe("getRecentFailures", () => {
    it("should query with default limit of 50", async () => {
      const mockEntries = [
        { id: 1, timestamp: "2024-01-01", operation: "sync", error_message: "fail", metadata: null, acknowledged: 0 },
      ];
      mockDbAll.mockReturnValue(mockEntries);

      const result = await failureLogService.getRecentFailures();

      expect(mockDbAll).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY timestamp DESC LIMIT ?"),
        [50]
      );
      expect(result).toEqual(mockEntries);
    });

    it("should accept custom limit", async () => {
      mockDbAll.mockReturnValue([]);

      await failureLogService.getRecentFailures(10);

      expect(mockDbAll).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT ?"),
        [10]
      );
    });
  });

  describe("getFailuresSince", () => {
    it("should query failures after given timestamp", async () => {
      mockDbAll.mockReturnValue([]);

      await failureLogService.getFailuresSince("2024-06-01T00:00:00Z");

      expect(mockDbAll).toHaveBeenCalledWith(
        expect.stringContaining("WHERE timestamp >= ?"),
        ["2024-06-01T00:00:00Z"]
      );
    });
  });

  describe("getFailureCount", () => {
    it("should return count of unacknowledged failures", async () => {
      mockDbGet.mockReturnValue({ count: 7 });

      const count = await failureLogService.getFailureCount();

      expect(count).toBe(7);
      expect(mockDbGet).toHaveBeenCalledWith(
        expect.stringContaining("WHERE acknowledged = 0")
      );
    });

    it("should return 0 when no rows found", async () => {
      mockDbGet.mockReturnValue(null);

      const count = await failureLogService.getFailureCount();

      expect(count).toBe(0);
    });
  });

  describe("acknowledgeAll", () => {
    it("should update all unacknowledged failures", async () => {
      await failureLogService.acknowledgeAll();

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE failure_log SET acknowledged = 1")
      );
    });
  });

  describe("clearLog", () => {
    it("should delete all failure log entries", async () => {
      await failureLogService.clearLog();

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM failure_log")
      );
    });
  });

  describe("pruneOldEntries", () => {
    it("should delete entries older than 30 days", async () => {
      mockDbRun.mockReturnValue({ changes: 5 });
      mockDbGet.mockReturnValue({ count: 10 });

      await failureLogService.pruneOldEntries();

      expect(mockDbRun).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM failure_log WHERE timestamp < datetime"),
        expect.arrayContaining(["-30 days"])
      );
    });

    it("should cap entries at 500 when count exceeds limit", async () => {
      // First call is the age-based delete
      mockDbRun.mockReturnValueOnce({ changes: 0 });
      // Count after age-based pruning
      mockDbGet.mockReturnValue({ count: 550 });
      // Second call is the cap-based delete
      mockDbRun.mockReturnValueOnce({ changes: 50 });

      await failureLogService.pruneOldEntries();

      // Should have been called with excess count (550 - 500 = 50)
      expect(mockDbRun).toHaveBeenCalledTimes(2);
    });

    it("should not throw when pruning fails", async () => {
      mockDbRun.mockImplementationOnce(() => {
        throw new Error("DB error");
      });

      await expect(
        failureLogService.pruneOldEntries()
      ).resolves.not.toThrow();
    });
  });

  describe("initialize", () => {
    it("should create table if not exists", async () => {
      mockDbRun.mockReturnValue({ changes: 0 });
      mockDbGet.mockReturnValue({ count: 0 });

      await failureLogService.initialize();

      expect(mockDbExec).toHaveBeenCalledWith(
        expect.stringContaining("CREATE TABLE IF NOT EXISTS failure_log")
      );
    });

    it("should not throw when initialization fails", async () => {
      mockDbExec.mockImplementationOnce(() => {
        throw new Error("Table creation failed");
      });

      await expect(
        failureLogService.initialize()
      ).resolves.not.toThrow();
    });
  });
});
