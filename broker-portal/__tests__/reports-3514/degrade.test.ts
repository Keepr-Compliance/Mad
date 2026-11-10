/**
 * C7 (BACKLOG-3514): a stored view is read against what the report offers
 * today. Unknown or malformed keys are stripped before any query, named in
 * `dropped`, and nothing throws.
 *
 * @jest-environment node
 */

import type { ReportSavedViewSpec } from '@/lib/reports/registry';
import { degradeView, serializeViewState, viewMatchesState } from '@/lib/reports/saved-views/degrade';

const SPEC: ReportSavedViewSpec = {
  filterKeys: ['status', 'agent', 'stalled', 'minDays'],
  sortKeys: ['closedAt', 'price'],
  metricColumns: ['deals', 'price'],
};

describe('degradeView', () => {
  it('keeps every known key of the right shape, drops nothing', () => {
    const v = degradeView(
      { filters: { status: ['open', 'closed'], agent: 'a-1', stalled: true, minDays: 3 }, sort: { key: 'price', direction: 'desc' } },
      { col: 'deals', fn: 'count' },
      SPEC
    );
    expect(v).toEqual({
      filters: { status: ['open', 'closed'], agent: 'a-1', stalled: true, minDays: 3 },
      sort: { key: 'price', direction: 'desc' },
      metric: { col: 'deals', fn: 'count' },
      dropped: [],
    });
  });

  it('strips a filter key the report no longer offers BEFORE the query, and names it', () => {
    const v = degradeView({ filters: { status: 'open', removedColumn: 'x' } }, null, SPEC);
    expect(Object.keys(v.filters)).toEqual(['status']);
    expect(v.filters).not.toHaveProperty('removedColumn');
    expect(v.dropped).toEqual(['filter removedColumn']);
  });

  it('strips an unknown sort key and an unknown metric column', () => {
    const v = degradeView({ sort: { key: 'gone', direction: 'asc' } }, { col: 'goneMetric', fn: 'sum' }, SPEC);
    expect(v.sort).toBeNull();
    expect(v.metric).toBeNull();
    expect(v.dropped).toEqual(['sort gone', 'metric column goneMetric']);
  });

  // Malformed rows: what jsonb can hold that the page cannot use.
  it.each<[string, unknown, unknown, string[]]>([
    ['filters value is an object', { filters: { status: { $ne: 1 } } }, null, ['filter status']],
    ['filters value is null', { filters: { agent: null } }, null, ['filter agent']],
    ['filters value is a mixed array', { filters: { status: ['open', 3] } }, null, ['filter status']],
    ['filters value is NaN-like', { filters: { minDays: Number.POSITIVE_INFINITY } }, null, ['filter minDays']],
    ['filters is an array', { filters: ['status'] }, null, ['filters']],
    ['filters is a string', { filters: 'status=open' }, null, ['filters']],
    ['whole blob is an array', [1, 2], null, ['filters']],
    ['whole blob is a number', 42, null, ['filters']],
    ['sort direction invalid', { sort: { key: 'price', direction: 'up' } }, null, ['sort price']],
    ['sort is a string', { sort: 'price' }, null, ['sort']],
    ['metric fn invalid', {}, { col: 'deals', fn: 'median' }, ['metric column deals']],
    ['metric is a string', {}, 'deals', ['metric']],
    ['metric col not a string', {}, { col: 7, fn: 'count' }, ['metric']],
  ])('%s: stripped, named, no throw', (_name, filters, metric, dropped) => {
    let v: ReturnType<typeof degradeView> | undefined;
    expect(() => {
      v = degradeView(filters, metric, SPEC);
    }).not.toThrow();
    expect(v?.dropped).toEqual(dropped);
    for (const key of Object.keys(v?.filters ?? {})) expect(SPEC.filterKeys).toContain(key);
  });

  it('null and missing columns mean an empty view, nothing dropped', () => {
    expect(degradeView(null, null, SPEC)).toEqual({ filters: {}, sort: null, metric: null, dropped: [] });
    expect(degradeView({}, undefined, SPEC)).toEqual({ filters: {}, sort: null, metric: null, dropped: [] });
  });
});

describe('serializeViewState', () => {
  it('saves only keys the report offers', () => {
    expect(
      serializeViewState({ filters: { status: 'open', stray: 'x' }, sort: { key: 'nope', direction: 'asc' } }, SPEC)
    ).toEqual({ filters: { status: 'open' }, sort: null });
  });
});

describe('viewMatchesState', () => {
  it('compares filters as sets and the sort exactly', () => {
    const a = { filters: { status: ['a', 'b'] }, sort: { key: 'price', direction: 'asc' as const } };
    expect(viewMatchesState(a, { filters: { status: ['b', 'a'] }, sort: { key: 'price', direction: 'asc' } })).toBe(true);
    expect(viewMatchesState(a, { filters: { status: ['b', 'a'] }, sort: { key: 'price', direction: 'desc' } })).toBe(false);
    expect(viewMatchesState(a, { filters: { status: ['a'] }, sort: a.sort })).toBe(false);
    expect(viewMatchesState(a, { filters: { status: ['a', 'b'], agent: 'x' }, sort: a.sort })).toBe(false);
  });
});
