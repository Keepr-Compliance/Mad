/**
 * TASK-2068: Tests for canonical date-range calculation utility.
 *
 * Covers:
 * - All date field combinations (started_at, created_at, closed_at)
 * - Fallback to 2 years ago when no start dates
 * - closed_at + 30 day buffer for end date
 * - Invalid date strings
 * - Null/undefined fields
 * - Backwards-compatible computeEmailFetchSinceDate wrapper
 */

import {
  computeTransactionDateRange,
  computeEmailFetchSinceDate,
  computeEarliestAuditStart,
  DEFAULT_BUFFER_DAYS,
} from "../emailDateRange";

describe("computeTransactionDateRange", () => {
  // ==========================================
  // START DATE TESTS
  // ==========================================

  describe("start date", () => {
    it("should use started_at when available (Date object)", () => {
      const started = new Date("2024-03-15T00:00:00Z");
      const { start } = computeTransactionDateRange({
        started_at: started,
        created_at: new Date("2024-06-01T00:00:00Z"),
      });
      expect(start.getTime()).toBe(started.getTime());
    });

    it("should use started_at when available (ISO string)", () => {
      const { start } = computeTransactionDateRange({
        started_at: "2024-03-15T00:00:00Z",
        created_at: "2024-06-01T00:00:00Z",
      });
      expect(start.toISOString()).toBe("2024-03-15T00:00:00.000Z");
    });

    it("should prefer started_at over created_at", () => {
      const { start } = computeTransactionDateRange({
        started_at: "2024-01-01T00:00:00Z",
        created_at: "2024-06-01T00:00:00Z",
      });
      expect(start.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    });

    it("should fall back to created_at when started_at is missing", () => {
      const created = new Date("2024-06-01T00:00:00Z");
      const { start } = computeTransactionDateRange({
        created_at: created,
      });
      expect(start.getTime()).toBe(created.getTime());
    });

    it("should fall back to created_at when started_at is undefined", () => {
      const { start } = computeTransactionDateRange({
        started_at: undefined,
        created_at: "2024-01-20T12:00:00Z",
      });
      expect(start.toISOString()).toBe("2024-01-20T12:00:00.000Z");
    });

    it("should fall back to created_at when started_at is null", () => {
      const { start } = computeTransactionDateRange({
        started_at: null,
        created_at: "2024-01-20T12:00:00Z",
      });
      expect(start.toISOString()).toBe("2024-01-20T12:00:00.000Z");
    });

    it("should fall back to created_at when started_at is invalid", () => {
      const { start } = computeTransactionDateRange({
        started_at: "invalid-date",
        created_at: "2024-06-01T00:00:00Z",
      });
      expect(start.toISOString()).toBe("2024-06-01T00:00:00.000Z");
    });

    it("should fall back to 2 years ago when no dates available", () => {
      const { start } = computeTransactionDateRange({});
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

      const diffMs = Math.abs(start.getTime() - twoYearsAgo.getTime());
      expect(diffMs).toBeLessThan(5000); // Within 5 seconds
    });

    it("should fall back to 2 years ago when both dates are invalid", () => {
      const { start } = computeTransactionDateRange({
        started_at: "invalid",
        created_at: "also-invalid",
      });
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

      const diffMs = Math.abs(start.getTime() - twoYearsAgo.getTime());
      expect(diffMs).toBeLessThan(5000);
    });

    it("should fall back to 2 years ago when both dates are null", () => {
      const { start } = computeTransactionDateRange({
        started_at: null,
        created_at: null,
      });
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

      const diffMs = Math.abs(start.getTime() - twoYearsAgo.getTime());
      expect(diffMs).toBeLessThan(5000);
    });
  });

  // ==========================================
  // END DATE TESTS
  // ==========================================

  describe("end date", () => {
    it("should default to today when closed_at is not set", () => {
      const before = new Date();
      const { end } = computeTransactionDateRange({
        started_at: "2024-01-01T00:00:00Z",
      });
      const after = new Date();

      expect(end.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(end.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("should use closed_at + 30 day buffer when closed_at is set", () => {
      const { end } = computeTransactionDateRange({
        started_at: "2024-01-01T00:00:00Z",
        closed_at: "2024-12-01T00:00:00Z",
      });

      const expected = new Date("2024-12-01T00:00:00Z");
      expected.setDate(expected.getDate() + DEFAULT_BUFFER_DAYS);

      expect(end.toISOString()).toBe(expected.toISOString());
    });

    it("should add exactly 30 days buffer to closed_at", () => {
      const closedAt = new Date("2024-06-15T12:00:00Z");
      const { end } = computeTransactionDateRange({
        closed_at: closedAt,
      });

      const expectedEnd = new Date(closedAt);
      expectedEnd.setDate(expectedEnd.getDate() + 30);

      expect(end.getTime()).toBe(expectedEnd.getTime());
    });

    it("should accept closed_at as string", () => {
      const { end } = computeTransactionDateRange({
        closed_at: "2024-09-01T00:00:00Z",
      });

      const expected = new Date("2024-09-01T00:00:00Z");
      expected.setDate(expected.getDate() + DEFAULT_BUFFER_DAYS);

      expect(end.toISOString()).toBe(expected.toISOString());
    });

    it("should default to today when closed_at is null", () => {
      const before = new Date();
      const { end } = computeTransactionDateRange({
        started_at: "2024-01-01T00:00:00Z",
        closed_at: null,
      });
      const after = new Date();

      expect(end.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(end.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("should default to today when closed_at is invalid", () => {
      const before = new Date();
      const { end } = computeTransactionDateRange({
        started_at: "2024-01-01T00:00:00Z",
        closed_at: "not-a-date",
      });
      const after = new Date();

      expect(end.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(end.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  // ==========================================
  // COMBINED (BOTH START + END) TESTS
  // ==========================================

  describe("combined start and end", () => {
    it("should compute full range with all dates provided", () => {
      const { start, end } = computeTransactionDateRange({
        started_at: "2024-01-15T00:00:00Z",
        created_at: "2024-01-10T00:00:00Z",
        closed_at: "2024-11-30T00:00:00Z",
      });

      // Start should be started_at (preferred over created_at)
      expect(start.toISOString()).toBe("2024-01-15T00:00:00.000Z");

      // End should be closed_at + 30 days
      const expectedEnd = new Date("2024-11-30T00:00:00Z");
      expectedEnd.setDate(expectedEnd.getDate() + 30);
      expect(end.toISOString()).toBe(expectedEnd.toISOString());
    });

    it("should handle empty params object", () => {
      const before = new Date();
      const { start, end } = computeTransactionDateRange({});
      const after = new Date();

      // Start: 2 years ago
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      const diffMs = Math.abs(start.getTime() - twoYearsAgo.getTime());
      expect(diffMs).toBeLessThan(5000);

      // End: today
      expect(end.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(end.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("should ensure start is before end with typical transaction dates", () => {
      const { start, end } = computeTransactionDateRange({
        started_at: "2024-01-01T00:00:00Z",
        closed_at: "2024-12-31T00:00:00Z",
      });

      expect(start.getTime()).toBeLessThan(end.getTime());
    });
  });
});

// ==========================================
// BACKWARDS-COMPATIBLE WRAPPER
// ==========================================

describe("computeEmailFetchSinceDate (backwards-compat wrapper)", () => {
  it("should return only the start date", () => {
    const result = computeEmailFetchSinceDate({
      started_at: "2024-03-15T00:00:00Z",
      created_at: "2024-06-01T00:00:00Z",
    });
    expect(result.toISOString()).toBe("2024-03-15T00:00:00.000Z");
  });

  it("should fall back to created_at", () => {
    const result = computeEmailFetchSinceDate({
      created_at: "2024-06-01T00:00:00Z",
    });
    expect(result.toISOString()).toBe("2024-06-01T00:00:00.000Z");
  });

  it("should fall back to 2 years ago", () => {
    const result = computeEmailFetchSinceDate({});
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

    const diffMs = Math.abs(result.getTime() - twoYearsAgo.getTime());
    expect(diffMs).toBeLessThan(5000);
  });
});

// ==========================================
// CONSTANTS
// ==========================================

describe("DEFAULT_BUFFER_DAYS constant", () => {
  it("should be 30", () => {
    expect(DEFAULT_BUFFER_DAYS).toBe(30);
  });
});

// ==========================================
// BACKLOG-2276: computeEarliestAuditStart
// ==========================================

describe("computeEarliestAuditStart", () => {
  it("should return null for an empty transaction list", () => {
    expect(computeEarliestAuditStart([])).toBeNull();
  });

  it("should return the single transaction's start (started_at)", () => {
    const result = computeEarliestAuditStart([
      { started_at: "2023-05-01T00:00:00Z", created_at: "2023-06-01T00:00:00Z" },
    ]);
    expect(result?.toISOString()).toBe("2023-05-01T00:00:00.000Z");
  });

  it("should return the EARLIEST start across multiple transactions", () => {
    const result = computeEarliestAuditStart([
      { started_at: "2024-01-01T00:00:00Z" },
      { started_at: "2022-03-15T00:00:00Z" }, // earliest
      { started_at: "2023-09-01T00:00:00Z" },
    ]);
    expect(result?.toISOString()).toBe("2022-03-15T00:00:00.000Z");
  });

  it("should use created_at when started_at is missing (per-tx priority)", () => {
    const result = computeEarliestAuditStart([
      { started_at: "2024-01-01T00:00:00Z" },
      { created_at: "2021-01-01T00:00:00Z" }, // earliest via created_at
    ]);
    expect(result?.toISOString()).toBe("2021-01-01T00:00:00.000Z");
  });

  it("should preserve the 2-year fallback for a tx with no dates", () => {
    // A transaction missing both dates falls back to ~2 years ago; with only such
    // a transaction, the earliest start is that fallback.
    const result = computeEarliestAuditStart([{}]);
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    expect(result).not.toBeNull();
    expect(Math.abs((result as Date).getTime() - twoYearsAgo.getTime())).toBeLessThan(5000);
  });

  it("should let an explicit older audit start win over a no-date fallback", () => {
    const result = computeEarliestAuditStart([
      {}, // ~2 years ago fallback
      { started_at: "2018-01-01T00:00:00Z" }, // much older → earliest
    ]);
    expect(result?.toISOString()).toBe("2018-01-01T00:00:00.000Z");
  });
});
