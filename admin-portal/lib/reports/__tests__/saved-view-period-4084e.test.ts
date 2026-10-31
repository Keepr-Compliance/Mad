/**
 * iPhone Sync and Exports saved views carry the time range (BACKLOG-4084 PR E)
 *
 * Rows below are in the shape `report_list_saved_views` returns: id, name,
 * filters (with `period` inside), metric, pinned, is_default, created_at.
 */

import { describe, expect, it, vi } from 'vitest';
import { EMPTY_FILTERS } from '../iphone-sync-filters';
import { resolvePeriod } from '../period';
import {
  parseSavedViews,
  serializeFilters,
  viewMatchesPage,
  viewMatchesState,
  type ReportSavedView,
} from '../report-views';
import {
  exportViewMatchesPage,
  exportViewMatchesState,
  parseExportSavedViews,
  serializeExportFilters,
} from '../exports-views';
import { resolveInitialSavedView } from '../initial-saved-view';
import { IPHONE_SYNC_URL_KEYS } from '../default-view';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const WEEK = resolvePeriod({ period: 'week' }, NOW);
const LAST_MONTH = resolvePeriod({ period: 'last-month' }, NOW);
const CUSTOM = resolvePeriod({ period: 'custom', from: '2026-10-01', to: '2026-10-05' }, NOW);

