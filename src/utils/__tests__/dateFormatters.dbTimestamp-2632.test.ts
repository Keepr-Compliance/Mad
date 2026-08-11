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
 * WHY THIS SUITE DOES NOT SET process.env.TZ
 * ===========================================================================
 * The obvious way to write this is `process.env.TZ = "America/Costa_Rica"` at
 * module scope. It DOES NOT WORK under jest's jsdom environment: the file runs
 * in a separate vm context whose `Date` came from the parent realm, and Node's
 * timezone-change notification never reaches it. Measured — with ambient
 * `TZ=UTC`, plain `node` honours the assignment (offset 360) and jest does not
 * (offset stays 0). A suite written that way is green only on a machine
 * PHYSICALLY at UTC-6 and red on a UTC CI runner.
 *
 * So the founder's zone is pinned per assertion via Intl's `timeZone` option,
 * and every parser assertion compares absolute instants (`toISOString()`), which
 * have no ambient dependency at all. This suite gives the same answer on any
 * runner in any zone.
 */

import {
  parseDbTimestamp,
  formatDbDate,
  parseDateSafe,
  normalizeDbTimestamp,
} from "../dateFormatters";

/** The founder's zone. Pinned explicitly — never inherited from the runner. */
const CR = "America/Costa_Rica";

/** Locale pinned too; the runner's default is not ours to assume. */
const LOCALE = "en-US";

const DAY_OPTS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: CR,
};

/** The exact skew the defect introduced at UTC-6: 6h. */
const SKEW_MS = 21_600_000;

/** What the founder's screen shows for a stored value, on any runner. */
function displayedInCostaRica(value: string): string | null {
  return formatDbDate(value, DAY_OPTS, LOCALE);
}

/** What the UNFIXED code produced: the naive string read as Costa Rica local time. */
function displayedByTheBug(naive: string): string {
  // `new Date(naive)` at UTC-6 lands on this instant. Expressed absolutely so
  // the comparison does not depend on where the runner is.
  const asIfLocal = new Date(`${naive.replace(" ", "T")}.000Z`).getTime() + SKEW_MS;
  return new Date(asIfLocal).toLocaleDateString(LOCALE, DAY_OPTS);
}

describe("Fixture guard (this suite is void if these do not hold)", () => {
  it("has Costa Rica zone data, at UTC-6 with no DST", () => {
    // If the runner's ICU lacked the zone, Intl would silently fall back to UTC
    // and every assertion below would be measuring the wrong thing.
    const hourIn = (iso: string): string =>
      new Date(iso).toLocaleString("en-US", { timeZone: CR, hour12: false, hour: "2-digit" });
    expect(hourIn("2026-08-10T01:00:00Z")).toBe("19"); // 01:00 UTC == 19:00 previous day
    expect(hourIn("2026-01-10T01:00:00Z")).toBe("19"); // same in winter — no DST
  });

  it("the right and wrong renderings are actually distinguishable", () => {
    // If these collapsed to one string the suite could not tell pass from fail
    // and would be green against the unfixed code.
    expect(displayedByTheBug("2026-08-10 01:00:00")).toBe("Aug 10, 2026");
    expect(displayedByTheBug("2026-08-10 01:00:00")).not.toBe("Aug 9, 2026");
  });
});

/**
 * ===========================================================================
 * THE ONLY CONTROL THAT DISCRIMINATES ON A UTC CI RUNNER
 * ===========================================================================
 * At UTC the naive shape and the UTC shape name the same instant, so
 * `new Date("2026-08-10 01:00:00")` and the fixed parser agree exactly — the
 * DEFECT ITSELF is undetectable there. Measured: with the normalisation removed,
 * every end-to-end assertion in this file still passes under `TZ=UTC` and 14 of
 * them fail under `TZ=America/Costa_Rica`.
 *
 * `normalizeDbTimestamp` is a pure string transform with no ambient timezone in
 * it, so these assertions go red at ANY offset including UTC. Without this
 * describe block, CI would be a green light that carries no information.
 */
describe("Zone-marking (ambient-free — this is what CI actually verifies)", () => {
  it.each([
    ["2026-08-10 01:00:00", "2026-08-10T01:00:00.000Z"],
    ["2026-08-05 03:08:06", "2026-08-05T03:08:06.000Z"],
    ["2026-08-10T01:00:00", "2026-08-10T01:00:00.000Z"],
    ["2026-08-10 01:00", "2026-08-10T01:00:00.000Z"],
    ["2026-08-10 01:00:00.500", "2026-08-10T01:00:00.500Z"],
    ["2026-08-10 01:00:00.123456", "2026-08-10T01:00:00.123Z"],
  ])("marks the naive %s as UTC -> %s", (raw, expected) => {
    expect(normalizeDbTimestamp(raw)).toBe(expected);
  });

  it.each([
    "2026-08-10T21:56:27.989Z",
    "2026-08-10T01:00:00Z",
    "2026-08-10T01:00:00+00:00",
    "2026-08-09T19:00:00-06:00",
    "2026-08-10",
    "not a date",
  ])("leaves %s byte-for-byte untouched", (raw) => {
    expect(normalizeDbTimestamp(raw)).toBe(raw);
  });

  it("adds a zone marker to every naive value and to nothing else", () => {
    // Sweeping the discriminator itself: a value either gains a Z or is identical.
    for (const raw of ["2026-08-10 00:00:00", "2026-08-10 23:59:59", "2026-08-10 06:00:00"]) {
      expect(normalizeDbTimestamp(raw)).toMatch(/Z$/);
      expect(normalizeDbTimestamp(raw)).not.toBe(raw);
    }
    for (const raw of ["2026-08-10T00:00:00Z", "2026-08-10T00:00:00-06:00"]) {
      expect(normalizeDbTimestamp(raw)).toBe(raw);
    }
  });
});

