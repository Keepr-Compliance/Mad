// @vitest-environment jsdom

/**
 * Saved views and pinned cards — the wiring (BACKLOG-3450 PR 2)
 *
 * The one-line environment directive at the top of this file is what makes it
 * run in a DOM, and it is load-bearing: delete it and every test below fails to
 * render. It is per-file on purpose — a global switch in vitest.config.ts would
 * drag all the other suites into a DOM for no reason.
 *
 * Do not repeat that directive anywhere else in this file, including inside a
 * comment. Vitest scans the whole file for it, so a second mention in prose
 * keeps the DOM alive even when the real one at the top has been removed —
 * which silently turns any control over it into a false green. That happened
 * once already, on PR 1.
 *
 * `IphoneSyncReport` takes BOTH navigation and the saved-view RPCs as props,
 * so there is no router to mock and no Supabase client anywhere near this file.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIphoneSyncReport } from '@/lib/reports/iphone-sync';
import { resolvePeriod } from '@/lib/reports/period';
import { DEFAULT_CLIENT_STATE } from '@/lib/reports/report-url';
import { MAX_PINNED, type ReportSavedView } from '@/lib/reports/report-views';
import type { ReportViewsApi } from '@/lib/reports/report-views-api';
import { FIXTURE_ROWS_24, FIXTURE_USERS_24 } from '@/lib/reports/__tests__/iphone-sync.fixture';
import { IphoneSyncReport } from '../IphoneSyncReport';

const NOW = new Date('2026-09-19T22:07:00.000Z');
const THIS_WEEK = resolvePeriod({}, NOW);

afterEach(cleanup);

// Silenced deliberately: the fail-closed path logs, and a console.error in a
// passing test reads as a broken test.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** A row as the RPC returns it, before `parseSavedViews` touches it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'v-errors',
    name: 'Errors',
    filters: { types: [], outcomes: ['error'], platforms: [], search: '', stalledOnly: false },
    metric: { col: 'runs', fn: 'count' },
    pinned: true,
    ...over,
  };
}

function fakeApi(rows: unknown[] = [row()]): ReportViewsApi & {
  save: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  // The real api parses; the fake mirrors that so the component sees the same
  // shape it will see in the browser.
  const parse = (raw: unknown[]): ReportSavedView[] =>
    raw.map((entry) => {
      const r = entry as Record<string, unknown>;
      const f = (r.filters ?? {}) as Record<string, unknown>;
      return {
        id: r.id as string,
        name: r.name as string,
        filters: {
          types: (f.types ?? []) as ReportSavedView['filters']['types'],
          outcomes: (f.outcomes ?? []) as string[],
          platforms: (f.platforms ?? []) as string[],
          search: (f.search ?? '') as string,
        },
        stalledOnly: f.stalledOnly === true,
        metric: r.metric as ReportSavedView['metric'],
        pinned: r.pinned === true,
      };
    });
  return {
    list: vi.fn().mockResolvedValue(parse(rows)),
    save: vi.fn().mockResolvedValue({ id: 'new-id' }),
    remove: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function mount({
  rows = FIXTURE_ROWS_24,
  period = THIS_WEEK,
  api,
}: { rows?: typeof FIXTURE_ROWS_24; period?: typeof THIS_WEEK; api?: ReportViewsApi } = {}) {
  const result = render(
    <IphoneSyncReport
      report={buildIphoneSyncReport(rows, FIXTURE_USERS_24)}
      period={period}
      rowCap={200}
      initialState={DEFAULT_CLIENT_STATE}
      onNavigate={vi.fn()}
      viewsApi={api}
    />
  );
  return result;
}

function openViews() {
  fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
}

function tileValue(container: HTMLElement, label: string): string {
  const labelEl = [...container.querySelectorAll('p')].find(
    (p) => p.textContent?.trim() === label && p.parentElement?.tagName !== 'DIV'
  );
  const found =
    labelEl ??
    [...container.querySelectorAll('p')].find((p) => p.textContent?.trim() === label);
  return (found?.nextElementSibling as HTMLElement)?.textContent?.trim() ?? '';
}

function cardText(container: HTMLElement, id: string): string {
  return container.querySelector(`[data-card-value="${id}"]`)?.textContent?.trim() ?? '';
}

function cardIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-view-id]')].map(
    (el) => el.getAttribute('data-view-id') as string
  );
}

const ERRORS_IN_FIXTURE = buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24).runs.filter(
  (r) => r.outcome === 'error'
).length;

describe('the harness itself', () => {
  it('reaches the views list through a real effect — otherwise everything below is vacuous', async () => {
    const api = fakeApi();
    const { container } = mount({ api });
    await waitFor(() => expect(cardIds(container)).toEqual(['v-errors']));
    expect(api.list).toHaveBeenCalledWith('iphone-sync');
  });
});

describe('fails closed when the migration has not been applied', () => {
  // The exact PostgREST shape for a function that is not in the schema cache.
  // This is the live state of every deployment between this PR merging and the
  // founder applying its migration.
  const missingFunction = Object.assign(
    new Error(
      'Could not find the function public.report_list_saved_views(p_report_key) in the schema cache'
    ),
    { code: 'PGRST202' }
  );

  it('says so in the dropdown and still renders the whole report', async () => {
    const api = { ...fakeApi(), list: vi.fn().mockRejectedValue(missingFunction) } as ReportViewsApi;
    const { container } = mount({ api });

    openViews();
    expect(await screen.findByText('Saved views are not available yet.')).toBeTruthy();

    // The rest of the page is untouched: tiles, charts and rows all present.
    expect(tileValue(container, 'Finished')).toBe('24');
    expect(container.querySelectorAll('[data-run-id]')).toHaveLength(5);
    expect(container.querySelectorAll('svg[viewBox="0 0 600 200"]')).toHaveLength(2);
    // No cards, and no save form to write into a table that does not exist.
    expect(cardIds(container)).toEqual([]);
    expect(screen.queryByRole('button', { name: /Save current view as a card/ })).toBeNull();
  });

  it('says the same thing when no api is wired at all', async () => {
    const { container } = mount({});
    openViews();
    expect(await screen.findByText('Saved views are not available yet.')).toBeTruthy();
    expect(cardIds(container)).toEqual([]);
  });

  it('distinguishes "could not read" from "there are none"', async () => {
    const api = fakeApi([]);
    mount({ api });
    openViews();
    expect(await screen.findByText('No saved views yet')).toBeTruthy();
    expect(screen.queryByText('Saved views are not available yet.')).toBeNull();
  });
});

describe('a pinned card', () => {
  it('shows ITS OWN filters and leaves the page`s alone until it is clicked', async () => {
    const api = fakeApi();
    const { container } = mount({ api });
    await waitFor(() => expect(cardIds(container)).toEqual(['v-errors']));

    // The card counts the errors...
    expect(ERRORS_IN_FIXTURE).toBeGreaterThan(0);
    expect(ERRORS_IN_FIXTURE).toBeLessThan(24);
    expect(cardText(container, 'v-errors')).toBe(String(ERRORS_IN_FIXTURE));

    // ...and the page is still showing everything. A card that leaked its
    // filters into the page would have narrowed these.
    expect(tileValue(container, 'Finished')).toBe('24');
    expect(container.querySelectorAll('[data-run-id]')).toHaveLength(5);
  });

  it('IGNORES the page`s own filters — it counts over the period, not over the page', async () => {
    const api = fakeApi();
    const { container } = mount({ api });
    await waitFor(() => expect(cardIds(container)).toEqual(['v-errors']));

    // Narrow the PAGE to something the card did not save. If the card read the
    // page's filtered rows it would now show errors AND stalled, which is
    // fewer — and it would be contradicting its own label.
    fireEvent.click(screen.getByRole('button', { name: /Stalled/ }));
    const bothCount = buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24).runs.filter(
      (r) => r.outcome === 'error' && r.stalled
    ).length;
    expect(bothCount).not.toBe(ERRORS_IN_FIXTURE);

    expect(cardText(container, 'v-errors')).toBe(String(ERRORS_IN_FIXTURE));
  });

  it('applies its filters on click and puts the page back on a second click', async () => {
    const api = fakeApi();
    const { container } = mount({ api });
    await waitFor(() => expect(cardIds(container)).toEqual(['v-errors']));
    const card = () => container.querySelector('[data-view-id="v-errors"]') as HTMLElement;

    expect(card().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(card());
    expect(tileValue(container, 'Finished')).toBe(String(ERRORS_IN_FIXTURE));
    expect(tileValue(container, 'Errored')).toBe(String(ERRORS_IN_FIXTURE));
    expect(card().getAttribute('aria-pressed')).toBe('true');
    // The card itself does not move — it was already counting only errors.
    expect(cardText(container, 'v-errors')).toBe(String(ERRORS_IN_FIXTURE));

    fireEvent.click(card());
    expect(tileValue(container, 'Finished')).toBe('24');
    expect(card().getAttribute('aria-pressed')).toBe('false');
  });

  it('restores what the page was showing before the card, not merely "everything"', async () => {
    const api = fakeApi();
    const { container } = mount({ api });
    await waitFor(() => expect(cardIds(container)).toEqual(['v-errors']));

    // Narrow the page by hand first: the Stalled tile.
    fireEvent.click(screen.getByRole('button', { name: /Stalled/ }));
    const stalledRows = container.querySelectorAll('[data-run-id]').length;
    expect(stalledRows).toBeGreaterThan(0);

    const card = () => container.querySelector('[data-view-id="v-errors"]') as HTMLElement;
    fireEvent.click(card());
    expect(tileValue(container, 'Finished')).toBe(String(ERRORS_IN_FIXTURE));

    fireEvent.click(card());
    // Back to the stalled view, NOT to an empty filter set.
    expect(container.querySelectorAll('[data-run-id]')).toHaveLength(stalledRows);
    expect(screen.getByRole('button', { name: /Stalled/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('RECOMPUTES when the period changes, because it follows the selector', async () => {
    const api = fakeApi();
    const { container, rerender } = mount({ api });
    await waitFor(() => expect(cardIds(container)).toEqual(['v-errors']));
    expect(cardText(container, 'v-errors')).toBe(String(ERRORS_IN_FIXTURE));

    // A narrower period returns fewer rows from the server. Same component
    // instance, same views, new rows — the card must move.
    const narrower = FIXTURE_ROWS_24.slice(0, 6);
    const expected = buildIphoneSyncReport(narrower, FIXTURE_USERS_24).runs.filter(
      (r) => r.outcome === 'error'
    ).length;
    expect(expected).not.toBe(ERRORS_IN_FIXTURE);

    rerender(
      <IphoneSyncReport
        report={buildIphoneSyncReport(narrower, FIXTURE_USERS_24)}
        period={resolvePeriod({ period: '48h' }, NOW)}
        rowCap={200}
        initialState={DEFAULT_CLIENT_STATE}
        onNavigate={vi.fn()}
        viewsApi={api}
      />
    );

    expect(cardText(container, 'v-errors')).toBe(String(expected));
  });

  it('says in words that it follows the period', async () => {
    const api = fakeApi();
    mount({ api });
    expect(
      await screen.findByText(/keep their own saved filters and follow the period above: This week/)
    ).toBeTruthy();
  });

  it('renders at most five, whatever the database returns', async () => {
    const six = Array.from({ length: 6 }, (_, i) =>
      row({ id: `v${i}`, name: `View ${i}`, pinned: true })
    );
    const { container } = mount({ api: fakeApi(six) });
    await waitFor(() => expect(cardIds(container)).toHaveLength(MAX_PINNED));
  });
});

describe('the views dropdown', () => {
  it('refuses a sixth pin and says why', async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row({ id: `v${i}`, name: `View ${i}`, pinned: true })),
      row({ id: 'v-unpinned', name: 'Not pinned', pinned: false }),
    ];
    const api = fakeApi(rows);
    mount({ api });
    openViews();

    const pinIt = await screen.findByRole('button', { name: 'Pin Not pinned as a card' });
    fireEvent.click(pinIt);

    expect(screen.getByText('At most 5 pinned cards. Unpin one first.')).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('unpins through the UPDATE path, keeping the row id', async () => {
    const api = fakeApi();
    mount({ api });
    openViews();
    fireEvent.click(await screen.findByRole('button', { name: 'Unpin Errors' }));

    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    const payload = api.save.mock.calls[0][0];
    // The id travels, so the pin toggle cannot change it — which is the whole
    // reason these RPCs upsert instead of delete-and-recreate.
    expect(payload.id).toBe('v-errors');
    expect(payload.pinned).toBe(false);
    expect(payload.filters.outcomes).toEqual(['error']);
  });

  it('deletes by id', async () => {
    const api = fakeApi();
    mount({ api });
    openViews();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Errors' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('v-errors'));
  });

  it('applies a view from the list and closes', async () => {
    const api = fakeApi();
    const { container } = mount({ api });
    openViews();
    fireEvent.click(await screen.findByRole('button', { name: 'Errors' }));
    expect(tileValue(container, 'Finished')).toBe(String(ERRORS_IN_FIXTURE));
    expect(screen.queryByText('Saved views')).toBeNull();
  });

  it('closes on a click outside', async () => {
    const api = fakeApi();
    mount({ api });
    openViews();
    expect(await screen.findByText('Saved views')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByText('Saved views')).toBeNull());
  });
});

describe('saving the current view', () => {
  it('sends the page`s CURRENT filters and the chosen column and function, and nothing else', async () => {
    const api = fakeApi([]);
    mount({ api });

    // Narrow the page first, so a payload built from defaults would be wrong.
    fireEvent.click(screen.getByRole('button', { name: /Stalled/ }));

    openViews();
    fireEvent.click(await screen.findByRole('button', { name: /Save current view as a card/ }));
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'Stalled runs' } });
    fireEvent.change(screen.getByLabelText('Column'), { target: { value: 'duration' } });
    fireEvent.change(screen.getByLabelText('Function'), { target: { value: 'average' } });
    fireEvent.click(screen.getByRole('button', { name: /Save and pin/ }));

    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    const payload = api.save.mock.calls[0][0];
    expect(payload.reportKey).toBe('iphone-sync');
    expect(payload.name).toBe('Stalled runs');
    expect(payload.metric).toEqual({ col: 'duration', fn: 'average' });
    expect(payload.pinned).toBe(true);
    expect(payload.id ?? null).toBeNull();
    expect(payload.filters.stalledOnly).toBe(true);
    // Five keys, no sixth. And no period: the card follows the selector.
    expect(Object.keys(payload.filters).sort()).toEqual([
      'outcomes',
      'platforms',
      'search',
      'stalledOnly',
      'types',
    ]);
    expect(JSON.stringify(payload)).not.toContain('@');
  });

  it('forces the function back to count when the column offers nothing else', async () => {
    const api = fakeApi([]);
    mount({ api });
    openViews();
    fireEvent.click(await screen.findByRole('button', { name: /Save current view as a card/ }));
    fireEvent.change(screen.getByLabelText('Column'), { target: { value: 'rate' } });
    fireEvent.change(screen.getByLabelText('Function'), { target: { value: 'average' } });
    fireEvent.change(screen.getByLabelText('Column'), { target: { value: 'runs' } });

    const functions = within(screen.getByLabelText('Function') as HTMLElement).getAllByRole('option');
    expect(functions.map((o) => o.textContent)).toEqual(['count']);

    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'How many' } });
    fireEvent.click(screen.getByRole('button', { name: /Save and pin/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0][0].metric).toEqual({ col: 'runs', fn: 'count' });
  });

  it('refuses an unnamed view without calling the database', async () => {
    const api = fakeApi([]);
    mount({ api });
    openViews();
    fireEvent.click(await screen.findByRole('button', { name: /Save current view as a card/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save and pin/ }));
    expect(screen.getByText('Give the view a name.')).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('refuses a sixth card from the save form too', async () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      row({ id: `v${i}`, name: `View ${i}`, pinned: true })
    );
    const api = fakeApi(five);
    mount({ api });
    openViews();
    fireEvent.click(await screen.findByRole('button', { name: /Save current view as a card/ }));
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'One too many' } });
    fireEvent.click(screen.getByRole('button', { name: /Save and pin/ }));
    expect(screen.getByText('At most 5 pinned cards. Unpin one first.')).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('reloads the list after a save, so the new card appears', async () => {
    const api = fakeApi([]);
    const { container } = mount({ api });
    openViews();
    fireEvent.click(await screen.findByRole('button', { name: /Save current view as a card/ }));
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'Everything' } });

    api.list.mockResolvedValue([
      {
        id: 'v-new',
        name: 'Everything',
        filters: { types: [], outcomes: [], platforms: [], search: '' },
        stalledOnly: false,
        metric: { col: 'runs', fn: 'count' },
        pinned: true,
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /Save and pin/ }));

    await waitFor(() => expect(cardIds(container)).toEqual(['v-new']));
    expect(cardText(container, 'v-new')).toBe('24');
  });
});
