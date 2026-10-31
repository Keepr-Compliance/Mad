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
