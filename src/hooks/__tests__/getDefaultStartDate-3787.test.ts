/**
 * BACKLOG-3787: default Representation Start Date = 1 month before today,
 * clamped to the last day of the previous month.
 */
import { getDefaultStartDate } from "../audit/useAuditAddressForm";

describe("getDefaultStartDate (BACKLOG-3787)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const cases: Array<[string, [number, number, number], string]> = [
    ["Jan 15 -> Dec 15 prior year", [2026, 1, 15], "2025-12-15"],
    ["Mar 31 non-leap -> Feb 28", [2026, 3, 31], "2026-02-28"],
    ["Mar 31 leap -> Feb 29", [2028, 3, 31], "2028-02-29"],
    ["May 31 -> Apr 30", [2026, 5, 31], "2026-04-30"],
    ["Dec 31 -> Nov 30", [2026, 12, 31], "2026-11-30"],
    ["Mar 1 -> Feb 1", [2026, 3, 1], "2026-02-01"],
    ["Mar 29 non-leap -> Feb 28", [2026, 3, 29], "2026-02-28"],
    ["Oct 8 -> Sep 8", [2026, 10, 8], "2026-09-08"],
  ];

  it.each(cases)("%s", (_n, [y, m, d], expected) => {
    jest.setSystemTime(new Date(y, m - 1, d, 12, 0, 0));
    expect(getDefaultStartDate()).toBe(expected);
  });
});

describe("getDefaultStartDate local-date formatting (BACKLOG-3787)", () => {
  // Zone-independent: a real local Date whose toISOString is overridden to the
  // UTC value a UTC-7 user sees in the evening (local Oct 8 23:30 = Oct 9 06:30Z).
  function standIn(local: Date, iso: string): Date {
    local.toISOString = () => iso;
    return local;
  }

  it("local 23:30 Oct 8 with UTC already Oct 9 -> 2026-09-08", () => {
    const now = standIn(new Date(2026, 9, 8, 23, 30, 0), "2026-10-09T06:30:00.000Z");
    expect(getDefaultStartDate(now)).toBe("2026-09-08");
  });

  it("local 00:30 Oct 8 with UTC still Oct 7 -> 2026-09-08", () => {
    const now = standIn(new Date(2026, 9, 8, 0, 30, 0), "2026-10-07T17:30:00.000Z");
    expect(getDefaultStartDate(now)).toBe("2026-09-08");
  });

  it("does not mutate the date passed in", () => {
    const now = new Date(2026, 2, 31, 12);
    getDefaultStartDate(now);
    expect(now.getMonth()).toBe(2);
    expect(now.getDate()).toBe(31);
  });
});
