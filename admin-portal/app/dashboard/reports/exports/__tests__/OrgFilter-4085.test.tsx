// @vitest-environment jsdom
/**
 * Exports report: the Organization filter is the kit Dropdown in multi mode (BACKLOG-4085).
 *
 * O1 kit contract, O2 search narrows and a pick of "No organization" narrows the
 * tiles, O3 clearing the Organization filter leaves Format applied, O4 Select all
 * while searching selects the whole set, O6 the bar's Clear filters and a saved
 * view drive the pill (no local copy). Option queries are scoped to the
 * Organization listbox: the native Period select also exposes role=option.
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
  } satisfies ExportViewsApi;
}

function mount(api?: ExportViewsApi) {
  return render(
    <ExportsReport report={buildExportsReport(EXPORT_ROWS, LOOKUPS)} period={PERIOD} rowCap={500} viewsApi={api} />
  );
}

const tile = (c: HTMLElement, id: string) => Number(c.querySelector(`[data-tile-value="${id}"]`)?.textContent?.trim());
const filterBar = () => document.querySelector('[data-filter-bar="exports"]') as HTMLElement;
const orgTrigger = () => within(filterBar()).getAllByRole('button', { name: /^Organization/ })[0];
const orgListbox = () => screen.getByRole('listbox', { name: 'Organization' });
const orgOption = (name: string) => within(orgListbox()).getByRole('option', { name });
const orgOptions = () => within(orgListbox()).getAllByRole('option');

function openOrg() {
  if (!screen.queryByRole('listbox', { name: 'Organization' })) fireEvent.click(orgTrigger());
}

function closeOrg() {
  if (screen.queryByRole('listbox', { name: 'Organization' })) fireEvent.click(orgTrigger());
}

function pickOrg(name: string) {
  openOrg();
  fireEvent.click(orgOption(name));
  closeOrg();
}

/** Format stays on the shared MultiSelectDropdown. */
function pickFormat(option: string) {
  const trigger = () => within(filterBar()).getByRole('button', { name: /^Format( \(\d+\))?$/ });
  fireEvent.click(trigger());
  fireEvent.click(within(filterBar()).getByLabelText(option));
  fireEvent.click(trigger());
}

describe('O1 the Organization filter is the kit multi Dropdown', () => {
  it('opens a multiselectable listbox with a search box, filter variant', () => {
    mount();
    fireEvent.click(orgTrigger());
    expect(orgListbox().getAttribute('aria-multiselectable')).toBe('true');
    expect(screen.getByRole('combobox', { name: 'Search Organization' })).toBeTruthy();
    expect(orgTrigger().closest('[data-slot="dropdown"]')?.getAttribute('data-variant')).toBe('filter');
  });
});

describe('O2 search narrows the list; a pick narrows the tiles', () => {
  it('No organization via search leaves that one user', () => {
    const { container } = mount();
    expect(tile(container, 'exports')).toBe(11);
    openOrg();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search Organization' }), { target: { value: 'no org' } });
    expect(orgOptions().map((o) => o.textContent?.trim())).toEqual(['No organization']);
    fireEvent.click(orgOption('No organization'));
    expect(orgOption('No organization').getAttribute('aria-selected')).toBe('true');
    expect(orgTrigger().textContent).toContain('Organization (1)');
    expect(tile(container, 'exports')).toBe(2);
    expect(tile(container, 'users')).toBe(1);
  });
});

describe('O3 clearing Organization keeps the Format filter', () => {
  it('PDF stays applied after the Organization clear X', () => {
    const { container } = mount();
    pickFormat('PDF');
    const pdfOnly = tile(container, 'exports');
    pickOrg('No organization');
    const both = tile(container, 'exports');
    // The three values must differ or this control cannot see a wrong clear.
    expect(new Set([11, pdfOnly, both]).size).toBe(3);

    fireEvent.click(within(filterBar()).getByRole('button', { name: 'Clear Organization filter' }));
    expect(orgTrigger().textContent).toBe('Organization');
    expect(tile(container, 'exports')).toBe(pdfOnly);
  });
});

describe('O4 Select all while searching selects the whole set', () => {
  it('search "brokerage", Select all -> all three options selected', () => {
    mount();
    openOrg();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search Organization' }), { target: { value: 'brokerage' } });
    expect(orgOptions()).toHaveLength(2);
    fireEvent.click(within(orgListbox().parentElement as HTMLElement).getByRole('button', { name: 'Select all' }));
    expect(orgTrigger().textContent).toContain('Organization (3)');
    fireEvent.change(screen.getByRole('combobox', { name: 'Search Organization' }), { target: { value: '' } });
    expect(orgOptions()).toHaveLength(3);
    for (const option of orgOptions()) expect(option.getAttribute('aria-selected')).toBe('true');
  });
});

describe('O6 the pill follows the report filters, not a local copy', () => {
  it('the bar-level Clear filters empties the pill; a saved view sets it', async () => {
    const view = {
      id: 'v-org-b',
      name: 'Brokerage B only',
      filters: { orgs: ['org-b'], users: [], formats: [], search: '' },
      metric: { col: 'exports', fn: 'count' },
      pinned: true,
    };
    const { container } = mount(fakeApi([view]));
    await waitFor(() => expect(container.querySelector('[data-view-id="v-org-b"]')).not.toBeNull());

    pickOrg('Brokerage A');
    expect(orgTrigger().textContent).toContain('Organization (1)');
    fireEvent.click(within(filterBar()).getByRole('button', { name: 'Clear filters' }));
    expect(orgTrigger().textContent).toBe('Organization');
    openOrg();
    expect(orgOption('Brokerage A').getAttribute('aria-selected')).toBe('false');
    closeOrg();

    fireEvent.click(container.querySelector('[data-view-id="v-org-b"]') as HTMLElement);
    expect(orgTrigger().textContent).toContain('Organization (1)');
    openOrg();
    expect(orgOption('Brokerage B').getAttribute('aria-selected')).toBe('true');
  });
});
