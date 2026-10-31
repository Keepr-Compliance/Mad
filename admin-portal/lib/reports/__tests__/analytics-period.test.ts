/**
 * Analytics report — period (BACKLOG-3723, SR R3, PLAN T7)
 */

import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_PERIOD_OPTIONS,
  buildAnalyticsPeriodUrl,
  DEFAULT_ANALYTICS_PERIOD,
  resolveAnalyticsPeriod,
} from '../analytics-period';

const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('resolveAnalyticsPeriod', () => {
  it.each([
    ['1', '2026-10-14T12:00:00.000Z', 'Last 24 hours'],
    ['7', '2026-10-08T12:00:00.000Z', 'Last 7 days'],
    ['30', '2026-09-15T12:00:00.000Z', 'Last 30 days'],
    ['90', '2026-07-17T12:00:00.000Z', 'Last 90 days'],
  ])('legacy value %s is a rolling window', (period, fromIso, label) => {
    expect(resolveAnalyticsPeriod({ period }, NOW)).toEqual({ key: period, fromIso, label });
  });

  it('all has no lower bound', () => {
    expect(resolveAnalyticsPeriod({ period: 'all' }, NOW)).toEqual({ key: 'all', fromIso: null, label: 'All time' });
  });

  it('no value, a bad key and custom all resolve to 30 days', () => {
    const thirty = resolveAnalyticsPeriod({ period: '30' }, NOW);
    expect(DEFAULT_ANALYTICS_PERIOD).toBe('30');
    expect(resolveAnalyticsPeriod({}, NOW)).toEqual(thirty);
    expect(resolveAnalyticsPeriod({ period: '14' }, NOW)).toEqual(thirty);
    expect(resolveAnalyticsPeriod({ period: 'custom' }, NOW)).toEqual(thirty);
  });

  it('custom with a VALID from/to still resolves to 30 days (no date window on last_seen_at)', () => {
    const p = resolveAnalyticsPeriod({ period: 'custom', from: '2026-10-01', to: '2026-10-15' } as { period: string }, NOW);
    expect(p).toEqual({ key: '30', fromIso: '2026-09-15T12:00:00.000Z', label: 'Last 30 days' });
  });
});

describe('picker options', () => {
  it('presets plus All time, no custom entry', () => {
    expect(ANALYTICS_PERIOD_OPTIONS.map((o) => o.value)).toEqual(['1', '7', '30', '90', 'all']);
    expect(ANALYTICS_PERIOD_OPTIONS.map((o) => o.label)).toEqual(['24h', '7d', '30d', '90d', 'All time']);
  });
});

describe('buildAnalyticsPeriodUrl', () => {
  it('writes the default too, sets others, keeps unrelated params, never writes from/to', () => {
    expect(buildAnalyticsPeriodUrl('period=7', '30')).toBe('?period=30');
    expect(buildAnalyticsPeriodUrl('', '7')).toBe('?period=7');
    expect(buildAnalyticsPeriodUrl('x=1', 'all')).toBe('?x=1&period=all');
    expect(buildAnalyticsPeriodUrl('period=custom&from=2026-10-01&to=2026-10-15', '90')).toBe('?period=90');
  });
});
