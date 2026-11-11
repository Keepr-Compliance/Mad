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
  bucketByDay,
  durationTooltipLines,
  failureTooltipLines,
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

// The bar geometry (layout, gridlines, label thinning, the stack gap, the
// rounded-top path) moved to the @keepr/ui chart kit with BACKLOG-4208 and is
// tested there (packages/ui/src/components/chart/scale.test.ts). What stays
// here is what the charts are drawn FROM: the per-day buckets.

describe('what the duration chart is drawn from', () => {
  const buckets = bucketByDay(RUNS, THIS_WEEK);

  it('leaves the average NULL (no bar) for a day with no runs', () => {
    expect(buckets).toHaveLength(6);
    expect(buckets[5].averageMinutes).toBeNull();
  });

  it('peaks at the tallest day', () => {
    const averages = buckets.map((b) => b.averageMinutes).filter((v): v is number => v != null);
    expect(Math.max(...averages)).toBeCloseTo(181.7, 1);
  });

  it('is empty-safe', () => {
    const empty = bucketByDay([], THIS_WEEK);
    expect(empty).toHaveLength(6);
    expect(empty.every((b) => b.averageMinutes === null)).toBe(true);
  });
});

describe('what the failure chart is drawn from', () => {
  const buckets = bucketByDay(RUNS, THIS_WEEK);

  it('counts errors and cancels per day', () => {
    expect(buckets.map((b) => b.errors + b.cancelled)).toEqual([8, 5, 1, 2, 4, 0]);
    expect(buckets[0].errors).toBe(5);
    expect(buckets[0].cancelled).toBe(3);
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
