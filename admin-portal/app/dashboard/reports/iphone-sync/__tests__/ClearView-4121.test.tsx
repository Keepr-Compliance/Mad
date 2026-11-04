// @vitest-environment jsdom

/**
 * iPhone sync: the applied-view chip's X resets to the BUILT-IN state
 * (BACKLOG-4121). Empty filters, the built-in period written into the URL,
 * the URL built from the CLEARED state (the live search string still holds
 * the old filters), and the card restore point forgotten.
 * Rows are in the `report_list_saved_views` shape; ids are invented.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPHONE_SYNC_URL_KEYS } from '@/lib/reports/default-view';
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

const ERRORS_ROW = {
  id: 'view-errors-1',
  name: 'Errors',
  filters: { types: [], outcomes: ['error'], platforms: [], search: '', stalledOnly: false, period: { key: 'last-month' } },
  metric: { col: 'runs', fn: 'count' },
  pinned: true,
  is_default: false,
  created_at: '2026-09-01T00:00:00.000Z',
};
const ALL_ROW = {
  ...ERRORS_ROW,
  id: 'view-all-1',
  name: 'All runs',
  filters: { types: [], outcomes: [], platforms: [], search: '', stalledOnly: false, period: { key: 'week' } },
};
const ERRORS_STATE: ClientState = {
  ...DEFAULT_CLIENT_STATE,
  filters: { types: [], outcomes: ['error'], platforms: [], search: '' },
};

function fakeApi(rows: unknown[]) {
  return {
    list: vi.fn().mockResolvedValue(parseSavedViews(rows)),
    save: vi.fn().mockResolvedValue({ id: 'view-new-1' }),
    remove: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  } satisfies ReportViewsApi;
}

function mount(rows: unknown[], period: PeriodRange, state: ClientState) {
  const onNavigate = vi.fn();
  render(
    <IphoneSyncReport
      report={REPORT}
      period={period}
      rowCap={200}
      initialState={state}
      onNavigate={onNavigate}
      viewsApi={fakeApi(rows)}
    />
  );
  return { onNavigate };
}

const caption = () =>
  [...document.querySelectorAll('p')].find((p) => p.textContent?.startsWith('Every card, chart and row'))
    ?.textContent ?? '';
const card = (id: string) => document.querySelector<HTMLElement>(`[data-view-id="${id}"]`);
const params = (url: string) => new URLSearchParams(url.replace(/^[^?]*\?/, ''));

describe('A-a X on a non-default view', () => {
  it('empties the filters and navigates once to period=week, with no filter key from the old state', async () => {
    const { onNavigate } = mount([ERRORS_ROW], LAST_MONTH, ERRORS_STATE);
    await screen.findByRole('button', { name: /^Views: Errors/ });
    // The mirror has written the old filters into the live URL.
    await waitFor(() => expect(window.location.search).toContain('outcome='));
    expect(caption()).not.toContain('no other filters');
    fireEvent.click(screen.getByRole('button', { name: 'Clear view Errors' }));
    expect(caption()).toContain('no other filters');
    expect(onNavigate).toHaveBeenCalledTimes(1);
    const p = params(onNavigate.mock.calls[0][0] as string);
    expect(p.get('period')).toBe('week');
    for (const key of IPHONE_SYNC_URL_KEYS) {
      if (key === 'sort' || key === 'dir') continue;
      expect(p.has(key), key).toBe(false);
    }
  });
});

describe('A-c pin a view, press X, toggle a card', () => {
  it('the filters stay empty (the restore point is forgotten)', async () => {
    mount([ERRORS_ROW, ALL_ROW], WEEK, ERRORS_STATE);
    await waitFor(() => expect(card('view-all-1')).not.toBeNull());
    // The card stores the Errors filters as its restore point.
    fireEvent.click(card('view-all-1') as HTMLElement);
    expect(caption()).toContain('no other filters');
    fireEvent.click(await screen.findByRole('button', { name: 'Clear view All runs' }));
    expect(caption()).toContain('no other filters');
    // Same card again: with a stale restore point this brings Errors back.
    fireEvent.click(card('view-all-1') as HTMLElement);
    expect(caption()).toContain('no other filters');
  });
});
