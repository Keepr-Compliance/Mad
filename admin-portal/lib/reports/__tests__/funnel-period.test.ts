/**
 * Paywall Funnel — period resolution and URL (BACKLOG-3722, T6 / R1)
 */

import { describe, expect, it } from 'vitest';
import { buildFunnelPeriodUrl, FUNNEL_PERIOD_OPTIONS, resolveFunnelPeriod } from '../funnel-period';
import { NOW } from './funnel.fixture';

const DAY = 86_400_000;
const back = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe('resolveFunnelPeriod', () => {
  it.each([
    ['1', back(1), 'Last 24 hours'],
    ['7', back(7), 'Last 7 days'],
    ['30', back(30), 'Last 30 days'],
    ['90', back(90), 'Last 90 days'],
  ])('legacy ?period=%s rolls back from now', (key, fromIso, label) => {
    expect(resolveFunnelPeriod({ period: key }, NOW)).toEqual({
      key,
      fromIso,
      toIso: NOW.toISOString(),
      label,
      customFrom: null,
      customTo: null,
    });
  });

  it('?period=all has no lower bound', () => {
    const p = resolveFunnelPeriod({ period: 'all' }, NOW);
    expect(p.key).toBe('all');
    expect(p.fromIso).toBeNull();
    expect(p.toIso).toBe(NOW.toISOString());
    expect(p.label).toBe('All time');
  });

  it.each([[undefined], ['week'], ['24h'], ['all-time'], ['']])('%s falls back to 30d', (period) => {
    const p = resolveFunnelPeriod({ period }, NOW);
    expect(p.key).toBe('30');
    expect(p.fromIso).toBe(back(30));
  });

  it('custom is [from 00:00Z, to + 1 day)', () => {
    expect(resolveFunnelPeriod({ period: 'custom', from: '2026-10-01', to: '2026-10-20' }, NOW)).toEqual({
      key: 'custom',
      fromIso: '2026-10-01T00:00:00.000Z',
      toIso: '2026-10-21T00:00:00.000Z',
      label: 'Oct 1 to Oct 20',
      customFrom: '2026-10-01',
      customTo: '2026-10-20',
    });
  });

  it.each([
    [{ period: 'custom' }],
    [{ period: 'custom', from: '2026-10-01' }],
    [{ period: 'custom', from: '2026-10-20', to: '2026-10-01' }],
    [{ period: 'custom', from: '2026-02-31', to: '2026-03-01' }],
    [{ period: 'custom', from: "2026-10-01'; drop", to: '2026-10-02' }],
  ])('a bad custom range %j falls back to 30d', (params) => {
    expect(resolveFunnelPeriod(params, NOW).key).toBe('30');
  });

  it('the picker offers 24h / 7d / 30d / 90d / All time / Custom range on the legacy values', () => {
    expect(FUNNEL_PERIOD_OPTIONS).toEqual([
      { value: '1', label: '24h' },
      { value: '7', label: '7d' },
      { value: '30', label: '30d' },
      { value: '90', label: '90d' },
      { value: 'all', label: 'All time' },
      { value: 'custom', label: 'Custom range' },
    ]);
  });
});

describe('buildFunnelPeriodUrl', () => {
  it('drops period at the funnel default 30', () => {
    expect(buildFunnelPeriodUrl('period=7', '30')).toBe('?');
  });

  it('writes every other value, keeping unrelated params', () => {
    expect(buildFunnelPeriodUrl('x=1', 'all')).toBe('?x=1&period=all');
    expect(buildFunnelPeriodUrl('', '90')).toBe('?period=90');
  });

  it('custom carries its dates; a preset drops them', () => {
    expect(buildFunnelPeriodUrl('', 'custom', '2026-10-01', '2026-10-20')).toBe(
      '?period=custom&from=2026-10-01&to=2026-10-20'
    );
    expect(buildFunnelPeriodUrl('period=custom&from=2026-10-01&to=2026-10-20', '7')).toBe('?period=7');
  });
});
