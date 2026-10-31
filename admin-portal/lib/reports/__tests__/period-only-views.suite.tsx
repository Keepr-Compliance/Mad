/**
 * Shared component suite for the period-only saved views (BACKLOG-4084 PR F).
 * Each report's test file calls `runPeriodOnlyViewsSuite` with its own
 * component, periods and rows; the test names carry the report's name.
 *
 * The fake api has the real method names and lists through the REPORT'S OWN
 * parser, so a row holding another report's period key reaches the component
 * the way the RPC would deliver it.
 */

import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PeriodOnlyViewsApi } from '../period-only-views-api';
import type { PeriodOnlySavedView, PeriodOnlyViews } from '../period-only-views';
import type { ResolvedPeriodLike } from '../view-period';

export type FakeApi = { [K in keyof PeriodOnlyViewsApi]: ReturnType<typeof vi.fn> } & PeriodOnlyViewsApi;

export function fakeApi(views: PeriodOnlyViews, rows: unknown[]): FakeApi {
  return {
    list: vi.fn().mockImplementation(async () => views.parseRows(rows)),
    save: vi.fn().mockResolvedValue({ id: 'view-saved-1' }),
    remove: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  } as FakeApi;
}

export const rawRow = (id: string, name: string, period: unknown, isDefault = false) => ({
  id,
  name,
  filters: { period },
  metric: { col: 'rows', fn: 'count' },
  pinned: false,
  is_default: isDefault,
  created_at: '2026-10-01T00:00:00.000Z',
});

export const panel = () => screen.getByRole('dialog', { name: 'Saved views' });
export const viewRow = (name: string) =>
  within(panel())
    .getAllByRole('button', { name: new RegExp(`^${name}`) })
    .find((b) => b.getAttribute('data-slot') === 'saved-views-row')!;

export async function openViews(api: FakeApi, someName: string) {
  await waitFor(() => expect(api.list).toHaveBeenCalled());
  if (!screen.queryByRole('dialog', { name: 'Saved views' })) {
    fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
  }
  await waitFor(() => expect(viewRow(someName)).toBeTruthy());
}

export interface SuiteSpec<P extends ResolvedPeriodLike> {
  report: string;
  reportKey: string;
  views: PeriodOnlyViews;
  /** The component under test with these props. */
  element(period: P, api: PeriodOnlyViewsApi, onNavigate: (url: string) => void): ReactElement;
  /** The period the page renders with. */
  pagePeriod: P;
  /** A different preset, its resolved form, and the URL applying it navigates to. */
  other: { key: string; period: P; url: string };
  /** A third preset for the default view row (not the page's). */
  defaultKey: string;
  /** A custom range on reports that have one: the stored period and the URL. */
  custom?: { stored: { key: 'custom'; from: string; to: string }; url: string };
  /** A period key from ANOTHER report's set (or a custom range on Analytics). */
  foreign: unknown;
}

