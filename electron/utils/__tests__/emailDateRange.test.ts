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

    /**
     * BACKLOG-2788 (founder decision, 2026-08-22 — "they work in their local
     * time, so we need to show the transaction from their eyes"): the closing
     * day ends at the user's LOCAL midnight, and `auditWindowEnd()` is the one
     * place that decides where. The buffer now advances 30 LOCAL days from that
     * instant, so the end of the range is the END of the buffered day rather
     * than UTC midnight at its START — about 24 hours later, in every zone.
     *
     * The expectations below moved for that reason and no other. They are
     * written as the local wall clock of the buffered day, so they are correct
     * in every timezone; a revert to `new Date(closed_at) + 30d` reds them
     * everywhere (it lands on 00:00 of that day, not 23:59:59.999).
     */
    const localEndOfDay = (y: number, monthIndex: number, d: number) =>
      new Date(y, monthIndex, d, 23, 59, 59, 999);

    it("ends at the END of the local buffered day, 30 days after closed_at", () => {
      const { end } = computeTransactionDateRange({
        started_at: "2024-01-01T00:00:00Z",
        closed_at: "2024-12-01T00:00:00Z",
      });

      // 2024-12-01 + 30 days = 2024-12-31, and the range ends when that day does.
      expect(end.toISOString()).toBe(localEndOfDay(2024, 11, 31).toISOString());
      expect(end.getMilliseconds()).toBe(999);
    });

    it("should add exactly 30 days buffer to closed_at", () => {
      const closedAt = new Date("2024-06-15T12:00:00Z");
      const { end } = computeTransactionDateRange({
        closed_at: closedAt,
      });

      // The calendar day is read from the value's UTC parts (see auditWindowEnd),
      // so a time-bearing closed_at is normalized to its day before buffering:
      // 2024-06-15 + 30 = 2024-07-15, ending at local midnight.
      expect(end.getTime()).toBe(localEndOfDay(2024, 6, 15).getTime());
    });

    it("should accept closed_at as string", () => {
      const { end } = computeTransactionDateRange({
        closed_at: "2024-09-01T00:00:00Z",
      });

      expect(end.toISOString()).toBe(localEndOfDay(2024, 9, 1).toISOString());
    });

    it("advances the buffer in LOCAL days, so a DST transition inside it does not shift the end", () => {
      // 2026-02-06 + 30 days = 2026-03-08, the US spring-forward day. A bound
      // built by adding 30 * 24 hours would land an hour late in a DST zone;
      // advancing the local day number and keeping the wall clock does not.
      const { end } = computeTransactionDateRange({ closed_at: "2026-02-06" });

      expect(end.toISOString()).toBe(localEndOfDay(2026, 2, 8).toISOString());
      expect([end.getHours(), end.getMinutes(), end.getSeconds()]).toEqual([23, 59, 59]);
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

      // End should be the END of the local day 30 days after closed_at
      // (BACKLOG-2788 — see the "end date" describe block above).
      // 2024-11-30 + 30 days = 2024-12-30.
      expect(end.toISOString()).toBe(new Date(2024, 11, 30, 23, 59, 59, 999).toISOString());
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
