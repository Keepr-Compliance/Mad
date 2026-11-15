/**
 * BACKLOG-4219 PR3 (A4): the admin portal's Wilson copy equals the desktop original.
 *
 * Both are called with (k, n) ONLY, so each uses its own default z: passing z here would hide a
 * wrong Z_95 constant in the copy. A z = 1.96 copy differs from the original in only 8 cells of
 * the 0 <= k <= n <= 60 grid, so the whole grid is swept, plus large-n points and every input the
 * function refuses.
 */

import { describe, expect, it } from 'vitest';

import { wilsonInterval as original } from '../../../electron/services/learn/wilson';
import { wilsonInterval as copy } from '@/lib/learn-pilot/wilson';

const GRID: [number, number][] = [];
for (let n = 0; n <= 60; n++) for (let k = 0; k <= n; k++) GRID.push([k, n]);

const EXTRAS: [number, number][] = [
  [1, 1000],
  [999, 1000],
  [0, 1e7],
  [1e7, 1e7],
  [5, 0],
  [-1, 5],
  [6, 5],
  [1, -1],
  [Number.NaN, 5],
  [1, Number.NaN],
  [Number.POSITIVE_INFINITY, 5],
];

describe('A4 Wilson copy == electron/services/learn/wilson.ts', () => {
  it('the grid has 1,891 cells', () => {
    expect(GRID).toHaveLength(1891);
  });

  it('equal on every cell of the grid and every extra input', () => {
    const differ = [...GRID, ...EXTRAS].filter(([k, n]) => JSON.stringify(copy(k, n)) !== JSON.stringify(original(k, n)));
    expect(differ).toEqual([]);
  });

  it('n = 0 is null in both (no interval)', () => {
    expect(copy(0, 0)).toBeNull();
    expect(original(0, 0)).toBeNull();
  });
});
