// @vitest-environment jsdom
/**
 * User Activity report: saved views (BACKLOG-4084 PR C).
 *
 * The api is a fake with the real method names; no Supabase client. Views are
 * invented fixtures over the user-activity fixture rows (Alice, Bob, Carol).
 *
 * S1 save, S2 remove a view, S3 set/clear default, A1 apply = one navigation
 * carrying filters AND period, A2 same period = no navigation, M1 the active
 * matcher includes the period, C2 the default is never re-applied on the client
 * (views load / navigation / reload), C3 a default applied then the built-in
 * period picked -> the URL carries period=, D1 the server-resolved default
 * seeds the filters.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildUserActivityReport } from '@/lib/reports/user-activity';
import { resolvePeriod, type PeriodRange } from '@/lib/reports/period';
import type { UserActivityViewsApi } from '@/lib/reports/user-activity-views-api';
import type { UserActivitySavedView } from '@/lib/reports/user-activity-views';
import {
  ALICE,
  BOB,
  CAROL,
  DEVICES,
  EVENTS,
  LAST_WEEK,
  MEMBERSHIPS,
  NOW,
  ORGS,
  STAFF_IDS,
  USERS,
} from '@/lib/reports/__tests__/user-activity.fixture';
import { UserActivityReport } from '../UserActivityReport';

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const REPORT = buildUserActivityReport({
  users: USERS,
  devices: DEVICES,
  events: EVENTS,
  memberships: MEMBERSHIPS,
  orgs: ORGS,
  staffIds: STAFF_IDS,
});
const THIS_MONTH = resolvePeriod({ period: 'month' }, NOW);
const LAST_MONTH = resolvePeriod({ period: 'last-month' }, NOW);

const vid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const BETA_MONTH: UserActivitySavedView = {
  id: vid(4001),
  name: 'Beta this month',
  filters: { orgs: ['Beta Homes'], activeOnly: false, search: '' },
  period: { key: 'month' },
  isDefault: false,
};
const ACME_LAST_WEEK: UserActivitySavedView = {
  id: vid(4002),
  name: 'Acme last week',
  filters: { orgs: ['Acme Realty'], activeOnly: false, search: '' },
  period: { key: 'last-week' },
  isDefault: false,
};
const ALICE_DEFAULT: UserActivitySavedView = {
  id: vid(4003),
  name: 'Alice default',
  filters: { orgs: [], activeOnly: false, search: 'alice' },
  period: { key: 'last-month' },
  isDefault: true,
};
const ALL_VIEWS = [BETA_MONTH, ACME_LAST_WEEK, ALICE_DEFAULT];

function fakeApi(rows: UserActivitySavedView[] = ALL_VIEWS) {
  return {
    list: vi.fn().mockResolvedValue(rows),
    save: vi.fn().mockResolvedValue({ id: vid(4999) }),
    remove: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  } satisfies UserActivityViewsApi;
}

interface MountOpts {
  api?: ReturnType<typeof fakeApi>;
  period?: PeriodRange;
  initialView?: UserActivitySavedView | null;
}

function mount({ api = fakeApi(), period = LAST_WEEK, initialView = null }: MountOpts = {}) {
  const onNavigate = vi.fn();
  const el = (p: PeriodRange, iv: UserActivitySavedView | null) => (
    <UserActivityReport
      report={REPORT}
      period={p}
      rowCap={20000}
      onNavigate={onNavigate}
      initialView={iv}
      viewsApi={api}
    />
  );
  const utils = render(el(period, initialView));
  return {
    api,
    onNavigate,
    rerender: (p: PeriodRange, iv: UserActivitySavedView | null = null) => utils.rerender(el(p, iv)),
  };
}

const rowIds = () =>
  [...document.querySelectorAll('[data-user-row]')].map((el) => el.getAttribute('data-user-row'));
const viewsTrigger = () => screen.getByRole('button', { name: /^Views/ });
const panel = () => screen.getByRole('dialog', { name: 'Saved views' });

async function openViews(api: ReturnType<typeof fakeApi>) {
  await waitFor(() => expect(api.list).toHaveBeenCalled());
  if (!screen.queryByRole('dialog', { name: 'Saved views' })) fireEvent.click(viewsTrigger());
  await waitFor(() => expect(viewRow('Beta this month')).toBeTruthy());
}
const viewRow = (name: string) =>
  within(panel())
    .getAllByRole('button', { name: new RegExp(`^${name}`) })
    .find((b) => b.getAttribute('data-slot') === 'saved-views-row')!;

describe('S1 save', () => {
  it('saves the current filters and the server-resolved period under the user-activity key', async () => {
    const { api } = mount();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Active in period only' }));
    await openViews(api);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Save current view' }));
    fireEvent.change(within(panel()).getByRole('textbox', { name: 'View name' }), { target: { value: '  Active  ' } });
    expect(within(panel()).getByText('Saves the filters and the time range.')).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save).toHaveBeenCalledWith({
      reportKey: 'user-activity',
      name: 'Active',
      filters: { orgs: [], activeOnly: true, search: '', period: { key: 'last-week' } },
      metric: { col: 'rows', fn: 'count' },
      pinned: false,
    });
  });
});

describe('S2 remove a view', () => {
  it('removes by id and applies nothing', async () => {
    const { api, onNavigate } = mount();
    await openViews(api);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Delete Beta this month' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(BETA_MONTH.id));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(rowIds()).toHaveLength(3);
  });
});

describe('S3 default', () => {
  it('makes a view the default by id, and clears the current default with null', async () => {
    const { api } = mount();
    await openViews(api);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Make Acme last week the default' }));
    await waitFor(() => expect(api.setDefault).toHaveBeenCalledWith('user-activity', ACME_LAST_WEEK.id));
    await openViews(api);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Stop opening Alice default by default' }));
    await waitFor(() => expect(api.setDefault).toHaveBeenLastCalledWith('user-activity', null));
  });
});

describe('A1 applying a view: filters at once, period in ONE navigation', () => {
  it('navigates exactly once to the view period and keeps its filters across the new period', async () => {
    const { api, onNavigate, rerender } = mount();
    await openViews(api);
    fireEvent.click(viewRow('Beta this month'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0][0]).toBe('?period=month');
    expect(rowIds()).toEqual([BOB]);

    // The server re-renders with the new period and (explicit URL) no initial view.
    rerender(THIS_MONTH, null);
    expect(rowIds()).toEqual([BOB]);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    await openViews(api);
    expect(viewRow('Beta this month').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('A2 a view on the page period navigates nowhere', () => {
  it('applies the filters with zero navigations', async () => {
    const { api, onNavigate } = mount();
    await openViews(api);
    fireEvent.click(viewRow('Acme last week'));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(rowIds()?.sort()).toEqual([ALICE, BOB].sort());
  });
});

describe('M1 the active view matches filters AND period', () => {
  it('same filters on another period is not active; on its period it is', async () => {
    const { api, rerender } = mount();
    await openViews(api);
    fireEvent.click(viewRow('Beta this month')); // filters now Beta Homes, page still last week
    await openViews(api);
    expect(viewRow('Beta this month').getAttribute('aria-pressed')).toBe('false');
    rerender(THIS_MONTH, null);
    await openViews(api);
    expect(viewRow('Beta this month').getAttribute('aria-pressed')).toBe('true');
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
    expect(rowIds()).toHaveLength(3);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('seeded default survives a new period, a null initial view and a reload of the views', async () => {
    const { api, onNavigate, rerender } = mount({ initialView: ALICE_DEFAULT, period: LAST_MONTH });
    expect(rowIds()).toEqual([ALICE]);
    await openViews(api);
    rerender(THIS_MONTH, null);
    expect(rowIds()).toEqual([ALICE]);
    // A write bumps the reload token -> list() again.
    fireEvent.click(within(panel()).getByRole('button', { name: 'Make Acme last week the default' }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(rowIds()).toEqual([ALICE]);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('C3 after a default, picking the built-in period writes period= explicitly', () => {
  it('This week -> ?period=week', async () => {
    const { onNavigate } = mount({ initialView: ALICE_DEFAULT, period: LAST_MONTH });
    fireEvent.click(screen.getAllByRole('button', { name: /^Period/ })[0]);
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Period' })).getByRole('option', { name: 'This week' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0][0]).toContain('period=week');
  });
});

describe('D1 the server-resolved default seeds the filters', () => {
  it('rows and search box follow the default view', async () => {
    const { api } = mount({ initialView: ALICE_DEFAULT, period: LAST_MONTH });
    expect(rowIds()).toEqual([ALICE]);
    expect((screen.getByRole('searchbox', { name: 'Search by name or email' }) as HTMLInputElement).value).toBe('alice');
    await openViews(api);
    expect(viewRow('Alice default').getAttribute('aria-pressed')).toBe('true');
    expect(rowIds()).not.toContain(CAROL);
  });
});
