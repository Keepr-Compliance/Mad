/**
 * The saved-view RPC wrapper parses what it lists (BACKLOG-4004)
 *
 * Pins the default parser of `reportViewsApi` before the module is made to
 * serve a second report: a malformed row from the database is dropped and a
 * good one is normalised, never handed to a render raw.
 */

import { describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ rpc }),
}));

import { reportViewsApi } from '../report-views-api';

describe('reportViewsApi.list', () => {
  it('drops a row with no id and normalises the rest', async () => {
    rpc.mockResolvedValueOnce({
      data: [
        {
          id: 'v-good',
          name: 'Errors',
          filters: { outcomes: ['error'] },
          metric: { col: 'nonsense', fn: 'count' },
          pinned: true,
        },
        { name: 'No id', filters: {}, metric: { col: 'runs', fn: 'count' }, pinned: true },
      ],
      error: null,
    });
    const views = await reportViewsApi.list('iphone-sync');
    expect(rpc).toHaveBeenCalledWith('report_list_saved_views', { p_report_key: 'iphone-sync' });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: 'v-good',
      metric: { col: 'runs', fn: 'count' },
      filters: { types: [], outcomes: ['error'], platforms: [], search: '' },
    });
  });
});

describe('reportViewsApi.list reads is_default (BACKLOG-4084)', () => {
  it('true only for a row that says true; a row without the key (migration not applied) is false', async () => {
    rpc.mockResolvedValueOnce({
      data: [
        { id: 'v1', name: 'A', filters: {}, metric: { col: 'runs', fn: 'count' }, pinned: false, is_default: true },
        { id: 'v2', name: 'B', filters: {}, metric: { col: 'runs', fn: 'count' }, pinned: false },
        { id: 'v3', name: 'C', filters: {}, metric: { col: 'runs', fn: 'count' }, pinned: false, is_default: 'true' },
      ],
      error: null,
    });
    const views = await reportViewsApi.list('iphone-sync');
    expect(views.map((v) => [v.id, v.isDefault])).toEqual([
      ['v1', true],
      ['v2', false],
      ['v3', false],
    ]);
  });
});

describe('reportViewsApi.save', () => {
  /**
   * The pin toggle is an UPDATE: the view's id must reach the RPC as p_id, or
   * report_save_view inserts a second row. The interaction suites use a fake
   * api and cannot see this.
   */
  it('passes the view id as p_id, so a pin toggle updates the row in place', async () => {
    rpc.mockResolvedValueOnce({ data: { id: 'v-errors' }, error: null });
    await reportViewsApi.save({
      id: 'v-errors',
      reportKey: 'iphone-sync',
      name: 'Errors',
      filters: { types: [], outcomes: ['error'], platforms: [], search: '', stalledOnly: false },
      metric: { col: 'runs', fn: 'count' },
      pinned: false,
    });
    expect(rpc).toHaveBeenLastCalledWith('report_save_view', {
      p_report_key: 'iphone-sync',
      p_name: 'Errors',
      p_filters: { types: [], outcomes: ['error'], platforms: [], search: '', stalledOnly: false },
      p_metric: { col: 'runs', fn: 'count' },
      p_pinned: false,
      p_id: 'v-errors',
    });
  });

  it('a new view goes in with p_id null', async () => {
    rpc.mockResolvedValueOnce({ data: { id: 'new' }, error: null });
    await reportViewsApi.save({
      reportKey: 'iphone-sync',
      name: 'New',
      filters: { types: [], outcomes: [], platforms: [], search: '', stalledOnly: false },
      metric: { col: 'runs', fn: 'count' },
      pinned: true,
    });
    expect(rpc.mock.lastCall?.[1]).toMatchObject({ p_id: null });
  });
});

describe('reportViewsApi.setDefault (BACKLOG-4084)', () => {
  it('calls report_set_default_view with the report key and id', async () => {
    rpc.mockResolvedValueOnce({ data: { default_id: 'v1' }, error: null });
    await reportViewsApi.setDefault('iphone-sync', 'v1');
    expect(rpc).toHaveBeenLastCalledWith('report_set_default_view', { p_report_key: 'iphone-sync', p_id: 'v1' });
  });

  it('null clears', async () => {
    rpc.mockResolvedValueOnce({ data: { default_id: null }, error: null });
    await reportViewsApi.setDefault('exports', null);
    expect(rpc).toHaveBeenLastCalledWith('report_set_default_view', { p_report_key: 'exports', p_id: null });
  });

  it('throws the refusal so the caller can show it', async () => {
    const refusal = Object.assign(new Error('Saved view not found'), { code: 'P0001' });
    rpc.mockResolvedValueOnce({ data: null, error: refusal });
    await expect(reportViewsApi.setDefault('iphone-sync', 'someone-elses')).rejects.toBe(refusal);
  });
});
