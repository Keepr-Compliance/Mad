/**
 * Chart kit geometry (BACKLOG-4208), ported from the admin geometry suite
 * (admin-portal/lib/reports/__tests__/iphone-sync-charts.test.ts, vitest ->
 * jest). The bucketing and tooltip-wording cases stay in admin: they test
 * report code, not the kit.
 *
 * Literals, not the exported constants, where a constant would make the
 * assertion vacuous (a STACK_GAP edit must red the gap case).
 */
import {
  barHeight,
  barLayout,
  BASELINE_Y,
  CHART_HEIGHT,
  CHART_WIDTH,
  gridValues,
  MAX_BAR_WIDTH,
  maxOf,
  PLOT_HEIGHT,
  roundedTopBarPath,
  stackSegments,
  thinLabels,
} from './scale';

describe('the axis', () => {
  it('draws exactly THREE gridlines, at 0, half and max', () => {
    expect(gridValues(8)).toEqual([0, 4, 8]);
    expect(gridValues(181.7)).toHaveLength(3);
  });

  it('gives three equal values at max 0 (why GridLines keys by index)', () => {
    expect(gridValues(0)).toEqual([0, 0, 0]);
  });

  it('shows every label up to 14 categories', () => {
    for (const n of [1, 6, 14]) expect(thinLabels(n).filter(Boolean)).toHaveLength(n);
  });

  it('thins to every ceil(n/7)th past 14, keeping first and last', () => {
    const thinned = thinLabels(30);
    expect(thinned).toHaveLength(30);
    expect(thinned.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).toEqual([0, 5, 10, 15, 20, 25, 29]);
  });

  it('keeps first and last at 15, 31 and 90 too', () => {
    for (const n of [15, 31, 90]) {
      const thinned = thinLabels(n);
      expect(thinned[0]).toBe(true);
      expect(thinned[n - 1]).toBe(true);
      expect(thinned.filter(Boolean).length).toBeLessThanOrEqual(9);
      expect(thinned.filter(Boolean).length).toBeGreaterThan(1);
    }
  });

  it('is empty for no categories', () => {
    expect(thinLabels(0)).toEqual([]);
    expect(barLayout(0)).toEqual([]);
  });
});

describe('bar layout', () => {
  it('uses the 600x200 geometry', () => {
    expect(CHART_WIDTH).toBe(600);
    expect(CHART_HEIGHT).toBe(200);
    expect(BASELINE_Y).toBe(174);
    expect(PLOT_HEIGHT).toBe(160);
  });

  it('caps a bar at 28px however few categories there are', () => {
    expect(barLayout(1)[0].width).toBe(28);
    expect(barLayout(2)[0].width).toBe(MAX_BAR_WIDTH);
  });

  it('falls back to 62% of the slot when categories get tight', () => {
    const bars = barLayout(30);
    expect(bars[0].width).toBeLessThan(28);
    expect(bars[0].width).toBeCloseTo(bars[0].slotWidth * 0.62, 6);
  });

  it('centres every bar in its slot and never overlaps the next', () => {
    const bars = barLayout(6);
    for (const bar of bars) expect(bar.x + bar.width / 2).toBeCloseTo(bar.slotCentre, 6);
    for (let i = 1; i < bars.length; i += 1) {
      expect(bars[i].x).toBeGreaterThanOrEqual(bars[i - 1].x + bars[i - 1].width);
    }
  });
});

describe('bar height', () => {
  it('scales to the max and is zero for a zero or negative value', () => {
    expect(barHeight(8, 8)).toBe(160);
    expect(barHeight(4, 8)).toBeCloseTo(80, 6);
    expect(barHeight(0, 8)).toBe(0);
    expect(barHeight(-3, 8)).toBe(0);
  });

  it('is zero, never NaN or Infinity, when the max is 0', () => {
    expect(barHeight(0, 0)).toBe(0);
    expect(barHeight(5, 0)).toBe(0);
  });

  it('maxOf ignores null, NaN and Infinity and floors at 0', () => {
    expect(maxOf([null, 3, NaN, Infinity, 7, undefined])).toBe(7);
    expect(maxOf([])).toBe(0);
    expect(maxOf([null, -4])).toBe(0);
  });
});

describe('the stack', () => {
  it('keeps a 2px gap between two segments and anchors to the baseline', () => {
    const [error, cancelled] = stackSegments([5, 3], 8);
    expect(error.index).toBe(0);
    expect(cancelled.index).toBe(1);
    expect(error.y + error.height).toBeCloseTo(174, 6);
    expect(error.y - (cancelled.y + cancelled.height)).toBeCloseTo(2, 6);
  });

  it('takes the gap out of the UPPER segment, so the stack top is unchanged', () => {
    const [, cancelled] = stackSegments([5, 3], 8);
    expect(cancelled.y).toBeCloseTo(174 - 160, 6);
    expect(cancelled.height).toBeCloseTo(60 - 2, 6);
  });

  it('takes no gap when only one segment is present', () => {
    const [segment] = stackSegments([0, 3], 8);
    expect(segment.index).toBe(1);
    expect(segment.y + segment.height).toBeCloseTo(174, 6);
    expect(segment.height).toBeCloseTo(60, 6);
  });

  it('draws nothing for a category with no values, null or zero', () => {
    expect(stackSegments([0, 0], 8)).toEqual([]);
    expect(stackSegments([null, null], 8)).toEqual([]);
    expect(stackSegments([0, 0], 0)).toEqual([]);
  });

  it('keeps a thin upper segment visible at 0.5px', () => {
    const [, top] = stackSegments([100, 1], 101);
    expect(top.height).toBe(0.5);
  });

  it('stacks three series with a gap above each lower one', () => {
    const segs = stackSegments([2, 2, 2], 6);
    expect(segs).toHaveLength(3);
    expect(segs[0].y - (segs[1].y + segs[1].height)).toBeCloseTo(2, 6);
    expect(segs[1].y - (segs[2].y + segs[2].height)).toBeCloseTo(2, 6);
    expect(segs[2].y).toBeCloseTo(14, 6);
  });
});

describe('bar shape', () => {
  it('rounds the TOP corners only and keeps the foot square on the baseline', () => {
    const d = roundedTopBarPath(10, 100, 28, 60, 4);
    expect(d.startsWith('M10,160')).toBe(true);
    expect(d.match(/Q/g)).toHaveLength(2);
    expect(d).toContain('L38,160');
    expect(d).toContain('Z');
  });

  it('clamps the radius so a thin or short bar cannot invert', () => {
    expect(roundedTopBarPath(0, 0, 2, 50, 4)).toContain('Q0,0 1,0');
    expect(roundedTopBarPath(0, 0, 28, 1, 4)).toContain('Q0,0 1,0');
  });

  it('draws nothing for a zero-size bar', () => {
    expect(roundedTopBarPath(0, 100, 28, 0)).toBe('');
    expect(roundedTopBarPath(0, 100, 0, 40)).toBe('');
  });
});
