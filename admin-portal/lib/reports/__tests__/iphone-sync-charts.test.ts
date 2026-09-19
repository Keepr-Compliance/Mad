/**
 * Per-day chart series (BACKLOG-3450)
 *
 * Every assertion here is on a number the SVG is drawn from, never on a
 * rendered pixel. The four things a wrong chart gets wrong and still looks
 * plausible — an absent empty day, a zero-height stub where there should be no
 * bar, a stack with no gap, and labels that overlap past 14 days — each have
 * their own case.
 */

import { describe, expect, it } from 'vitest';
import { buildIphoneSyncReport } from '../iphone-sync';
import { resolvePeriod } from '../period';
import {
  barHeight,
  barLayout,
  BASELINE_Y,
  bucketByDay,
  buildDurationSeries,
  buildFailureSeries,
  CHART_HEIGHT,
  CHART_WIDTH,
  COLOR_CANCELLED,
  COLOR_ERROR,
  durationTooltipLines,
  failureTooltipLines,
  gridValues,
  MAX_BAR_WIDTH,
  PLOT_HEIGHT,
  roundedTopBarPath,
  stackSegments,
  STACK_GAP,
  thinLabels,
} from '../iphone-sync-charts';
import { DERIVED_ROWS, FIXTURE_ROWS_24, FIXTURE_USERS_24 } from './iphone-sync.fixture';

const NOW = new Date('2026-09-19T22:07:00.000Z');
const THIS_WEEK = resolvePeriod({}, NOW);
const RUNS = buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24).runs;

describe('bucketByDay', () => {
  const buckets = bucketByDay(RUNS, THIS_WEEK);

  it('emits a bucket for EVERY day in the range, empty ones included', () => {
    expect(buckets.map((b) => b.dayIso)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
    ]);
  });

  it('reproduces the measured per-day shape of the corpus', () => {
    // select date_trunc('day', created_at)::date, count(*) ... group by 1;
    expect(buckets.map((b) => b.runs.length)).toEqual([9, 7, 1, 2, 5, 0]);
    expect(buckets.map((b) => b.errors)).toEqual([5, 4, 0, 2, 2, 0]);
    expect(buckets.map((b) => b.cancelled)).toEqual([3, 1, 1, 0, 2, 0]);
    expect(buckets.map((b) => b.completed)).toEqual([1, 2, 0, 0, 1, 0]);
  });

  it('leaves a day with no runs NULL, not zero', () => {
    const empty = buckets[5];
    expect(empty.dayIso).toBe('2026-09-19');
    expect(empty.runs).toHaveLength(0);
    expect(empty.averageMinutes).toBeNull();
    expect(empty.longestMinutes).toBeNull();
    expect(empty.averageMinutes).not.toBe(0);
  });

  it('puts the 181.7-minute incident on its own day, far above its neighbours', () => {
    expect(buckets[2].averageMinutes).toBeCloseTo(181.7, 1);
    expect(buckets[2].longestMinutes).toBeCloseTo(181.7, 1);
    for (const other of [0, 1, 3, 4]) {
      expect(buckets[other].averageMinutes!).toBeLessThan(40);
    }
  });

  it('counts stalled runs per day', () => {
    // Measured, same query as the shape above plus:
    //   count(*) filter (where elapsed_ms >= 1800000
    //                      and coalesce(messages_extracted,0) = 0)
    expect(buckets.map((b) => b.stalled)).toEqual([2, 0, 1, 0, 2, 0]);
    expect(buckets.reduce((sum, b) => sum + b.stalled, 0)).toBe(5);
  });

  it('buckets on the UTC day, not the local one', () => {
    const rows = [DERIVED_ROWS.lateUtcEvening, DERIVED_ROWS.earlyUtcMorning];
    const runs = buildIphoneSyncReport(rows, FIXTURE_USERS_24).runs;
    const b = bucketByDay(runs, THIS_WEEK);
    // 2026-09-17T23:30Z and 2026-09-18T00:30Z are on DIFFERENT UTC days.
    expect(b.find((x) => x.dayIso === '2026-09-17')!.runs).toHaveLength(1);
    expect(b.find((x) => x.dayIso === '2026-09-18')!.runs).toHaveLength(1);
  });

  it('drops a run outside the range rather than inventing a day for it', () => {
    const lastWeek = resolvePeriod({ period: 'last-week' }, NOW);
    const b = bucketByDay(RUNS, lastWeek);
    expect(b).toHaveLength(7);
    expect(b.every((x) => x.runs.length === 0)).toBe(true);
  });
});

