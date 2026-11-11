'use client';

/**
 * Submissions report — two per-day charts (BACKLOG-3715)
 *
 * Drawn with the @keepr/ui BarChart (BACKLOG-4208). Every day of the period
 * has a column (`data-day`), including days with no attempts.
 *
 * (a) attempts per day, one colour. A day with no attempts is NULL, so it
 *     draws no bar and no "0" label.
 * (b) failures per day, stacked: red = failed + outcome unknown, amber = did
 *     not finish (abandoned + stalled). Cancelled is left out of the bar — it
 *     is the agent's own action — and shown in the tooltip.
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
  attemptsTooltipLines,
  failureTooltipLines,
  type SubmissionDayBucket,
} from '@/lib/reports/submissions';
import { linesByDay } from '../iphone-sync/SyncCharts';

const ATTEMPT_SERIES: ChartSeries[] = [{ key: 'attempts', label: 'attempts', color: CHART_1.value }];

const FAILURE_SERIES: ChartSeries[] = [
  { key: 'failed', label: 'failed or unknown', color: CHART_2.value },
  { key: 'didNotFinish', label: 'did not finish or stalled', color: CHART_3.value },
];

export function SubmissionCharts({ buckets }: { buckets: SubmissionDayBucket[] }) {
  const attempts: ChartDatum[] = buckets.map((b) => ({
    key: b.dayIso,
    label: b.dayLabel,
    values: { attempts: b.attempts === 0 ? null : b.attempts },
  }));
  const failures: ChartDatum[] = buckets.map((b) => ({
    key: b.dayIso,
    label: b.dayLabel,
    values: { failed: b.failed, didNotFinish: b.didNotFinish },
  }));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartFrame title="Submit attempts per day" subtitle="By the UTC day each attempt started.">
        <BarChart
          chartId="attempts"
          title="Submit attempts per day"
          data={attempts}
          series={ATTEMPT_SERIES}
          tooltipLines={linesByDay(buckets, attemptsTooltipLines)}
          categoryHeader="Day"
        />
      </ChartFrame>

      <ChartFrame
        title="Failures per day"
        subtitle="Failed or unknown, and did not finish or stalled, stacked. Cancelled is in the tooltip only."
        legend={<Legend series={FAILURE_SERIES} />}
      >
        <BarChart
          chartId="failures"
          title="Failed submit attempts per day, stacked"
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
