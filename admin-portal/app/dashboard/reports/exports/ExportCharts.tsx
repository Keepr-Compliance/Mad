'use client';

/**
 * Exports report — exports per day (BACKLOG-4004)
 *
 * Drawn with the @keepr/ui BarChart in nested mode (BACKLOG-4208). Every UTC
 * day of the period has a column (`data-day`), empty days included. Two
 * series: every export, and the narrower bar inside it for unique exports
 * first made that day. Both read the same filtered set as the cards. The
 * series keys `exports` and `unique` are the bars' `data-series` values.
 */

import { BarChart, CHART_1, CHART_4, ChartFrame, Legend, type ChartDatum, type ChartSeries } from '@keepr/ui';
import { exportTooltipLines, type ExportDayBucket } from '@/lib/reports/exports';
import { linesByDay } from '../iphone-sync/SyncCharts';

const EXPORT_SERIES: ChartSeries[] = [
  { key: 'exports', label: 'exports', color: CHART_1.value },
  { key: 'unique', label: 'unique exports', color: CHART_4.value },
];

export function ExportCharts({ buckets }: { buckets: ExportDayBucket[] }) {
  const data: ChartDatum[] = buckets.map((b) => ({
    key: b.dayIso,
    label: b.dayLabel,
    values: { exports: b.exports, unique: b.unique },
  }));

  return (
    <div>
      <ChartFrame
        title="Exports per day"
        subtitle="By the UTC day of each export. Unique counts a user's deal on the first day it was exported in the period."
        legend={<Legend series={EXPORT_SERIES} />}
      >
        <BarChart
          chartId="exports"
          title="Exports per day"
          mode="nested"
          data={data}
          series={EXPORT_SERIES}
          tooltipLines={linesByDay(buckets, exportTooltipLines)}
          categoryHeader="Day"
        />
      </ChartFrame>
    </div>
  );
}
