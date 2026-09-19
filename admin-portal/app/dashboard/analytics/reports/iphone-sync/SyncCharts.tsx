'use client';

/**
 * iPhone Sync Performance — the two per-day charts (BACKLOG-3450)
 *
 * Hand-written SVG, no chart library. The brief is per-day bars with a specific
 * stacked-failure encoding and a 2px segment gap, the colours are already-
 * validated data-viz steps, and an SVG driven by a pure series function can be
 * asserted with `renderToStaticMarkup` — where a `ResponsiveContainer` measures
 * zero and renders nothing.
 *
 * Geometry and wording are transcribed from the approved mockup (artifact v5).
 * Every number the bars are drawn from lives in `lib/reports/iphone-sync-charts`
 * and is tested there.
 */

import { useState } from 'react';
import {
  barHeight,
  barLayout,
  BASELINE_Y,
  buildDurationSeries,
  buildFailureSeries,
  CHART_HEIGHT,
  CHART_WIDTH,
  COLOR_CANCELLED,
  COLOR_DURATION,
  COLOR_ERROR,
  COLOR_LABEL,
  durationTooltipLines,
  failureTooltipLines,
  gridValues,
  PAD_LEFT,
  PAD_TOP,
  roundedTopBarPath,
  stackSegments,
  thinLabels,
  type DayBucket,
} from '@/lib/reports/iphone-sync-charts';

interface Tooltip {
  x: number;
  y: number;
  lines: string[];
}

function GridLines({ max, unit }: { max: number; unit: string }) {
  const values = gridValues(max);
  return (
    <g aria-hidden="true">
      {values.map((value) => {
        const y = BASELINE_Y - barHeight(value, max);
        return (
          <g key={value}>
            <line
              x1={PAD_LEFT}
              x2={CHART_WIDTH - 8}
              y1={y}
              y2={y}
              stroke="#e5e7eb"
              strokeWidth={1}
            />
            <text x={PAD_LEFT - 6} y={y + 3} textAnchor="end" fontSize={10} fill="#9ca3af">
              {max === 0 ? '' : formatTick(value, unit)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function formatTick(value: number, unit: string): string {
  if (unit === 'min') return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return String(Math.round(value));
}

function DayLabels({ buckets }: { buckets: DayBucket[] }) {
  const bars = barLayout(buckets.length);
  const show = thinLabels(buckets.length);
  return (
    <g aria-hidden="true">
      {buckets.map((bucket, i) =>
        show[i] ? (
          <text
            key={bucket.dayIso}
            x={bars[i].slotCentre}
            y={CHART_HEIGHT - 8}
            textAnchor="middle"
            fontSize={10}
            fill="#9ca3af"
          >
            {bucket.dayLabel}
          </text>
        ) : null
      )}
    </g>
  );
}

/**
 * An invisible full-height rect per day. The tooltip is a fixed div that
 * follows the pointer, so the hit area has to be the whole column — a bar
 * alone would leave an empty day unhoverable, and "no runs that day" is
 * exactly what a reader wants the tooltip to say.
 */
function HitRects({
  buckets,
  lines,
  onShow,
  onHide,
}: {
  buckets: DayBucket[];
  lines: (bucket: DayBucket) => string[];
  onShow: (tooltip: Tooltip) => void;
  onHide: () => void;
}) {
  const bars = barLayout(buckets.length);
  return (
    <g>
      {buckets.map((bucket, i) => (
        <rect
          key={bucket.dayIso}
          data-day={bucket.dayIso}
          x={bars[i].slotX}
          y={PAD_TOP}
          width={bars[i].slotWidth}
          height={BASELINE_Y - PAD_TOP}
          fill="transparent"
          onMouseMove={(e) => onShow({ x: e.clientX, y: e.clientY, lines: lines(bucket) })}
          onMouseLeave={onHide}
        />
      ))}
    </g>
  );
}

function TooltipBox({ tooltip }: { tooltip: Tooltip | null }) {
  if (!tooltip) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 rounded-md bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg"
      style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}
    >
      {tooltip.lines.map((line, i) => (
        <div key={line + i} className={i === 0 ? 'font-semibold' : 'text-gray-200'}>
          {line}
        </div>
      ))}
    </div>
  );
}

function ChartFrame({
  title,
  subtitle,
  children,
  legend,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  legend?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <p className="text-xs text-gray-500">{subtitle}</p>
        </div>
        {legend}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

export function SyncCharts({ buckets }: { buckets: DayBucket[] }) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const duration = buildDurationSeries(buckets);
  const failures = buildFailureSeries(buckets);
  const bars = barLayout(buckets.length);
  const hide = () => setTooltip(null);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartFrame
        title="Average duration per finished run"
        subtitle="Minutes per day. A day with no finished runs draws no bar."
      >
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          width="100%"
          height={CHART_HEIGHT}
          role="img"
          aria-label="Average sync duration in minutes per day"
        >
          <GridLines max={duration.max} unit="min" />
          {duration.points.map((point, i) =>
            point.value == null ? null : (
              <g key={point.dayIso}>
                <path
                  d={roundedTopBarPath(
                    bars[i].x,
                    BASELINE_Y - barHeight(point.value, duration.max),
                    bars[i].width,
                    barHeight(point.value, duration.max)
                  )}
                  fill={COLOR_DURATION}
                  data-value={point.value}
                />
                {bars[i].width >= 14 ? (
                  <text
                    x={bars[i].slotCentre}
                    y={BASELINE_Y - barHeight(point.value, duration.max) - 4}
                    textAnchor="middle"
                    fontSize={11}
                    fill={COLOR_LABEL}
                  >
                    {Math.round(point.value)}
                  </text>
                ) : null}
              </g>
            )
          )}
          <DayLabels buckets={buckets} />
          <HitRects
            buckets={buckets}
            lines={durationTooltipLines}
            onShow={setTooltip}
            onHide={hide}
          />
        </svg>
      </ChartFrame>

      <ChartFrame
        title="Failed syncs per day"
        subtitle="Errors and cancels, stacked. A day with no failures draws no bar."
        legend={
          <span className="flex items-center gap-3">
            <LegendSwatch color={COLOR_ERROR} label="error" />
            <LegendSwatch color={COLOR_CANCELLED} label="cancelled" />
          </span>
        }
      >
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          width="100%"
          height={CHART_HEIGHT}
          role="img"
          aria-label="Failed syncs per day, errors and cancels stacked"
        >
          <GridLines max={failures.max} unit="count" />
          {failures.points.map((point, i) => (
            <g key={point.dayIso}>
              {stackSegments(point, failures.max).map((segment) => (
                <path
                  key={segment.color}
                  d={roundedTopBarPath(bars[i].x, segment.y, bars[i].width, segment.height)}
                  fill={segment.color}
                />
              ))}
              {point.total > 0 && bars[i].width >= 14 ? (
                <text
                  x={bars[i].slotCentre}
                  y={BASELINE_Y - barHeight(point.total, failures.max) - 4}
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
          <HitRects
            buckets={buckets}
            lines={failureTooltipLines}
            onShow={setTooltip}
            onHide={hide}
          />
        </svg>
      </ChartFrame>

      <TooltipBox tooltip={tooltip} />
    </div>
  );
}
