// @vitest-environment jsdom

/**
 * Exports report — interaction (BACKLOG-4004)
 *
 * The environment line at the top of this file is load-bearing and appears
 * once. `ExportsReport` takes navigation and the saved-view RPCs as props, so
 * no router and no Supabase client is involved.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExportsReport } from '@/lib/reports/exports';
import { parseExportSavedViews } from '@/lib/reports/exports-views';
import { EXPORT_ROWS, LOOKUPS, PERIOD } from '@/lib/reports/__tests__/exports.fixture';
import { ExportsReport, type ExportViewsApi } from '../ExportsReport';

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function fakeApi(rows: unknown[] = []) {
  return {
    list: vi.fn().mockResolvedValue(parseExportSavedViews(rows)),
    save: vi.fn().mockResolvedValue({ id: 'new-id' }),
    remove: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  } satisfies ExportViewsApi;
}

function mount(api?: ExportViewsApi) {
  return render(
    <ExportsReport report={buildExportsReport(EXPORT_ROWS, LOOKUPS)} period={PERIOD} rowCap={500} viewsApi={api} />
  );
}

const num = (el: Element | null) => Number(el?.textContent?.trim() ?? NaN);

function tile(container: HTMLElement, id: string): number {
  return num(container.querySelector(`[data-tile-value="${id}"]`));
}

function columnSum(container: HTMLElement, table: string, cell: string): number {
  return [...container.querySelectorAll(`[data-table="${table}"] [data-cell="${cell}"]`)].reduce(
    (n, el) => n + num(el),
    0
  );
}

function chartSum(container: HTMLElement, series: string): number {
  return [...container.querySelectorAll(`[data-chart="exports"] [data-series="${series}"]`)].reduce(
    (n, el) => n + Number(el.getAttribute('data-value')),
    0
  );
}

function filterBar(): HTMLElement {
  return document.querySelector('[data-filter-bar="exports"]') as HTMLElement;
}

function trigger(label: string) {
  return within(filterBar()).getByRole('button', { name: new RegExp(`^${label}( \\(\\d+\\))?$`) });
}

/** Open a filter dropdown, tick one option, close it. */
function pick(label: string, option: string) {
  fireEvent.click(trigger(label));
  fireEvent.click(within(filterBar()).getByLabelText(option));
  fireEvent.click(trigger(label));
}

describe('cards, both tables and the chart read one filtered set', () => {
  function expectAgreement(container: HTMLElement, exports: number, unique: number) {
    expect(tile(container, 'exports')).toBe(exports);
    expect(tile(container, 'unique')).toBe(unique);
    expect(columnSum(container, 'users', 'exports')).toBe(exports);
    expect(columnSum(container, 'users', 'unique')).toBe(unique);
    expect(columnSum(container, 'orgs', 'exports')).toBe(exports);
    expect(columnSum(container, 'orgs', 'unique')).toBe(unique);
    expect(chartSum(container, 'exports')).toBe(exports);
    expect(chartSum(container, 'unique')).toBe(unique);
  }

  it('with users 1 and 2 selected (the chain and the double-click pair are both inside)', () => {
    const { container } = mount();
    pick('User', 'Agent One');
    pick('User', 'Agent Two');
    expectAgreement(container, 8, 4);
  });

  it('with a format filter on as well', () => {
    const { container } = mount();
    pick('User', 'Agent One');
    pick('User', 'Agent Two');
    pick('Format', 'Folder');
    expectAgreement(container, 3, 2);
  });

  it('format options come from the data, including a format the UI never names', () => {
    mount();
    fireEvent.click(trigger('Format'));
    expect(screen.getByLabelText('excel')).toBeTruthy();
    expect(screen.getByLabelText('PDF')).toBeTruthy();
  });

  it('organization filter offers No organization and narrows to that user', () => {
    const { container } = mount();
    pick('Organization', 'No organization');
    expect(tile(container, 'exports')).toBe(2);
    expect(tile(container, 'users')).toBe(1);
  });
});

describe('drill-down', () => {
  it('clicking a user lists every one of that user`s exports, repeats included', () => {
    const { container } = mount();
    fireEvent.click(container.querySelector('[data-user-row="user-1"]') as HTMLElement);
    const panel = container.querySelector('[data-user-detail="user-1"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.querySelectorAll('[data-event-row]')).toHaveLength(5);
    expect(within(panel).getAllByText('7a000000')).toHaveLength(5);
    expect(within(panel).getByRole('link', { name: 'Open user' }).getAttribute('href')).toBe(
      '/dashboard/users/user-1'
    );
  });
});

describe('saved views', () => {
  const uniqueFolder = {
    id: 'v-unique-folder',
    name: 'Folder unique',
    filters: { orgs: [], users: [], formats: ['folder'], search: '' },
    metric: { col: 'unique', fn: 'count' },
    pinned: true,
  };

  it('lists under the exports key and shows a card with its own filters and label', async () => {
    const api = fakeApi([uniqueFolder]);
    const { container } = mount(api);
    await waitFor(() => expect(container.querySelector('[data-card-value="v-unique-folder"]')).not.toBeNull());
    expect(api.list).toHaveBeenCalledWith('exports');
    expect(container.querySelector('[data-card-value="v-unique-folder"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-view-id="v-unique-folder"]')?.textContent).toContain(
      'count · Unique exports'
    );
    // The page itself is unfiltered until the card is clicked.
    expect(tile(container, 'exports')).toBe(11);
  });

  it('a card keeps its own filters when the page is filtered by hand', async () => {
    const api = fakeApi([uniqueFolder]);
    const { container } = mount(api);
    await waitFor(() => expect(container.querySelector('[data-card-value="v-unique-folder"]')).not.toBeNull());
    pick('User', 'Agent One');
    expect(tile(container, 'exports')).toBe(5);
    // Folder unique over the whole period is user-1/D1 and user-2/D3; the page filter must not narrow it.
    expect(container.querySelector('[data-card-value="v-unique-folder"]')?.textContent).toBe('2');
  });

  it('saving without touching Column saves count of Exports with only the four filter keys and the period', async () => {
    const api = fakeApi([]);
    mount(api);
    pick('Format', 'PDF');
    fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Save current view as a card/ }));
    expect(screen.getByLabelText('Column')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Unique exports' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'PDF' } });
    fireEvent.click(screen.getByRole('button', { name: /Save and pin/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0][0]).toEqual({
      reportKey: 'exports',
      name: 'PDF',
      filters: { orgs: [], users: [], formats: ['pdf'], search: '', period: { key: 'custom', from: '2026-10-12', to: '2026-10-18' } },
      metric: { col: 'exports', fn: 'count' },
      pinned: true,
    });
  });
});
