// @vitest-environment jsdom

/**
 * iPhone Sync Performance — interaction tests (BACKLOG-3450)
 *
 * Sorting, "Show 5 more" and the row detail are the three things that cannot
 * be reached by `renderToStaticMarkup`, and they are exactly where a wired-up
 * page differs from a rendered one. The one-line environment pragma at the top
 * of this file is what makes it run in a DOM, and it is load-bearing: delete it
 * and every test below fails to render. It is per-file on purpose — a global
 * switch in vitest.config.ts would drag all twenty other suites into a DOM for
 * no reason.
 *
 * Do not repeat that pragma anywhere else in this file, including inside a
 * comment. Vitest scans the whole file for it, so a second mention in prose
 * keeps the DOM alive even when the real one at the top has been removed —
 * which silently turns any control over it into a false green.
 *
 * `IphoneSyncReport` takes navigation as a prop, so there is no router to mock
 * here either.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildIphoneSyncReport } from '@/lib/reports/iphone-sync';
import { resolvePeriod } from '@/lib/reports/period';
import { DEFAULT_CLIENT_STATE } from '@/lib/reports/report-url';
import {
  derivedRunRows,
  DERIVED_ROWS,
  FIXTURE_ROWS_24,
  FIXTURE_USERS_24,
  ROW_IDS,
} from '@/lib/reports/__tests__/iphone-sync.fixture';
import { IphoneSyncReport } from '../IphoneSyncReport';

const NOW = new Date('2026-09-19T22:07:00.000Z');
const THIS_WEEK = resolvePeriod({}, NOW);

afterEach(cleanup);

function mount(rows = FIXTURE_ROWS_24, onNavigate = vi.fn()) {
  const result = render(
    <IphoneSyncReport
      report={buildIphoneSyncReport(rows, FIXTURE_USERS_24)}
      period={THIS_WEEK}
      rowCap={200}
      initialState={DEFAULT_CLIENT_STATE}
      onNavigate={onNavigate}
    />
  );
  return { ...result, onNavigate };
}

/**
 * Column headers, looked up INSIDE the table head.
 *
 * "Platform", "Outcome" and "Type" are also filter-dropdown triggers, so an
 * unscoped `getByRole('button', {name: /^Platform/})` matches two elements.
 */
function header(container: HTMLElement, label: RegExp) {
  const thead = container.querySelector('thead') as HTMLElement;
  return within(thead).getByRole('button', { name: label });
}

function rowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-run-id]')].map(
    (el) => el.getAttribute('data-run-id') as string
  );
}

describe('the harness itself', () => {
  it('renders and reacts to a real click — otherwise everything below is vacuous', () => {
    const { container } = mount();
    expect(rowIds(container)).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: /Show 5 more/ }));
    expect(rowIds(container)).toHaveLength(10);
  });
});

