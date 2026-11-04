/**
 * BACKLOG-4120 — prints, as JSON on stdout, which edge instants the Learn mode
 * deal matcher puts inside a transaction's window, in the timezone THIS
 * process was started in. A separate process because a jest test cannot
 * change its own timezone (pattern: auditWindowStartZoneProbe.ts).
 *
 * Import-light on purpose: only the matcher (which uses exportPlan's bounds).
 */
import { overlapsWindow } from "../../electron/services/learn/dealMatcher";

const START = "2026-09-24";
const END = "2026-09-30";

function local(y: number, m: number, d: number, h: number, min: number): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

const edges: Record<string, number> = {
  dayBeforeStart2330: local(2026, 9, 23, 23, 30),
  startDay0030: local(2026, 9, 24, 0, 30),
  endDay2330: local(2026, 9, 30, 23, 30),
  dayAfterEnd0030: local(2026, 10, 1, 0, 30),
};

const included: Record<string, boolean> = {};
for (const [name, ms] of Object.entries(edges)) {
  included[name] = overlapsWindow(ms, ms, START, END);
}

const farPast = local(2020, 1, 1, 12, 0);
const farFuture = local(2030, 1, 1, 12, 0);

process.stdout.write(
  JSON.stringify({
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    included,
    openStart: overlapsWindow(farPast, farPast, null, END),
    openEnd: overlapsWindow(farFuture, farFuture, START, null),
    bothOpen: overlapsWindow(farPast, farFuture, null, null),
  }),
);
