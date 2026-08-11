/**
 * BACKLOG-2632 — naive SQLite timestamps must not display tomorrow's date.
 *
 * ===========================================================================
 * THE DEFECT, IN ONE LINE
 * ===========================================================================
 * `CURRENT_TIMESTAMP` / `datetime('now')` write UTC with NO zone marker
 * ("2026-08-10 01:00:00"). `new Date(...)` on that string parses it as LOCAL
 * time. The founder is in Costa Rica (UTC-6, no DST), so the value lands
 * 21,600,000 ms late and EVERY event between 18:00 and 23:59 local rendered
 * with the NEXT day's date.
 *
 * ===========================================================================
 * THE FIXTURE IS TRANSCRIBED, NOT INVENTED
 * ===========================================================================
 * The naive shape used below is the one an existing suite already captured from
 * a real `contactDbService.getRemovedContacts` row against a database built
 * from `electron/database/schema.sql`:
 *
 *     "removed_at": "2026-08-05 03:08:06"
 *
 * (see `src/components/contact/components/__tests__/RemovedContactsSection.test.tsx`
 * docblock). Space separator, seconds precision, no fractional part, no zone.
 * The ISO shape is `emailSyncService.ts`'s `toISOString()` output.
 *
 * ===========================================================================
 * THE TZ GUARD IS PART OF THE TEST
 * ===========================================================================
 * Every assertion here is meaningless at UTC — the skew is zero and the whole
 * suite would pass against the UNFIXED code. `describe("TZ guard")` fails LOUD
 * if the process is not actually at UTC-6, so this suite cannot go green for
 * the wrong reason.
 *
 * Locales are PINNED to "en-US" wherever a formatted string is asserted; the
 * runner's default locale is not ours to assume.
 */

// Must precede any Date use. Node >= 16 picks up a runtime TZ change; the guard
// below is what proves it actually took effect on THIS runner.
process.env.TZ = "America/Costa_Rica";

import { parseDbTimestamp, formatDbDate, parseDateSafe } from "../dateFormatters";

/** Costa Rica is UTC-6 year round. getTimezoneOffset() reports minutes WEST. */
const CR_OFFSET_MINUTES = 360;

/** The exact skew the defect introduced: 6h. */
const SKEW_MS = 21_600_000;

/** Calendar day of a Date in the process's local zone — never a formatted string. */
function localParts(d: Date): { y: number; m: number; day: number } {
  return { y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate() };
}

describe("TZ guard (this suite is void at UTC)", () => {
  it("runs at UTC-6 with no DST, so the 6h skew is actually exercised", () => {
    const probe = new Date("2026-08-10T01:00:00Z");
    expect(probe.getTimezoneOffset()).toBe(CR_OFFSET_MINUTES);
    // 01:00 UTC on Aug 10 is 19:00 on Aug 9 in Costa Rica.
    expect(probe.getHours()).toBe(19);
    expect(probe.getDate()).toBe(9);
    // January too — no DST anywhere in the year.
    expect(new Date("2026-01-10T01:00:00Z").getTimezoneOffset()).toBe(CR_OFFSET_MINUTES);
  });

  it("reproduces the unfixed behaviour, so the fix has something to fix", () => {
    const naive = "2026-08-10 01:00:00";
    const unfixed = new Date(naive); // what every call site used to do
    const fixed = parseDbTimestamp(naive)!;

    expect(unfixed.getTime() - fixed.getTime()).toBe(SKEW_MS);
    expect(localParts(unfixed).day).toBe(10); // the bug: tomorrow
    expect(localParts(fixed).day).toBe(9); // the fix: today
  });
});

/**
 * CONTROL 1 — the founder's exact case.
 * An event at 19:00 local (= 01:00 UTC the NEXT day) must display that day.
 */
describe("Control 1 — 19:00 local displays today, not tomorrow", () => {
  it("renders Aug 9 for a naive '2026-08-10 01:00:00'", () => {
    expect(formatDbDate("2026-08-10 01:00:00", undefined, "en-US")).toBe("Aug 9, 2026");
  });

  it("renders Aug 9 in the 'Added <date>' shape used by the contact card", () => {
    expect(
      formatDbDate(
        "2026-08-10 01:00:00",
        { year: "numeric", month: "short", day: "numeric" },
        "en-US",
      ),
    ).toBe("Aug 9, 2026");
  });
});

/**
 * CONTROL 2 — rows ALREADY in the database carry the naive shape.
 * The fix must be a READ-side tolerance, not a new-writes-only change.
 */
describe("Control 2 — an already-stored naive row renders correctly", () => {
  it("handles the transcribed getRemovedContacts value", () => {
    // "2026-08-05 03:08:06" UTC == 2026-08-04 21:08:06 in Costa Rica.
    const parsed = parseDbTimestamp("2026-08-05 03:08:06")!;
    expect(parsed.toISOString()).toBe("2026-08-05T03:08:06.000Z");
    expect(localParts(parsed)).toEqual({ y: 2026, m: 8, day: 4 });
    expect(formatDbDate("2026-08-05 03:08:06", undefined, "en-US")).toBe("Aug 4, 2026");
  });

  it("handles the naive shape with a T separator and with fractional seconds", () => {
    // Adding a T fixes nothing on its own — it must still be read as UTC.
    expect(parseDbTimestamp("2026-08-10T01:00:00")!.toISOString()).toBe(
      "2026-08-10T01:00:00.000Z",
    );
    expect(parseDbTimestamp("2026-08-10 01:00:00.500")!.toISOString()).toBe(
      "2026-08-10T01:00:00.500Z",
    );
    // datetime('now') without seconds, and strftime with 6-digit fraction.
    expect(parseDbTimestamp("2026-08-10 01:00")!.toISOString()).toBe(
      "2026-08-10T01:00:00.000Z",
    );
    expect(parseDbTimestamp("2026-08-10 01:00:00.123456")!.toISOString()).toBe(
      "2026-08-10T01:00:00.123Z",
    );
  });
});

