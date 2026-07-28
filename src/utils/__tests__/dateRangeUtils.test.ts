/**
 * Unit tests for date-range boundary helpers (BACKLOG-2247).
 *
 * These tests are intentionally TIMEZONE-AGNOSTIC: they assert the LOCAL-time
 * view of the returned instant (via Date's local getters) and the relationship
 * between consecutive days, so they pass on any CI runner regardless of its
 * timezone (jest does not reliably honor a per-file `process.env.TZ`).
 *
 * The dates used (2026-07-25/26) are NOT US DST-transition days, so a local
 * calendar day is a clean 24 hours.
 */

import {
  startOfLocalDayISO,
  endOfLocalDayISO,
  parseLocalCalendarDay,
} from "../dateRangeUtils";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("dateRangeUtils local-day boundaries (BACKLOG-2247)", () => {
  describe("startOfLocalDayISO", () => {
    it("returns the instant whose LOCAL time is midnight of the given calendar day", () => {
      const d = new Date(startOfLocalDayISO("2026-07-25")!);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(6); // July (0-based)
      expect(d.getDate()).toBe(25);
      expect(d.getHours()).toBe(0);
      expect(d.getMinutes()).toBe(0);
      expect(d.getSeconds()).toBe(0);
      expect(d.getMilliseconds()).toBe(0);
    });

    it("returns undefined for empty or malformed input", () => {
      expect(startOfLocalDayISO("")).toBeUndefined();
      expect(startOfLocalDayISO("not-a-date")).toBeUndefined();
      expect(startOfLocalDayISO("2026-13-40")).toBeUndefined();
    });
  });

  describe("endOfLocalDayISO", () => {
    it("returns the instant whose LOCAL time is the LAST millisecond of the given calendar day", () => {
      const d = new Date(endOfLocalDayISO("2026-07-25")!);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(6);
      expect(d.getDate()).toBe(25);
      expect(d.getHours()).toBe(23);
      expect(d.getMinutes()).toBe(59);
      expect(d.getSeconds()).toBe(59);
      expect(d.getMilliseconds()).toBe(999);
    });

    it("returns undefined for empty or malformed input", () => {
      expect(endOfLocalDayISO("")).toBeUndefined();
      expect(endOfLocalDayISO("garbage")).toBeUndefined();
    });
  });

  describe("full-day span (the boundary bug)", () => {
    it("end-of-day is exactly 1ms before the NEXT day's start-of-day", () => {
      const endOf25 = new Date(endOfLocalDayISO("2026-07-25")!).getTime();
      const startOf26 = new Date(startOfLocalDayISO("2026-07-26")!).getTime();
      expect(startOf26 - endOf25).toBe(1);
    });

    it("spans an entire day: end-of-day is (24h - 1ms) after start-of-day", () => {
      const start = new Date(startOfLocalDayISO("2026-07-25")!).getTime();
      const end = new Date(endOfLocalDayISO("2026-07-25")!).getTime();
      expect(end - start).toBe(DAY_MS - 1);
    });
  });
});

// BACKLOG-2277: the audit range must DISPLAY exactly the day the user picked.
// These assertions read the LOCAL-time view of the returned Date, so they are
// timezone-agnostic (they pass on any CI runner regardless of its TZ). The bug
// was `new Date("YYYY-MM-DD")` parsing as UTC midnight, which renders a day
// early ("Dec 31" for a "Jan 1" start) in negative-offset timezones.
describe("parseLocalCalendarDay (BACKLOG-2277)", () => {
  it("returns LOCAL midnight of a bare YYYY-MM-DD calendar day", () => {
    const d = parseLocalCalendarDay("2026-01-01")!;
    expect(d).not.toBeNull();
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0); // January (0-based)
    expect(d.getDate()).toBe(1); // the exact day set — NOT Dec 31
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });

  it("uses the calendar-day portion when the value carries a time component", () => {
    const d = parseLocalCalendarDay("2026-01-01T00:00:00.000Z")!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1); // still Jan 1 in local time, no -1 shift
    expect(d.getHours()).toBe(0);
  });

  it("passes a Date value through unchanged", () => {
    const original = new Date(2026, 6, 27, 9, 30, 0);
    expect(parseLocalCalendarDay(original)).toBe(original);
  });

  it("returns null for empty, null, undefined, or malformed input", () => {
    expect(parseLocalCalendarDay("")).toBeNull();
    expect(parseLocalCalendarDay(null)).toBeNull();
    expect(parseLocalCalendarDay(undefined)).toBeNull();
    expect(parseLocalCalendarDay("not-a-date")).toBeNull();
  });
});
