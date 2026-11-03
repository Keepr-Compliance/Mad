// @vitest-environment jsdom
/**
 * The browser seam lists the saved views ONCE, under the submissions key
 * (BACKLOG-4084 PR D). useReportSavedViews re-lists whenever the api object
 * changes identity; an api built inside a render would list on every render.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc }) }));

import { resolvePeriod } from '@/lib/reports/period';
import { buildOpenAttempts, buildSubmissionsReport } from '@/lib/reports/submissions';
import {
  FIXTURE_ORGS,
  FIXTURE_USERS,
  NOW,
  OPEN_ROWS,
  PERIOD_ROWS,
} from '@/lib/reports/__tests__/submissions.fixture';
import { SubmissionsReportClient } from '../SubmissionsReportClient';

afterEach(cleanup);

const REPORT = buildSubmissionsReport(PERIOD_ROWS, FIXTURE_USERS, FIXTURE_ORGS, NOW);
const OPEN = buildOpenAttempts(OPEN_ROWS, FIXTURE_USERS, FIXTURE_ORGS, NOW);
const WEEK = resolvePeriod({ period: 'week' }, NOW);

describe('L1 one list per mount', () => {
  it('re-renders do not re-list', async () => {
    const el = () => (
      <SubmissionsReportClient report={REPORT} openAttempts={OPEN} openCap={200} period={WEEK} rowCap={500} />
    );
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
    expect(lists[0][1]).toEqual({ p_report_key: 'submissions' });
  });
});
