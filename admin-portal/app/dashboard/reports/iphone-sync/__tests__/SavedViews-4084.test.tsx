// @vitest-environment jsdom

/**
 * iPhone Sync on the kit SavedViews: time range, default view, cards vs list
 * (BACKLOG-4084 PR E)
 *
 * SR ruling: a pinned card's value follows the page period and clicking it
 * applies its FILTERS only; picking the view from the Views list applies its
 * filters AND its period, with at most one navigation.
 *
 * Rows are in the `report_list_saved_views` shape and go through the real
 * parser. Ids are invented.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIphoneSyncReport } from '@/lib/reports/iphone-sync';
import { resolvePeriod, type PeriodRange } from '@/lib/reports/period';
import { DEFAULT_CLIENT_STATE, type ClientState } from '@/lib/reports/report-url';
import { parseSavedViews } from '@/lib/reports/report-views';
import type { ReportViewsApi } from '@/lib/reports/report-views-api';
import { FIXTURE_ROWS_24, FIXTURE_USERS_24 } from '@/lib/reports/__tests__/iphone-sync.fixture';
import { IphoneSyncReport } from '../IphoneSyncReport';

const NOW = new Date('2026-09-19T22:07:00.000Z');
const WEEK = resolvePeriod({ period: 'week' }, NOW);
const LAST_MONTH = resolvePeriod({ period: 'last-month' }, NOW);
const REPORT = buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24);

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState(null, '', '/dashboard/reports/iphone-sync');
});

function row(over: Record<string, unknown> = {}, period: unknown = { key: 'month' }) {
  return {
    id: 'view-errors-1',
    name: 'Errors',
    filters: { types: [], outcomes: ['error'], platforms: [], search: '', stalledOnly: false, period },
    metric: { col: 'runs', fn: 'count' },
    pinned: true,
    is_default: false,
    created_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function fakeApi(rows: unknown[]) {
  return {
    list: vi.fn().mockResolvedValue(parseSavedViews(rows)),
    save: vi.fn().mockResolvedValue({ id: 'view-new-1' }),
    remove: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  } satisfies ReportViewsApi;
}

function element(api: ReportViewsApi, onNavigate: (url: string) => void, period: PeriodRange, state: ClientState) {
  return (
    <IphoneSyncReport
      report={REPORT}
      period={period}
      rowCap={200}
      initialState={state}
      onNavigate={onNavigate}
      viewsApi={api}
    />
  );
}

function mount(
  api: ReportViewsApi,
  { period = WEEK, state = DEFAULT_CLIENT_STATE }: { period?: PeriodRange; state?: ClientState } = {}
) {
  const onNavigate = vi.fn();
  const result = render(element(api, onNavigate, period, state));
  return { ...result, onNavigate };
}

const caption = () =>
  [...document.querySelectorAll('p')].find((p) => p.textContent?.startsWith('Every card, chart and row'))
    ?.textContent ?? '';

async function openViews() {
  fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
  return screen.findByRole('list', { name: 'Saved views' });
}

function listRow(name: string): HTMLElement {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="saved-views-row"]')];
  const found = rows.find((r) => r.textContent?.includes(name));
  if (!found) throw new Error(`no row ${name}`);
  return found;
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-view-id="${id}"]`);

const DEFAULT_VIEW_STATE: ClientState = {
  ...DEFAULT_CLIENT_STATE,
  filters: { types: [], outcomes: ['error'], platforms: [], search: '' },
};

describe('guards', () => {
  it('the fixture period labels differ and the filtered caption names the outcome', () => {
    expect(WEEK.label).not.toBe(LAST_MONTH.label);
    mount(fakeApi([]), { state: DEFAULT_VIEW_STATE });
    expect(caption()).toContain('outcome: error');
  });
});

describe('PIN togglePin keeps filters.period', () => {
  it('re-saves the same id with the stored period and only pinned flipped', async () => {
    const api = fakeApi([row({ pinned: false })]);
    mount(api);
    await openViews();
    fireEvent.click(screen.getByRole('button', { name: 'Pin Errors as a card' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    const payload = api.save.mock.calls[0][0];
    expect(payload.id).toBe('view-errors-1');
    expect(payload.pinned).toBe(true);
    expect(payload.filters.period).toEqual({ key: 'month' });
    expect(payload.filters.outcomes).toEqual(['error']);
  });
});

describe('URL the client URL always carries the rendered period', () => {
  it('U1 after a default view opened the page, a filter toggle keeps period=last-month', async () => {
    const api = fakeApi([row({ is_default: true }, { key: 'last-month' })]);
    mount(api, { period: LAST_MONTH, state: DEFAULT_VIEW_STATE });
    expect(new URLSearchParams(window.location.search).get('period')).toBe('last-month');
    fireEvent.click(screen.getByRole('button', { name: /Stalled/ }));
    const params = new URLSearchParams(window.location.search);
    expect(params.get('stalled')).toBe('1');
    expect(params.get('outcome')).toBe('error');
    expect(params.get('period')).toBe('last-month');
  });

  it('U2 a custom period keeps both dates', () => {
    const custom = resolvePeriod({ period: 'custom', from: '2026-09-01', to: '2026-09-05' }, NOW);
    mount(fakeApi([]), { period: custom });
    fireEvent.click(screen.getByRole('button', { name: /Stalled/ }));
    const params = new URLSearchParams(window.location.search);
    expect([params.get('period'), params.get('from'), params.get('to')]).toEqual([
      'custom',
      '2026-09-01',
      '2026-09-05',
    ]);
  });
});

describe('CARD clicking a pinned card applies its filters only', () => {
  it('no navigation, filters applied, card active, list row NOT active (period differs)', async () => {
    const api = fakeApi([row()]);
    const { onNavigate } = mount(api);
    await waitFor(() => expect(card('view-errors-1')).not.toBeNull());
    fireEvent.click(card('view-errors-1') as HTMLElement);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(caption()).toContain(WEEK.label);
    expect(caption()).toContain('outcome: error');
    expect(card('view-errors-1')?.getAttribute('aria-pressed')).toBe('true');
    await openViews();
    expect(listRow('Errors').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('LIST picking a view from the Views list applies filters and period', () => {
  it('L1 navigates exactly once, to a URL built from the VIEW filters and its period', async () => {
    const api = fakeApi([row()]);
    const { onNavigate } = mount(api);
    // Narrow the page first, so a URL built from the current search would carry stalled=1.
    fireEvent.click(screen.getByRole('button', { name: /Stalled/ }));
    await openViews();
    fireEvent.click(listRow('Errors'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(String(onNavigate.mock.calls[0][0]).replace(/^\?/, ''));
    expect(params.get('period')).toBe('month');
    expect(params.get('outcome')).toBe('error');
    expect(params.get('stalled')).toBeNull();
    expect(caption()).toContain('outcome: error');
  });

  it('L2 a view whose period is the page period applies with zero navigations and is the active row', async () => {
    const api = fakeApi([row({}, { key: 'week' })]);
    const { onNavigate } = mount(api);
    await openViews();
    fireEvent.click(listRow('Errors'));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(caption()).toContain('outcome: error');
    await openViews();
    expect(listRow('Errors').getAttribute('aria-pressed')).toBe('true');
  });

  it('L3 a view saved with no period applies its filters and keeps the page period', async () => {
    const api = fakeApi([row({}, null)]);
    const { onNavigate } = mount(api);
    await openViews();
    fireEvent.click(listRow('Errors'));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(caption()).toContain('outcome: error');
  });
});

describe('MATCH the active list row compares the period', () => {
  it('same filters, other period -> row not active; same period -> active', async () => {
    const api = fakeApi([row({}, { key: 'month' }), row({ id: 'view-errors-2', name: 'Week errors' }, { key: 'week' })]);
    mount(api, { state: DEFAULT_VIEW_STATE });
    await openViews();
    expect(listRow('Errors').getAttribute('aria-pressed')).toBe('false');
    expect(listRow('Week errors').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('C2 the default is applied by the server only, never again on the client', () => {
  it('a new period, a plain initial state and a views reload change no filter and navigate nowhere', async () => {
    const api = fakeApi([row({ is_default: true }, { key: 'last-month' })]);
    const onNavigate = vi.fn();
    const { rerender } = render(element(api, onNavigate, LAST_MONTH, DEFAULT_VIEW_STATE));
    await openViews();
    // Clear the filters by hand, then let the server hand over a new period.
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /Stalled/ }));
    rerender(element(api, onNavigate, WEEK, DEFAULT_CLIENT_STATE));
    // Reload the views (a write re-reads the list).
    await openViews();
    fireEvent.click(screen.getByRole('button', { name: 'Stop opening Errors by default' }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(caption()).toContain(WEEK.label);
    expect(caption()).toContain('outcome: error');
    expect(new URLSearchParams(window.location.search).get('stalled')).toBe('1');
  });
});

describe('DEFAULT set, clear, marker; DELETE', () => {
  it('marks the default row and calls setDefault with the report key', async () => {
    const api = fakeApi([row({ is_default: true }), row({ id: 'view-errors-2', name: 'Other' })]);
    mount(api);
    const list = await openViews();
    expect(list.querySelectorAll('[data-slot="saved-views-default-marker"]')).toHaveLength(1);
    expect(within(listRow('Errors')).getByText('Default')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make Other the default' }));
    await waitFor(() => expect(api.setDefault).toHaveBeenCalledWith('iphone-sync', 'view-errors-2'));
  });

  it('clears the default with null', async () => {
    const api = fakeApi([row({ is_default: true })]);
    mount(api);
    await openViews();
    fireEvent.click(screen.getByRole('button', { name: 'Stop opening Errors by default' }));
    await waitFor(() => expect(api.setDefault).toHaveBeenCalledWith('iphone-sync', null));
  });

  it('removes by id and applies nothing', async () => {
    const api = fakeApi([row()]);
    const { onNavigate } = mount(api);
    await openViews();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Errors' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('view-errors-1'));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(caption()).not.toContain('outcome: error');
  });
});

describe('SAVE stores the rendered period as a key', () => {
  it('a preset page saves { key } only', async () => {
    const api = fakeApi([]);
    mount(api, { period: LAST_MONTH });
    fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Save current view as a card/ }));
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: /Save and pin/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0][0].filters.period).toEqual({ key: 'last-month' });
  });
});
