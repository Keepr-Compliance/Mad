import { barHeight, BASELINE_Y, CHART_WIDTH, gridValues, PAD_LEFT, PAD_RIGHT } from './scale';
import { CHART_AXIS_TEXT_COLOR, CHART_GRID_COLOR } from './palette';

export interface GridLinesProps {
  max: number;
  formatTick?: (value: number) => string;
}

export function defaultFormatTick(value: number): string {
  return String(Math.round(value));
}

/**
 * Three horizontal gridlines with their tick text. Keyed by INDEX: with max 0
 * the three values are all 0, and a value key would collide.
 */
export function GridLines({ max, formatTick = defaultFormatTick }: GridLinesProps) {
  return (
    <g aria-hidden="true">
      {gridValues(max).map((value, i) => {
        const y = BASELINE_Y - barHeight(value, max);
        return (
          <g key={i}>
            <line
              x1={PAD_LEFT}
              x2={CHART_WIDTH - PAD_RIGHT}
              y1={y}
              y2={y}
              stroke={CHART_GRID_COLOR}
              strokeWidth={1}
            />
            <text x={PAD_LEFT - 6} y={y + 3} textAnchor="end" fontSize={10} fill={CHART_AXIS_TEXT_COLOR}>
              {max <= 0 ? '' : formatTick(value)}
            </text>
          </g>
        );
      })}
    </g>
  );
}