describe('show more', () => {
  it('starts at five and adds five at a time', () => {
    const { container } = mount();
    expect(rowIds(container)).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: /Show 5 more/ }));
    expect(rowIds(container)).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: /Show 5 more/ }));
    expect(rowIds(container)).toHaveLength(15);
    expect(screen.getByText(/Showing 15 of 24/)).toBeTruthy();
  });

  it('"Show all" reveals EVERY filtered row, not a fixed number', () => {
    // 60 rows: past both the 5-row default and any hardcoded 50.
    const { container } = mount(derivedRunRows(60));
    fireEvent.click(screen.getByRole('button', { name: /Show all/ }));
    expect(rowIds(container)).toHaveLength(60);
    expect(screen.getByText(/Showing 60 of 60/)).toBeTruthy();
  });

  it('hides both buttons once everything is shown', () => {
    mount(FIXTURE_ROWS_24.slice(0, 3));
    expect(screen.queryByRole('button', { name: /Show 5 more/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });
});

describe('sorting', () => {
  it('sorts newest-first by default, and flips on a second click of the same column', () => {
    const { container } = mount();
    const newestFirst = rowIds(container);

    fireEvent.click(header(container, /^When/));
    const oldestFirst = rowIds(container);
    expect(oldestFirst).not.toEqual(newestFirst);

    fireEvent.click(header(container, /^When/));
    expect(rowIds(container)).toEqual(newestFirst);
  });

  it('opens a NUMERIC column descending on the first click', () => {
    const { container } = mount();
    fireEvent.click(header(container, /^Duration/));
    expect(header(container, /^Duration/).closest('th')?.getAttribute('aria-sort')).toBe(
      'descending'
    );
    // The longest run in the corpus is the 181.7-minute incident.
    expect(within(container).getByText('3h 1m')).toBeTruthy();
    expect(rowIds(container)[0]).toBe(ROW_IDS.incident0916);
  });

  it('opens a TEXT column ascending on the first click', () => {
    const { container } = mount();
    fireEvent.click(header(container, /^User/));
    expect(header(container, /^User/).closest('th')?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('sorts every one of the ten columns both ways without losing a row', () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: /Show all/ }));
    for (const label of [
      /^When/, /^User/, /^Platform/, /^Version/, /^Outcome/,
      /^Duration/, /^Backup/, /^Rate/, /^Messages/, /^Type/,
    ]) {
      fireEvent.click(header(container, label));
      const first = rowIds(container);
      expect(new Set(first).size).toBe(24);
      fireEvent.click(header(container, label));
      const second = rowIds(container);
      expect(new Set(second).size).toBe(24);
      expect(second).not.toEqual(first);
    }
  });

  it('puts runs with no Rate LAST in both directions, never at the top', () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: /Show all/ }));

    fireEvent.click(header(container, /^Rate/));
    expect(rowIds(container).slice(0, 4)).toHaveLength(4);
    const descTop = rowIds(container).slice(0, 4);

    fireEvent.click(header(container, /^Rate/));
    const ascTop = rowIds(container).slice(0, 4);
    expect(new Set(ascTop)).toEqual(new Set(descTop));
    expect(ascTop).toEqual([...descTop].reverse());
  });
});

