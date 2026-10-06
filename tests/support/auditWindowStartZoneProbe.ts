/**
 * BACKLOG-3734 — prints what the audit-window START comes to in the timezone
 * THIS process was started in, as JSON on stdout.
 *
 * A separate process because a jest test cannot change its own timezone (see
 * `auditWindowZoneProbe.ts` for the measurement). `localStartOfDay-3734.test.ts`
 * spawns this under fixed zones so a UTC-only CI run still checks Chicago and
 * Tokyo, including both US DST transition days.
 *
 * Import-light on purpose: only the boundary modules — no jest mapping, no
 * electron, no database. The submission's SQL binds
 * `auditPeriodFromRow(...).auditStartDate.toISOString()` against ISO `sent_at`
 * text (`submissionDbService.ts`), so the `submission` column reproduces that
 * comparison exactly from the same Date.
 */
import type { Communication } from "../../electron/types/models";
import {
  auditWindowEnd,
  auditWindowStart,
  auditWindowStartParam,
  resolveExportPlan,
} from "../../electron/services/exportPlan";
import { auditPeriodFromRow } from "../../electron/services/submissionAuditPeriod";
import { computeTransactionDateRange } from "../../electron/utils/emailDateRange";
import {
  parseLocalCalendarDay,
  isTimestampInAuditPeriod,
} from "../../src/utils/dateRangeUtils";

/** One-day deals: an ordinary day and both US DST transition days. */
const DAYS = ["2026-09-24", "2026-03-08", "2026-11-01"] as const;

type Edge = "dayBefore2359" | "start0000" | "endDay235959" | "nextDay0000";
type Surface = "submission" | "export" | "matcher" | "tab";

function localInstants(day: string): Record<Edge, string> {
  const [y, m, d] = day.split("-").map(Number);
  return {
    dayBefore2359: new Date(y, m - 1, d - 1, 23, 59, 0, 0).toISOString(),
    start0000: new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(),
    endDay235959: new Date(y, m - 1, d, 23, 59, 59, 0).toISOString(),
    nextDay0000: new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString(),
  };
}

const report = {
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  /** auditWindowStart(day).toISOString() — the one helper. */
  startBounds: {} as Record<string, string>,
  /** computeTransactionDateRange({ started_at: day }).start — email/import window. */
  emailRangeStart: {} as Record<string, string>,
  /** What the auto-link matcher binds into its `>= ?`. */
  matcherStartParam: {} as Record<string, string>,
  /** day -> edge -> surface -> included? */
  included: {} as Record<string, Record<Edge, Record<Surface, boolean>>>,
  /** A time-bearing start must come back as the same instant. */
  timeBearingPassthrough: auditWindowStart("2026-09-24T12:34:56.000Z")?.toISOString() ?? null,
};

for (const day of DAYS) {
  const start = auditWindowStart(day);
  if (!start || isNaN(start.getTime())) {
    throw new Error(`auditWindowStart("${day}") produced no usable instant`);
  }
  report.startBounds[day] = start.toISOString();
  report.emailRangeStart[day] = computeTransactionDateRange({ started_at: day }).start.toISOString();
  report.matcherStartParam[day] = auditWindowStartParam(day);

  const period = auditPeriodFromRow({ started_at: day, closed_at: day });
  const subStart = period.auditStartDate!.toISOString();
  const subEnd = auditWindowEnd(period.auditEndDate)!.toISOString();
  const endBound = auditWindowEnd(day)!.toISOString();

  const instants = localInstants(day);
  const comms = (Object.keys(instants) as Edge[]).map(
    (edge) =>
      ({ id: edge, sent_at: instants[edge], communication_type: "sms", channel: "sms" }) as unknown as Communication,
  );
  const exported = new Set(
    resolveExportPlan(
      { format: "folder", contentType: "both", attachmentType: "all", emailMode: "thread", startDate: day, endDate: day },
      comms,
    ).communications.map((c) => c.id as string),
  );

  const row = {} as Record<Edge, Record<Surface, boolean>>;
  for (const edge of Object.keys(instants) as Edge[]) {
    const ts = instants[edge];
    row[edge] = {
      // Lexicographic, exactly like the SQL `>= ?` / `<= ?`.
      submission: ts >= subStart && ts <= subEnd,
      export: exported.has(edge),
      matcher: ts >= report.matcherStartParam[day] && ts <= endBound,
      tab: isTimestampInAuditPeriod(ts, parseLocalCalendarDay(day), parseLocalCalendarDay(day)),
    };
  }
  report.included[day] = row;
}

process.stdout.write(JSON.stringify(report));