describe('the duration series', () => {
  const series = buildDurationSeries(bucketByDay(RUNS, THIS_WEEK));

  it('draws NO BAR for a day with no runs', () => {
    expect(series.points).toHaveLength(6);
    expect(series.points[5].value).toBeNull();
    expect(barHeight(0, series.max)).toBe(0);
  });

  it('scales to the tallest day', () => {
    expect(series.max).toBeCloseTo(181.7, 1);
    expect(barHeight(series.max, series.max)).toBe(PLOT_HEIGHT);
    expect(barHeight(series.max / 2, series.max)).toBeCloseTo(PLOT_HEIGHT / 2, 6);
  });

  it('is empty-safe', () => {
    const empty = buildDurationSeries(bucketByDay([], THIS_WEEK));
    expect(empty.points).toHaveLength(6);
    expect(empty.points.every((p) => p.value === null)).toBe(true);
    expect(empty.max).toBe(0);
  });
});

describe('the failure series and its stack', () => {
  const buckets = bucketByDay(RUNS, THIS_WEEK);
  const series = buildFailureSeries(buckets);

  it('stacks errors and cancels per day', () => {
    expect(series.points.map((p) => p.total)).toEqual([8, 5, 1, 2, 4, 0]);
    expect(series.max).toBe(8);
  });

  it('keeps a 2px gap between the two segments, and anchors to the baseline', () => {
    const day = series.points[0]; // 5 errors, 3 cancelled
    const segments = stackSegments(day, series.max);
    expect(segments).toHaveLength(2);

    const [error, cancelled] = segments;
    expect(error.color).toBe(COLOR_ERROR);
    expect(cancelled.color).toBe(COLOR_CANCELLED);
    // The error segment sits ON the baseline.
    expect(error.y + error.height).toBeCloseTo(BASELINE_Y, 6);
    // The gap is real: the cancelled segment ends 2px above the error's top.
    const gap = error.y - (cancelled.y + cancelled.height);
    expect(gap).toBeCloseTo(STACK_GAP, 6);
    expect(gap).toBeGreaterThan(0);
  });

  it('draws nothing at all on a day with no failures', () => {
    expect(stackSegments(series.points[5], series.max)).toEqual([]);
  });

  it('takes no gap when only one segment is present', () => {
    const only = { dayIso: 'x', dayLabel: 'x', errors: 0, cancelled: 3, total: 3 };
    const [segment] = stackSegments(only, 8);
    expect(segment.color).toBe(COLOR_CANCELLED);
    expect(segment.y + segment.height).toBeCloseTo(BASELINE_Y, 6);
  });
});

describe('the axis', () => {
  it('draws exactly THREE gridlines, at 0, half and max', () => {
    expect(gridValues(8)).toEqual([0, 4, 8]);
    expect(gridValues(181.7)).toHaveLength(3);
  });

  it('shows every day label up to 14 days', () => {
    for (const n of [1, 6, 14]) {
      expect(thinLabels(n).filter(Boolean)).toHaveLength(n);
    }
  });

  it('thins to every ceil(n/7)th past 14 days, keeping first and last', () => {
    // n=30 → step 5 → indices 0,5,10,15,20,25 plus the last (29) = 7 labels.
    const thinned = thinLabels(30);
    expect(thinned).toHaveLength(30);
    expect(thinned.filter(Boolean)).toHaveLength(7);
    expect(thinned[0]).toBe(true);
    expect(thinned[29]).toBe(true);
    expect(thinned.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).toEqual([
      0, 5, 10, 15, 20, 25, 29,
    ]);
  });

  it('keeps first and last at 15 and at 90 days too', () => {
    for (const n of [15, 31, 90]) {
      const thinned = thinLabels(n);
      expect(thinned[0]).toBe(true);
      expect(thinned[n - 1]).toBe(true);
      expect(thinned.filter(Boolean).length).toBeLessThanOrEqual(9);
      expect(thinned.filter(Boolean).length).toBeGreaterThan(1);
    }
  });
});

