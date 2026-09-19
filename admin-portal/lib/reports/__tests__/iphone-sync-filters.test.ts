/**
 * Filtering, sorting and counting (BACKLOG-3450)
 *
 * Sorting is asserted on the FULL id sequence in both directions, not on the
 * first element and not on a length — a partial sort satisfies `[0]`, and a
 * count cannot tell ascending from descending.
 */

import { describe, expect, it } from 'vitest';
import { buildIphoneSyncReport, type SyncRun } from '../iphone-sync';
import {
  activeFilterNames,
  applyFilters,
  computeCounts,
  defaultDirectionFor,
  EMPTY_FILTERS,
  hasActiveFilters,
  nextVisibleCount,
  SORT_KEYS,
  sortRuns,
  type SortKey,
} from '../iphone-sync-filters';
import {
  DERIVED_ROWS,
  FIXTURE_ROWS_24,
  FIXTURE_USERS_24,
  RATE_ROW_IDS,
  ROW_IDS,
} from './iphone-sync.fixture';

const RUNS: SyncRun[] = buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24).runs;

describe('the filter predicate', () => {
  it('starts from all 24 finished runs', () => {
    expect(applyFilters(RUNS, EMPTY_FILTERS)).toHaveLength(24);
  });

  it('filters by type, and multi-select is a UNION not an intersection', () => {
    const first = applyFilters(RUNS, { ...EMPTY_FILTERS, types: ['first'] });
    const incremental = applyFilters(RUNS, { ...EMPTY_FILTERS, types: ['incremental'] });
    const both = applyFilters(RUNS, { ...EMPTY_FILTERS, types: ['first', 'incremental'] });
    expect(first).toHaveLength(5);
    expect(incremental).toHaveLength(8);
    expect(both).toHaveLength(13);
  });

  it('filters by outcome and by platform', () => {
    expect(applyFilters(RUNS, { ...EMPTY_FILTERS, outcomes: ['complete'] })).toHaveLength(4);
    expect(applyFilters(RUNS, { ...EMPTY_FILTERS, outcomes: ['error', 'cancelled'] })).toHaveLength(20);
    expect(applyFilters(RUNS, { ...EMPTY_FILTERS, platforms: ['darwin'] })).toHaveLength(2);
    expect(applyFilters(RUNS, { ...EMPTY_FILTERS, platforms: ['win32'] })).toHaveLength(22);
  });

  it('combines filters with AND across fields', () => {
    const both = applyFilters(RUNS, { ...EMPTY_FILTERS, outcomes: ['complete'], platforms: ['darwin'] });
    expect(both).toHaveLength(0);
  });

  it('searches the user LABEL, case-insensitively, and nothing else', () => {
    expect(applyFilters(RUNS, { ...EMPTY_FILTERS, search: 'sync user f' })).toHaveLength(7);
    expect(applyFilters(RUNS, { ...EMPTY_FILTERS, search: 'SYNC USER F' })).toHaveLength(7);
    expect(applyFilters(RUNS, { ...EMPTY_FILTERS, search: '  user h  ' })).toHaveLength(1);
    // An email is not on the model at all, so it cannot match.
    expect(applyFilters(RUNS, { ...EMPTY_FILTERS, search: 'example.test' })).toHaveLength(0);
  });

  it('searches the user and NOTHING ELSE on the run', () => {
    // Each of these matches most rows if the search widens past `userLabel` —
    // a device model, an outcome, a platform and an app version are all on
    // every run. The placeholder says "Search by user"; this holds it to that.
    for (const needle of ['iPhone17', 'cancelled', 'win32', '2.37.0', 'backup:transferring']) {
      expect(applyFilters(RUNS, { ...EMPTY_FILTERS, search: needle })).toHaveLength(0);
    }
  });

  it('ships NO email to the browser for a user who has a display name', () => {
    // BACKLOG-3450 Q5: `analytics.view` is held by roles without `users.view`,
    // so an email per row would widen who can read one. `userLabel` already
    // falls back to the email when there is no display name — every fixture
    // user has one, so not a single address may appear in the model.
    const serialized = JSON.stringify(
      buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24)
    );
    for (const user of FIXTURE_USERS_24) {
      expect(user.display_name).toBeTruthy();
      expect(user.email).toBeTruthy();
      expect(serialized).not.toContain(user.email as string);
    }
    expect(serialized).not.toContain('@');
  });

  it('knows whether anything is active, and can name it', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, search: '  ' })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, types: ['first'] })).toBe(true);
    expect(activeFilterNames({ ...EMPTY_FILTERS, outcomes: ['error'], search: 'a' })).toEqual([
      'outcome: error',
      'user matching "a"',
    ]);
  });
});