function iphoneRow(over: Record<string, unknown> = {}, period: unknown = { key: 'last-month' }) {
  return {
    id: 'view-iphone-1',
    name: 'Errors last month',
    filters: { types: [], outcomes: ['error'], platforms: [], search: '', stalledOnly: false, period },
    metric: { col: 'runs', fn: 'count' },
    pinned: true,
    is_default: false,
    created_at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function exportRow(over: Record<string, unknown> = {}, period: unknown = { key: 'last-month' }) {
  return {
    id: 'view-exports-1',
    name: 'PDF last month',
    filters: { orgs: [], users: [], formats: ['pdf'], search: '', period },
    metric: { col: 'exports', fn: 'count' },
    pinned: true,
    is_default: false,
    created_at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

describe('P1 the period is read back from filters.period', () => {
  it('iPhone: preset key, custom dates, none, and an unknown key', () => {
    const [preset, custom, none, unknown] = parseSavedViews([
      iphoneRow({ id: 'a' }),
      iphoneRow({ id: 'b' }, { key: 'custom', from: '2026-10-01', to: '2026-10-05' }),
      iphoneRow({ id: 'c' }, null),
      iphoneRow({ id: 'd' }, { key: 'fortnight' }),
    ]);
    expect(preset.period).toEqual({ key: 'last-month' });
    expect(custom.period).toEqual({ key: 'custom', from: '2026-10-01', to: '2026-10-05' });
    expect(none.period).toBeNull();
    expect(unknown.period).toBeNull();
  });

  it('Exports: preset key, malformed custom date', () => {
    const [preset, bad] = parseExportSavedViews([
      exportRow({ id: 'a' }),
      exportRow({ id: 'b' }, { key: 'custom', from: '2026-13-01', to: '2026-10-05' }),
    ]);
    expect(preset.period).toEqual({ key: 'last-month' });
    expect(bad.period).toBeNull();
  });
});

describe('P2 the serializers write the period only when given one', () => {
  it('iPhone', () => {
    expect(serializeFilters(EMPTY_FILTERS, false, { key: 'week' }).period).toEqual({ key: 'week' });
    expect('period' in serializeFilters(EMPTY_FILTERS, false, null)).toBe(false);
  });

  it('Exports', () => {
    const f = { orgs: [], users: [], formats: [], search: '' };
    expect(serializeExportFilters(f, { key: 'month' }).period).toEqual({ key: 'month' });
    expect('period' in serializeExportFilters(f)).toBe(false);
  });
});

describe('M1 two matchers: cards compare filters, the Views list compares filters and period', () => {
  it('iPhone', () => {
    const [view] = parseSavedViews([iphoneRow()]);
    const filters = { ...EMPTY_FILTERS, outcomes: ['error'] };
    expect(viewMatchesState(view, filters, false)).toBe(true);
    expect(viewMatchesPage(view, filters, false, WEEK)).toBe(false);
    expect(viewMatchesPage(view, filters, false, LAST_MONTH)).toBe(true);
  });

  it('iPhone: a custom view matches only the same two dates', () => {
    const [view] = parseSavedViews([iphoneRow({}, { key: 'custom', from: '2026-10-01', to: '2026-10-05' })]);
    const filters = { ...EMPTY_FILTERS, outcomes: ['error'] };
    expect(viewMatchesPage(view, filters, false, CUSTOM)).toBe(true);
    const other = resolvePeriod({ period: 'custom', from: '2026-10-01', to: '2026-10-06' }, NOW);
    expect(viewMatchesPage(view, filters, false, other)).toBe(false);
  });

  it('iPhone: a view saved before 4084 (no period) matches any period', () => {
    const [view] = parseSavedViews([iphoneRow({}, null)]);
    expect(viewMatchesPage(view, { ...EMPTY_FILTERS, outcomes: ['error'] }, false, WEEK)).toBe(true);
  });

  it('Exports', () => {
    const [view] = parseExportSavedViews([exportRow()]);
    const f = { orgs: [], users: [], formats: ['pdf'], search: '' };
    expect(exportViewMatchesState(view, f)).toBe(true);
    expect(exportViewMatchesPage(view, f, WEEK)).toBe(false);
    expect(exportViewMatchesPage(view, f, LAST_MONTH)).toBe(true);
  });
});

describe('I resolveInitialSavedView', () => {
  const rows = [iphoneRow({ is_default: true })];

  it('I1 bare URL: reads once, returns the default and its period', async () => {
    const listViews = vi.fn().mockResolvedValue(rows);
    const out = await resolveInitialSavedView<ReportSavedView>({
      params: { error: 'x' },
      reportKeys: IPHONE_SYNC_URL_KEYS,
      listViews,
      parse: parseSavedViews,
    });
    expect(listViews).toHaveBeenCalledTimes(1);
    expect(out.initialView?.id).toBe('view-iphone-1');
    expect(out.periodInput).toEqual({ period: 'last-month' });
  });

  it.each([
    ['period', 'week'],
    ['from', '2026-10-01'],
    ['to', '2026-10-05'],
    ...IPHONE_SYNC_URL_KEYS.map((k) => [k, '1'] as [string, string]),
    ['period', ''],
  ])('I2 explicit %s=%s alone: no read, no default', async (key, value) => {
    const listViews = vi.fn().mockResolvedValue(rows);
    const out = await resolveInitialSavedView<ReportSavedView>({
      params: { [key]: value },
      reportKeys: IPHONE_SYNC_URL_KEYS,
      listViews,
      parse: parseSavedViews,
    });
    expect(listViews).not.toHaveBeenCalled();
    expect(out.initialView).toBeNull();
  });

  it('I3 a failed read means no default and the URL period', async () => {
    const out = await resolveInitialSavedView<ReportSavedView>({
      params: {},
      listViews: () => Promise.reject(new Error('nope')),
      parse: parseSavedViews,
    });
    expect(out).toEqual({ initialView: null, periodInput: { period: undefined, from: undefined, to: undefined } });
  });

  it('I4 a default with no stored period keeps the built-in period', async () => {
    const out = await resolveInitialSavedView<ReportSavedView>({
      params: {},
      listViews: async () => [iphoneRow({ is_default: true }, null)],
      parse: parseSavedViews,
    });
    expect(out.initialView?.id).toBe('view-iphone-1');
    expect(out.periodInput.period).toBeUndefined();
  });

  it('I5 a custom default period becomes period=custom with both dates', async () => {
    const out = await resolveInitialSavedView({
      params: {},
      listViews: async () => [exportRow({ is_default: true }, { key: 'custom', from: '2026-10-01', to: '2026-10-05' })],
      parse: parseExportSavedViews,
    });
    expect(out.periodInput).toEqual({ period: 'custom', from: '2026-10-01', to: '2026-10-05' });
  });
});
