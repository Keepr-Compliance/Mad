/**
 * iPhone Sync Performance — per-day chart series (BACKLOG-3450)
 *
 * Pure geometry and pure text. Nothing here imports React, so every number a
 * bar is drawn from — and every line a tooltip shows — is asserted directly
 * rather than measured off a rendered pixel.
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

// ─── Geometry, transcribed from the approved mockup (artifact v5) ────

export const CHART_WIDTH = 600;
export const CHART_HEIGHT = 200;
export const PAD_LEFT = 36;
export const PAD_RIGHT = 8;
export const PAD_TOP = 14;
export const PAD_BOTTOM = 26;
export const MAX_BAR_WIDTH = 28;
export const BAR_SLOT_FRACTION = 0.62;
export const BAR_RADIUS = 4;
/** Gap between the two segments of a stacked bar. */
export const STACK_GAP = 2;

/** Validated data-viz steps. Do not substitute a Tailwind token. */
export const COLOR_DURATION = '#2a78d6';
export const COLOR_ERROR = '#d03b3b';
export const COLOR_CANCELLED = '#f59e0b';
export const COLOR_LABEL = '#374151';

export const PLOT_WIDTH = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
export const PLOT_HEIGHT = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
/** The y of a zero-height bar — every bar is anchored here. */
export const BASELINE_Y = PAD_TOP + PLOT_HEIGHT;

// ─── Buckets ─────────────────────────────────────────────────────

export interface DayBucket {
  dayIso: string;
  dayLabel: string;
  runs: SyncRun[];
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
export function bucketByDay(runs: SyncRun[], range: PeriodRange): DayBucket[] {
  const byDay = new Map<string, SyncRun[]>();
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

// ─── Axis ────────────────────────────────────────────────────────

/**
 * Show every day label up to 14 days; past that show every ⌈n/7⌉-th, ALWAYS
 * including the first and the last.
 *
 * Pure, so "labels never overlap at 30 days" is an assertion on a boolean
 * array rather than a pixel measurement.
 */
export function thinLabels(count: number): boolean[] {
  if (count <= 0) return [];
  if (count <= 14) return Array.from({ length: count }, () => true);
  const step = Math.ceil(count / 7);
  return Array.from({ length: count }, (_, i) => i % step === 0 || i === count - 1);
}

/** Three gridlines: 0, half and the max. */
export function gridValues(max: number): number[] {
  return [0, max / 2, max];
}

// ─── Bar geometry ────────────────────────────────────────────────

export interface Bar {
  dayIso: string;
  x: number;
  width: number;
  /** Centre of the day's slot — where the label and the hit rect sit. */
  slotCentre: number;
  slotX: number;
  slotWidth: number;
}

export function barLayout(days: number): Bar[] {
  if (days <= 0) return [];
  const slotWidth = PLOT_WIDTH / days;
  const width = Math.min(MAX_BAR_WIDTH, slotWidth * BAR_SLOT_FRACTION);
  return Array.from({ length: days }, (_, i) => {
    const slotX = PAD_LEFT + i * slotWidth;
    const slotCentre = slotX + slotWidth / 2;
    return { dayIso: '', x: slotCentre - width / 2, width, slotCentre, slotX, slotWidth };
  });
}

/**
 * A bar with ROUNDED TOP CORNERS ONLY, its foot square on the baseline.
 *
 * `rx` on a `<rect>` rounds all four corners, which lifts the bar off the axis
 * and makes a stacked segment's join look like a gap that is not there. The
 * radius is clamped to half the width and to the height, so a 1px bar does not
 * invert into a bow tie.
 */
export function roundedTopBarPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius = BAR_RADIUS
): string {
  if (width <= 0 || height <= 0) return '';
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const right = x + width;
  const bottom = y + height;
  return [
    `M${x},${bottom}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${right - r},${y}`,
    `Q${right},${y} ${right},${y + r}`,
    `L${right},${bottom}`,
    'Z',
  ].join(' ');
}

/** Height in pixels for `value` against `max`, anchored to the baseline. */
export function barHeight(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return (value / max) * PLOT_HEIGHT;
}

// ─── Series ──────────────────────────────────────────────────────

export interface DurationPoint {
  dayIso: string;
  dayLabel: string;
  /** NULL means NO BAR — not a zero-height one. */
  value: number | null;
}

export interface DurationSeries {
  points: DurationPoint[];
  max: number;
}

export function buildDurationSeries(buckets: DayBucket[]): DurationSeries {
  const points = buckets.map((b) => ({
    dayIso: b.dayIso,
    dayLabel: b.dayLabel,
    value: b.averageMinutes,
  }));
  const values = points.map((p) => p.value).filter((v): v is number => v != null);
  return { points, max: values.length === 0 ? 0 : Math.max(...values) };
}

export interface FailurePoint {
  dayIso: string;
  dayLabel: string;
  errors: number;
  cancelled: number;
  total: number;
}

export interface FailureSeries {
  points: FailurePoint[];
  max: number;
}

export function buildFailureSeries(buckets: DayBucket[]): FailureSeries {
  const points = buckets.map((b) => ({
    dayIso: b.dayIso,
    dayLabel: b.dayLabel,
    errors: b.errors,
    cancelled: b.cancelled,
    total: b.errors + b.cancelled,
  }));
  return { points, max: Math.max(0, ...points.map((p) => p.total)) };
}

/**
 * Stacked segment geometry: errors below, cancelled above, with a 2 px gap
 * between them whenever both are present.
 *
 * The gap comes out of the UPPER segment, so the two never touch and neither
 * segment's base moves — a gap taken off the lower one would shift the whole
 * stack off the baseline.
 */
export interface StackSegment {
  y: number;
  height: number;
  color: string;
}

export function stackSegments(point: FailurePoint, max: number): StackSegment[] {
  const segments: StackSegment[] = [];
  const errorHeight = barHeight(point.errors, max);
  const cancelledHeight = barHeight(point.cancelled, max);

  if (errorHeight > 0) {
    segments.push({ y: BASELINE_Y - errorHeight, height: errorHeight, color: COLOR_ERROR });
  }
  if (cancelledHeight > 0) {
    const gap = errorHeight > 0 ? STACK_GAP : 0;
    const height = Math.max(cancelledHeight - gap, 0.5);
    segments.push({
      y: BASELINE_Y - errorHeight - gap - height,
      height,
      color: COLOR_CANCELLED,
    });
  }
  return segments;
}

// ─── Tooltips ────────────────────────────────────────────────────

/**
 * The tooltip's lines, as text. A pure function so the wording is asserted
 * directly — the tooltip itself is a fixed div that follows the pointer, so
 * there is no `<title>` in the markup to read it back out of.
 *
 * Wording transcribed from the approved mockup (artifact v5).
 */
export function durationTooltipLines(bucket: DayBucket): string[] {
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

export function failureTooltipLines(bucket: DayBucket): string[] {
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
