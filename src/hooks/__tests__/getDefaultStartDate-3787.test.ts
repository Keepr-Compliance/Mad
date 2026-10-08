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
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // Setting process.env.TZ inside a jest file does NOT change the zone (jest
  // sandboxes process.env), so these run in the machine's zone. They only
  // discriminate UTC vs local formatting where offset != 0: 23:30 local is
  // already the next UTC day west of UTC, 00:30 local is still the previous
  // UTC day east of UTC. In a UTC runner (CI) they pass vacuously.
  it("23:30 local Oct 8 (already Oct 9 UTC) -> 2026-09-08", () => {
    jest.setSystemTime(new Date(2026, 9, 8, 23, 30, 0));
    expect(getDefaultStartDate()).toBe("2026-09-08");
  });

  it("00:30 local Oct 8 -> 2026-09-08", () => {
    jest.setSystemTime(new Date(2026, 9, 8, 0, 30, 0));
    expect(getDefaultStartDate()).toBe("2026-09-08");
  });
});
