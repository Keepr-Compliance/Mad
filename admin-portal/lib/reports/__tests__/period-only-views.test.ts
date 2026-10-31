/**
 * Saved views on the period-only reports (BACKLOG-4084 PR F): Paywall Funnel,
 * Analytics, Support SLA.
 *
 * Rows are in the shape `report_list_saved_views` returns (id, name, filters,
 * metric, pinned, is_default, created_at). Ids are invented ('view-...').
 */

import { describe, expect, it, vi } from 'vitest';
import { REPORTS } from '../registry';
import { FUNNEL_PERIOD_OPTIONS } from '../funnel-period';
import { ANALYTICS_PERIOD_OPTIONS } from '../analytics-period';
import { PERIOD_OPTIONS } from '../period';
import {
  ANALYTICS_REPORT_KEY,
  analyticsViews,
  FUNNEL_REPORT_KEY,
  funnelViews,
  PERIOD_ONLY_SAVE_HINT,
  SUPPORT_SLA_REPORT_KEY,
  supportSlaViews,
  type PeriodOnlyViews,
} from '../period-only-views';

const row = (id: string, period: unknown, isDefault = false) => ({
  id,
  name: `View ${id}`,
  filters: period === undefined ? {} : { period },
  metric: { col: 'rows', fn: 'count' },
  pinned: false,
  is_default: isDefault,
  created_at: '2026-10-01T00:00:00.000Z',
});

const CUSTOM = { key: 'custom', from: '2026-10-01', to: '2026-10-10' };

const presetKeys = (opts: { value: string }[]) => opts.map((o) => o.value).filter((k) => k !== 'custom');

const REPORT_SETS: { name: string; views: PeriodOnlyViews; keys: string[]; custom: boolean }[] = [
  { name: 'funnel', views: funnelViews, keys: presetKeys(FUNNEL_PERIOD_OPTIONS), custom: true },
  { name: 'analytics', views: analyticsViews, keys: presetKeys(ANALYTICS_PERIOD_OPTIONS), custom: false },
  { name: 'support-sla', views: supportSlaViews, keys: presetKeys(PERIOD_OPTIONS), custom: true },
];
const ALL_KEYS = [...new Set(REPORT_SETS.flatMap((r) => r.keys))];

describe('K1 report keys', () => {
  it('each report saves under its own registry slug, and the three differ', () => {
    const slugs = REPORTS.map((r) => r.slug);
    expect([FUNNEL_REPORT_KEY, ANALYTICS_REPORT_KEY, SUPPORT_SLA_REPORT_KEY]).toEqual([
      'funnel',
      'analytics',
      'support-sla',
    ]);
    for (const k of [FUNNEL_REPORT_KEY, ANALYTICS_REPORT_KEY, SUPPORT_SLA_REPORT_KEY]) expect(slugs).toContain(k);
    expect(funnelViews.reportKey).toBe(FUNNEL_REPORT_KEY);
    expect(analyticsViews.reportKey).toBe(ANALYTICS_REPORT_KEY);
    expect(supportSlaViews.reportKey).toBe(SUPPORT_SLA_REPORT_KEY);
    expect(new Set(REPORT_SETS.map((r) => r.views.reportKey)).size).toBe(3);
  });

  it('the save hint names the time range only', () => {
    expect(PERIOD_ONLY_SAVE_HINT).toBe('Saves the time range.');
  });
});

describe('P1 each report reads back only its OWN period keys (full sweep)', () => {
  for (const r of REPORT_SETS) {
    it(`${r.name}: every key of every report, accepted exactly when it is ${r.name}'s`, () => {
      for (const key of ALL_KEYS) {
        const [view] = r.views.parseRows([row('view-1', { key })]);
        expect([key, view.period]).toEqual([key, r.keys.includes(key) ? { key } : null]);
      }
    });

    it(`${r.name}: custom range ${r.custom ? 'kept' : 'rejected'}; malformed, reversed, unknown rejected`, () => {
      const parse = (p: unknown) => r.views.parseRows([row('view-1', p)])[0].period;
      expect(parse(CUSTOM)).toEqual(r.custom ? CUSTOM : null);
      expect(parse({ key: 'custom', from: '2026-10-10', to: '2026-10-01' })).toBeNull();
      expect(parse({ key: 'custom', from: '2026-13-01', to: '2026-10-10' })).toBeNull();
      expect(parse({ key: 'custom', from: '2026-10-01' })).toBeNull();
      expect(parse({ key: 'fortnight' })).toBeNull();
      expect(parse(undefined)).toBeNull();
      expect(parse('7')).toBeNull();
    });
  }

  it('cross-report examples: Funnel refuses "week", Support SLA refuses "30", Analytics refuses a custom range', () => {
    expect(funnelViews.parseRows([row('view-1', { key: 'week' })])[0].period).toBeNull();
    expect(supportSlaViews.parseRows([row('view-1', { key: '30' })])[0].period).toBeNull();
    expect(analyticsViews.parseRows([row('view-1', CUSTOM)])[0].period).toBeNull();
    expect(funnelViews.parseRows([row('view-1', CUSTOM)])[0].period).toEqual(CUSTOM);
  });
});

