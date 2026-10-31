// @vitest-environment jsdom

/**
 * iPhone Sync saved views — pinning the shared defaults (BACKLOG-4004)
 *
 * BACKLOG-4004 makes `PinnedViewCards` and `ReportViewSelector` serve a second
 * report. Each gains an optional prop whose DEFAULT must stay exactly what the
 * iPhone Sync report shows today. The existing suites could not see a change
 * to any of these defaults (measured at SR plan review): their pinned cards
 * only use count metrics, and their saves always pick a column first.
 *
 * These tests were written, and proven red against each mutated default,
 * BEFORE the components were touched.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIphoneSyncReport } from '@/lib/reports/iphone-sync';
import { resolvePeriod } from '@/lib/reports/period';
import { DEFAULT_CLIENT_STATE } from '@/lib/reports/report-url';
import { parseSavedViews } from '@/lib/reports/report-views';
import type { ReportViewsApi } from '@/lib/reports/report-views-api';
import { FIXTURE_ROWS_24, FIXTURE_USERS_24 } from '@/lib/reports/__tests__/iphone-sync.fixture';
import { IphoneSyncReport } from '../IphoneSyncReport';

const NOW = new Date('2026-09-19T22:07:00.000Z');
const THIS_WEEK = resolvePeriod({}, NOW);

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function fakeApi(rows: unknown[]) {
  return {
    list: vi.fn().mockResolvedValue(parseSavedViews(rows)),
    save: vi.fn().mockResolvedValue({ id: 'new-id' }),
    remove: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  } satisfies ReportViewsApi;
}

function mount(api: ReportViewsApi) {
  return render(
    <IphoneSyncReport
      report={buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24)}
      period={THIS_WEEK}
      rowCap={200}
      initialState={DEFAULT_CLIENT_STATE}
      onNavigate={vi.fn()}
      viewsApi={api}
    />
  );
}

describe('a pinned card with a non-count metric', () => {
  const durationRow = {
    id: 'v-duration',
    name: 'Average duration',
    filters: { types: [], outcomes: [], platforms: [], search: '', stalledOnly: false },
    metric: { col: 'duration', fn: 'average' },
    pinned: true,
  };

  it('formats the value with its unit and one decimal', async () => {
    const { container } = mount(fakeApi([durationRow]));
    await waitFor(() =>
      expect(container.querySelector('[data-card-value="v-duration"]')).not.toBeNull()
    );
    const value = container.querySelector('[data-card-value="v-duration"]')?.textContent?.trim();
    expect(value).toMatch(/^\d[\d,]*\.\d min$/);
  });

  it('labels the card with the function and the column label', async () => {
    const { container } = mount(fakeApi([durationRow]));
    await waitFor(() =>
      expect(container.querySelector('[data-view-id="v-duration"]')).not.toBeNull()
    );
    const card = container.querySelector('[data-view-id="v-duration"]') as HTMLElement;
    expect(card.textContent).toContain('average · Duration (min)');
  });
});

describe('saving without touching Column or Function', () => {
  it('shows the iPhone filter sentence and saves count of runs', async () => {
    const api = fakeApi([]);
    mount(api);
    fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Save current view as a card/ }));
    expect(
      screen.getByText(
        'Saves the Type, Outcome, Platform, search and Stalled filters you have now — not the period. The card follows whichever period is selected.'
      )
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'Everything' } });
    fireEvent.click(screen.getByRole('button', { name: /Save and pin/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0][0]).toMatchObject({
      reportKey: 'iphone-sync',
      metric: { col: 'runs', fn: 'count' },
    });
  });
});
