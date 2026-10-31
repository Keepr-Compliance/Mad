// @vitest-environment jsdom
/**
 * Funnel page: the default saved view on a bare URL (BACKLOG-4084 PR F).
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
 * L1 the browser seam lists the views once across re-renders, under 'funnel'
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
  usePathname: () => '/dashboard/reports/funnel',
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
        maybeSingle: async () => ({ data: null, error: null }),
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

import Page from '@/app/dashboard/reports/funnel/page';
import { computeFunnel } from '@/lib/funnel-analytics';
import { resolveFunnelPeriod } from '@/lib/reports/funnel-period';
import { FunnelReportClient } from '../FunnelReportClient';
const CLIENT_PERIOD = resolveFunnelPeriod({ period: '30' }, new Date('2026-10-15T12:00:00.000Z'));

const DEFAULT_ROW = {
  id: 'view-default-1',
  name: 'Opens by default',
  filters: { period: { key: 'all' } },
  metric: { col: 'rows', fn: 'count' },
  pinned: false,
  is_default: true,
  created_at: '2026-10-01T00:00:00.000Z',
};
const OTHER_ROW = { ...DEFAULT_ROW, id: 'view-other-1', name: 'Not the default', is_default: false, filters: { period: { key: '7' } } };

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

describe('Funnel page opens the default view', () => {
  it('a) bare URL: the default view sets the period (All time), read once under funnel', async () => {
    await renderPage();
    expect(state.listArgs).toEqual([{ p_report_key: 'funnel' }]);
    expect(periodPill()).toContain('All time');
    expect(periodPill()).not.toContain('30d');
  });

  it('b) explicit ?period=7 wins: its label, views not read', async () => {
    await renderPage({ period: '7' });
    expect(state.listArgs).toHaveLength(0);
    expect(periodPill()).toContain('7d');
    expect(periodPill()).not.toContain('All time');
  });

  it('c) a failed views read renders the built-in period (30d) and logs once without the error text', async () => {
    state.viewsError = { message: 'permission denied for secret-user@example.com' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage();
    expect(state.listArgs).toHaveLength(1);
    expect(periodPill()).toContain('30d');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].join(' ')).toContain('[funnel] saved views read failed');
    expect(spy.mock.calls[0].join(' ')).not.toContain('secret-user@example.com');
  });
});

describe('Funnel L1 one list per mount', () => {
  it('re-renders do not re-list', async () => {
    const { rerender } = render(<FunnelReportClient funnel={computeFunnel([])} period={CLIENT_PERIOD} rowCap={20000} />);
    await waitFor(() => expect(browserRpc).toHaveBeenCalled());
    for (let i = 0; i < 3; i += 1) {
      rerender(<FunnelReportClient funnel={computeFunnel([])} period={CLIENT_PERIOD} rowCap={20000} />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    const lists = browserRpc.mock.calls.filter((c) => c[0] === 'report_list_saved_views');
    expect(lists).toHaveLength(1);
    expect(lists[0][1]).toEqual({ p_report_key: 'funnel' });
  });
});
