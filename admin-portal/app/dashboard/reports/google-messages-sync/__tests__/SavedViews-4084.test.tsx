// @vitest-environment jsdom
/**
 * Google Messages Sync report: saved views (BACKLOG-4084 PR D, BACKLOG-3728).
 *
 * The api is a fake with the real method names; no Supabase client. Runs and
 * views are invented fixtures.
 *
 * S1 save under THIS report's key (not the iPhone report's), S2 remove a view,
 * S3 set/clear default, A1 apply = one navigation carrying filters AND period,
 * A2 same period = no navigation, M1 the active matcher includes the period,
 * C2 the default is never re-applied on the client (views load / navigation /
 * reload), C3 a default applied then the built-in period picked -> the URL
 * carries period=, D1 the server-resolved default seeds the filters.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { resolvePeriod, type PeriodRange } from '@/lib/reports/period';
import {
  buildGoogleMessagesSyncReport,
  GM_EMPTY_FILTERS,
  type GmFilters,
  type GmSyncOutcomeRow,
} from '@/lib/reports/google-messages-sync';
import type { GmViewsApi } from '@/lib/reports/google-messages-sync-views-api';
import type { GmSavedView } from '@/lib/reports/google-messages-sync-views';
import { GoogleMessagesSyncReport } from '../GoogleMessagesSyncReport';

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const NOW = new Date('2026-10-04T12:00:00.000Z');
const THIS_WEEK = resolvePeriod({ period: 'week' }, NOW);
const THIS_MONTH = resolvePeriod({ period: 'month' }, NOW);
const LAST_MONTH = resolvePeriod({ period: 'last-month' }, NOW);

function row(over: Partial<GmSyncOutcomeRow>): GmSyncOutcomeRow {
  return {
    id: 'run-1',
    user_id: 'user-a',
    created_at: '2026-10-01T10:00:00.000Z',
    source: 'google-messages',
    outcome: 'complete',
    elapsed_ms: 100_000,
    phases: [],
    app_version: '2.38.1',
    platform: 'win32',
    is_packaged: true,
    run_kind: 'sync',
    ...over,
  };
}

const USERS = [
  { id: 'user-a', email: 'agent.a@example.test', display_name: 'Agent A' },
  { id: 'user-b', email: 'agent.b@example.test', display_name: 'Agent B' },
];
const ROWS = [
  row({ id: 'run-1' }),
  row({ id: 'run-2', outcome: 'error', reason_code: 'phone_unreachable', created_at: '2026-10-02T10:00:00.000Z' }),
  row({ id: 'run-3', run_kind: 'retry', platform: 'darwin', user_id: 'user-b', created_at: '2026-10-03T10:00:00.000Z' }),
  row({ id: 'run-4', outcome: 'cancelled', user_id: 'user-b', created_at: '2026-10-03T11:00:00.000Z' }),
];
const REPORT = buildGoogleMessagesSyncReport(ROWS, USERS);

const filtersOf = (over: Partial<GmFilters>): GmFilters => ({ ...GM_EMPTY_FILTERS, ...over });

const ERRORS_MONTH: GmSavedView = {
  id: 'view-gm-1',
  name: 'Errors this month',
  filters: filtersOf({ outcomes: ['error'] }),
  period: { key: 'month' },
  isDefault: false,
};
const MAC_WEEK: GmSavedView = {
  id: 'view-gm-2',
  name: 'Mac this week',
  filters: filtersOf({ platforms: ['darwin'] }),
  period: { key: 'week' },
  isDefault: false,
};
const AGENT_B_DEFAULT: GmSavedView = {
  id: 'view-default-1',
  name: 'Agent B default',
  filters: filtersOf({ search: 'agent b' }),
  period: { key: 'last-month' },
  isDefault: true,
};
const ALL_VIEWS = [ERRORS_MONTH, MAC_WEEK, AGENT_B_DEFAULT];

function fakeApi(rows: GmSavedView[] = ALL_VIEWS) {
  return {
    list: vi.fn().mockResolvedValue(rows),
    save: vi.fn().mockResolvedValue({ id: 'view-new-1' }),
    remove: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  } satisfies GmViewsApi;
}

interface MountOpts {
  api?: ReturnType<typeof fakeApi>;
  period?: PeriodRange;
  initialView?: GmSavedView | null;
}

function mount({ api = fakeApi(), period = THIS_WEEK, initialView = null }: MountOpts = {}) {
  const onNavigate = vi.fn();
  const el = (p: PeriodRange, iv: GmSavedView | null) => (
    <GoogleMessagesSyncReport
      report={REPORT}
      period={p}
      rowCap={200}
      onNavigate={onNavigate}
      initialView={iv}
      viewsApi={api}
    />
  );
  const utils = render(el(period, initialView));
  return {
    api,
    onNavigate,
    rerender: (p: PeriodRange, iv: GmSavedView | null = null) => utils.rerender(el(p, iv)),
  };
}

const rowIds = () => [...document.querySelectorAll('[data-run-id]')].map((el) => el.getAttribute('data-run-id')).sort();
const viewsTrigger = () => screen.getByRole('button', { name: /^Views/ });
const panel = () => screen.getByRole('dialog', { name: 'Saved views' });
const searchBox = () => screen.getByLabelText('Search by user') as HTMLInputElement;

async function openViews(api: ReturnType<typeof fakeApi>) {
  await waitFor(() => expect(api.list).toHaveBeenCalled());
  if (!screen.queryByRole('dialog', { name: 'Saved views' })) fireEvent.click(viewsTrigger());
  await waitFor(() => expect(viewRow('Errors this month')).toBeTruthy());
}
const viewRow = (name: string) =>
  within(panel())
    .getAllByRole('button', { name: new RegExp(`^${name}`) })
    .find((b) => b.getAttribute('data-slot') === 'saved-views-row')!;

describe('S1 save', () => {
  it('saves the current filters and the server-resolved period under the google-messages-sync key', async () => {
    const { api } = mount({ period: LAST_MONTH });
    fireEvent.change(searchBox(), { target: { value: '  agent a  ' } });
    await openViews(api);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Save current view' }));
    fireEvent.change(within(panel()).getByRole('textbox', { name: 'View name' }), { target: { value: '  Mine  ' } });
    expect(within(panel()).getByText('Saves the filters and the time range.')).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save).toHaveBeenCalledWith({
      reportKey: 'google-messages-sync',
      name: 'Mine',
      filters: { types: [], outcomes: [], platforms: [], search: 'agent a', period: { key: 'last-month' } },
      metric: { col: 'runs', fn: 'count' },
      pinned: false,
    });
  });

  it('lists under its own key, not the iPhone sync key', async () => {
    const { api } = mount();
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(api.list).toHaveBeenCalledWith('google-messages-sync');
    expect(api.list).not.toHaveBeenCalledWith('iphone-sync');
  });
});

describe('S2 remove a view', () => {
  it('removes by id and applies nothing', async () => {
    const { api, onNavigate } = mount();
    await openViews(api);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Delete Errors this month' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(ERRORS_MONTH.id));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(rowIds()).toEqual(['run-1', 'run-2', 'run-3', 'run-4']);
  });
});

describe('S3 default', () => {
  it('makes a view the default by id, and clears the current default with null', async () => {
    const { api } = mount();
    await openViews(api);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Make Mac this week the default' }));
    await waitFor(() => expect(api.setDefault).toHaveBeenCalledWith('google-messages-sync', MAC_WEEK.id));
    await openViews(api);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Stop opening Agent B default by default' }));
    await waitFor(() => expect(api.setDefault).toHaveBeenLastCalledWith('google-messages-sync', null));
  });
});

describe('A1 applying a view: filters at once, period in ONE navigation', () => {
  it('navigates exactly once to the view period and keeps its filters across the new period', async () => {
    const { api, onNavigate, rerender } = mount();
    await openViews(api);
    fireEvent.click(viewRow('Errors this month'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0][0]).toBe('?period=month');
    expect(rowIds()).toEqual(['run-2']);

    // The server re-renders with the new period and (explicit URL) no initial view.
    rerender(THIS_MONTH, null);
    expect(rowIds()).toEqual(['run-2']);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    await openViews(api);
    expect(viewRow('Errors this month').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('A2 a view on the page period navigates nowhere', () => {
  it('applies the filters with zero navigations', async () => {
    const { api, onNavigate } = mount();
    await openViews(api);
    fireEvent.click(viewRow('Mac this week'));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(rowIds()).toEqual(['run-3']);
  });
});

describe('M1 the active view matches filters AND period', () => {
  it('same filters on another period is not active; on its period it is', async () => {
    const { api, rerender } = mount();
    await openViews(api);
    fireEvent.click(viewRow('Errors this month')); // filters now errors, page still this week
    await openViews(api);
    expect(viewRow('Errors this month').getAttribute('aria-pressed')).toBe('false');
    rerender(THIS_MONTH, null);
    await openViews(api);
    expect(viewRow('Errors this month').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('C2 the default is never re-applied on the client', () => {
  it('explicit URL (no initial view): views loading with a default changes nothing', async () => {
    const { api, onNavigate } = mount();
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    await openViews(api);
    expect(rowIds()).toHaveLength(4);
    expect(searchBox().value).toBe('');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('seeded default survives a new period, a null initial view and a reload of the views', async () => {
    const { api, onNavigate, rerender } = mount({ initialView: AGENT_B_DEFAULT, period: LAST_MONTH });
    expect(rowIds()).toEqual(['run-3', 'run-4']);
    await openViews(api);
    rerender(THIS_MONTH, null);
    expect(rowIds()).toEqual(['run-3', 'run-4']);
    // A write bumps the reload token -> list() again.
    fireEvent.click(within(panel()).getByRole('button', { name: 'Make Mac this week the default' }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(rowIds()).toEqual(['run-3', 'run-4']);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('C3 after a default, picking the built-in period writes period= explicitly', () => {
  it('This week -> ?period=week', async () => {
    const { onNavigate } = mount({ initialView: AGENT_B_DEFAULT, period: LAST_MONTH });
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'week' } });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0][0]).toContain('period=week');
  });
});

describe('D1 the server-resolved default seeds the filters', () => {
  it('rows and search box follow the default view', async () => {
    const { api } = mount({ initialView: AGENT_B_DEFAULT, period: LAST_MONTH });
    expect(rowIds()).toEqual(['run-3', 'run-4']);
    expect(searchBox().value).toBe('agent b');
    await openViews(api);
    expect(viewRow('Agent B default').getAttribute('aria-pressed')).toBe('true');
  });
});
