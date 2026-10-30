'use client';

/**
 * Exports report — exports per day (BACKLOG-4004)
 *
 * Hand SVG reusing the iPhone Sync chart geometry and frame pieces. Every UTC
 * day of the period has a column (`data-day`), empty days included. Two
 * series: every export, and the narrower bar inside it for unique exports
 * first made that day. Both read the same filtered set as the cards.
 */

import { useState } from 'react';
import {
  barHeight,
  barLayout,
  BASELINE_Y,
  CHART_HEIGHT,
  CHART_WIDTH,
  COLOR_DURATION,
  COLOR_LABEL,
  roundedTopBarPath,
} from '@/lib/reports/iphone-sync-charts';
import { exportTooltipLines, type ExportDayBucket } from '@/lib/reports/exports';
import {
  ChartFrame,
  DayLabels,
  GridLines,
  HitRects,
  LegendSwatch,
  TooltipBox,
  type Tooltip,
} from '../iphone-sync/SyncCharts';

export const COLOR_UNIQUE = '#1e3a8a';

export function ExportCharts({ buckets }: { buckets: ExportDayBucket[] }) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const bars = barLayout(buckets.length);
  const max = Math.max(0, ...buckets.map((b) => b.exports));

  return (
    <div>
      <ChartFrame
        title="Exports per day"
        subtitle="By the UTC day of each export. Unique counts a user's deal on the first day it was exported in the period."
        legend={
          <span className="flex items-center gap-3">
            <LegendSwatch color={COLOR_DURATION} label="exports" />
            <LegendSwatch color={COLOR_UNIQUE} label="unique exports" />
          </span>
        }
      >
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          width="100%"
          height={CHART_HEIGHT}
          role="img"
          aria-label="Exports per day"
          data-chart="exports"
        >
          <GridLines max={max} unit="count" />
          {buckets.map((b, i) => {
            if (b.exports === 0) return null;
            const h = barHeight(b.exports, max);
            const uh = barHeight(b.unique, max);
            const inner = Math.max(2, bars[i].width / 2);
            return (
              <g key={b.dayIso}>
                <path
                  d={roundedTopBarPath(bars[i].x, BASELINE_Y - h, bars[i].width, h)}
                  fill={COLOR_DURATION}
                  data-series="exports"
                  data-value={b.exports}
                />
                {b.unique > 0 ? (
                  <path
                    d={roundedTopBarPath(bars[i].slotCentre - inner / 2, BASELINE_Y - uh, inner, uh)}
                    fill={COLOR_UNIQUE}
                    data-series="unique"
                    data-value={b.unique}
                  />
                ) : null}
                {bars[i].width >= 14 ? (
                  <text
                    x={bars[i].slotCentre}
                    y={BASELINE_Y - h - 4}
                    textAnchor="middle"
                    fontSize={11}
                    fill={COLOR_LABEL}
                  >
                    {b.exports}
                  </text>
                ) : null}
              </g>
            );
          })}
          <DayLabels buckets={buckets} />
          <HitRects buckets={buckets} lines={exportTooltipLines} onShow={setTooltip} onHide={() => setTooltip(null)} />
        </svg>
      </ChartFrame>
      <TooltipBox tooltip={tooltip} />
    </div>
  );
}
