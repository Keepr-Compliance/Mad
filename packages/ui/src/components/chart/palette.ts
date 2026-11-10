/**
 * Chart kit palette (BACKLOG-4208).
 *
 * Four validated data-viz steps, declared as --chart-1..4 in styles/theme.css.
 * Each colour is used as `var(--chart-N, #hex)` so a chart still draws the
 * right colour on a page that has not loaded theme.css.
 *
 * Hexes are the ones the admin report charts use today; do not substitute a
 * Tailwind token.
 */

export interface ChartColor {
  token: string;
  hex: string;
  /** What goes in an SVG `fill`. */
  value: string;
}

function color(token: string, hex: string): ChartColor {
  return { token, hex, value: `var(${token}, ${hex})` };
}

/** Blue: the primary series (duration, attempts, exports). */
export const CHART_1 = color('--chart-1', '#2a78d6');
/** Red: errors and failures. */
export const CHART_2 = color('--chart-2', '#d03b3b');
/** Amber: cancelled, did not finish. */
export const CHART_3 = color('--chart-3', '#f59e0b');
/** Navy: the inner series of a nested bar. */
export const CHART_4 = color('--chart-4', '#1e3a8a');

export const CHART_PALETTE: readonly ChartColor[] = [CHART_1, CHART_2, CHART_3, CHART_4];

/** Value-label text colour (gray-700). */
export const CHART_LABEL_COLOR = '#374151';
/** Gridline stroke (gray-200). */
export const CHART_GRID_COLOR = '#e5e7eb';
/** Tick and category text (gray-400). */
export const CHART_AXIS_TEXT_COLOR = '#9ca3af';

/** The default fill for the series at `index`, cycling through the palette. */
export function seriesColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length].value;
}
