/**
 * Saved views and pinned cards — the pure half (BACKLOG-3450 PR 2)
 *
 * Everything here is a plain function call. The RPC wrappers live in
 * `report-views-api.ts` and are exercised by the interaction suite; the
 * database half — that one internal user cannot see another's rows — cannot be
 * reached from vitest at all and ships as SQL under
 * `supabase/tests/backlog-3450/`, founder-run after he applies the migration.
 */

import { describe, expect, it } from 'vitest';
import { buildIphoneSyncReport, type SyncRun } from '../iphone-sync';
import { EMPTY_FILTERS, type RunFilters } from '../iphone-sync-filters';
import {
  cardValue,
  computeMetric,
  FALLBACK_METRIC,
  formatMetricValue,
  functionsFor,
  MAX_PINNED,
  METRIC_COLUMNS,
  parseMetric,
  parseSavedView,
  parseSavedViews,
  parseStoredFilters,
  pinnedViews,
  pinWouldExceedCap,
  REPORT_KEY,
  serializeFilters,
  STORED_FILTER_KEYS,
  viewMatchesState,
  type MetricColumn,
  type MetricFunction,
  type ReportSavedView,
} from '../report-views';
import {
  DERIVED_ROWS,
  FIXTURE_ROWS_24,
  FIXTURE_USERS_24,
  USERS_WITH_A_MISSING_DISPLAY_NAME,
} from './iphone-sync.fixture';

const RUNS: SyncRun[] = buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24).runs;

function view(over: Partial<ReportSavedView> = {}): ReportSavedView {
  return {
    id: 'view-1',
    name: 'A view',
    filters: { ...EMPTY_FILTERS },
    stalledOnly: false,
    metric: { col: 'runs', fn: 'count' },
    pinned: true,
    ...over,
  };
}