describe('bar layout', () => {
  it('uses the mockup s geometry', () => {
    expect(CHART_WIDTH).toBe(600);
    expect(CHART_HEIGHT).toBe(200);
  });

  it('caps a bar at 28px however few days there are', () => {
    const [bar] = barLayout(2);
    expect(bar.width).toBe(MAX_BAR_WIDTH);
  });

  it('falls back to 62% of the slot when the days get tight', () => {
    const bars = barLayout(30);
    expect(bars[0].width).toBeLessThan(MAX_BAR_WIDTH);
    expect(bars[0].width).toBeCloseTo(bars[0].slotWidth * 0.62, 6);
  });

  it('centres every bar in its slot and never overlaps the next', () => {
    const bars = barLayout(6);
    for (const bar of bars) {
      expect(bar.x + bar.width / 2).toBeCloseTo(bar.slotCentre, 6);
    }
    for (let i = 1; i < bars.length; i += 1) {
      expect(bars[i].x).toBeGreaterThanOrEqual(bars[i - 1].x + bars[i - 1].width);
    }
  });
});

describe('tooltip wording', () => {
  const buckets = bucketByDay(RUNS, THIS_WEEK);

  it('names runs, average and longest for the duration chart', () => {
    expect(durationTooltipLines(buckets[4])).toEqual([
      'Sep 18',
      '5 runs · average 19 min',
      'longest 50 min',
    ]);
  });

  it('says so plainly when a day has no finished runs', () => {
    expect(durationTooltipLines(buckets[5])).toEqual(['Sep 19', 'No finished runs']);
  });

  it('names errors, cancels, completions and stalls for the failure chart', () => {
    expect(failureTooltipLines(buckets[4])).toEqual([
      'Sep 18',
      '2 errors · 2 cancelled · 1 completed',
      '2 stalled',
    ]);
  });

  it('leaves the stalled line off when there are none', () => {
    expect(failureTooltipLines(buckets[3])).toEqual(['Sep 17', '2 errors · 0 cancelled · 0 completed']);
  });

  it('singularises one run and one error', () => {
    expect(durationTooltipLines(buckets[2])[1]).toContain('1 run ·');
    expect(failureTooltipLines(buckets[2])[1]).toContain('0 errors');
  });
});

describe('bar shape', () => {
  it('rounds the TOP corners only and keeps the foot square on the baseline', () => {
    const d = roundedTopBarPath(10, 100, 28, 60, 4);
    // Starts at the bottom-left, on the baseline.
    expect(d.startsWith('M10,160')).toBe(true);
    // Two quadratic curves — the two top corners — and no more.
    expect(d.match(/Q/g)).toHaveLength(2);
    // Both bottom corners are reached by straight lines, so the foot is square.
    expect(d).toContain('L38,160');
    expect(d).toContain('Z');
  });

  it('clamps the radius so a thin or short bar cannot invert', () => {
    expect(roundedTopBarPath(0, 0, 2, 50, 4)).toContain('Q0,0 1,0');
    expect(roundedTopBarPath(0, 0, 28, 1, 4)).toContain('Q0,0 1,0');
  });

  it('draws nothing for a zero-height bar', () => {
    expect(roundedTopBarPath(0, 100, 28, 0)).toBe('');
    expect(roundedTopBarPath(0, 100, 0, 40)).toBe('');
  });
});
