// @vitest-environment jsdom

/**
 * Exports on the kit SavedViews: time range, default view, cards vs list
 * (BACKLOG-4084 PR E)
 *
 * SR ruling: a pinned card follows the page period and applies its filters
 * only; the Views list applies filters and period, with at most one
 * navigation. Rows are in the `report_list_saved_views` shape and go through
 * the real parser. Ids are invented.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExportsReport } from '@/lib/reports/exports';
import { parseExportSavedViews, type ExportSavedView } from '@/lib/reports/exports-views';
import { resolvePeriod, type PeriodRange } from '@/lib/reports/period';
import { EXPORT_ROWS, LOOKUPS, NOW, PERIOD } from '@/lib/reports/__tests__/exports.fixture';
import { ExportsReport, type ExportViewsApi } from '../ExportsReport';

const REPORT = buildExportsReport(EXPORT_ROWS, LOOKUPS);
const LAST_MONTH = resolvePeriod({ period: 'last-month' }, NOW);

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState(null, '', '/dashboard/reports/exports');
});

function row(over: Record<string, unknown> = {}, period: unknown = { key: 'week' }) {
  return {
    id: 'view-pdf-1',
    name: 'PDF',
    filters: { orgs: [], users: [], formats: ['pdf'], search: '', period },
    metric: { col: 'exports', fn: 'count' },
    pinned: true,
    is_default: false,
    created_at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function fakeApi(rows: unknown[]) {
  return {
    list: vi.fn().mockResolvedValue(parseExportSavedViews(rows)),
    save: vi.fn().mockResolvedValue({ id: 'view-new-1' }),
    remove: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  } satisfies ExportViewsApi;
}

function element(
  api: ExportViewsApi,
  onNavigate: (url: string) => void,
  period: PeriodRange,
  initialView: ExportSavedView | null = null
) {
  return (
    <ExportsReport
      report={REPORT}
      period={period}
      rowCap={500}
      onNavigate={onNavigate}
      viewsApi={api}
      initialView={initialView}
    />
  );
}

function mount(api: ExportViewsApi, period: PeriodRange = PERIOD, initialView: ExportSavedView | null = null) {
  const onNavigate = vi.fn();
  const result = render(element(api, onNavigate, period, initialView));
  return { ...result, onNavigate };
}

const caption = () =>
  [...document.querySelectorAll('p')].find((p) => p.textContent?.startsWith('Cards, chart and tables'))
    ?.textContent ?? '';

async function openViews() {
  fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
  return screen.findByRole('list', { name: 'Saved views' });
}

function listRow(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[data-slot="saved-views-row"]')].find((r) =>
    r.textContent?.includes(name)
  );
  if (!found) throw new Error(`no row ${name}`);
  return found;
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-view-id="${id}"]`);

describe('guards', () => {
  it('PERIOD is a custom range, so a week view differs from it', () => {
    expect(PERIOD.key).toBe('custom');
    mount(fakeApi([]));
    expect(caption()).toContain('no other filters');
  });
});

describe('PIN togglePin keeps filters.period', () => {
  it('re-saves the same id with the stored period', async () => {
    const api = fakeApi([row({ pinned: false }, { key: 'month' })]);
    mount(api);
    await openViews();
    fireEvent.click(screen.getByRole('button', { name: 'Pin PDF as a card' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    const payload = api.save.mock.calls[0][0];
    expect(payload.id).toBe('view-pdf-1');
    expect(payload.pinned).toBe(true);
    expect(payload.filters.period).toEqual({ key: 'month' });
  });
});

describe('CARD a pinned card applies its filters only', () => {
  it('no navigation; card active; list row not active', async () => {
    const api = fakeApi([row()]);
    const { onNavigate } = mount(api);
    await waitFor(() => expect(card('view-pdf-1')).not.toBeNull());
    fireEvent.click(card('view-pdf-1') as HTMLElement);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(caption()).toContain('Format (1)');
    expect(caption()).toContain(PERIOD.label);
    expect(card('view-pdf-1')?.getAttribute('aria-pressed')).toBe('true');
    await openViews();
    expect(listRow('PDF').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('LIST the Views list applies filters and period', () => {
  it('L1 navigates exactly once to the stored period', async () => {
    const api = fakeApi([row()]);
    const { onNavigate } = mount(api);
    await openViews();
    fireEvent.click(listRow('PDF'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(String(onNavigate.mock.calls[0][0]).replace(/^\?/, ''));
    expect(params.get('period')).toBe('week');
    expect(params.get('from')).toBeNull();
    expect(caption()).toContain('Format (1)');
  });

  it('L2 the same custom range applies with zero navigations and is the active row', async () => {
    const api = fakeApi([row({}, { key: 'custom', from: '2026-10-12', to: '2026-10-18' })]);
    const { onNavigate } = mount(api);
    await openViews();
    fireEvent.click(listRow('PDF'));
    expect(onNavigate).not.toHaveBeenCalled();
    await openViews();
    expect(listRow('PDF').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('DEFAULT the server-chosen view seeds the filters once', () => {
  const [defaultView] = parseExportSavedViews([row({ is_default: true }, { key: 'last-month' })]);

  it('D1 initialView sets the filters on first render', () => {
    mount(fakeApi([]), LAST_MONTH, defaultView);
    expect(caption()).toContain('Format (1)');
  });

  it('C2 a new period, a null initial view and a views reload change nothing and navigate nowhere', async () => {
    const api = fakeApi([row({ is_default: true }, { key: 'last-month' })]);
    const onNavigate = vi.fn();
    const { rerender } = render(element(api, onNavigate, LAST_MONTH, defaultView));
    rerender(element(api, onNavigate, PERIOD, null));
    await openViews();
    fireEvent.click(screen.getByRole('button', { name: 'Stop opening PDF by default' }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(api.setDefault).toHaveBeenCalledWith('exports', null);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(caption()).toContain('Format (1)');
  });

  it('C2b an explicit URL (no initial view) with a default in the list applies nothing', async () => {
    const api = fakeApi([row({ is_default: true }, { key: 'last-month' })]);
    const { onNavigate } = mount(api);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(caption()).toContain('no other filters');
  });

  it('makes another view the default', async () => {
    const api = fakeApi([row({ is_default: true }), row({ id: 'view-pdf-2', name: 'Other' })]);
    mount(api);
    const list = await openViews();
    expect(list.querySelectorAll('[data-slot="saved-views-default-marker"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Make Other the default' }));
    await waitFor(() => expect(api.setDefault).toHaveBeenCalledWith('exports', 'view-pdf-2'));
  });

  it('removes by id', async () => {
    const api = fakeApi([row()]);
    mount(api);
    await openViews();
    fireEvent.click(screen.getByRole('button', { name: 'Delete PDF' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('view-pdf-1'));
  });
});
