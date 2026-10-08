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

  // jest.config sets no TZ; pin one so the UTC/local difference is real.
  // Date reads process.env.TZ at call time in Node, so set it before use.
  const origTZ = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    if (origTZ === undefined) delete process.env.TZ;
    else process.env.TZ = origTZ;
  });

  it("23:30 local Oct 8 (already Oct 9 UTC) -> 2026-09-08", () => {
    jest.setSystemTime(new Date(2026, 9, 8, 23, 30, 0));
    expect(new Date().getTimezoneOffset()).toBe(420); // PDT, proves TZ applied
    expect(getDefaultStartDate()).toBe("2026-09-08");
  });

  it("00:30 local Oct 8 -> 2026-09-08", () => {
    jest.setSystemTime(new Date(2026, 9, 8, 0, 30, 0));
    expect(getDefaultStartDate()).toBe("2026-09-08");
  });
});
