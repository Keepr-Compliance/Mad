/**
 * Exports report — saved views (BACKLOG-4004)
 */

import { describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ rpc }),
}));

import { buildExportsReport, EMPTY_EXPORT_FILTERS } from '../exports';
import {
  exportCardValue,
  EXPORTS_REPORT_KEY,
  parseExportFilters,
  parseExportSavedViews,
  serializeExportFilters,
} from '../exports-views';
import { exportsViewsApi } from '../exports-views-api';
import { REPORT_KEY as IPHONE_REPORT_KEY } from '../report-views';
import { EXPORT_ROWS, LOOKUPS } from './exports.fixture';

describe('the stored blob', () => {
  it('is keyed exports, not the iPhone Sync key', () => {
    expect(EXPORTS_REPORT_KEY).toBe('exports');
    expect(EXPORTS_REPORT_KEY).not.toBe(IPHONE_REPORT_KEY);
  });

  it('carries the four filter keys and nothing else', () => {
    const stored = serializeExportFilters({ orgs: ['org-a'], users: ['user-1'], formats: ['pdf'], search: '  one ' });
    expect(stored).toEqual({ orgs: ['org-a'], users: ['user-1'], formats: ['pdf'], search: 'one' });
  });

  it('parses a hand-edited blob without throwing', () => {
    for (const raw of [null, 'x', [], { orgs: 'org-a', users: [1, 'u'], formats: null, search: 5 }]) {
      expect(() => parseExportFilters(raw)).not.toThrow();
    }
    expect(parseExportFilters({ orgs: 'org-a', users: [1, 'u'] })).toEqual({
      ...EMPTY_EXPORT_FILTERS,
      users: ['u'],
    });
  });
});

describe('the parser keeps Exports metrics', () => {
  it('a view with col unique survives; an unknown col falls back to exports', () => {
    const views = parseExportSavedViews([
      { id: 'v1', name: 'Unique', filters: {}, metric: { col: 'unique', fn: 'count' }, pinned: true },
      { id: 'v2', name: 'Odd', filters: {}, metric: { col: 'runs', fn: 'average' }, pinned: false },
      { name: 'no id' },
    ]);
    expect(views.map((v) => [v.id, v.metric.col])).toEqual([
      ['v1', 'unique'],
      ['v2', 'exports'],
    ]);
  });

  it('exportsViewsApi lists under the exports key with the Exports parser', async () => {
    rpc.mockResolvedValueOnce({
      data: [{ id: 'v1', name: 'Unique', filters: { formats: ['pdf'] }, metric: { col: 'unique', fn: 'count' }, pinned: true }],
      error: null,
    });
    const views = await exportsViewsApi.list(EXPORTS_REPORT_KEY);
    expect(rpc).toHaveBeenCalledWith('report_list_saved_views', { p_report_key: 'exports' });
    expect(views[0]).toMatchObject({ metric: { col: 'unique', fn: 'count' }, filters: { formats: ['pdf'] } });
  });
});

describe('card value', () => {
  const { events } = buildExportsReport(EXPORT_ROWS, LOOKUPS);
  const view = (col: 'exports' | 'unique' | 'users', filters = {}) =>
    parseExportSavedViews([{ id: 'v', name: 'v', filters, metric: { col, fn: 'count' }, pinned: true }])[0];

  it('uses the card`s own filters over the period`s events', () => {
    expect(exportCardValue(events, view('exports', { formats: ['folder'] }))).toBe(3);
    expect(exportCardValue(events, view('unique', { formats: ['folder'] }))).toBe(2);
    expect(exportCardValue(events, view('users'))).toBe(4);
  });
});
