/**
 * iPhone Sync Performance — per-day chart series (BACKLOG-3450)
 *
 * Pure bucketing and pure text. Nothing here imports React, so every bucket a
 * bar is drawn from — and every line a tooltip shows — is asserted directly.
 * The chart geometry lives in the @keepr/ui chart kit (BACKLOG-4208).
 *
 * Bucketing is on `created_at` in UTC, by SLICING the ISO string. No `Date` is
 * constructed for it, so no local timezone can move a run into the wrong day.
 *
 * `created_at` is the END of a run today (21 of 21 rows carrying `started_at`
 * satisfy `created_at ≈ started_at + elapsed_ms`), so a run crossing midnight
 * is counted on the day it ENDED. From 2.38.1 the start write lands first and
 * `created_at` becomes the START — the same chart will then bucket by start
 * with no error anywhere. "How to use this report" says so.
 */

import { daysInRange, formatDayLabel, type PeriodRange } from './period';
import { formatMinutes, type SyncRun } from './iphone-sync';

// ─── Buckets ─────────────────────────────────────────────────────

/**
 * What a chart needs of a run — any report's run (iPhone, Google Messages)
 * that has these can be bucketed and drawn by the same charts.
 */
export interface ChartRun {
  createdAtIso: string;
  elapsedMs: number | null;
  outcome: string;
  stalled: boolean;
}

export interface DayBucket<R extends ChartRun = SyncRun> {
  dayIso: string;
  dayLabel: string;
  runs: R[];
  /** Runs that finished with a duration, i.e. what the duration chart averages. */
  finishedRuns: number;
  /** Mean elapsed of those runs, in minutes. NULL when there are none. */
  averageMinutes: number | null;
  /** Longest elapsed of those runs, in minutes. NULL when there are none. */
  longestMinutes: number | null;
  errors: number;
  cancelled: number;
  completed: number;
  stalled: number;
}

/**
 * One bucket per UTC day in the range, INCLUDING days with no runs.
 *
 * An absent key would squeeze the axis and draw the wrong day under every bar;
 * a present-but-empty bucket draws a gap in the right place. `averageMinutes`
 * is NULL rather than 0 for an empty day, because "no syncs" and "syncs that
 * took no time" are different statements and only one of them is true.
 */
export function bucketByDay<R extends ChartRun>(runs: R[], range: PeriodRange): DayBucket<R>[] {
  const byDay = new Map<string, R[]>();
  for (const day of daysInRange(range)) byDay.set(day, []);
  for (const run of runs) {
    // A pure string slice on an ISO-8601 UTC timestamp — no Date, no local TZ.
    const day = run.createdAtIso.slice(0, 10);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(run);
  }

  return [...byDay.entries()].map(([dayIso, dayRuns]) => {
    const durations = dayRuns
      .map((r) => r.elapsedMs)
      .filter((ms): ms is number => ms != null && Number.isFinite(ms));
    const total = durations.reduce((sum, ms) => sum + ms, 0);
    return {
      dayIso,
      dayLabel: formatDayLabel(dayIso),
      runs: dayRuns,
      finishedRuns: durations.length,
      averageMinutes: durations.length === 0 ? null : Number(formatMinutes(total / durations.length)),
      longestMinutes: durations.length === 0 ? null : Number(formatMinutes(Math.max(...durations))),
      errors: dayRuns.filter((r) => r.outcome === 'error').length,
      cancelled: dayRuns.filter((r) => r.outcome === 'cancelled').length,
      completed: dayRuns.filter((r) => r.outcome === 'complete').length,
      stalled: dayRuns.filter((r) => r.stalled).length,
    };
  });
}

// ─── Tooltips ────────────────────────────────────────────────────

/**
 * The tooltip's lines, as text. A pure function so the wording is asserted
 * directly — the tooltip itself is a fixed div that follows the pointer, so
 * there is no `<title>` in the markup to read it back out of.
 *
 * Wording transcribed from the approved mockup (artifact v5).
 */
export function durationTooltipLines(bucket: DayBucket<ChartRun>): string[] {
  if (bucket.finishedRuns === 0 || bucket.averageMinutes == null) {
    return [bucket.dayLabel, 'No finished runs'];
  }
  const runWord = bucket.finishedRuns === 1 ? 'run' : 'runs';
  return [
    bucket.dayLabel,
    `${bucket.finishedRuns} ${runWord} · average ${Math.round(bucket.averageMinutes)} min`,
    `longest ${Math.round(bucket.longestMinutes ?? 0)} min`,
  ];
}

export function failureTooltipLines(bucket: DayBucket<ChartRun>): string[] {
  if (bucket.runs.length === 0) {
    return [bucket.dayLabel, 'No runs'];
  }
  const lines = [
    bucket.dayLabel,
    `${bucket.errors} ${bucket.errors === 1 ? 'error' : 'errors'} · ${bucket.cancelled} cancelled · ${bucket.completed} completed`,
  ];
  if (bucket.stalled > 0) lines.push(`${bucket.stalled} stalled`);
  return lines;
}
