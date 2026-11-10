/** Chart kit data shapes (BACKLOG-4208). */

/** NULL means NO BAR, not a zero-height one. */
export type ChartValue = number | null;

export interface ChartDatum {
  /** Stable id of the category (a day's ISO date, for a per-day chart). Emitted as `data-day`. */
  key: string;
  /** Category axis text, e.g. "Sep 18". */
  label: string;
  /** One value per series, keyed by `ChartSeries.key`. A missing key reads as null. */
  values: Record<string, ChartValue>;
}

export interface ChartSeries {
  key: string;
  label: string;
  /** Any SVG fill. Defaults to the palette step for the series' position. */
  color?: string;
}

/**
 * - `single`: one bar per category, from the first series.
 * - `stacked`: the series stacked bottom-up in order, 2px apart.
 * - `nested`: the second series drawn as a narrower bar inside the first.
 */
export type BarChartMode = 'single' | 'stacked' | 'nested';
