/**
 * User Activity saved views, pure half (BACKLOG-4084 PR C).
 *
 * P1 serialize stores the period KEY, P2 defensive parse, P3 matcher includes
 * the period, I1-I4 resolveUserActivityInitial: explicit URL beats the default
 * (each key alone, views never read), bare URL opens the default with its
 * period, unrelated params do not count, a failed read means no default.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolvePeriod } from '../period';
import {
  parseUserActivitySavedView,
  parseUserActivitySavedViews,
  resolveUserActivityInitial,
  serializeUserActivityView,
  userActivityViewMatchesState,
} from '../user-activity-views';
import { NOW } from './user-activity.fixture';

const vid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const RAW_DEFAULT = {
  id: vid(4103),
  name: 'Mine',
  filters: { orgs: ['Acme Realty'], activeOnly: true, search: 'x', period: { key: 'last-month' } },
  metric: { col: 'rows', fn: 'count' },
  pinned: false,
  is_default: true,
};
const RAW_OTHER = { ...RAW_DEFAULT, id: vid(4104), name: 'Other', is_default: false };

describe('P1 serialize', () => {
  it('stores the preset key, never resolved bounds', () => {
    const period = resolvePeriod({ period: 'week' }, NOW);
    expect(serializeUserActivityView({ orgs: ['A'], activeOnly: false, search: '  q  ' }, period)).toEqual({
      orgs: ['A'],
      activeOnly: false,
      search: 'q',
      period: { key: 'week' },
    });
  });

  it('stores a custom range as its two dates', () => {
    const period = resolvePeriod({ period: 'custom', from: '2026-10-01', to: '2026-10-05' }, NOW);
    expect(serializeUserActivityView({ orgs: [], activeOnly: false, search: '' }, period).period).toEqual({
      key: 'custom',
      from: '2026-10-01',
      to: '2026-10-05',
    });
  });
});

describe('P2 parse', () => {
  it('reads a row', () => {
    expect(parseUserActivitySavedView(RAW_DEFAULT)).toEqual({
      id: vid(4103),
      name: 'Mine',
      filters: { orgs: ['Acme Realty'], activeOnly: true, search: 'x' },
      period: { key: 'last-month' },
      isDefault: true,
    });
  });

  it('anything unexpected becomes no filter / no period / not default', () => {
    expect(
      parseUserActivitySavedView({ id: vid(4105), name: '', filters: { orgs: 'x', activeOnly: 'yes', period: { key: '30' } } })
    ).toEqual({
      id: vid(4105),
      name: 'Untitled view',
      filters: { orgs: [], activeOnly: false, search: '' },
      period: null,
      isDefault: false,
    });
    expect(parseUserActivitySavedViews([null, { id: '' }, RAW_OTHER]).map((v) => v.id)).toEqual([vid(4104)]);
    expect(parseUserActivitySavedViews('nope')).toEqual([]);
  });
});

describe('P3 matcher includes the period', () => {
  const view = parseUserActivitySavedView(RAW_DEFAULT)!;
  const filters = { orgs: ['Acme Realty'], activeOnly: true, search: 'x' };
  it('same filters, same period -> match; another period -> no match', () => {
    expect(userActivityViewMatchesState(view, filters, resolvePeriod({ period: 'last-month' }, NOW))).toBe(true);
    expect(userActivityViewMatchesState(view, filters, resolvePeriod({ period: 'week' }, NOW))).toBe(false);
  });
  it('a filter difference -> no match', () => {
    expect(
      userActivityViewMatchesState(view, { ...filters, activeOnly: false }, resolvePeriod({ period: 'last-month' }, NOW))
    ).toBe(false);
  });
});

describe('I1 an explicit URL beats the default, and the views are not read', () => {
  for (const params of [{ period: 'week' }, { from: '2026-10-01' }, { to: '2026-10-05' }, { period: '' }]) {
    it(`${JSON.stringify(params)} alone`, async () => {
      const list = vi.fn().mockResolvedValue([RAW_DEFAULT]);
      const out = await resolveUserActivityInitial(params, list);
      expect(out.initialView).toBeNull();
      expect(list).not.toHaveBeenCalled();
      expect(out.periodInput.period).toBe(params.period);
    });
  }
});

describe('I2 a bare URL opens the default with its period', () => {
  it('default last-month drives the period input', async () => {
    const out = await resolveUserActivityInitial({}, async () => [RAW_OTHER, RAW_DEFAULT]);
    expect(out.initialView?.id).toBe(vid(4103));
    expect(out.periodInput).toEqual({ period: 'last-month' });
  });

  it('no default -> nothing, period from the URL', async () => {
    const out = await resolveUserActivityInitial({}, async () => [RAW_OTHER]);
    expect(out.initialView).toBeNull();
    expect(out.periodInput).toEqual({ period: undefined, from: undefined, to: undefined });
  });
});

describe('I3 unrelated params do not count as explicit', () => {
  it('error= still opens the default', async () => {
    const out = await resolveUserActivityInitial({ error: 'x' }, async () => [RAW_DEFAULT]);
    expect(out.initialView?.id).toBe(vid(4103));
  });
});

describe('I4 a failed read means no default (fails closed)', () => {
  it('rejection -> null, built-in period', async () => {
    const out = await resolveUserActivityInitial({}, async () => {
      throw new Error('Could not find the function');
    });
    expect(out.initialView).toBeNull();
    expect(out.periodInput.period).toBeUndefined();
  });
});