describe('computeMetric', () => {
  /**
   * TRANSCRIBED from the same 24 rows the fixture holds, 2026-09-19:
   *
   *   with corpus as (
   *     select *, (select (p->>'elapsed_ms')::numeric
   *                from jsonb_array_elements(phases) p
   *                where p->>'phase' = 'backup:transferring' limit 1) as transfer_ms
   *     from sync_outcomes
   *     where source = 'iphone-backup' and outcome <> 'running'
   *       and created_at < '2026-09-19T00:00:00Z'     -- the fixture's corpus, 24 rows
   *   ), r as (
   *     select elapsed_ms/60000.0 as minutes, backup_bytes/1000000000.0 as backup_gb,
   *            device_used_bytes/1000000000.0 as device_gb, messages_extracted,
   *            case when backup_bytes > 0 and transfer_ms > 0
   *                   then (backup_bytes/1048576.0)/(transfer_ms/1000.0)
   *                 when backup_bytes > 0 and elapsed_ms > 0
   *                   then (backup_bytes/1048576.0)/(elapsed_ms/1000.0) end as rate
   *     from corpus
   *   )
   *   select count(*), count(minutes), avg(minutes), sum(minutes), min(minutes), max(minutes),
   *          count(backup_gb), avg(backup_gb), …  from r;
   *
   * The GB divisor is 1 000 000 000, not 1 GiB — founder QA 2026-09-19: his
   * phone reads 58.1 GB in iOS Settings where the card said 54.1. Rate keeps
   * MiB; see the note on BYTES_PER_MB for why the two differ.
   *
   * The counts differ per column ON PURPOSE and are the point of the table:
   * 24 rows, but only 6 wrote a backup figure, only 4 measured a rate, only 4
   * extracted messages and only 20 reported device usage. A `count` here is
   * "how many runs HAVE this", not the run count.
   */
  const EXPECTED: Record<MetricColumn, Partial<Record<MetricFunction, number>>> = {
    runs: { count: 24 },
    duration: { count: 24, average: 22.665, sum: 543.9604, min: 0.0371, max: 181.6933 },
    backup: { count: 6, average: 43.5398, sum: 261.239, min: 0, max: 122.1319 },
    rate: { count: 4, average: 24.6397, sum: 98.5586, min: 21.1419, max: 27.3692 },
    messages: { count: 4, average: 110097.75, sum: 440391, min: 2592, max: 232940 },
    deviceUsed: { count: 20, average: 48.6729, sum: 973.4586, min: 20.6602, max: 70.8045 },
  };

  it('reproduces every column x function against the transcribed 24 rows', () => {
    expect(RUNS).toHaveLength(24);
    for (const col of Object.keys(EXPECTED) as MetricColumn[]) {
      for (const [fn, expected] of Object.entries(EXPECTED[col]) as [MetricFunction, number][]) {
        const actual = computeMetric(RUNS, { col, fn });
        expect(actual, `${col} / ${fn}`).not.toBeNull();
        expect(actual as number, `${col} / ${fn}`).toBeCloseTo(expected, 3);
      }
    }
  });

  it('counts how many runs HAVE a value, which is not the run count', () => {
    // If `count` counted rows rather than values, all six would read 24 and
    // the whole table above would collapse into one number.
    expect(computeMetric(RUNS, { col: 'rate', fn: 'count' })).toBe(4);
    expect(computeMetric(RUNS, { col: 'backup', fn: 'count' })).toBe(6);
    expect(computeMetric(RUNS, { col: 'runs', fn: 'count' })).toBe(24);
  });

  it('SKIPS nulls rather than reading them as zero', () => {
    // Rate is null on 20 of 24. Under `?? 0` the average would be
    // 98.5586 / 24 = 4.11, a number that describes nothing.
    expect(computeMetric(RUNS, { col: 'rate', fn: 'average' })).toBeCloseTo(24.6397, 3);
    expect(computeMetric(RUNS, { col: 'rate', fn: 'min' })).toBeCloseTo(21.1419, 3);
  });

  it('returns NULL, not 0, when no run in the set has a value', () => {
    const noBackups = RUNS.filter((r) => r.rateMbPerSec == null);
    expect(noBackups.length).toBeGreaterThan(0);
    expect(computeMetric(noBackups, { col: 'rate', fn: 'average' })).toBeNull();
    expect(computeMetric(noBackups, { col: 'rate', fn: 'sum' })).toBeNull();
    expect(computeMetric(noBackups, { col: 'rate', fn: 'min' })).toBeNull();
    expect(computeMetric(noBackups, { col: 'rate', fn: 'max' })).toBeNull();
    // A count of nothing is honestly zero — it is the only one that is.
    expect(computeMetric(noBackups, { col: 'rate', fn: 'count' })).toBe(0);
    expect(computeMetric([], { col: 'duration', fn: 'average' })).toBeNull();
  });

  it('formats a null as an em dash and never as 0', () => {
    expect(formatMetricValue(null, { col: 'rate', fn: 'average' })).toBe('—');
    expect(formatMetricValue(24.6397, { col: 'rate', fn: 'average' })).toBe('24.6 MB/s');
    expect(formatMetricValue(22.665, { col: 'duration', fn: 'average' })).toBe('22.7 min');
    expect(formatMetricValue(440391, { col: 'messages', fn: 'sum' })).toBe('440,391');
    // A count is a plain integer whatever column it counts.
    expect(formatMetricValue(4, { col: 'rate', fn: 'count' })).toBe('4');
  });

  it('offers COUNT and nothing else for the Runs column', () => {
    expect(functionsFor('runs')).toEqual(['count']);
    expect(functionsFor('rate')).toEqual(['count', 'average', 'sum', 'min', 'max']);
  });
});

