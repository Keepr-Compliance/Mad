// @vitest-environment jsdom
/**
 * The browser seam lists the saved views ONCE, under the Google Messages Sync
 * key and not the iPhone sync key (BACKLOG-4084 PR D, BACKLOG-3728).
 * useReportSavedViews re-lists whenever the api object changes identity; an
 * api built inside a render would list on every render.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc }) }));

import { resolvePeriod } from '@/lib/reports/period';
import { buildGoogleMessagesSyncReport } from '@/lib/reports/google-messages-sync';
import { GoogleMessagesSyncReportClient } from '../GoogleMessagesSyncReportClient';

afterEach(cleanup);

const NOW = new Date('2026-10-04T12:00:00.000Z');
const REPORT = buildGoogleMessagesSyncReport([], []);
const WEEK = resolvePeriod({ period: 'week' }, NOW);

describe('L1 one list per mount', () => {
  it('re-renders do not re-list, and the list is under google-messages-sync', async () => {
    const el = () => <GoogleMessagesSyncReportClient report={REPORT} period={WEEK} rowCap={200} />;
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
    expect(lists[0][1]).toEqual({ p_report_key: 'google-messages-sync' });
  });
});