export function runPeriodOnlyViewsSuite<P extends ResolvedPeriodLike>(spec: SuiteSpec<P>) {
  const R = spec.report;
  const rows = [
    rawRow('view-other-1', 'Other range', { key: spec.other.key }),
    rawRow('view-page-1', 'Page range', { key: spec.pagePeriod.key }),
    rawRow('view-foreign-1', 'Foreign range', spec.foreign),
    rawRow('view-default-1', 'Default range', { key: spec.defaultKey }, true),
    ...(spec.custom ? [rawRow('view-custom-1', 'Custom range view', spec.custom.stored)] : []),
  ];

  function mount(period: P = spec.pagePeriod) {
    const api = fakeApi(spec.views, rows);
    const onNavigate = vi.fn();
    const utils = render(spec.element(period, api, onNavigate));
    return { api, onNavigate, rerender: (p: P) => utils.rerender(spec.element(p, api, onNavigate)) };
  }

  describe(`${R} S1 save`, () => {
    it(`${R}: saves the server-resolved period under the ${spec.reportKey} key, count metric, not pinned`, async () => {
      const { api } = mount();
      await openViews(api, 'Other range');
      fireEvent.click(within(panel()).getByRole('button', { name: 'Save current view' }));
      expect(within(panel()).getByText('Saves the time range.')).toBeTruthy();
      fireEvent.change(within(panel()).getByRole('textbox', { name: 'View name' }), { target: { value: '  Mine  ' } });
      fireEvent.click(within(panel()).getByRole('button', { name: 'Save view' }));
      await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save).toHaveBeenCalledWith({
        reportKey: spec.reportKey,
        name: 'Mine',
        filters: spec.views.serialize(spec.pagePeriod),
        metric: { col: 'rows', fn: 'count' },
        pinned: false,
      });
      expect(api.list).toHaveBeenCalledWith(spec.reportKey);
    });
  });

  describe(`${R} A1 apply = exactly one navigation carrying the period`, () => {
    it(`${R}: another preset navigates once to ${spec.other.url}`, async () => {
      const { api, onNavigate } = mount();
      await openViews(api, 'Other range');
      fireEvent.click(viewRow('Other range'));
      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(onNavigate.mock.calls[0][0]).toBe(spec.other.url);
    });

    if (spec.custom) {
      const custom = spec.custom;
      it(`${R}: a custom range navigates once with both dates`, async () => {
        const { api, onNavigate } = mount();
        await openViews(api, 'Custom range view');
        fireEvent.click(viewRow('Custom range view'));
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(onNavigate.mock.calls[0][0]).toBe(custom.url);
      });
    }

    it(`${R}: a view on the page period navigates nowhere`, async () => {
      const { api, onNavigate } = mount();
      await openViews(api, 'Page range');
      fireEvent.click(viewRow('Page range'));
      expect(onNavigate).not.toHaveBeenCalled();
    });
  });

  describe(`${R} X1 a period from another report's set`, () => {
    it(`${R}: is never the active view and applying it changes nothing`, async () => {
      const { api, onNavigate, rerender } = mount();
      await openViews(api, 'Foreign range');
      expect(viewRow('Foreign range').getAttribute('aria-pressed')).toBe('false');
      rerender(spec.other.period);
      await openViews(api, 'Foreign range');
      expect(viewRow('Foreign range').getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(viewRow('Foreign range'));
      expect(onNavigate).not.toHaveBeenCalled();
    });
  });

  describe(`${R} M1 the active view follows the period`, () => {
    it(`${R}: "Other range" is active only once the page shows its period`, async () => {
      const { api, rerender } = mount();
      await openViews(api, 'Other range');
      expect(viewRow('Other range').getAttribute('aria-pressed')).toBe('false');
      expect(viewRow('Page range').getAttribute('aria-pressed')).toBe('true');
      rerender(spec.other.period);
      await openViews(api, 'Other range');
      expect(viewRow('Other range').getAttribute('aria-pressed')).toBe('true');
      expect(viewRow('Page range').getAttribute('aria-pressed')).toBe('false');
    });
  });

  describe(`${R} C2 the default is never applied on the client`, () => {
    it(`${R}: views loading, a new period and a reload of the views navigate nowhere`, async () => {
      const { api, onNavigate, rerender } = mount();
      await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
      await act(async () => {
        await Promise.resolve();
      });
      rerender(spec.other.period);
      await openViews(api, 'Other range');
      fireEvent.click(within(panel()).getByRole('button', { name: 'Make Other range the default' }));
      await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
      await act(async () => {
        await Promise.resolve();
      });
      expect(onNavigate).not.toHaveBeenCalled();
    });
  });

  describe(`${R} S3 default and S2 remove`, () => {
    it(`${R}: sets the default by id and clears it with null, under ${spec.reportKey}`, async () => {
      const { api } = mount();
      await openViews(api, 'Other range');
      fireEvent.click(within(panel()).getByRole('button', { name: 'Make Other range the default' }));
      await waitFor(() => expect(api.setDefault).toHaveBeenCalledWith(spec.reportKey, 'view-other-1'));
      await openViews(api, 'Default range');
      fireEvent.click(within(panel()).getByRole('button', { name: 'Stop opening Default range by default' }));
      await waitFor(() => expect(api.setDefault).toHaveBeenLastCalledWith(spec.reportKey, null));
    });

    it(`${R}: remove sends the id and applies nothing`, async () => {
      const { api, onNavigate } = mount();
      await openViews(api, 'Other range');
      fireEvent.click(within(panel()).getByRole('button', { name: 'Delete Other range' }));
      await waitFor(() => expect(api.remove).toHaveBeenCalledWith('view-other-1'));
      expect(onNavigate).not.toHaveBeenCalled();
    });
  });
}

/** Shape check: the parsed row type is what the kit receives. */
export type { PeriodOnlySavedView };
