// @vitest-environment jsdom
/**
 * User Activity report page: default view on a bare URL (BACKLOG-4084 PR C)
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
import { NOW } from '@/lib/reports/__tests__/user-activity.fixture';

const state = vi.hoisted(() => ({
  views: [] as unknown[],
  viewsError: null as { message: string } | null,
  listCalls: 0,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

function stubSupabase() {
  return {
    rpc: async (fn: string) => {
      if (fn === 'report_list_saved_views') {
        state.listCalls += 1;
        return state.viewsError
          ? { data: null, error: state.viewsError }
          : { data: state.views, error: null };
      }
      // has_permission and is_super_admin
      return { data: true, error: null };
    },
    from() {
      const builder: Record<string, unknown> = {
        single: async () => ({ data: { role_id: 'r1' }, error: null }),
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      for (const m of ['select', 'eq', 'neq', 'gte', 'lt', 'order', 'range', 'limit', 'in', 'not', 'or']) {
        builder[m] = () => builder;
      }
      return builder;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({ user: { id: 'u-1' }, supabase: stubSupabase() }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ rpc: async () => ({ data: [], error: null }) }),
}));

import UserActivityReportPage from '@/app/dashboard/reports/user-activity/page';

/** report_list_saved_views output shape. */
const DEFAULT_ROW = {
  id: 'view-default-1',
  name: 'Monthly look',
  filters: { orgs: [], activeOnly: false, search: 'x', period: { key: 'last-month' } },
  metric: { col: 'rows', fn: 'count' },
  pinned: false,
  is_default: true,
  created_at: '2026-10-01T00:00:00.000Z',
};

const LAST_MONTH_LABEL = resolvePeriod({ period: 'last-month' }, NOW).label;
const WEEK_LABEL = resolvePeriod({ period: 'week' }, NOW).label;

async function renderPage(params: Record<string, string> = {}) {
  render(await UserActivityReportPage({ searchParams: Promise.resolve(params) }));
}

const searchBox = () => screen.getByLabelText('Search by name or email') as HTMLInputElement;
const pageText = () => document.body.textContent ?? '';

beforeEach(() => {
  state.views = [DEFAULT_ROW];
  state.viewsError = null;
  state.listCalls = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('User Activity page opens the default view', () => {
  it('guards: the two period labels differ', () => {
    expect(LAST_MONTH_LABEL).not.toBe(WEEK_LABEL);
  });

  it('a) bare URL: the default view sets the period and the search box', async () => {
    await renderPage();
    expect(state.listCalls).toBe(1);
    expect(pageText()).toContain(LAST_MONTH_LABEL);
    expect(pageText()).not.toContain(WEEK_LABEL);
    expect(searchBox().value).toBe('x');
  });

  it('b) ?period=week wins: week label, empty search, views not read', async () => {
    await renderPage({ period: 'week' });
    expect(state.listCalls).toBe(0);
    expect(pageText()).toContain(WEEK_LABEL);
    expect(pageText()).not.toContain(LAST_MONTH_LABEL);
    expect(searchBox().value).toBe('');
  });

  it('c) a failed views read still renders the week and logs once without user data', async () => {
    state.viewsError = { message: 'permission denied for secret-user@example.com' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage();
    expect(state.listCalls).toBe(1);
    expect(pageText()).toContain(WEEK_LABEL);
    expect(searchBox().value).toBe('');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0].join(' '))).not.toContain('secret-user@example.com');
  });
});