/**
 * CONTROL 1 — the founder's exact case.
 * An event at 19:00 local (= 01:00 UTC the NEXT day) must display that day.
 */
describe("Control 1 — 19:00 local displays today, not tomorrow", () => {
  it("renders Aug 9 for a naive '2026-08-10 01:00:00'", () => {
    expect(displayedInCostaRica("2026-08-10 01:00:00")).toBe("Aug 9, 2026");
  });

  it("produces the right INSTANT, which is SKEW_MS from what the bug produced", () => {
    const fixed = parseDbTimestamp("2026-08-10 01:00:00")!;
    // toISOString() is absolute — no ambient timezone in the assertion at all.
    expect(fixed.toISOString()).toBe("2026-08-10T01:00:00.000Z");
    expect(new Date(fixed.getTime() + SKEW_MS).toISOString()).toBe("2026-08-10T07:00:00.000Z");
  });

  it("renders Aug 9 in the 'Added <date>' shape used by the contact card", () => {
    expect(
      formatDbDate(
        "2026-08-10 01:00:00",
        { year: "numeric", month: "short", day: "numeric", timeZone: CR },
        LOCALE,
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
    expect(parseDbTimestamp("2026-08-05 03:08:06")!.toISOString()).toBe(
      "2026-08-05T03:08:06.000Z",
    );
    expect(displayedInCostaRica("2026-08-05 03:08:06")).toBe("Aug 4, 2026");
  });

  it("handles the naive shape with a T separator and with fractional seconds", () => {
    // Adding a T fixes nothing on its own — it must still be read as UTC.
    expect(parseDbTimestamp("2026-08-10T01:00:00")!.toISOString()).toBe(
      "2026-08-10T01:00:00.000Z",
    );
    expect(parseDbTimestamp("2026-08-10 01:00:00.500")!.toISOString()).toBe(
      "2026-08-10T01:00:00.500Z",
    );
    // datetime('now') without seconds, and strftime with a 6-digit fraction.
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
    // RemovedEmailsSection; both must land on Aug 9 for the founder.
    expect(displayedInCostaRica("2026-08-10T01:00:00.000Z")).toBe("Aug 9, 2026");
    expect(displayedInCostaRica("2026-08-10 01:00:00")).toBe("Aug 9, 2026");
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
 * sides of the UTC day boundary. One input per branch cannot catch an off-by-one.
 */
describe("Control 5 — day boundaries, swept", () => {
  const cases: Array<{ label: string; naive: string; expected: string }> = [
    // ---- Aug 9 local, all of it ----
    { label: "00:00:00 local Aug 9", naive: "2026-08-09 06:00:00", expected: "Aug 9, 2026" },
    { label: "00:00:01 local Aug 9", naive: "2026-08-09 06:00:01", expected: "Aug 9, 2026" },
    { label: "11:59:59 local Aug 9", naive: "2026-08-09 17:59:59", expected: "Aug 9, 2026" },
    { label: "17:59:59 local Aug 9", naive: "2026-08-09 23:59:59", expected: "Aug 9, 2026" },
    // ---- the UTC day boundary falls INSIDE local Aug 9 ----
    { label: "18:00:00 local Aug 9 (= 00:00:00 UTC Aug 10)", naive: "2026-08-10 00:00:00", expected: "Aug 9, 2026" },
    { label: "18:00:01 local Aug 9", naive: "2026-08-10 00:00:01", expected: "Aug 9, 2026" },
    { label: "19:00:00 local Aug 9 (founder's measured case)", naive: "2026-08-10 01:00:00", expected: "Aug 9, 2026" },
    { label: "23:59:59 local Aug 9", naive: "2026-08-10 05:59:59", expected: "Aug 9, 2026" },
    // ---- and here the local day finally rolls ----
    { label: "00:00:00 local Aug 10", naive: "2026-08-10 06:00:00", expected: "Aug 10, 2026" },
    { label: "00:00:01 local Aug 10", naive: "2026-08-10 06:00:01", expected: "Aug 10, 2026" },
  ];

  it.each(cases)("$label renders $expected", ({ naive, expected }) => {
    expect(displayedInCostaRica(naive)).toBe(expected);
  });

  it("crosses month and year boundaries the same way", () => {
    // 19:00 local Aug 31 == 01:00 UTC Sep 1.
    expect(displayedInCostaRica("2026-09-01 01:00:00")).toBe("Aug 31, 2026");
    // 18:00 local Dec 31 == 00:00 UTC Jan 1 — the year must not roll early.
    expect(displayedInCostaRica("2027-01-01 00:00:00")).toBe("Dec 31, 2026");
  });

  it("never disagrees with the ISO value for the same instant", () => {
    for (const { naive } of cases) {
      const iso = `${naive.replace(" ", "T")}.000Z`;
      expect(parseDbTimestamp(naive)!.getTime()).toBe(new Date(iso).getTime());
      expect(displayedInCostaRica(naive)).toBe(displayedInCostaRica(iso));
    }
  });

  it("goes wrong in exactly the 18:00-23:59 window and nowhere else", () => {
    // The user-visible rule from the report, asserted rather than stated: the
    // bug is invisible for 18 hours a day, which is why it went unnoticed.
    for (const { naive, expected } of cases) {
      const hourUtc = Number(naive.slice(11, 13));
      const inEveningWindow = hourUtc < 6; // 00:00-05:59 UTC == 18:00-23:59 at UTC-6
      expect(displayedByTheBug(naive) !== expected).toBe(inEveningWindow);
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
