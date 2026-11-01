// @vitest-environment jsdom
/**
 * Submissions report: saved views (BACKLOG-4084 PR D).
 *
 * The api is a fake with the real method names; no Supabase client. Views are
 * invented fixtures over the submissions fixture rows.
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
import { resolvePeriod, type PeriodRange } from '@/lib/reports/period';
import {
  applySubmissionFilters,
  buildOpenAttempts,
  buildSubmissionsReport,
  EMPTY_SUBMISSION_FILTERS,
  type SubmissionFilters,
} from '@/lib/reports/submissions';
import type { SubmissionsViewsApi } from '@/lib/reports/submissions-views-api';
import type { SubmissionsSavedView } from '@/lib/reports/submissions-views';
import {
  FIXTURE_ORGS,
  FIXTURE_USERS,
  NOW,
  OPEN_ROWS,
  PERIOD_ROWS,
} from '@/lib/reports/__tests__/submissions.fixture';
import { SubmissionsReport } from '../SubmissionsReport';

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const REPORT = buildSubmissionsReport(PERIOD_ROWS, FIXTURE_USERS, FIXTURE_ORGS, NOW);
const OPEN = buildOpenAttempts(OPEN_ROWS, FIXTURE_USERS, FIXTURE_ORGS, NOW);
const THIS_WEEK = resolvePeriod({ period: 'week' }, NOW);
const THIS_MONTH = resolvePeriod({ period: 'month' }, NOW);
const LAST_MONTH = resolvePeriod({ period: 'last-month' }, NOW);

const filtersOf = (over: Partial<SubmissionFilters>): SubmissionFilters => ({ ...EMPTY_SUBMISSION_FILTERS, ...over });

const FAILED_MONTH: SubmissionsSavedView = {
  id: 'view-sub-1',
  name: 'Failed this month',
  filters: filtersOf({ statuses: ['failed'] }),
  period: { key: 'month' },
  isDefault: false,
};
const OFFICE_B_WEEK: SubmissionsSavedView = {
  id: 'view-sub-2',
  name: 'Office B this week',
  filters: filtersOf({ orgs: ['org-b'] }),
  period: { key: 'week' },
  isDefault: false,
};
const AGENT_TWO_DEFAULT: SubmissionsSavedView = {
  id: 'view-default-1',
  name: 'Agent two default',
  filters: filtersOf({ search: 'agent.two' }),
  period: { key: 'last-month' },
  isDefault: true,
};
const ALL_VIEWS = [FAILED_MONTH, OFFICE_B_WEEK, AGENT_TWO_DEFAULT];

const expectedIds = (f: SubmissionFilters) => applySubmissionFilters(REPORT.submissions, f)
    .map((s) => s.submissionId)
    .sort();
const ALL_IDS = REPORT.submissions.map((s) => s.submissionId);

function fakeApi(rows: SubmissionsSavedView[] = ALL_VIEWS) {
  return {
    list: vi.fn().mockResolvedValue(rows),
    save: vi.fn().mockResolvedValue({ id: 'view-new-1' }),
    remove: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  } satisfies SubmissionsViewsApi;
}

interface MountOpts {
  api?: ReturnType<typeof fakeApi>;
  period?: PeriodRange;
  initialView?: SubmissionsSavedView | null;
}

function mount({ api = fakeApi(), period = THIS_WEEK, initialView = null }: MountOpts = {}) {
  const onNavigate = vi.fn();
  const el = (p: PeriodRange, iv: SubmissionsSavedView | null) => (
    <SubmissionsReport
      report={REPORT}
      openAttempts={OPEN}
      openCap={200}
      period={p}
      rowCap={500}
      onNavigate={onNavigate}
      initialView={iv}
      viewsApi={api}
    />
  );
  const utils = render(el(period, initialView));
  return {
    api,
    onNavigate,
    rerender: (p: PeriodRange, iv: SubmissionsSavedView | null = null) => utils.rerender(el(p, iv)),
  };
}

const rowIds = () =>
  [...document.querySelectorAll('[data-submission-row]')].map((el) => el.getAttribute('data-submission-row')).sort();
const viewsTrigger = () => screen.getByRole('button', { name: /^Views/ });
const panel = () => screen.getByRole('dialog', { name: 'Saved views' });
const searchBox = () => screen.getByLabelText('Search by submission id or agent email') as HTMLInputElement;

async function openViews(api: ReturnType<typeof fakeApi>) {
  await waitFor(() => expect(api.list).toHaveBeenCalled());
  if (!screen.queryByRole('dialog', { name: 'Saved views' })) fireEvent.click(viewsTrigger());
  await waitFor(() => expect(viewRow('Failed this month')).toBeTruthy());
}
const viewRow = (name: string) =>
  within(panel())
    .getAllByRole('button', { name: new RegExp(`^${name}`) })
    .find((b) => b.getAttribute('data-slot') === 'saved-views-row')!;

describe('fixture guards', () => {
  it('each view narrows the rows to a different, non-empty set', () => {
    for (const v of ALL_VIEWS) {
      const ids = expectedIds(v.filters);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.length).toBeLessThan(ALL_IDS.length);
    }
    expect(expectedIds(FAILED_MONTH.filters)).not.toEqual(expectedIds(OFFICE_B_WEEK.filters));
  });
});

describe('S1 save', () => {
  it('saves the current filters and the server-resolved period under the submissions key', async () => {
    const { api } = mount({ period: LAST_MONTH });
    fireEvent.change(searchBox(), { target: { value: '  agent.one  ' } });
    await openViews(api);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Save current view' }));
    fireEvent.change(within(panel()).getByRole('textbox', { name: 'View name' }), { target: { value: '  Mine  ' } });
    expect(within(panel()).getByText('Saves the filters and the time range.')).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save).toHaveBeenCalledWith({
      reportKey: 'submissions',
      name: 'Mine',
      filters: {
        statuses: [],
        orgs: [],
        agents: [],
        reasons: [],
        platforms: [],
        search: 'agent.one',
        period: { key: 'last-month' },
      },
      metric: { col: 'attempts', fn: 'count' },
      pinned: false,
    });
  });
});

describe('S2 remove a view', () => {
  it('removes by id and applies nothing', async () => {
    const { api, onNavigate } = mount();
    await openViews(api);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Delete Failed this month' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(FAILED_MONTH.id));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(rowIds()).toEqual(expect.arrayContaining(ALL_IDS));
    expect(rowIds()).toHaveLength(ALL_IDS.length);
  });
});

describe('S3 default', () => {
  it('makes a view the default by id, and clears the current default with null', async () => {
    const { api } = mount();
    await openViews(api);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Make Office B this week the default' }));
    await waitFor(() => expect(api.setDefault).toHaveBeenCalledWith('submissions', OFFICE_B_WEEK.id));
    await openViews(api);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Stop opening Agent two default by default' }));
    await waitFor(() => expect(api.setDefault).toHaveBeenLastCalledWith('submissions', null));
  });
});

describe('A1 applying a view: filters at once, period in ONE navigation', () => {
  it('navigates exactly once to the view period and keeps its filters across the new period', async () => {
    const { api, onNavigate, rerender } = mount();
    await openViews(api);
    fireEvent.click(viewRow('Failed this month'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0][0]).toBe('?period=month');
    expect(rowIds()).toEqual(expectedIds(FAILED_MONTH.filters));

    // The server re-renders with the new period and (explicit URL) no initial view.
    rerender(THIS_MONTH, null);
    expect(rowIds()).toEqual(expectedIds(FAILED_MONTH.filters));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    await openViews(api);
    expect(viewRow('Failed this month').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('A2 a view on the page period navigates nowhere', () => {
  it('applies the filters with zero navigations', async () => {
    const { api, onNavigate } = mount();
    await openViews(api);
    fireEvent.click(viewRow('Office B this week'));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(rowIds()).toEqual(expectedIds(OFFICE_B_WEEK.filters));
  });
});

describe('M1 the active view matches filters AND period', () => {
  it('same filters on another period is not active; on its period it is', async () => {
    const { api, rerender } = mount();
    await openViews(api);
    fireEvent.click(viewRow('Failed this month')); // filters now Failed, page still this week
    await openViews(api);
    expect(viewRow('Failed this month').getAttribute('aria-pressed')).toBe('false');
    rerender(THIS_MONTH, null);
    await openViews(api);
    expect(viewRow('Failed this month').getAttribute('aria-pressed')).toBe('true');
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
    expect(rowIds()).toHaveLength(ALL_IDS.length);
    expect(searchBox().value).toBe('');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('seeded default survives a new period, a null initial view and a reload of the views', async () => {
    const { api, onNavigate, rerender } = mount({ initialView: AGENT_TWO_DEFAULT, period: LAST_MONTH });
    const seeded = expectedIds(AGENT_TWO_DEFAULT.filters);
    expect(rowIds()).toEqual(seeded);
    await openViews(api);
    rerender(THIS_MONTH, null);
    expect(rowIds()).toEqual(seeded);
    // A write bumps the reload token -> list() again.
    fireEvent.click(within(panel()).getByRole('button', { name: 'Make Office B this week the default' }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(rowIds()).toEqual(seeded);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('C3 after a default, picking the built-in period writes period= explicitly', () => {
  it('This week -> ?period=week', async () => {
    const { onNavigate } = mount({ initialView: AGENT_TWO_DEFAULT, period: LAST_MONTH });
    fireEvent.click(screen.getAllByRole('button', { name: /^Period/ })[0]);
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Period' })).getByRole('option', { name: 'This week' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0][0]).toContain('period=week');
  });
});

describe('D1 the server-resolved default seeds the filters', () => {
  it('rows and search box follow the default view', async () => {
    const { api } = mount({ initialView: AGENT_TWO_DEFAULT, period: LAST_MONTH });
    expect(rowIds()).toEqual(expectedIds(AGENT_TWO_DEFAULT.filters));
    expect(searchBox().value).toBe('agent.two');
    await openViews(api);
    expect(viewRow('Agent two default').getAttribute('aria-pressed')).toBe('true');
  });
});