describe('cardValue', () => {
  it('applies the card OWN filters, not the page`s', () => {
    const errorsOnly = view({
      filters: { ...EMPTY_FILTERS, outcomes: ['error'] },
      metric: { col: 'runs', fn: 'count' },
    });
    const errorRuns = RUNS.filter((r) => r.outcome === 'error').length;
    expect(errorRuns).toBeGreaterThan(0);
    expect(errorRuns).toBeLessThan(RUNS.length);
    expect(cardValue(RUNS, errorsOnly)).toBe(errorRuns);
  });

  it('narrows to stalled runs when the view saved the stalled tile', () => {
    const stalled = view({ stalledOnly: true, metric: { col: 'runs', fn: 'count' } });
    const stalledRuns = RUNS.filter((r) => r.stalled).length;
    expect(stalledRuns).toBeGreaterThan(0);
    expect(cardValue(RUNS, stalled)).toBe(stalledRuns);
    expect(cardValue(RUNS, view())).toBe(24);
  });

  it('moves when the rows it is handed change, because that is how it follows the period', () => {
    const firstHalf = RUNS.slice(0, 10);
    expect(cardValue(RUNS, view())).toBe(24);
    expect(cardValue(firstHalf, view())).toBe(10);
  });
});

describe('the stored blob', () => {
  it('carries EXACTLY the five filter keys and nothing else', () => {
    const filters: RunFilters = {
      types: ['first'],
      outcomes: ['error'],
      platforms: ['darwin'],
      search: '  Sync user A  ',
      };
    const stored = serializeFilters(filters, true);
    // Identity, not a subset check: a sixth key riding along is the failure.
    expect(Object.keys(stored).sort()).toEqual([...STORED_FILTER_KEYS].sort());
    expect(stored.search).toBe('Sync user A');
    expect(stored.stalledOnly).toBe(true);
  });

  it('carries NO email, even when the page was showing a user who has no display name', () => {
    // DERIVED user: `userLabel` falls back to the email, so a leaked user
    // label WOULD put an `@` in the payload. Against FIXTURE_USERS_24, where
    // everyone has a display name, this assertion could not fail.
    const model = buildIphoneSyncReport(
      [DERIVED_ROWS.zeroBackupBytes],
      USERS_WITH_A_MISSING_DISPLAY_NAME
    );
    expect(model.runs[0].userLabel).toContain('@');

    const stored = serializeFilters({ ...EMPTY_FILTERS, platforms: ['darwin'] }, false);
    expect(JSON.stringify(stored)).not.toContain('@');
    expect(Object.keys(stored).sort()).toEqual([...STORED_FILTER_KEYS].sort());
  });

  it('does not store the period — a card follows the selector, it does not fight it', () => {
    const stored = serializeFilters(EMPTY_FILTERS, false) as unknown as Record<string, unknown>;
    expect(stored.period).toBeUndefined();
    expect(stored.fromIso).toBeUndefined();
    expect(stored.toIso).toBeUndefined();
  });
});

describe('parseStoredFilters — defensive on read', () => {
  it('reads a well-formed blob back unchanged', () => {
    const parsed = parseStoredFilters({
      types: ['first', 'unknown'],
      outcomes: ['error'],
      platforms: ['darwin'],
      search: 'user a',
      stalledOnly: true,
    });
    expect(parsed.filters.types).toEqual(['first', 'unknown']);
    expect(parsed.filters.outcomes).toEqual(['error']);
    expect(parsed.stalledOnly).toBe(true);
  });

  it('a STRING where an array belongs applies no filter instead of throwing', () => {
    // SR change 13's case verbatim.
    const parsed = parseStoredFilters({ types: 'first' });
    expect(parsed.filters.types).toEqual([]);
    expect(applyCount(parsed.filters)).toBe(24);
  });

  it('drops an unknown sync type rather than filtering everything away', () => {
    const parsed = parseStoredFilters({ types: ['first', 'sideways'] });
    expect(parsed.filters.types).toEqual(['first']);
  });

  it('survives null, a string, an array and a missing key', () => {
    for (const raw of [null, undefined, 'nonsense', [1, 2, 3], {}, 42]) {
      const parsed = parseStoredFilters(raw);
      expect(parsed.filters).toEqual(EMPTY_FILTERS);
      expect(parsed.stalledOnly).toBe(false);
    }
  });

  it('caps a runaway search string', () => {
    const parsed = parseStoredFilters({ search: 'x'.repeat(400) });
    expect(parsed.filters.search).toHaveLength(120);
  });

  function applyCount(filters: RunFilters): number {
    return cardValue(RUNS, view({ filters }))!;
  }
});

