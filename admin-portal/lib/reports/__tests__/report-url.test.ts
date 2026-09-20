/**
 * Report URL state (BACKLOG-3450)
 *
 * The control that matters here is the one on `buildPeriodUrl`: changing the
 * period must not silently reset the filters beside it. A fresh
 * `URLSearchParams()` instead of a copy produces a page where the period works
 * and everything else quietly clears, which no rendering test would notice.
 */

import { describe, expect, it } from 'vitest';
import {
  applyClientState,
  buildPeriodUrl,
  parseClientState,
  parseRunFilters,
  parseSort,
  parseStalledOnly,
} from '../report-url';

describe('buildPeriodUrl', () => {
  const current = 'type=first&outcome=error,cancelled&platform=win32&q=user+f&sort=rate&dir=asc&stalled=1';

  it('KEEPS every other filter when the period changes', () => {
    const url = buildPeriodUrl(current, 'last-month');
    const params = new URLSearchParams(url.slice(1));
    expect(params.get('period')).toBe('last-month');
    expect(params.get('type')).toBe('first');
    expect(params.get('outcome')).toBe('error,cancelled');
    expect(params.get('platform')).toBe('win32');
    expect(params.get('q')).toBe('user f');
    expect(params.get('sort')).toBe('rate');
    expect(params.get('dir')).toBe('asc');
    expect(params.get('stalled')).toBe('1');
  });

  it('omits the param entirely for the default period', () => {
    const params = new URLSearchParams(buildPeriodUrl(current, 'week').slice(1));
    expect(params.has('period')).toBe(false);
    expect(params.get('type')).toBe('first');
  });

  it('carries the custom dates, and clears them when leaving custom', () => {
    const custom = buildPeriodUrl('', 'custom', '2026-09-01', '2026-09-18');
    expect(custom).toContain('period=custom');
    expect(custom).toContain('from=2026-09-01');
    expect(custom).toContain('to=2026-09-18');

    const back = new URLSearchParams(buildPeriodUrl(custom.slice(1), '48h').slice(1));
    expect(back.get('period')).toBe('48h');
    expect(back.has('from')).toBe(false);
    expect(back.has('to')).toBe(false);
  });
});

describe('parsing the client state back out of the URL', () => {
  it('round-trips a full state', () => {
    const state = {
      filters: { types: ['first' as const], outcomes: ['error'], platforms: ['win32'], search: 'user f' },
      sortKey: 'rate' as const,
      sortDirection: 'asc' as const,
      stalledOnly: true,
    };
    const written = applyClientState(new URLSearchParams('period=48h'), state);
    expect(written.get('period')).toBe('48h');
    expect(parseClientState(Object.fromEntries(written))).toEqual(state);
  });

  it('drops defaults from the URL rather than writing them out', () => {
    const written = applyClientState(new URLSearchParams(), {
      filters: { types: [], outcomes: [], platforms: [], search: '  ' },
      sortKey: 'when',
      sortDirection: 'desc',
      stalledOnly: false,
    });
    expect(written.toString()).toBe('');
  });

  it('ignores an unknown sync type instead of filtering everything away', () => {
    expect(parseRunFilters({ type: 'first,wat,incremental' }).types).toEqual(['first', 'incremental']);
    expect(parseRunFilters({ type: 'wat' }).types).toEqual([]);
  });

  it('de-duplicates and trims', () => {
    expect(parseRunFilters({ outcome: ' error , error ,cancelled' }).outcomes).toEqual([
      'error',
      'cancelled',
    ]);
  });

  it('takes the first value when a param is repeated', () => {
    expect(parseRunFilters({ q: ['alpha', 'beta'] }).search).toBe('alpha');
  });

  it('caps the search so a pathological URL cannot reach the predicate', () => {
    expect(parseRunFilters({ q: 'x'.repeat(5000) }).search).toHaveLength(120);
  });

  it('falls back to newest-first for an unknown sort key', () => {
    expect(parseSort({ sort: 'destroy' })).toEqual({ key: 'when', direction: 'desc' });
    expect(parseSort({})).toEqual({ key: 'when', direction: 'desc' });
  });

  it('opens a numeric column descending and a text column ascending', () => {
    expect(parseSort({ sort: 'rate' }).direction).toBe('desc');
    expect(parseSort({ sort: 'user' }).direction).toBe('asc');
    expect(parseSort({ sort: 'rate', dir: 'asc' }).direction).toBe('asc');
    expect(parseSort({ sort: 'rate', dir: 'sideways' }).direction).toBe('desc');
  });

  it('treats the stalled tile as off unless it is explicitly on', () => {
    expect(parseStalledOnly({})).toBe(false);
    expect(parseStalledOnly({ stalled: 'true' })).toBe(false);
    expect(parseStalledOnly({ stalled: '1' })).toBe(true);
  });
});
