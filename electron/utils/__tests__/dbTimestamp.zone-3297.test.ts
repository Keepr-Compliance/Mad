/**
 * @jest-environment node
 *
 * BACKLOG-3297 — `parseDbTimestamp` reads SQLite's zone-less `CURRENT_TIMESTAMP`
 * values as UTC in every timezone, not just the runner's.
 *
 * `sessions.created_at` is stored as "2026-09-13 18:15:21" (UTC, no marker). A
 * bare `new Date()` reads that as local time: 6h late in Costa Rica, 9h early in
 * Tokyo. CI runs in UTC, where the two readings agree, so an in-process test
 * cannot see the defect. Each zone below runs the parser in a child process
 * started with that `TZ` (`tests/support/dbTimestampZoneProbe.ts`).
 *
 * Every zone first asserts the child really is in that zone — by name AND by the
 * offset a bare `new Date()` produces there. Without that check, a child that
 * kept the runner's UTC passes every parse assertion (measured at SR review).
 */
import path from "path";
import { execFileSync } from "child_process";

interface ZoneReport {
  zone: string;
  bareDateOffsetMs: number;
  parsed: Record<string, number | null>;
}

const HOUR = 60 * 60 * 1000;

/**
 * Offset a bare `new Date("2026-09-13 18:15:21")` has in each zone on that date.
 * Written out, not recomputed: Tokyo UTC+9, Kiritimati UTC+14, Los Angeles
 * UTC-7 (PDT), Costa Rica UTC-6.
 */
const ZONES: Array<[string, number]> = [
  ["Asia/Tokyo", -9 * HOUR],
  ["Pacific/Kiritimati", -14 * HOUR],
  ["America/Los_Angeles", 7 * HOUR],
  ["America/Costa_Rica", 6 * HOUR],
  ["UTC", 0],
];

const EXPECTED: Record<string, number> = {
  "2026-09-13 18:15:21": Date.UTC(2026, 8, 13, 18, 15, 21),
  "2026-09-13T18:15:21": Date.UTC(2026, 8, 13, 18, 15, 21),
  "2026-09-13 18:15": Date.UTC(2026, 8, 13, 18, 15, 0),
  "2026-09-13 18:15:21.5": Date.UTC(2026, 8, 13, 18, 15, 21, 500),
  "2026-09-13 18:15:21.123456": Date.UTC(2026, 8, 13, 18, 15, 21, 123),
  "2026-09-14T18:15:21.549Z": Date.UTC(2026, 8, 14, 18, 15, 21, 549),
  "2026-09-13T12:15:21-06:00": Date.UTC(2026, 8, 13, 18, 15, 21),
};

function runInZone(tz: string): ZoneReport {
  const stdout = execFileSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      path.join(__dirname, "..", "..", "..", "tests", "support", "dbTimestampZoneProbe.ts"),
    ],
    {
      // Spread the full environment: Windows needs SystemRoot and friends.
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
  return JSON.parse(stdout) as ZoneReport;
}

/** Generous: the first spawn on a cold CI runner pays for ts-node. */
const ZONE_TIMEOUT_MS = 120_000;

describe("parseDbTimestamp reads SQLite UTC values as UTC in every zone (BACKLOG-3297)", () => {
  it.each(ZONES)(
    "C6 TZ=%s",
    (tz, bareDateOffsetMs) => {
      const report = runInZone(tz);

      // The zone must have taken, or everything below is vacuous.
      expect(report.zone).toBe(tz);
      expect(report.bareDateOffsetMs).toBe(bareDateOffsetMs);

      expect(report.parsed).toEqual(EXPECTED);
    },
    ZONE_TIMEOUT_MS,
  );
});