describe('the row detail', () => {
  it('opens the run card below the table on a row click, and closes again', () => {
    const { container } = mount();
    const firstId = rowIds(container)[0];

    expect(container.querySelector('[data-run-detail]')).toBeNull();
    fireEvent.click(container.querySelector(`[data-run-id="${firstId}"]`) as HTMLElement);
    expect(container.querySelector(`[data-run-detail="${firstId}"]`)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(container.querySelector('[data-run-detail]')).toBeNull();
  });

  it('keeps ONE row open at a time', () => {
    const { container } = mount();
    const [first, second] = rowIds(container);
    fireEvent.click(container.querySelector(`[data-run-id="${first}"]`) as HTMLElement);
    fireEvent.click(container.querySelector(`[data-run-id="${second}"]`) as HTMLElement);
    expect(container.querySelectorAll('[data-run-detail]')).toHaveLength(1);
    expect(container.querySelector(`[data-run-detail="${second}"]`)).toBeTruthy();
  });

  it('shows the phase breakdown and the Rate inside the detail', () => {
    const { container } = mount();
    // The 2026-09-18 19:04 complete run: 22.8 MB/s, nine phases.
    const target = ROW_IDS.rate0918;
    fireEvent.click(screen.getByRole('button', { name: /Show all/ }));
    fireEvent.click(container.querySelector(`[data-run-id="${target}"]`) as HTMLElement);
    const detail = container.querySelector(`[data-run-detail="${target}"]`) as HTMLElement;
    expect(within(detail).getByText('Where the time went')).toBeTruthy();
    expect(within(detail).getByText('22.8 MB/s')).toBeTruthy();
    expect(within(detail).getByText('Transferring backup from device')).toBeTruthy();
  });

  it('renders the 2.38.1 evidence fields only for a row that carries them', () => {
    const { container } = mount([DERIVED_ROWS.bytesTransferredOnly, ...FIXTURE_ROWS_24]);
    const withEvidence = DERIVED_ROWS.bytesTransferredOnly.id;
    fireEvent.click(screen.getByRole('button', { name: /Show all/ }));
    fireEvent.click(container.querySelector(`[data-run-id="${withEvidence}"]`) as HTMLElement);
    const detail = container.querySelector(`[data-run-detail="${withEvidence}"]`) as HTMLElement;
    expect(within(detail).getByText('Bytes moved')).toBeTruthy();
    expect(within(detail).getByText('Ended by')).toBeTruthy();
    expect(within(detail).getByText('user_cancelled')).toBeTruthy();

    cleanup();
    // A row from a shipped build carries none of them, and must render NOTHING
    // rather than a row of em dashes that reads as "we looked and found none".
    const plain = mount();
    const plainId = rowIds(plain.container)[0];
    fireEvent.click(plain.container.querySelector(`[data-run-id="${plainId}"]`) as HTMLElement);
    const plainDetail = plain.container.querySelector(`[data-run-detail="${plainId}"]`) as HTMLElement;
    expect(within(plainDetail).queryByText('Bytes moved')).toBeNull();
    expect(within(plainDetail).queryByText('Ended by')).toBeNull();
  });
});

describe('the stalled tile, clicked for real', () => {
  it('narrows the table and leaves the tiles where they were', () => {
    const { container } = mount();
    const tile = screen.getByRole('button', { name: /Stalled/ });
    const before = [...container.querySelectorAll('.text-2xl')].map((el) => el.textContent);

    fireEvent.click(tile);
    expect(rowIds(container)).toHaveLength(5);
    expect(screen.getByText(/Showing 5 of 5/)).toBeTruthy();
    expect([...container.querySelectorAll('.text-2xl')].map((el) => el.textContent)).toEqual(before);

    fireEvent.click(tile);
    expect(screen.getByText(/Showing 5 of 24/)).toBeTruthy();
  });
});

describe('changing the period', () => {
  it('navigates, KEEPING the filters that are already set', () => {
    const onNavigate = vi.fn();
    render(
      <IphoneSyncReport
        report={buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24)}
        period={THIS_WEEK}
        rowCap={200}
        initialState={{
          ...DEFAULT_CLIENT_STATE,
          filters: { types: ['first'], outcomes: ['error'], platforms: [], search: 'user f' },
        }}
        onNavigate={onNavigate}
      />
    );

    // The shell mirrors its state to the URL on mount, so the filters are in
    // `window.location.search` by the time the period select fires.
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'last-month' } });

    expect(onNavigate).toHaveBeenCalledTimes(1);
    const url = onNavigate.mock.calls[0][0] as string;
    const params = new URLSearchParams(url.slice(1));
    expect(params.get('period')).toBe('last-month');
    expect(params.get('type')).toBe('first');
    expect(params.get('outcome')).toBe('error');
    expect(params.get('q')).toBe('user f');
  });
});

describe('filters, driven through the UI', () => {
  it('re-filters the table and resets the page back to five rows', () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: /Show all/ }));
    expect(rowIds(container)).toHaveLength(24);

    fireEvent.change(screen.getByLabelText('Search by user'), {
      target: { value: 'sync user c' },
    });
    expect(rowIds(container).length).toBeLessThan(24);
    expect(screen.getByText(/Showing \d+ of \d+/)).toBeTruthy();
  });

  it('shows Clear only once something is set, and clearing restores everything', () => {
    const { container } = mount();
    expect(screen.queryByRole('button', { name: /Clear filters/ })).toBeNull();

    fireEvent.change(screen.getByLabelText('Search by user'), { target: { value: 'sync user h' } });
    expect(rowIds(container)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }));
    expect(screen.getByText(/Showing 5 of 24/)).toBeTruthy();
  });
});
