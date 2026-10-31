/**
 * Which saved view a report opens with (BACKLOG-4084)
 *
 * The likely wrong implementation is a default that overrides a link: a
 * shared URL, or a period the user just picked. Each explicit key is swept
 * ALONE, so dropping any one of them from the check reds a named case.
 */

import { describe, expect, it } from 'vitest';
import { applyClientState, DEFAULT_CLIENT_STATE } from '../report-url';
import {
  hasExplicitState,
  IPHONE_SYNC_URL_KEYS,
  PERIOD_URL_KEYS,
  resolveInitialView,
} from '../default-view';

const VIEWS = [
  { id: 'v-a', name: 'Same name', isDefault: false },
  { id: 'v-b', name: 'Same name', isDefault: true },
  { id: 'v-c', name: 'Other', isDefault: false },
];

describe('resolveInitialView', () => {
  it('opens the default view on a URL that names nothing', () => {
    expect(resolveInitialView({ params: {}, views: VIEWS })?.id).toBe('v-b');
  });

  it('ignores unrelated params', () => {
    expect(resolveInitialView({ params: { error: 'x', utm_source: 'y' }, views: VIEWS })?.id).toBe('v-b');
  });

  // Written out, not read from PERIOD_URL_KEYS: a sweep generated from the
  // constant loses its own case when a key is removed from it.
  it('PERIOD_URL_KEYS is exactly period, from, to', () => {
    expect([...PERIOD_URL_KEYS].sort()).toEqual(['from', 'period', 'to']);
  });

  for (const key of ['period', 'from', 'to']) {
    it(`does not apply when the URL names "${key}"`, () => {
      expect(resolveInitialView({ params: { [key]: 'x' }, views: VIEWS })).toBeNull();
    });
  }

  for (const key of IPHONE_SYNC_URL_KEYS) {
    it(`iPhone sync: does not apply when the URL names "${key}"`, () => {
      expect(resolveInitialView({ params: { [key]: 'x' }, reportKeys: IPHONE_SYNC_URL_KEYS, views: VIEWS })).toBeNull();
    });
  }

  it('an empty value is still explicit', () => {
    expect(resolveInitialView({ params: { period: '' }, views: VIEWS })).toBeNull();
  });

  it('no default, or views that could not be read, open nothing', () => {
    expect(resolveInitialView({ params: {}, views: VIEWS.map((v) => ({ ...v, isDefault: false })) })).toBeNull();
    expect(resolveInitialView({ params: {}, views: [] })).toBeNull();
    expect(resolveInitialView({ params: {}, views: null })).toBeNull();
  });

  it('a report key list only counts for that report', () => {
    expect(hasExplicitState({ type: 'first' })).toBe(false);
    expect(hasExplicitState({ type: 'first' }, IPHONE_SYNC_URL_KEYS)).toBe(true);
  });
});

describe('IPHONE_SYNC_URL_KEYS is exactly what applyClientState writes', () => {
  it('a state with every key set writes those keys and no others', () => {
    const params = applyClientState(new URLSearchParams(), {
      filters: { types: ['first'], outcomes: ['error'], platforms: ['win32'], search: 'x' },
      sortKey: 'rate',
      sortDirection: DEFAULT_CLIENT_STATE.sortDirection === 'desc' ? 'asc' : 'desc',
      stalledOnly: true,
    });
    expect([...params.keys()].sort()).toEqual([...IPHONE_SYNC_URL_KEYS].sort());
  });
});
