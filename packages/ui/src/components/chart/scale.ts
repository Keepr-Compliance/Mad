/**
 * Chart kit geometry (BACKLOG-4208).
 *
 * Pure numbers, no React. Ported from the admin report charts
 * (admin-portal/lib/reports/iphone-sync-charts.ts, BACKLOG-3450) so the kit
 * draws the same pixels: a fixed 600x200 viewBox, bars capped at 28px, top
 * corners rounded, a 2px gap between stacked segments.
 *
 * Nothing here measures the DOM. Every bar is computed from the data and the
 * constants below, so the chart renders identically on the server and in tests.
 */

export const CHART_WIDTH = 600;
export const CHART_HEIGHT = 200;
export const PAD_LEFT = 36;
export const PAD_RIGHT = 8;
export const PAD_TOP = 14;
export const PAD_BOTTOM = 26;
export const MAX_BAR_WIDTH = 28;
export const BAR_SLOT_FRACTION = 0.62;
export const BAR_RADIUS = 4;
/** Gap between two segments of a stacked bar. */
export const STACK_GAP = 2;
/** A bar narrower than this has no room for its value label. */
export const MIN_LABEL_BAR_WIDTH = 14;
/** The thinnest a stacked segment that would otherwise vanish into the gap is drawn. */
export const MIN_SEGMENT_HEIGHT = 0.5;

export const PLOT_WIDTH = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
export const PLOT_HEIGHT = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
/** The y of a zero-height bar; every bar is anchored here. */
export const BASELINE_Y = PAD_TOP + PLOT_HEIGHT;

// ─── Axis ────────────────────────────────────────────────────────

/**
 * Every label up to 14 categories; past that every ceil(n/7)-th, ALWAYS keeping
 * the first and the last.
 */
export function thinLabels(count: number): boolean[] {
  if (count <= 0) return [];
  if (count <= 14) return Array.from({ length: count }, () => true);
  const step = Math.ceil(count / 7);
  return Array.from({ length: count }, (_, i) => i % step === 0 || i === count - 1);
}

/**
 * Three gridlines: 0, half and the max. With max 0 all three are 0, so a
 * consumer must key them by INDEX, never by value.
 */
export function gridValues(max: number): number[] {
  return [0, max / 2, max];
}

// ─── Bars ────────────────────────────────────────────────────────

export interface BarSlot {
  x: number;
  width: number;
  /** Centre of the slot: where the label and the hit rect sit. */
  slotCentre: number;
  slotX: number;
  slotWidth: number;
}

export function barLayout(count: number): BarSlot[] {
  if (count <= 0) return [];
  const slotWidth = PLOT_WIDTH / count;
  const width = Math.min(MAX_BAR_WIDTH, slotWidth * BAR_SLOT_FRACTION);
  return Array.from({ length: count }, (_, i) => {
    const slotX = PAD_LEFT + i * slotWidth;
    const slotCentre = slotX + slotWidth / 2;
    return { x: slotCentre - width / 2, width, slotCentre, slotX, slotWidth };
  });
}

/**
 * A bar with ROUNDED TOP CORNERS ONLY, its foot square on the baseline. The
 * radius is clamped to half the width and to the height, so a 1px bar cannot
 * invert. A zero-size bar is the empty string.
 */
export function roundedTopBarPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius = BAR_RADIUS
): string {
  if (width <= 0 || height <= 0) return '';
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const right = x + width;
  const bottom = y + height;
  return [
    `M${x},${bottom}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${right - r},${y}`,
    `Q${right},${y} ${right},${y + r}`,
    `L${right},${bottom}`,
    'Z',
  ].join(' ');
}

/** Height in pixels for `value` against `max`, anchored to the baseline. */
export function barHeight(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return (value / max) * PLOT_HEIGHT;
}

/** The largest finite value, or 0 when there is none. Never NaN or Infinity. */
export function maxOf(values: Array<number | null | undefined>): number {
  let max = 0;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

// ─── Stacks ──────────────────────────────────────────────────────

export interface StackSegment {
  /** Index of the series this segment draws. */
  index: number;
  y: number;
  height: number;
}

/**
 * Stacked segment geometry, first value at the bottom.
 *
 * Every segment that sits on another one gives up STACK_GAP from its own
 * height, so no segment's base moves and the stack never leaves the baseline.
 * A null or non-positive value draws no segment.
 */
export function stackSegments(values: Array<number | null>, max: number): StackSegment[] {
  const segments: StackSegment[] = [];
  let cursor = BASELINE_Y;
  values.forEach((value, index) => {
    const h = value === null ? 0 : barHeight(value, max);
    if (h <= 0) return;
    const gap = segments.length > 0 ? STACK_GAP : 0;
    const height = Math.max(h - gap, MIN_SEGMENT_HEIGHT);
    const y = cursor - gap - height;
    segments.push({ index, y, height });
    cursor = y;
  });
  return segments;
}
