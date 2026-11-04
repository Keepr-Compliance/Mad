// @vitest-environment jsdom
/**
 * SupportSla page: the default saved view on a bare URL (BACKLOG-4084 PR F).
 *
 * Renders the REAL server page and report shell; only the Supabase server
 * client, the browser client and the router are stubbed. Every table read
 * returns no rows. The saved-view row is in the shape
 * `report_list_saved_views` returns (id, name, filters with a stored period,
 * metric, pinned, is_default, created_at). Ids are invented.
 *
 * a) bare URL + a default -> its period is applied
 * b) explicit ?period -> the URL wins and the views are not read
 * c) a failed views read -> the built-in period, one stage-only console.error
 * L1 the browser seam lists the views once across re-renders, under 'support-sla'
 */
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  views: [] as unknown[],
  viewsError: null as { message: string } | null,
  listArgs: [] as unknown[],
}));
const browserRpc = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/reports/support-sla',
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

function stubSupabase() {
  return {
    rpc: async (fn: string, args: unknown) => {
      if (fn === 'report_list_saved_views') {
        state.listArgs.push(args);
        return state.viewsError ? { data: null, error: state.viewsError } : { data: state.views, error: null };
      }
      return { data: true, error: null };
    },
    from() {
      const builder: Record<string, unknown> = {
        single: async () => ({ data: { role_id: 'r1' }, error: null }),
        // The migration's seeded support_sla_settings row (BACKLOG-4086), so the settings read succeeds.
        maybeSingle: async () => ({
          data: {
            first_response_target_minutes: 480,
            resolution_target_business_days: 3,
            business_day_start_minute: 540,
            business_day_end_minute: 1020,
            business_days: [1, 2, 3, 4, 5],
            time_zone: 'America/Los_Angeles',
          },
          error: null,
        }),
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve({ data: [], count: 0, error: null }).then(resolve);
        },
      };
      for (const m of ['select', 'eq', 'neq', 'gte', 'lt', 'lte', 'order', 'range', 'limit', 'in', 'not', 'or', 'is']) {
        builder[m] = () => builder;
      }
      return builder;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({ user: { id: 'u-1' }, supabase: stubSupabase() }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: browserRpc }) }));

import Page from '@/app/dashboard/reports/support-sla/page';
import { resolvePeriod } from '@/lib/reports/period';
import { SupportSlaReportClient } from '../SupportSlaReportClient';
const CLIENT_PERIOD = resolvePeriod({ period: 'week' }, new Date('2026-10-15T12:00:00.000Z'));

const DEFAULT_ROW = {
  id: 'view-default-1',
  name: 'Opens by default',
  filters: { period: { key: 'last-month' } },
  metric: { col: 'rows', fn: 'count' },
  pinned: false,
  is_default: true,
  created_at: '2026-10-01T00:00:00.000Z',
};
const OTHER_ROW = { ...DEFAULT_ROW, id: 'view-other-1', name: 'Not the default', is_default: false, filters: { period: { key: 'month' } } };

async function renderPage(params: Record<string, string> = {}) {
  render(await Page({ searchParams: Promise.resolve(params) }));
}

/** The Period pill shows the selected period's label. */
const periodPill = () => document.querySelector('[data-slot="period-picker"]')?.textContent ?? '';

beforeEach(() => {
  state.views = [OTHER_ROW, DEFAULT_ROW];
  state.viewsError = null;
  state.listArgs = [];
  browserRpc.mockReset();
  browserRpc.mockResolvedValue({ data: [], error: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SupportSla page opens the default view', () => {
  it('a) bare URL: the default view sets the period (Last month), read once under support-sla', async () => {
    await renderPage();
    expect(state.listArgs).toEqual([{ p_report_key: 'support-sla' }]);
    expect(periodPill()).toContain('Last month');
    expect(periodPill()).not.toContain('This week');
  });

  it('b) explicit ?period=month wins: its label, views not read', async () => {
    await renderPage({ period: 'month' });
    expect(state.listArgs).toHaveLength(0);
    expect(periodPill()).toContain('This month');
    expect(periodPill()).not.toContain('Last month');
  });

  it('c) a failed views read renders the built-in period (This week) and logs once without the error text', async () => {
    state.viewsError = { message: 'permission denied for secret-user@example.com' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage();
    expect(state.listArgs).toHaveLength(1);
    expect(periodPill()).toContain('This week');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].join(' ')).toContain('[support-sla] saved views read failed');
    expect(spy.mock.calls[0].join(' ')).not.toContain('secret-user@example.com');
  });
});

describe('SupportSla L1 one list per mount', () => {
  it('re-renders do not re-list', async () => {
    const { rerender } = render(<SupportSlaReportClient report={null} settings={null} period={CLIENT_PERIOD} rowCap={1000} />);
    await waitFor(() => expect(browserRpc).toHaveBeenCalled());
    for (let i = 0; i < 3; i += 1) {
      rerender(<SupportSlaReportClient report={null} settings={null} period={CLIENT_PERIOD} rowCap={1000} />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    const lists = browserRpc.mock.calls.filter((c) => c[0] === 'report_list_saved_views');
    expect(lists).toHaveLength(1);
    expect(lists[0][1]).toEqual({ p_report_key: 'support-sla' });
  });
});
