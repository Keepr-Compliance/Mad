// @vitest-environment jsdom
/**
 * Google Messages Sync report page: default view on a bare URL (BACKLOG-4084 PR D)
 *
 * Renders the REAL server page, real queries, builder and report shell; only
 * the Supabase server client and the router are stubbed. The saved-view row is
 * in the shape `report_list_saved_views` returns (id, name, filters with a
 * stored period, metric, pinned, is_default, created_at).
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePeriod } from '@/lib/reports/period';

const NOW = new Date('2026-10-04T12:00:00.000Z');

const state = vi.hoisted(() => ({
  views: [] as unknown[],
  viewsError: null as { message: string } | null,
  listCalls: 0,
  listKeys: [] as unknown[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

/** Every query chain resolves to no rows; single() is the internal-role row. */
function queryBuilder(): unknown {
  const result = { data: [], error: null, count: 0 };
  const proxy: unknown = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      if (prop === 'single' || prop === 'maybeSingle') {
        return async () => ({ data: { role_id: 'role-1' }, error: null });
      }
      return () => proxy;
    },
  });
  return proxy;
}

function stubSupabase() {
  return {
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'report_list_saved_views') {
        state.listCalls += 1;
        state.listKeys.push(args?.p_report_key);
        return state.viewsError ? { data: null, error: state.viewsError } : { data: state.views, error: null };
      }
      // has_permission and the like
      return { data: true, error: null };
    },
    from: () => queryBuilder(),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({ user: { id: 'user-1' }, supabase: stubSupabase() }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ rpc: async () => ({ data: [], error: null }) }),
}));

import GoogleMessagesSyncReportPage from '@/app/dashboard/reports/google-messages-sync/page';

/** report_list_saved_views output shape. */
const DEFAULT_ROW = {
  id: 'view-default-1',
  name: 'Monthly look',
  filters: { types: [], outcomes: [], platforms: [], search: 'x', period: { key: 'last-month' } },
  metric: { col: 'runs', fn: 'count' },
  pinned: false,
  is_default: true,
  created_at: '2026-10-01T00:00:00.000Z',
};

const LAST_MONTH_LABEL = resolvePeriod({ period: 'last-month' }, NOW).label;
const WEEK_LABEL = resolvePeriod({ period: 'week' }, NOW).label;

async function renderPage(params: Record<string, string> = {}) {
  render(await GoogleMessagesSyncReportPage({ searchParams: Promise.resolve(params) }));
}

const searchBox = () => screen.getByLabelText('Search by user') as HTMLInputElement;
/** The native period select (shared SyncFilterBar). */
const periodValue = () => (screen.getByLabelText('Period') as HTMLSelectElement).value;

beforeEach(() => {
  state.views = [DEFAULT_ROW];
  state.viewsError = null;
  state.listCalls = 0;
  state.listKeys = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Google Messages Sync page opens the default view', () => {
  it('guards: the two period labels differ', () => {
    expect(LAST_MONTH_LABEL).not.toBe(WEEK_LABEL);
  });

  it('a) bare URL: the default view sets the period and the search box', async () => {
    await renderPage();
    expect(state.listCalls).toBe(1);
    expect(state.listKeys).toEqual(['google-messages-sync']);
    expect(periodValue()).toBe('last-month');
    expect(searchBox().value).toBe('x');
  });

  it('b) ?period=week wins: week, empty search, views not read', async () => {
    await renderPage({ period: 'week' });
    expect(state.listCalls).toBe(0);
    expect(periodValue()).toBe('week');
    expect(searchBox().value).toBe('');
  });

  it('c) a failed views read still renders the week and logs once without user data', async () => {
    state.viewsError = { message: 'permission denied for secret-user@example.com' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage();
    expect(state.listCalls).toBe(1);
    expect(periodValue()).toBe('week');
    expect(searchBox().value).toBe('');
    // React's own dev warnings (chart keys on an all-zero period) are not ours.
    const ours = spy.mock.calls.filter((c) => !String(c[0]).startsWith('Warning: '));
    expect(ours).toHaveLength(1);
    expect(String(ours[0][0])).toMatch(/saved views read failed/);
    expect(String(ours[0].join(' '))).not.toContain('secret-user@example.com');
  });
});
