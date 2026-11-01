// @vitest-environment jsdom
/**
 * iPhone Sync page: default view on a bare URL (BACKLOG-4084 PR E)
 *
 * Renders the REAL server page with its real queries, builder and report
 * shell; only the Supabase server client and the router are stubbed. The
 * saved-view row is in the shape `report_list_saved_views` returns (id, name,
 * filters with a stored period, metric, pinned, is_default, created_at).
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePeriod } from '@/lib/reports/period';

const NOW = new Date('2026-10-20T12:00:00.000Z');

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

function stubSupabase() {
  return {
    rpc: async (fn: string, args: unknown) => {
      if (fn === 'report_list_saved_views') {
        state.listCalls += 1;
        state.listKeys.push(args);
        return state.viewsError ? { data: null, error: state.viewsError } : { data: state.views, error: null };
      }
      return { data: true, error: null };
    },
    from() {
      const builder: Record<string, unknown> = {
        single: async () => ({ data: { role_id: 'role-1' }, error: null }),
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
  getAuthenticatedUser: async () => ({ user: { id: 'user-1' }, supabase: stubSupabase() }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ rpc: async () => ({ data: [], error: null }) }),
}));

import Page from '@/app/dashboard/reports/iphone-sync/page';

const DEFAULT_ROW = {
  id: 'view-default-1',
  name: 'Monthly look',
  filters: { types: [], outcomes: ['error'], platforms: [], search: '', stalledOnly: false, period: { key: 'last-month' } },
  metric: { col: 'runs', fn: 'count' },
  pinned: false,
  is_default: true,
  created_at: '2026-10-01T00:00:00.000Z',
};

const LAST_MONTH_LABEL = resolvePeriod({ period: 'last-month' }, NOW).label;
const WEEK_LABEL = resolvePeriod({ period: 'week' }, NOW).label;
const CUSTOM_LABEL = resolvePeriod({ period: 'custom', from: '2026-09-01', to: '2026-09-15' }, NOW).label;

async function renderPage(params: Record<string, string> = {}) {
  render(await Page({ searchParams: Promise.resolve(params) }));
}

const caption = () =>
  [...document.querySelectorAll('p')].find((p) => p.textContent?.startsWith('Every card, chart and row'))?.textContent ?? '';

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

describe('iPhone Sync page opens the default view', () => {
  it('guards: the two period labels differ', () => {
    expect(LAST_MONTH_LABEL).not.toBe(WEEK_LABEL);
    expect(CUSTOM_LABEL).not.toBe(WEEK_LABEL);
    expect(CUSTOM_LABEL).not.toBe(LAST_MONTH_LABEL);
  });

  it('a) bare URL: the default view sets the period and the filters', async () => {
    await renderPage();
    expect(state.listCalls).toBe(1);
    expect(state.listKeys[0]).toEqual({ p_report_key: 'iphone-sync' });
    expect(caption()).toContain(LAST_MONTH_LABEL);
    expect(caption()).not.toContain(WEEK_LABEL);
    expect(caption()).toContain('outcome: error');
  });

  it('b) ?period=week wins: week label, no filters, views not read', async () => {
    await renderPage({ period: 'week' });
    expect(state.listCalls).toBe(0);
    expect(caption()).toContain(WEEK_LABEL);
    expect(caption()).not.toContain('outcome: error');
  });

  it('b2) an iPhone filter key alone (?type=first) wins: views not read, week label', async () => {
    await renderPage({ type: 'first' });
    expect(state.listCalls).toBe(0);
    expect(caption()).toContain(WEEK_LABEL);
  });

  it('c) a failed views read still renders the week and logs once without user data', async () => {
    state.viewsError = { message: 'permission denied for secret-user@example.com' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage();
    expect(state.listCalls).toBe(1);
    expect(caption()).toContain(WEEK_LABEL);
    expect(caption()).not.toContain('outcome: error');
    const pageLogs = spy.mock.calls.filter((c) => String(c[0]).includes('saved views read failed'));
    expect(pageLogs).toHaveLength(1);
    expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).not.toContain('secret-user@example.com');
  });

  it('d) bare URL: a default view with a custom date range keeps both dates and the filter', async () => {
    state.views = [{ ...DEFAULT_ROW, filters: { ...DEFAULT_ROW.filters, period: { key: 'custom', from: '2026-09-01', to: '2026-09-15' } } }];
    await renderPage();
    expect(state.listCalls).toBe(1);
    expect(caption()).toContain(CUSTOM_LABEL);
    expect(caption()).not.toContain(WEEK_LABEL);
    expect(caption()).toContain('outcome: error');
  });
});
