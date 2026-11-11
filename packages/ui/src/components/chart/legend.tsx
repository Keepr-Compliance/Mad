import type { ChartSeries } from './types';
import { seriesColor } from './palette';

export function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

export interface LegendProps {
  series: ChartSeries[];
}

/** One swatch per series, in series order. */
export function Legend({ series }: LegendProps) {
  return (
    <span className="flex items-center gap-3">
      {series.map((s, i) => (
        <LegendSwatch key={s.key} color={s.color ?? seriesColor(i)} label={s.label} />
      ))}
    </span>
  );
}
