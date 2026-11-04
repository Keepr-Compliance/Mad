// @vitest-environment jsdom

/**
 * Exports: the applied-view chip's X resets to the BUILT-IN state
 * (BACKLOG-4121). Empty filters, and the built-in period written into the URL:
 * a bare URL re-opens the default view on the server (default-view.ts).
 * Rows are in the `report_list_saved_views` shape; ids are invented.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExportsReport } from '@/lib/reports/exports';
import { parseExportSavedViews, type ExportSavedView } from '@/lib/reports/exports-views';
import { resolveInitialSavedView } from '@/lib/reports/initial-saved-view';
import { resolvePeriod, type PeriodRange } from '@/lib/reports/period';
import { EXPORT_ROWS, LOOKUPS, NOW } from '@/lib/reports/__tests__/exports.fixture';
import { ExportsReport, type ExportViewsApi } from '../ExportsReport';

const REPORT = buildExportsReport(EXPORT_ROWS, LOOKUPS);
const WEEK = resolvePeriod({ period: 'week' }, NOW);
const LAST_MONTH = resolvePeriod({ period: 'last-month' }, NOW);

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState(null, '', '/dashboard/reports/exports');
});

const PDF_ROW = {
  id: 'view-pdf-1',
  name: 'PDF',
  filters: { orgs: [], users: [], formats: ['pdf'], search: '', period: { key: 'last-month' } },
  metric: { col: 'exports', fn: 'count' },
  pinned: true,
  is_default: false,
  created_at: '2026-10-01T00:00:00.000Z',
};
const ALL_ROW = {
  ...PDF_ROW,
  id: 'view-all-1',
  name: 'All formats',
  filters: { orgs: [], users: [], formats: [], search: '', period: { key: 'week' } },
};

function fakeApi(rows: unknown[]) {
  return {
    list: vi.fn().mockResolvedValue(parseExportSavedViews(rows)),
    save: vi.fn().mockResolvedValue({ id: 'view-new-1' }),
    remove: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  } satisfies ExportViewsApi;
}

function mount(rows: unknown[], period: PeriodRange, initialView: ExportSavedView | null) {
  const onNavigate = vi.fn();
  render(
    <ExportsReport
      report={REPORT}
      period={period}
      rowCap={500}
      onNavigate={onNavigate}
      viewsApi={fakeApi(rows)}
      initialView={initialView}
    />
  );
  return { onNavigate };
}

const caption = () =>
  [...document.querySelectorAll('p')].find((p) => p.textContent?.startsWith('Cards, chart and tables'))
    ?.textContent ?? '';
const card = (id: string) => document.querySelector<HTMLElement>(`[data-view-id="${id}"]`);
const params = (url: string) => new URLSearchParams(url.replace(/^[^?]*\?/, ''));

describe('A-a X on a non-default view', () => {
  it('names the view; X empties the filters and navigates once with period=week written out', async () => {
    const [pdf] = parseExportSavedViews([PDF_ROW]);
    const { onNavigate } = mount([PDF_ROW], LAST_MONTH, pdf);
    const chip = await screen.findByRole('button', { name: /^Views: PDF/ });
    expect(caption()).not.toContain('no other filters');
    fireEvent.click(screen.getByRole('button', { name: 'Clear view PDF' }));
    expect(caption()).toContain('no other filters');
    expect(onNavigate).toHaveBeenCalledTimes(1);
    const url = onNavigate.mock.calls[0][0] as string;
    expect(params(url).get('period')).toBe('week');
    expect(params(url).has('from')).toBe(false);
    expect(document.activeElement).toBe(chip);
  });
});

describe('A-b X with a default view applied on a bare URL', () => {
  it('goes to the built-in state, and that URL does not re-open the default on the server', async () => {
    const defaultRow = { ...PDF_ROW, is_default: true };
    const [pdf] = parseExportSavedViews([defaultRow]);
    expect(window.location.search).toBe('');
    const { onNavigate } = mount([defaultRow], LAST_MONTH, pdf);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear view PDF' }));
    expect(caption()).toContain('no other filters');
    const url = onNavigate.mock.calls[0][0] as string;
    const listViews = vi.fn().mockResolvedValue([defaultRow]);
    const server = await resolveInitialSavedView({
      params: Object.fromEntries(params(url)),
      listViews,
      parse: parseExportSavedViews,
    });
    expect(server.initialView).toBeNull();
    expect(server.periodInput.period).toBe('week');
    // The control for the line above: a bare URL DOES re-open it.
    const bare = await resolveInitialSavedView({ params: {}, listViews, parse: parseExportSavedViews });
    expect(bare.initialView?.id).toBe('view-pdf-1');
  });
});

describe('A-c X forgets the card restore point', () => {
  it('card -> X -> the same card again: the filters stay empty', async () => {
    const [pdf] = parseExportSavedViews([PDF_ROW]);
    mount([PDF_ROW, ALL_ROW], WEEK, pdf);
    await waitFor(() => expect(card('view-all-1')).not.toBeNull());
    fireEvent.click(card('view-all-1') as HTMLElement);
    expect(caption()).toContain('no other filters');
    fireEvent.click(await screen.findByRole('button', { name: 'Clear view All formats' }));
    fireEvent.click(card('view-all-1') as HTMLElement);
    expect(caption()).toContain('no other filters');
  });
});
