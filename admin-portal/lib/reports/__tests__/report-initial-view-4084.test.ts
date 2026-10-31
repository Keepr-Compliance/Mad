/**
 * The shared resolver carries a stored CUSTOM range (BACKLOG-4084 PR D).
 *
 * A default view saved with a custom date range must open on that range: the
 * period input needs the key AND both dates, not the key alone.
 */

import { describe, expect, it } from 'vitest';
import { parseSubmissionsSavedViews } from '../submissions-views';
import { resolveReportInitial } from '../report-initial-view';

/** report_list_saved_views output shape. */
const RAW_CUSTOM_DEFAULT = {
  id: 'view-default-1',
  name: 'Mid September',
  filters: { statuses: [], orgs: [], agents: [], reasons: [], platforms: [], search: '', period: { key: 'custom', from: '2026-09-01', to: '2026-09-15' } },
  metric: { col: 'attempts', fn: 'count' },
  pinned: false,
  is_default: true,
  created_at: '2026-10-01T00:00:00.000Z',
};

describe('resolveReportInitial with a custom-range default', () => {
  it('bare URL: the period input carries key, from and to', async () => {
    const out = await resolveReportInitial({}, async () => [RAW_CUSTOM_DEFAULT], parseSubmissionsSavedViews);
    expect(out.initialView?.id).toBe('view-default-1');
    expect(out.periodInput).toEqual({ period: 'custom', from: '2026-09-01', to: '2026-09-15' });
  });
});
