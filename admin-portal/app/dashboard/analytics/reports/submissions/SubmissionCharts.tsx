'use client';

/**
 * Submissions report — two per-day charts (BACKLOG-3715)
 *
 * Hand SVG reusing the iPhone Sync chart geometry and frame pieces. Every day
 * of the period has a column (`data-day`), including days with no attempts.
 *
 * (a) attempts per day, one colour.
 * (b) failures per day, stacked: red = failed + outcome unknown, amber = did
 *     not finish (abandoned + stalled). Cancelled is left out of the bar — it
 *     is the agent's own action — and shown in the tooltip.
 */

import { useState } from 'react';
import {
  barHeight,
  barLayout,
  BASELINE_Y,
  CHART_HEIGHT,
  CHART_WIDTH,
  COLOR_CANCELLED,
  COLOR_DURATION,
  COLOR_ERROR,
  COLOR_LABEL,
  roundedTopBarPath,
  stackSegments,
} from '@/lib/reports/iphone-sync-charts';
import {
  attemptsTooltipLines,
  failureTooltipLines,
  type SubmissionDayBucket,
} from '@/lib/reports/submissions';
import {
  ChartFrame,
  DayLabels,
  GridLines,
  HitRects,
  LegendSwatch,
  TooltipBox,
  type Tooltip,
} from '../iphone-sync/SyncCharts';

export function SubmissionCharts({ buckets }: { buckets: SubmissionDayBucket[] }) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const bars = barLayout(buckets.length);
  const hide = () => setTooltip(null);
  const attemptsMax = Math.max(0, ...buckets.map((b) => b.attempts));
  const failurePoints = buckets.map((b) => ({
    dayIso: b.dayIso,
    dayLabel: b.dayLabel,
    errors: b.failed,
    cancelled: b.didNotFinish,
    total: b.failed + b.didNotFinish,
  }));
  const failureMax = Math.max(0, ...failurePoints.map((p) => p.total));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartFrame title="Submit attempts per day" subtitle="By the UTC day each attempt started.">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          width="100%"
          height={CHART_HEIGHT}
          role="img"
          aria-label="Submit attempts per day"
          data-chart="attempts"
        >
          <GridLines max={attemptsMax} unit="count" />
          {buckets.map((b, i) =>
            b.attempts === 0 ? null : (
              <g key={b.dayIso}>
                <path
                  d={roundedTopBarPath(
                    bars[i].x,
                    BASELINE_Y - barHeight(b.attempts, attemptsMax),
                    bars[i].width,
                    barHeight(b.attempts, attemptsMax)
                  )}
                  fill={COLOR_DURATION}
                  data-value={b.attempts}
                />
                {bars[i].width >= 14 ? (
                  <text
                    x={bars[i].slotCentre}
                    y={BASELINE_Y - barHeight(b.attempts, attemptsMax) - 4}
                    textAnchor="middle"
                    fontSize={11}
                    fill={COLOR_LABEL}
                  >
                    {b.attempts}
                  </text>
                ) : null}
              </g>
            )
          )}
          <DayLabels buckets={buckets} />
          <HitRects buckets={buckets} lines={attemptsTooltipLines} onShow={setTooltip} onHide={hide} />
        </svg>
      </ChartFrame>

      <ChartFrame
        title="Failures per day"
        subtitle="Failed or unknown, and did not finish or stalled, stacked. Cancelled is in the tooltip only."
        legend={
          <span className="flex items-center gap-3">
            <LegendSwatch color={COLOR_ERROR} label="failed or unknown" />
            <LegendSwatch color={COLOR_CANCELLED} label="did not finish or stalled" />
          </span>
        }
      >
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          width="100%"
          height={CHART_HEIGHT}
          role="img"
          aria-label="Failed submit attempts per day, stacked"
          data-chart="failures"
        >
          <GridLines max={failureMax} unit="count" />
          {failurePoints.map((point, i) => (
            <g key={point.dayIso}>
              {stackSegments(point, failureMax).map((segment) => (
                <path
                  key={segment.color}
                  d={roundedTopBarPath(bars[i].x, segment.y, bars[i].width, segment.height)}
                  fill={segment.color}
                />
              ))}
              {point.total > 0 && bars[i].width >= 14 ? (
                <text
                  x={bars[i].slotCentre}
                  y={BASELINE_Y - barHeight(point.total, failureMax) - 4}
                  textAnchor="middle"
                  fontSize={11}
                  fill={COLOR_LABEL}
                >
                  {point.total}
                </text>
              ) : null}
            </g>
          ))}
          <DayLabels buckets={buckets} />
          <HitRects buckets={buckets} lines={failureTooltipLines} onShow={setTooltip} onHide={hide} />
        </svg>
      </ChartFrame>

      <TooltipBox tooltip={tooltip} />
    </div>
  );
}