describe('parseMetric and parseSavedView', () => {
  it('falls back to count · Runs rather than throwing on a hand-edited row', () => {
    expect(parseMetric(null)).toEqual(FALLBACK_METRIC);
    expect(parseMetric({ col: 'nope', fn: 'average' })).toEqual(FALLBACK_METRIC);
    expect(parseMetric('rate')).toEqual(FALLBACK_METRIC);
  });

  it('forces a function the column does not offer back to one it does', () => {
    // `runs` offers count alone, so a stored "average" cannot be honoured.
    expect(parseMetric({ col: 'runs', fn: 'average' })).toEqual({ col: 'runs', fn: 'count' });
    expect(parseMetric({ col: 'rate', fn: 'average' })).toEqual({ col: 'rate', fn: 'average' });
  });

  it('drops a row with no id and keeps the rest', () => {
    const rows = [
      { id: 'a', name: 'Errors', filters: {}, metric: { col: 'runs', fn: 'count' }, pinned: true },
      { name: 'No id', filters: {}, metric: {}, pinned: true },
      null,
    ];
    const parsed = parseSavedViews(rows);
    expect(parsed.map((v) => v.id)).toEqual(['a']);
    expect(parseSavedView('not a row')).toBeNull();
    expect(parseSavedViews('not an array')).toEqual([]);
  });

  it('names an unnamed view rather than rendering a blank card', () => {
    const parsed = parseSavedView({ id: 'a', filters: {}, metric: {}, pinned: false });
    expect(parsed?.name).toBe('Untitled view');
  });
});

describe('the pin cap', () => {
  const five = Array.from({ length: MAX_PINNED }, (_, i) =>
    view({ id: `v${i}`, name: `View ${i}`, pinned: true })
  );

  it('refuses a sixth pin', () => {
    expect(MAX_PINNED).toBe(5);
    expect(pinWouldExceedCap(five)).toBe(true);
    expect(pinWouldExceedCap(five.slice(0, 4))).toBe(false);
  });

  it('does not count the view being re-saved against itself', () => {
    // Renaming or re-saving an already-pinned card must not refuse itself.
    expect(pinWouldExceedCap(five, 'v0')).toBe(false);
  });

  it('renders at most five cards even if a sixth row somehow exists', () => {
    const six = [...five, view({ id: 'v5', name: 'View 5', pinned: true })];
    // The literal 5, not MAX_PINNED: an assertion written against the constant
    // it is checking cannot notice the constant moving.
    expect(pinnedViews(six)).toHaveLength(5);
    expect(pinnedViews([...five, view({ id: 'u', pinned: false })])).toHaveLength(5);
  });
});

describe('viewMatchesState — which card is active', () => {
  const errorsOnly = view({ filters: { ...EMPTY_FILTERS, outcomes: ['error'] } });

  it('matches regardless of the order the values were selected in', () => {
    const two = view({ filters: { ...EMPTY_FILTERS, outcomes: ['error', 'cancelled'] } });
    expect(viewMatchesState(two, { ...EMPTY_FILTERS, outcomes: ['cancelled', 'error'] }, false)).toBe(
      true
    );
  });

  it('is false while the page shows anything else', () => {
    expect(viewMatchesState(errorsOnly, EMPTY_FILTERS, false)).toBe(false);
    expect(viewMatchesState(errorsOnly, { ...EMPTY_FILTERS, outcomes: ['error'] }, false)).toBe(true);
    // The stalled tile is part of the view, so toggling it un-matches.
    expect(viewMatchesState(errorsOnly, { ...EMPTY_FILTERS, outcomes: ['error'] }, true)).toBe(false);
  });
});

describe('the report key and the column list', () => {
  it('names this report and offers the six columns the mockup lists', () => {
    expect(REPORT_KEY).toBe('iphone-sync');
    expect(METRIC_COLUMNS.map((c) => c.value)).toEqual([
      'runs',
      'duration',
      'backup',
      'rate',
      'messages',
      'deviceUsed',
    ]);
  });
});
