'use client';

/**
 * iPhone Sync Performance — the two per-day charts (BACKLOG-3450)
 *
 * Drawn with the @keepr/ui BarChart (BACKLOG-4208): a static SVG on a fixed
 * viewBox, so `renderToStaticMarkup` produces the whole chart. The geometry
 * lives in the kit; bucketing and tooltip wording stay in
 * `lib/reports/iphone-sync-charts`.
 *
 * The Google Messages report renders this same component.
 */

import {
  BarChart,
  CHART_1,
  CHART_2,
  CHART_3,
  ChartFrame,
  Legend,
  type ChartDatum,
  type ChartSeries,
} from '@keepr/ui';
import {
  durationTooltipLines,
  failureTooltipLines,
  type ChartRun,
  type DayBucket,
} from '@/lib/reports/iphone-sync-charts';

const DURATION_SERIES: ChartSeries[] = [
  { key: 'duration', label: 'average minutes', color: CHART_1.value },
];

const FAILURE_SERIES: ChartSeries[] = [
  { key: 'errors', label: 'error', color: CHART_2.value },
  { key: 'cancelled', label: 'cancelled', color: CHART_3.value },
];

/** Gridline ticks in minutes: one decimal under 10, whole minutes above. */
export function minuteTick(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

/** Tooltip lines for a chart category, looked up by the day it stands for. */
export function linesByDay<B extends { dayIso: string }>(
  buckets: B[],
  lines: (bucket: B) => string[]
): (datum: ChartDatum) => string[] {
  const byDay = new Map(buckets.map((b) => [b.dayIso, b]));
  return (datum) => {
    const bucket = byDay.get(datum.key);
    return bucket ? lines(bucket) : [datum.label];
  };
}

/** Any report's day buckets (see ChartRun): the iPhone and Google Messages reports share it. */
export function SyncCharts({ buckets }: { buckets: DayBucket<ChartRun>[] }) {
  // NULL average = no finished runs that day = no bar (not a zero-height one).
  const duration: ChartDatum[] = buckets.map((b) => ({
    key: b.dayIso,
    label: b.dayLabel,
    values: { duration: b.averageMinutes },
  }));
  const failures: ChartDatum[] = buckets.map((b) => ({
    key: b.dayIso,
    label: b.dayLabel,
    values: { errors: b.errors, cancelled: b.cancelled },
  }));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartFrame
        title="Average duration per finished run"
        subtitle="Minutes per day. A day with no finished runs draws no bar."
      >
        <BarChart
          chartId="duration"
          title="Average sync duration in minutes per day"
          data={duration}
          series={DURATION_SERIES}
          formatTick={minuteTick}
          tooltipLines={linesByDay(buckets, durationTooltipLines)}
          categoryHeader="Day"
        />
      </ChartFrame>

      <ChartFrame
        title="Failed syncs per day"
        subtitle="Errors and cancels, stacked. A day with no failures draws no bar."
        legend={<Legend series={FAILURE_SERIES} />}
      >
        <BarChart
          chartId="failures"
          title="Failed syncs per day, errors and cancels stacked"
          mode="stacked"
          data={failures}
          series={FAILURE_SERIES}
          tooltipLines={linesByDay(buckets, failureTooltipLines)}
          categoryHeader="Day"
        />
      </ChartFrame>
    </div>
  );
}