describe('P2 parse rows defensively', () => {
  it('drops rows with no id, names the unnamed, default only when is_default === true', () => {
    const views = funnelViews.parseRows([
      row('view-a', { key: '7' }, true),
      { ...row('view-b', { key: '7' }), name: '', is_default: 'true' },
      { ...row('', { key: '7' }) },
      null,
      'x',
    ]);
    expect(views.map((v) => [v.id, v.name, v.isDefault])).toEqual([
      ['view-a', 'View view-a', true],
      ['view-b', 'Untitled view', false],
    ]);
    expect(funnelViews.parseRows({ not: 'a list' })).toEqual([]);
  });
});

describe('S1 serialize stores the key, never bounds', () => {
  it('preset -> { period: { key } }; custom -> its two dates', () => {
    expect(funnelViews.serialize({ key: '7', customFrom: null, customTo: null })).toEqual({ period: { key: '7' } });
    expect(analyticsViews.serialize({ key: 'all' })).toEqual({ period: { key: 'all' } });
    expect(supportSlaViews.serialize({ key: 'custom', customFrom: '2026-10-01', customTo: '2026-10-10' })).toEqual({
      period: CUSTOM,
    });
  });
});

describe('M1 isActive needs a readable period that matches', () => {
  const [seven, none, custom] = funnelViews.parseRows([
    row('view-7', { key: '7' }),
    row('view-none', { key: 'week' }),
    row('view-c', CUSTOM),
  ]);
  it('matches its own period only', () => {
    expect(funnelViews.isActive(seven, { key: '7' })).toBe(true);
    expect(funnelViews.isActive(seven, { key: '30' })).toBe(false);
    expect(funnelViews.isActive(custom, { key: 'custom', customFrom: '2026-10-01', customTo: '2026-10-10' })).toBe(true);
    expect(funnelViews.isActive(custom, { key: 'custom', customFrom: '2026-10-01', customTo: '2026-10-11' })).toBe(false);
  });
  it('a view with no readable period is never active', () => {
    for (const key of ['1', '7', '30', '90', 'all']) expect(funnelViews.isActive(none, { key })).toBe(false);
  });
});

describe('I1 resolveInitial: the default opens only on a bare URL', () => {
  const DEFAULT_ALL = row('view-default-1', { key: 'all' }, true);

  it('bare URL: reads once, the default period drives the input', async () => {
    const list = vi.fn().mockResolvedValue([row('view-2', { key: '7' }), DEFAULT_ALL]);
    const out = await funnelViews.resolveInitial({}, list);
    expect(list).toHaveBeenCalledTimes(1);
    expect(out.initialView?.id).toBe('view-default-1');
    expect(out.periodInput).toEqual({ period: 'all' });
  });

  it('a custom default becomes period=custom with its dates', async () => {
    const out = await supportSlaViews.resolveInitial({}, async () => [row('view-default-1', CUSTOM, true)]);
    expect(out.periodInput).toEqual({ period: 'custom', from: '2026-10-01', to: '2026-10-10' });
  });

  for (const params of [{ period: '7' }, { from: '2026-10-01' }, { to: '2026-10-10' }, { period: '' }]) {
    it(`explicit ${JSON.stringify(params)} alone: views not read, the URL wins`, async () => {
      const list = vi.fn().mockResolvedValue([DEFAULT_ALL]);
      const out = await funnelViews.resolveInitial(params, list);
      expect(list).not.toHaveBeenCalled();
      expect(out.initialView).toBeNull();
      expect(out.periodInput).toEqual({ period: undefined, from: undefined, to: undefined, ...params });
    });
  }

  it('an unrelated param (error=) still opens the default', async () => {
    const out = await funnelViews.resolveInitial({ error: 'x' }, async () => [DEFAULT_ALL]);
    expect(out.periodInput).toEqual({ period: 'all' });
  });

  it('a failed read -> no default, built-in period', async () => {
    const out = await funnelViews.resolveInitial({}, async () => {
      throw new Error('boom');
    });
    expect(out).toEqual({ initialView: null, periodInput: { period: undefined, from: undefined, to: undefined } });
  });

  it("a default holding another report's key opens nothing", async () => {
    const out = await analyticsViews.resolveInitial({}, async () => [row('view-default-1', CUSTOM, true)]);
    expect(out.initialView).toBeNull();
    expect(out.periodInput.period).toBeUndefined();
  });

  it('no default -> built-in period', async () => {
    const out = await funnelViews.resolveInitial({}, async () => [row('view-2', { key: '7' })]);
    expect(out.initialView).toBeNull();
    expect(out.periodInput.period).toBeUndefined();
  });
});
