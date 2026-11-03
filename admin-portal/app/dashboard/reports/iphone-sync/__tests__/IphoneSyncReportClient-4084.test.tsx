// @vitest-environment jsdom
/**
 * The browser seam lists the saved views ONCE (BACKLOG-4084 PR E, SR note 1).
 *
 * useReportSavedViews re-lists whenever the api object changes identity; an
 * api built inside a render would list on every render.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc }) }));

import { buildIphoneSyncReport } from '@/lib/reports/iphone-sync';
import { resolvePeriod } from '@/lib/reports/period';
import { FIXTURE_ROWS_24, FIXTURE_USERS_24 } from '@/lib/reports/__tests__/iphone-sync.fixture';
import { IphoneSyncReportClient } from '../IphoneSyncReportClient';

const REPORT = buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24);
const PERIOD = resolvePeriod({ period: 'week' }, new Date('2026-09-19T22:07:00.000Z'));

afterEach(cleanup);

describe('L1 one list per mount', () => {
  it('re-renders do not re-list', async () => {
    const el = () => <IphoneSyncReportClient report={REPORT} period={PERIOD} rowCap={200} />;
    const { rerender } = render(el());
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    for (let i = 0; i < 3; i += 1) {
      rerender(el());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    const lists = rpc.mock.calls.filter((c) => c[0] === 'report_list_saved_views');
    expect(lists).toHaveLength(1);
    expect(lists[0][1]).toEqual({ p_report_key: 'iphone-sync' });
  });
});
