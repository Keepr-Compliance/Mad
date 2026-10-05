/**
 * @jest-environment node
 *
 * BACKLOG-3734 — a date-only transaction START means LOCAL 00:00 of that day,
 * on every surface, in every zone.
 *
 * Before: `new Date("2026-09-24")` is UTC midnight = 18:00/19:00 local on the
 * PREVIOUS day in America/Chicago, so the submission, the Attachments tab, the
 * export, the auto-link matcher and the email window all admitted the evening
 * before the deal started — while the Texts tab (`parseLocalCalendarDay`) did
 * not. The end was already local (`auditWindowEnd`, BACKLOG-2788).
 *
 * Section 1 spawns `tests/support/auditWindowStartZoneProbe.ts` pinned to a
 * zone (a jest test cannot change its own timezone), and sweeps the four
 * boundary instants — built from the LOCAL wall clock, so one expectation table
 * is right in every zone — through four surfaces at once:
 *
 *   submission   auditPeriodFromRow() + the SQL's lexicographic ISO compare
 *   export       resolveExportPlan()
 *   matcher      auditWindowStartParam(), the auto-link `>= ?` bind
 *   tab          isTimestampInAuditPeriod() (renderer mirror)
 *
 * Reverting `auditWindowStart` to `new Date(value)` reds the Chicago and Tokyo
 * tests (the instants move by the offset; in Chicago `dayBefore2359` becomes
 * included). UTC alone cannot see that mutation — UTC midnight IS local
 * midnight there — which is why the zone pin, not the CI machine's zone, is the
 * load-bearing control.
 */

import path from "path";
import { execFileSync } from "child_process";
import { auditWindowStart, auditWindowStartParam } from "../services/exportPlan";

type Edge = "dayBefore2359" | "start0000" | "endDay235959" | "nextDay0000";
type Surface = "submission" | "export" | "matcher" | "tab";

interface StartZoneReport {
  zone: string;
  startBounds: Record<string, string>;
  emailRangeStart: Record<string, string>;
  matcherStartParam: Record<string, string>;
  included: Record<string, Record<Edge, Record<Surface, boolean>>>;
  timeBearingPassthrough: string | null;
}

const zoneCache = new Map<string, StartZoneReport>();

function runInZone(tz: string): StartZoneReport {
  const cached = zoneCache.get(tz);
  if (cached) return cached;
  const stdout = execFileSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      path.join(__dirname, "..", "..", "tests", "support", "auditWindowStartZoneProbe.ts"),
    ],
    {
      env: {
        ...process.env,
        TZ: tz,
        ELECTRON_RUN_AS_NODE: "1",
        TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: "commonjs" }),
      },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  const report = JSON.parse(stdout) as StartZoneReport;
  // The pin has to have taken, or every expectation below is vacuous.
  expect(report.zone).toBe(tz);
  zoneCache.set(tz, report);
  return report;
}

const ZONE_TIMEOUT_MS = 120_000;
const DAYS = ["2026-09-24", "2026-03-08", "2026-11-01"];
const ALL_SURFACES = { submission: true, export: true, matcher: true, tab: true };
const NO_SURFACE = { submission: false, export: false, matcher: false, tab: false };

/** The same table holds in every zone: the instants are local wall clock. */
function expectBoundarySweep(report: StartZoneReport): void {
  for (const day of DAYS) {
    expect({ day, ...report.included[day] }).toEqual({
      day,
      dayBefore2359: NO_SURFACE, // local 23:59 the evening before: OUT
      start0000: ALL_SURFACES, // local 00:00 on the start day: IN
      endDay235959: ALL_SURFACES, // local 23:59:59 on the end day: IN
      nextDay0000: NO_SURFACE, // local 00:00 the next day: OUT
    });
    // Every main-process reader agrees on the one instant.
    expect(report.emailRangeStart[day]).toBe(report.startBounds[day]);
    expect(report.matcherStartParam[day]).toBe(report.startBounds[day]);
  }
  expect(report.timeBearingPassthrough).toBe("2026-09-24T12:34:56.000Z");
}

describe("BACKLOG-3734 — zone-pinned boundary sweep (four surfaces)", () => {
  /**
   * Instants measured by running the probe under each zone, written out rather
   * than recomputed: an expectation the code under test derives is not one.
   */
  it("America/Chicago: the start day begins at local midnight, DST days included", () => {
    const report = runInZone("America/Chicago");
    expect(report.startBounds).toEqual({
      "2026-09-24": "2026-09-24T05:00:00.000Z", // CDT; old bound was 00:00Z = 19:00 Sep 23 local
      "2026-03-08": "2026-03-08T06:00:00.000Z", // spring-forward day starts in CST
      "2026-11-01": "2026-11-01T05:00:00.000Z", // fall-back day starts in CDT
    });
    expectBoundarySweep(report);
  }, ZONE_TIMEOUT_MS);

  it("Asia/Tokyo: the start day begins at local midnight (east of UTC)", () => {
    const report = runInZone("Asia/Tokyo");
    expect(report.startBounds).toEqual({
      "2026-09-24": "2026-09-23T15:00:00.000Z",
      "2026-03-08": "2026-03-07T15:00:00.000Z",
      "2026-11-01": "2026-10-31T15:00:00.000Z",
    });
    expectBoundarySweep(report);
  }, ZONE_TIMEOUT_MS);

  it("UTC: unchanged — local midnight is UTC midnight", () => {
    const report = runInZone("UTC");
    expect(report.startBounds).toEqual({
      "2026-09-24": "2026-09-24T00:00:00.000Z",
      "2026-03-08": "2026-03-08T00:00:00.000Z",
      "2026-11-01": "2026-11-01T00:00:00.000Z",
    });
    expectBoundarySweep(report);
  }, ZONE_TIMEOUT_MS);
});

describe("BACKLOG-3734 — auditWindowStart contract (in-process, any zone)", () => {
  it("a date-only value is local 00:00:00.000 of that day", () => {
    expect(auditWindowStart("2026-09-24")!.getTime()).toBe(new Date(2026, 8, 24, 0, 0, 0, 0).getTime());
    expect(auditWindowStart("  2026-09-24 ")!.getTime()).toBe(new Date(2026, 8, 24).getTime());
  });

  it("a time-bearing value is an instant and passes through unchanged", () => {
    expect(auditWindowStart("2026-09-24T12:34:56.000Z")!.toISOString()).toBe("2026-09-24T12:34:56.000Z");
    expect(auditWindowStart("2026-09-24T00:00:00.000Z")!.toISOString()).toBe("2026-09-24T00:00:00.000Z");
  });

  it("a Date passes through as a copy", () => {
    const d = new Date("2026-09-24T07:00:00.000Z");
    const out = auditWindowStart(d)!;
    expect(out.getTime()).toBe(d.getTime());
    expect(out).not.toBe(d);
  });

  it("empty is null; garbage is an Invalid Date (loud), never null", () => {
    expect(auditWindowStart(null)).toBeNull();
    expect(auditWindowStart(undefined)).toBeNull();
    expect(auditWindowStart("")).toBeNull();
    expect(isNaN(auditWindowStart("not a date")!.getTime())).toBe(true);
    expect(isNaN(auditWindowStart("2026-13-40")!.getTime())).toBe(true);
  });

  it("the SQL bind is the ISO of that instant, or the raw value when unparseable", () => {
    expect(auditWindowStartParam("2026-09-24")).toBe(new Date(2026, 8, 24).toISOString());
    expect(auditWindowStartParam("not a date")).toBe("not a date");
  });
});
