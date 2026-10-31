/**
 * The time range a saved view stores (BACKLOG-4084)
 *
 * Every key of every report's set is swept, plus an unknown key and malformed
 * custom dates. The likely wrong implementation (storing resolved ISO bounds,
 * which freezes "This week" at the day it was saved) is caught by the
 * round-trip through a later `now`.
 */

import { describe, expect, it } from 'vitest';
import { ANALYTICS_PERIOD_OPTIONS, resolveAnalyticsPeriod } from '../analytics-period';
import { FUNNEL_PERIOD_OPTIONS, resolveFunnelPeriod } from '../funnel-period';
import { PERIOD_OPTIONS, resolvePeriod } from '../period';
import {
  ANALYTICS_VIEW_PERIODS,
  FUNNEL_VIEW_PERIODS,
  parseViewPeriod,
  serializeViewPeriod,
  SHARED_VIEW_PERIODS,
  viewPeriodMatches,
  viewPeriodParams,
} from '../view-period';

const SAVED_AT = new Date('2026-09-14T10:00:00.000Z'); // a Monday
const MONTH_LATER = new Date('2026-10-14T10:00:00.000Z');

describe('a preset is stored as its key, never as bounds', () => {
  it('serializes exactly { key } for a resolved preset', () => {
    expect(serializeViewPeriod(resolvePeriod({ period: 'week' }, SAVED_AT))).toEqual({ key: 'week' });
    expect(serializeViewPeriod(resolveFunnelPeriod({ period: '7' }, SAVED_AT))).toEqual({ key: '7' });
    expect(serializeViewPeriod(resolveAnalyticsPeriod({ period: 'all' }, SAVED_AT))).toEqual({ key: 'all' });
  });

  it('"This week" saved on one day resolves to a later week when applied later', () => {
    const stored = parseViewPeriod(
      JSON.parse(JSON.stringify(serializeViewPeriod(resolvePeriod({ period: 'week' }, SAVED_AT)))),
      SHARED_VIEW_PERIODS
    );
    expect(stored).toEqual({ key: 'week' });
    const then = resolvePeriod(viewPeriodParams(stored!), SAVED_AT);
    const later = resolvePeriod(viewPeriodParams(stored!), MONTH_LATER);
    expect(later.key).toBe('week');
    expect(later.fromIso).not.toBe(then.fromIso);
    expect(later.fromIso).toBe(resolvePeriod({ period: 'week' }, MONTH_LATER).fromIso);
  });

  it('stores a custom range as its two dates, and applies it unchanged', () => {
    const custom = resolvePeriod({ period: 'custom', from: '2026-09-01', to: '2026-09-10' }, SAVED_AT);
    const stored = serializeViewPeriod(custom);
    expect(stored).toEqual({ key: 'custom', from: '2026-09-01', to: '2026-09-10' });
    const applied = resolvePeriod(viewPeriodParams(parseViewPeriod(stored, SHARED_VIEW_PERIODS)!), MONTH_LATER);
    expect(applied.fromIso).toBe(custom.fromIso);
    expect(applied.toIso).toBe(custom.toIso);
  });
});

describe('reading a stored period back, per report', () => {
  const cases = [
    { name: 'shared', spec: SHARED_VIEW_PERIODS, keys: PERIOD_OPTIONS.map((o) => o.value), custom: true },
    { name: 'funnel', spec: FUNNEL_VIEW_PERIODS, keys: FUNNEL_PERIOD_OPTIONS.map((o) => o.value), custom: true },
    { name: 'analytics', spec: ANALYTICS_VIEW_PERIODS, keys: ANALYTICS_PERIOD_OPTIONS.map((o) => o.value), custom: false },
  ];

  for (const { name, spec, keys, custom } of cases) {
    it(`${name}: accepts every preset key of its own set`, () => {
      const presets = keys.filter((k) => k !== 'custom');
      expect(presets.length).toBeGreaterThan(3);
      for (const key of presets) expect(parseViewPeriod({ key }, spec)).toEqual({ key });
    });

    it(`${name}: refuses an unknown key`, () => {
      expect(parseViewPeriod({ key: 'fortnight' }, spec)).toBeNull();
    });

    it(`${name}: custom range ${custom ? 'accepted when valid' : 'refused'}`, () => {
      const parsed = parseViewPeriod({ key: 'custom', from: '2026-09-01', to: '2026-09-10' }, spec);
      expect(parsed).toEqual(custom ? { key: 'custom', from: '2026-09-01', to: '2026-09-10' } : null);
    });
  }

  it('refuses the other reports\' keys (no cross-report leak)', () => {
    expect(parseViewPeriod({ key: 'week' }, FUNNEL_VIEW_PERIODS)).toBeNull();
    expect(parseViewPeriod({ key: 'week' }, ANALYTICS_VIEW_PERIODS)).toBeNull();
    expect(parseViewPeriod({ key: '30' }, SHARED_VIEW_PERIODS)).toBeNull();
    expect(parseViewPeriod({ key: 'custom', from: '2026-09-01', to: '2026-09-10' }, ANALYTICS_VIEW_PERIODS)).toBeNull();
  });

  it('refuses malformed and reversed custom dates', () => {
    const bad = [
      { key: 'custom', from: '2026-02-31', to: '2026-03-01' },
      { key: 'custom', from: '2026-9-1', to: '2026-09-10' },
      { key: 'custom', from: '2026-09-01' },
      { key: 'custom', from: 20260901, to: '2026-09-10' },
      { key: 'custom', from: '2026-09-10', to: '2026-09-01' },
    ];
    for (const raw of bad) expect(parseViewPeriod(raw, SHARED_VIEW_PERIODS)).toBeNull();
  });

  it('a missing or non-object period is "no period"', () => {
    for (const raw of [undefined, null, 'week', ['week'], { key: 7 }]) {
      expect(parseViewPeriod(raw, SHARED_VIEW_PERIODS)).toBeNull();
    }
  });
});

describe('viewPeriodMatches', () => {
  it('a view with no period matches any; otherwise key and custom dates must agree', () => {
    const week = resolvePeriod({ period: 'week' }, SAVED_AT);
    const custom = resolvePeriod({ period: 'custom', from: '2026-09-01', to: '2026-09-10' }, SAVED_AT);
    expect(viewPeriodMatches(null, week)).toBe(true);
    expect(viewPeriodMatches({ key: 'week' }, week)).toBe(true);
    expect(viewPeriodMatches({ key: 'month' }, week)).toBe(false);
    expect(viewPeriodMatches({ key: 'custom', from: '2026-09-01', to: '2026-09-10' }, custom)).toBe(true);
    expect(viewPeriodMatches({ key: 'custom', from: '2026-09-02', to: '2026-09-10' }, custom)).toBe(false);
  });
});