/**
 * CONTROL 4 — the half that is already right must not regress.
 * Anything carrying an explicit zone is handed to `new Date` untouched.
 */
describe("Control 4 — zone-carrying values are untouched", () => {
  it.each([
    "2026-08-10T21:56:27.989Z",
    "2026-08-10T01:00:00.000Z",
    "2026-08-10T01:00:00Z",
    "2026-08-10T01:00:00+00:00",
    "2026-08-09T19:00:00-06:00",
    "2026-08-10", // date-only: JS already reads this as UTC; parseDateSafe owns it
  ])("passes %s through with the same instant as new Date()", (value) => {
    expect(parseDbTimestamp(value)!.getTime()).toBe(new Date(value).getTime());
  });

  it("keeps the ISO writer's day correct (emails.sent_at)", () => {
    // The same row renders sent_at (ISO) and ignored_at (naive) side by side in
    // RemovedEmailsSection; both must now land on Aug 9.
    expect(formatDbDate("2026-08-10T01:00:00.000Z", undefined, "en-US")).toBe("Aug 9, 2026");
    expect(formatDbDate("2026-08-10 01:00:00", undefined, "en-US")).toBe("Aug 9, 2026");
  });

  it("does not change parseDateSafe's behaviour", () => {
    expect(parseDateSafe("2026-08-10T01:00:00.000Z")!.getTime()).toBe(
      new Date("2026-08-10T01:00:00.000Z").getTime(),
    );
  });
});

/**
 * CONTROL 5 — sweep the boundary, do not sample it.
 * Every local hour boundary that can flip a calendar day at UTC-6, plus both
 * sides of the UTC day boundary. One case per branch cannot catch an off-by-one.
 */
describe("Control 5 — day boundaries, swept", () => {
  const cases: Array<{ label: string; naive: string; expectDay: number }> = [
    // ---- Aug 9 local, all of it ----
    { label: "00:00:00 local Aug 9", naive: "2026-08-09 06:00:00", expectDay: 9 },
    { label: "00:00:01 local Aug 9", naive: "2026-08-09 06:00:01", expectDay: 9 },
    { label: "11:59:59 local Aug 9", naive: "2026-08-09 17:59:59", expectDay: 9 },
    { label: "17:59:59 local Aug 9", naive: "2026-08-09 23:59:59", expectDay: 9 },
    // ---- the UTC day boundary falls INSIDE local Aug 9 ----
    { label: "18:00:00 local Aug 9 (= 00:00:00 UTC Aug 10)", naive: "2026-08-10 00:00:00", expectDay: 9 },
    { label: "18:00:01 local Aug 9", naive: "2026-08-10 00:00:01", expectDay: 9 },
    { label: "19:00:00 local Aug 9 (founder's measured case)", naive: "2026-08-10 01:00:00", expectDay: 9 },
    { label: "23:59:59 local Aug 9", naive: "2026-08-10 05:59:59", expectDay: 9 },
    // ---- and here the local day finally rolls ----
    { label: "00:00:00 local Aug 10", naive: "2026-08-10 06:00:00", expectDay: 10 },
    { label: "00:00:01 local Aug 10", naive: "2026-08-10 06:00:01", expectDay: 10 },
  ];

  it.each(cases)("$label renders Aug $expectDay", ({ naive, expectDay }) => {
    expect(localParts(parseDbTimestamp(naive)!)).toEqual({ y: 2026, m: 8, day: expectDay });
    expect(formatDbDate(naive, undefined, "en-US")).toBe(`Aug ${expectDay}, 2026`);
  });

  it("crosses a month boundary the same way", () => {
    // 19:00 local Aug 31 == 01:00 UTC Sep 1.
    expect(formatDbDate("2026-09-01 01:00:00", undefined, "en-US")).toBe("Aug 31, 2026");
    // 18:00 local Dec 31 == 00:00 UTC Jan 1 — the year must not roll early.
    expect(formatDbDate("2027-01-01 00:00:00", undefined, "en-US")).toBe("Dec 31, 2026");
  });

  it("never disagrees with the ISO value for the same instant", () => {
    for (const { naive } of cases) {
      const iso = `${naive.replace(" ", "T")}.000Z`;
      expect(parseDbTimestamp(naive)!.getTime()).toBe(new Date(iso).getTime());
    }
  });
});

describe("missing and unparseable values", () => {
  it.each([null, undefined, "", "   "])("returns null for %p", (value) => {
    expect(parseDbTimestamp(value as string | null | undefined)).toBeNull();
    expect(formatDbDate(value as string | null | undefined)).toBeNull();
  });

  it("returns null rather than the string 'Invalid Date'", () => {
    expect(parseDbTimestamp("not a date")).toBeNull();
    expect(formatDbDate("not a date")).toBeNull();
    // The month is out of range, so this is NOT a valid naive timestamp.
    expect(parseDbTimestamp("2026-13-40 99:99:99")).toBeNull();
  });

  it("passes a valid Date instance through and rejects an invalid one", () => {
    const d = new Date("2026-08-10T01:00:00Z");
    expect(parseDbTimestamp(d)).toBe(d);
    expect(parseDbTimestamp(new Date("nope"))).toBeNull();
  });
});