describe('the counts follow whatever set they are handed', () => {
  it('counts the whole corpus', () => {
    expect(computeCounts(RUNS)).toEqual({
      finished: 24,
      complete: 4,
      cancelled: 7,
      error: 13,
      stalled: 5,
    });
  });

  it('counts the FILTERED set, not the corpus', () => {
    const filtered = applyFilters(RUNS, { ...EMPTY_FILTERS, outcomes: ['cancelled'] });
    const counts = computeCounts(filtered);
    expect(counts.finished).toBe(7);
    expect(counts.complete).toBe(0);
    expect(counts.error).toBe(0);
    expect(counts.stalled).toBeLessThan(5);
  });

  it('counts nothing as zero rather than as absent', () => {
    expect(computeCounts([])).toEqual({ finished: 0, complete: 0, cancelled: 0, error: 0, stalled: 0 });
  });
});

describe('sorting', () => {
  const ids = (runs: SyncRun[]) => runs.map((r) => r.id);

  it('reverses exactly on direction, for every one of the ten columns', () => {
    for (const key of SORT_KEYS) {
      const asc = ids(sortRuns(RUNS, key, 'asc'));
      const desc = ids(sortRuns(RUNS, key, 'desc'));
      expect(asc).toHaveLength(24);
      expect(new Set(asc)).toEqual(new Set(desc));
      // Not merely "different": the two orders must disagree somewhere.
      expect(asc).not.toEqual(desc);
    }
  });

  it('puts NULLS LAST in BOTH directions — Rate, on 20 null rows of 24', () => {
    for (const direction of ['asc', 'desc'] as const) {
      const sorted = sortRuns(RUNS, 'rate', direction);
      const firstNull = sorted.findIndex((r) => r.rateMbPerSec == null);
      const lastValue = sorted.map((r) => r.rateMbPerSec).lastIndexOf(
        sorted.filter((r) => r.rateMbPerSec != null).slice(-1)[0]?.rateMbPerSec ?? null
      );
      expect(firstNull).toBe(4); // the four rows with a rate come first
      expect(lastValue).toBeLessThan(firstNull + 1);
      expect(sorted.slice(4).every((r) => r.rateMbPerSec == null)).toBe(true);
    }
  });

  it('orders the four rated runs by value, both ways, by identity', () => {
    const asc = ids(sortRuns(RUNS, 'rate', 'asc')).slice(0, 4);
    const desc = ids(sortRuns(RUNS, 'rate', 'desc')).slice(0, 4);
    // 21.14 < 22.76 < 27.29 < 27.37
    expect(asc).toEqual([...RATE_ROW_IDS]);
    expect(desc).toEqual([...asc].reverse());
  });

  it('puts the unrecorded Type last, not first, in both directions', () => {
    for (const direction of ['asc', 'desc'] as const) {
      const sorted = sortRuns(RUNS, 'type', direction);
      expect(sorted.slice(-11).every((r) => r.syncType === 'unknown')).toBe(true);
    }
  });

  it('sorts When with Date.parse — a WHOLE-SECOND timestamp proves it', () => {
    // '2026-09-14T20:21:43Z' and '2026-09-14T20:21:43.803Z' compare the WRONG
    // way round under `<`: '.' sorts before 'Z'. Newest-first must put the
    // .803 row ABOVE the whole-second one.
    const rows = [DERIVED_ROWS.wholeSecondTimestamp, ...FIXTURE_ROWS_24];
    const runs = buildIphoneSyncReport(rows, FIXTURE_USERS_24).runs;
    const sorted = ids(sortRuns(runs, 'when', 'desc'));
    const whole = sorted.indexOf(DERIVED_ROWS.wholeSecondTimestamp.id);
    const fractional = sorted.indexOf(ROW_IDS.fractionalTimestamp);
    expect(whole).toBeGreaterThan(-1);
    expect(fractional).toBeGreaterThan(-1);
    expect(fractional).toBeLessThan(whole);
  });

  it('defaults numeric columns to descending and text columns to ascending', () => {
    const expected: Record<SortKey, string> = {
      when: 'desc', duration: 'desc', backup: 'desc', rate: 'desc', messages: 'desc',
      user: 'asc', platform: 'asc', version: 'asc', outcome: 'asc', type: 'asc',
    };
    for (const key of SORT_KEYS) {
      expect(defaultDirectionFor(key)).toBe(expected[key]);
    }
  });

  it('never drops or duplicates a row', () => {
    for (const key of SORT_KEYS) {
      for (const direction of ['asc', 'desc'] as const) {
        expect(new Set(ids(sortRuns(RUNS, key, direction))).size).toBe(24);
      }
    }
  });
});

describe('show more', () => {
  it('adds exactly five', () => {
    expect(nextVisibleCount(5)).toBe(10);
    expect(nextVisibleCount(10)).toBe(15);
  });
});
