/**
 * BACKLOG-2788 — prints what the closing-day boundary comes to in the timezone
 * THIS process was started in, as JSON on stdout.
 *
 * Why a separate process: a jest test cannot change its own timezone. V8 caches
 * the zone per context, and jest hands tests a COPY of `process.env`, so the
 * assignment never reaches the Node setter that would invalidate that cache.
 * Measured 2026-08-22 in this repo: setting `process.env.TZ` mid-suite left
 * `new Date(2026, 6, 29).getTimezoneOffset()` unchanged under both the node and
 * the electron jest runners. `TZ` in the ENVIRONMENT AT STARTUP is honored by
 * both, which is what the spawn in `localMidnightBoundary-2788.test.ts` uses.
 *
 * Kept import-light on purpose: only the boundary modules, so the child needs
 * no jest module mapping, no electron, and no database.
 */
import { auditWindowEnd } from "../../electron/services/exportPlan";
import { computeTransactionDateRange } from "../../electron/utils/emailDateRange";
import {
  parseLocalCalendarDay,
  isTimestampInAuditPeriod,
} from "../../src/utils/dateRangeUtils";

/** Closing days: an ordinary one, and both US DST transition days. */
const DAYS = ["2026-07-29", "2026-03-08", "2026-11-01"] as const;

const AUDIT_START = "2026-01-01";

const report = {
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  julyOffsetMinutes: new Date(2026, 6, 29).getTimezoneOffset(),
  januaryOffsetMinutes: new Date(2026, 0, 15).getTimezoneOffset(),
  /** auditWindowEnd(day) — the one helper. */
  bounds: {} as Record<string, string>,
  /** The local wall clock of each bound, as [Y, M, D, h, m, s, ms]. */
  boundLocalParts: {} as Record<string, number[]>,
  /** Does the Texts tab agree, AT the bound and one millisecond past it? */
  tabAtBound: {} as Record<string, boolean>,
  tabPastBound: {} as Record<string, boolean>,
  /** The email/import window end (closing day + 30-day buffer). */
  emailRangeEnd: computeTransactionDateRange({ closed_at: "2026-07-29" }).end.toISOString(),
};

for (const day of DAYS) {
  const bound = auditWindowEnd(day)!;
  report.bounds[day] = bound.toISOString();
  report.boundLocalParts[day] = [
    bound.getFullYear(),
    bound.getMonth(),
    bound.getDate(),
    bound.getHours(),
    bound.getMinutes(),
    bound.getSeconds(),
    bound.getMilliseconds(),
  ];

  const start = parseLocalCalendarDay(AUDIT_START);
  const end = parseLocalCalendarDay(day);
  report.tabAtBound[day] = isTimestampInAuditPeriod(bound.toISOString(), start, end);
  report.tabPastBound[day] = isTimestampInAuditPeriod(
    new Date(bound.getTime() + 1).toISOString(),
    start,
    end,
  );
}

process.stdout.write(JSON.stringify(report));
