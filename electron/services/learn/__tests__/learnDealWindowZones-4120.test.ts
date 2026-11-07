/**
 * @jest-environment node
 *
 * BACKLOG-4120 C4 — the Learn mode matcher's date bounds, under pinned zones.
 *
 * A deal's window is [local 00:00 of started_at, local 23:59:59.999 of
 * closed_at] (exportPlan's auditWindowStart / auditWindowEnd); a NULL bound
 * is open. A UTC-only CI runner cannot see a wrong START bound (SR 33692305,
 * control 3), so the probe runs in a child process pinned to a negative-offset
 * zone, plus UTC and a positive-offset zone.
 */
import path from "path";
import { execFileSync } from "child_process";

interface Report {
  zone: string;
  included: Record<string, boolean>;
  openStart: boolean;
  openEnd: boolean;
  bothOpen: boolean;
}

function runInZone(tz: string): Report {
  const stdout = execFileSync(
    process.execPath,
    ["-r", "ts-node/register/transpile-only", path.join(__dirname, "..", "..", "..", "..", "tests", "support", "learnDealWindowZoneProbe.ts")],
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
  const report = JSON.parse(stdout) as Report;
  expect(report.zone).toBe(tz); // the pin took, or everything below is vacuous
  return report;
}

describe("C4 Learn mode deal window bounds", () => {
  it.each(["America/Los_Angeles", "UTC", "Asia/Tokyo"])(
    "%s: local day bounds, NULL = open",
    (tz) => {
      const r = runInZone(tz);
      expect(r.included).toEqual({
        dayBeforeStart2330: false,
        startDay0030: true,
        endDay2330: true,
        dayAfterEnd0030: false,
      });
      expect([r.openStart, r.openEnd, r.bothOpen]).toEqual([true, true, true]);
    },
    120_000,
  );
});
