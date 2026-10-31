/**
 * Median / nearest-rank p90 tests (BACKLOG-4086)
 *
 * The p90 values for n = 1..20 are hard-coded nearest-rank answers
 * (sorted[ceil(0.9n) - 1] of 1..n), so a floor, round or interpolated index
 * differs at some n and goes red. Input is passed REVERSED so a missing sort
 * also goes red.
 */

import { describe, expect, it } from 'vitest';
import { median, percentileNearestRank } from '../percentiles';

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const reversed = (n: number) => range(n).reverse();

// n:            1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20
const P90 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 18];

describe('p90 nearest rank', () => {
  it.each(range(20))('p90 of 1..%d (reversed input)', (n) => {
    expect(percentileNearestRank(reversed(n), 90)).toBe(P90[n]);
  });

  it('A14 p90(1..10) = 9, p90([7]) = 7, p90([]) = null', () => {
    expect(percentileNearestRank(range(10), 90)).toBe(9);
    expect(percentileNearestRank([7], 90)).toBe(7);
    expect(percentileNearestRank([], 90)).toBeNull();
  });

  it('A15 p90(1..20) = 18; SR R5 p90(1..7) = 7, p90(1..17) = 16', () => {
    expect(percentileNearestRank(range(20), 90)).toBe(18);
    expect(percentileNearestRank(range(7), 90)).toBe(7);
    expect(percentileNearestRank(range(17), 90)).toBe(16);
  });

  it('unsorted, non-integer input', () => {
    expect(percentileNearestRank([619, 53.5, 195, 170, 400.25], 90)).toBe(619);
  });

  it('does not reorder the caller array', () => {
    const v = [3, 1, 2];
    percentileNearestRank(v, 90);
    median(v);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe('median', () => {
  it('A16 even count = mean of the two middles: median([4,1,3,2]) = 2.5', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('odd count, unsorted: median([619, 170, 195]) = 195', () => {
    expect(median([619, 170, 195])).toBe(195);
  });

  it('empty is null; one value is itself', () => {
    expect(median([])).toBeNull();
    expect(median([42])).toBe(42);
  });
});
