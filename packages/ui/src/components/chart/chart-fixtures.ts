/**
 * Chart kit fixtures (BACKLOG-4208), TRANSCRIBED from the admin iPhone Sync
 * report, not invented.
 *
 * Source: admin-portal `bucketByDay(buildIphoneSyncReport(FIXTURE_ROWS_24,
 * FIXTURE_USERS_24).runs, range)` -> `buildDurationSeries` / `buildFailureSeries`,
 * NOW = 2026-09-19T22:07Z, at int-portal/report-charts-247 @ 3edc0bdbd. Dumped
 * with an esbuild one-off script; the same script rendered the admin
 * <SyncCharts> and this kit's <BarChart> from these inputs and found every path,
 * gridline, text and data-day identical for all three ranges.
 *
 * - DAYS_7: custom range 2026-09-13..2026-09-19 (7 days; the 13th and 19th empty).
 * - DAYS_30: custom range 2026-08-21..2026-09-19 (30 days; 24 leading empty days).
 * - DAYS_EMPTY: 'last-week' (2026-09-07..13): 7 days, no runs at all.
 */
import type { ChartDatum, ChartSeries } from './types';
import { CHART_1, CHART_2, CHART_3, CHART_4 } from './palette';

interface Row {
  key: string;
  label: string;
  duration: number | null;
  errors: number;
  cancelled: number;
}

const CORPUS: Row[] = [
  { key: '2026-09-14', label: 'Sep 14', duration: 16.2, errors: 5, cancelled: 3 },
  { key: '2026-09-15', label: 'Sep 15', duration: 17.1, errors: 4, cancelled: 1 },
  { key: '2026-09-16', label: 'Sep 16', duration: 181.7, errors: 0, cancelled: 1 },
  { key: '2026-09-17', label: 'Sep 17', duration: 1, errors: 2, cancelled: 0 },
  { key: '2026-09-18', label: 'Sep 18', duration: 19, errors: 2, cancelled: 2 },
  { key: '2026-09-19', label: 'Sep 19', duration: null, errors: 0, cancelled: 0 },
];

function empty(month: 'Aug' | 'Sep', day: number): Row {
  const mm = month === 'Aug' ? '08' : '09';
  return { key: `2026-${mm}-${String(day).padStart(2, '0')}`, label: `${month} ${day}`, duration: null, errors: 0, cancelled: 0 };
}

function range(month: 'Aug' | 'Sep', from: number, to: number): Row[] {
  return Array.from({ length: to - from + 1 }, (_, i) => empty(month, from + i));
}

const ROWS: Record<'DAYS_7' | 'DAYS_30' | 'DAYS_EMPTY', Row[]> = {
  DAYS_7: [empty('Sep', 13), ...CORPUS],
  DAYS_30: [...range('Aug', 21, 31), ...range('Sep', 1, 13), ...CORPUS],
  DAYS_EMPTY: range('Sep', 7, 13),
};

export type FixtureName = keyof typeof ROWS;
export const FIXTURE_NAMES = Object.keys(ROWS) as FixtureName[];

export const DURATION_SERIES: ChartSeries[] = [{ key: 'duration', label: 'Average minutes', color: CHART_1.value }];
export const FAILURE_SERIES: ChartSeries[] = [
  { key: 'errors', label: 'error', color: CHART_2.value },
  { key: 'cancelled', label: 'cancelled', color: CHART_3.value },
];
export const EXPORT_SERIES: ChartSeries[] = [
  { key: 'exports', label: 'exports', color: CHART_1.value },
  { key: 'unique', label: 'unique exports', color: CHART_4.value },
];

export function durationData(name: FixtureName): ChartDatum[] {
  return ROWS[name].map((r) => ({ key: r.key, label: r.label, values: { duration: r.duration } }));
}

export function failureData(name: FixtureName): ChartDatum[] {
  return ROWS[name].map((r) => ({ key: r.key, label: r.label, values: { errors: r.errors, cancelled: r.cancelled } }));
}

/** Admin's duration tick format (SyncCharts formatTick, unit 'min'). */
export function minuteTick(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}
