'use client';

/**
 * BarChart (BACKLOG-4208): the kit's per-category bar chart.
 *
 * Hand-written SVG on a fixed 600x200 viewBox, width 100%. It never measures
 * the DOM, so `renderToStaticMarkup` produces the full chart and a test can
 * assert on the markup. Geometry lives in ./scale and is ported from the admin
 * report charts.
 *
 * Attributes consumers' tests read, kept exactly as the admin charts emit them:
 * - `data-chart` on the <svg> (from `chartId`)
 * - `data-day` on each category's full-height hit rect
 * - `data-value` on single-mode bars and on both nested bars
 * - `data-series` on every bar and segment
 * Stacked segments carry no `data-value`.
 */

import { useId, useState } from 'react';
import { CategoryAxis } from './category-axis';
import { ChartDataTable } from './chart-data-table';
import { ChartTooltip, type ChartTooltipState } from './chart-tooltip';
import { defaultFormatTick, GridLines } from './grid-lines';
import { CHART_LABEL_COLOR, seriesColor } from './palette';
import {
  barHeight,
  barLayout,
  BASELINE_Y,
  CHART_HEIGHT,
  CHART_WIDTH,
  maxOf,
  MIN_LABEL_BAR_WIDTH,
  PAD_TOP,
  roundedTopBarPath,
  stackSegments,
  type BarSlot,
} from './scale';
import type { BarChartMode, ChartDatum, ChartSeries, ChartValue } from './types';

export interface BarChartProps {
  data: ChartDatum[];
  series: ChartSeries[];
  mode?: BarChartMode;
  /** The chart's accessible name: rendered as the SVG <title>. */
  title: string;
  /** Longer description: rendered as the SVG <desc>. */
  desc?: string;
  /** Emitted as `data-chart` on the <svg>. */
  chartId?: string;
  /** Value labels and the screen-reader table. Default: rounded integer. */
  formatValue?: (value: number, series: ChartSeries) => string;
  /** Gridline tick text. Default: rounded integer. */
  formatTick?: (value: number) => string;
  /** Tooltip lines for a hovered category. Default: label, then one line per series. */
  tooltipLines?: (datum: ChartDatum) => string[];
  /** Draw the value above each bar (when the bar is wide enough). Default true. */
  showValueLabels?: boolean;
  /** Header of the screen-reader table's category column. */
  categoryHeader?: string;
}

function defaultFormatValue(value: number): string {
  return String(Math.round(value));
}

function valueOf(datum: ChartDatum, s: ChartSeries | undefined): ChartValue {
  if (!s) return null;
  const v = datum.values[s.key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The value a category's bar height (and label) is drawn from, per mode. */
function headlineValue(datum: ChartDatum, series: ChartSeries[], mode: BarChartMode): ChartValue {
  if (mode === 'stacked') {
    const present = series.map((s) => valueOf(datum, s)).filter((v): v is number => v !== null);
    return present.length === 0 ? null : present.reduce((sum, v) => sum + Math.max(0, v), 0);
  }
  return valueOf(datum, series[0]);
}

export function BarChart({
  data,
  series,
  mode = 'single',
  title,
  desc,
  chartId,
  formatValue = defaultFormatValue,
  formatTick = defaultFormatTick,
  tooltipLines,
  showValueLabels = true,
  categoryHeader,
}: BarChartProps) {
  const [tooltip, setTooltip] = useState<ChartTooltipState | null>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descId = `${baseId}-desc`;

  const colors = series.map((s, i) => s.color ?? seriesColor(i));
  const headlines = data.map((d) => headlineValue(d, series, mode));
  const max = maxOf(headlines);
  const slots = barLayout(data.length);
  const lines =
    tooltipLines ??
    ((d: ChartDatum) => [
      d.label,
      ...series.map((s) => {
        const v = valueOf(d, s);
        return `${s.label}: ${v === null ? 'none' : formatValue(v, s)}`;
      }),
    ]);

  const label = (slot: BarSlot, value: number, s: ChartSeries) =>
    showValueLabels && slot.width >= MIN_LABEL_BAR_WIDTH ? (
      <text
        x={slot.slotCentre}
        y={BASELINE_Y - barHeight(value, max) - 4}
        textAnchor="middle"
        fontSize={11}
        fill={CHART_LABEL_COLOR}
      >
        {formatValue(value, s)}
      </text>
    ) : null;

  const bars = (datum: ChartDatum, i: number) => {
    const slot = slots[i];
    if (mode === 'stacked') {
      const total = headlines[i];
      const segments = stackSegments(
        series.map((s) => valueOf(datum, s)),
        max
      );
      if (segments.length === 0) return null;
      return (
        <g key={datum.key}>
          {segments.map((seg) => (
            <path
              key={series[seg.index].key}
              d={roundedTopBarPath(slot.x, seg.y, slot.width, seg.height)}
              fill={colors[seg.index]}
              data-series={series[seg.index].key}
            />
          ))}
          {total !== null && total > 0 ? label(slot, total, series[0]) : null}
        </g>
      );
    }

    const outer = valueOf(datum, series[0]);
    if (outer === null) return null;
    const h = barHeight(outer, max);

    if (mode === 'nested') {
      if (outer <= 0) return null;
      const inner = valueOf(datum, series[1]);
      const ih = inner === null ? 0 : barHeight(inner, max);
      const innerWidth = Math.max(2, slot.width / 2);
      return (
        <g key={datum.key}>
          <path
            d={roundedTopBarPath(slot.x, BASELINE_Y - h, slot.width, h)}
            fill={colors[0]}
            data-series={series[0].key}
            data-value={outer}
          />
          {inner !== null && inner > 0 && series[1] ? (
            <path
              d={roundedTopBarPath(slot.slotCentre - innerWidth / 2, BASELINE_Y - ih, innerWidth, ih)}
              fill={colors[1]}
              data-series={series[1].key}
              data-value={inner}
            />
          ) : null}
          {label(slot, outer, series[0])}
        </g>
      );
    }

    return (
      <g key={datum.key}>
        <path
          d={roundedTopBarPath(slot.x, BASELINE_Y - h, slot.width, h)}
          fill={colors[0]}
          data-series={series[0].key}
          data-value={outer}
        />
        {label(slot, outer, series[0])}
      </g>
    );
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        width="100%"
        height={CHART_HEIGHT}
        role="img"
        aria-labelledby={desc ? `${titleId} ${descId}` : titleId}
        data-chart={chartId}
      >
        <title id={titleId}>{title}</title>
        {desc ? <desc id={descId}>{desc}</desc> : null}
        <GridLines max={max} formatTick={formatTick} />
        {/* No scale to draw against: every value is zero, null or absent. */}
        {max <= 0 ? null : data.map(bars)}
        <CategoryAxis categories={data} />
        <g>
          {data.map((datum, i) => (
            <rect
              key={datum.key}
              data-day={datum.key}
              x={slots[i].slotX}
              y={PAD_TOP}
              width={slots[i].slotWidth}
              height={BASELINE_Y - PAD_TOP}
              fill="transparent"
              onMouseMove={(e) => setTooltip({ x: e.clientX, y: e.clientY, lines: lines(datum) })}
              onMouseLeave={() => setTooltip(null)}
            />
          ))}
        </g>
      </svg>
      <ChartDataTable
        caption={title}
        data={data}
        series={series}
        formatValue={formatValue}
        categoryHeader={categoryHeader}
      />
      <ChartTooltip tooltip={tooltip} />
    </div>
  );
}
