// @vitest-environment jsdom
/**
 * Paywall Funnel report: shared saved views (BACKLOG-4087), a period-only report. The same hook
 * (usePeriodOnlySavedViews) serves Analytics and Support SLA.
 *
 * The real views api, parser and share api against a fake client (share-rpc-stub.ts). Invented names.
 *
 * F1 sharing is wired: Share on own rows, Leave on shared rows, Update on editor rows
 * F2 editor Update stores the page period + the fixed metric; p_name null, no p_pinned
 * F3 4121 chip + clear on a shared view
 * F4 a database before sharing: no Share or Leave
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const stub = vi.hoisted(() => ({ current: null as null | import('@/lib/reports/__tests__/share-rpc-stub').ShareRpcStub }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => stub.current!.client }));

import { computeFunnel } from '@/lib/funnel-analytics';
import { resolveFunnelPeriod } from '@/lib/reports/funnel-period';
import { ALL_TIME_ROWS, NOW } from '@/lib/reports/__tests__/funnel.fixture';
import { funnelViews, PERIOD_ONLY_VIEW_METRIC } from '@/lib/reports/period-only-views';
import { funnelViewsApi } from '@/lib/reports/period-only-views-api';
import { reportShareApi } from '@/lib/reports/report-share-api';
import { createShareRpcStub, legacyRow, ownRow, sharedRow } from '@/lib/reports/__tests__/share-rpc-stub';
import { FunnelReport } from '../FunnelReport';
import { withReportAccess } from '@/lib/reports/__tests__/report-access-wrapper';

const FUNNEL = computeFunnel(ALL_TIME_ROWS);
const PERIOD = resolveFunnelPeriod({ period: '30' }, NOW);
const OWN = ownRow({ name: 'Mine', filters: { period: { key: '7' } }, metric: PERIOD_ONLY_VIEW_METRIC });
const VIEWER = sharedRow('viewer', { filters: { period: { key: '30' } }, metric: PERIOD_ONLY_VIEW_METRIC });
const EDITOR = sharedRow('editor', { filters: { period: { key: '7' } }, metric: PERIOD_ONLY_VIEW_METRIC });

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState(null, '', '/dashboard/reports/funnel?period=30');
  stub.current = createShareRpcStub();
});

function mount(rows: unknown[]) {
  stub.current!.setListRows(rows);
  const onNavigate = vi.fn();
  render(
    <FunnelReport
      funnel={FUNNEL}
      period={PERIOD}
      rowCap={20000}
      onNavigate={onNavigate}
      viewsApi={funnelViewsApi}
      shareApi={reportShareApi}
    />,
    { wrapper: withReportAccess('owner') }
  );
  return { onNavigate };
}

const panel = () => screen.getByRole('dialog', { name: 'Saved views' });
async function openViews() {
  await waitFor(() => expect(stub.current!.calls('report_list_saved_views').length).toBeGreaterThan(0));
  if (!screen.queryByRole('dialog', { name: 'Saved views' })) fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
  await waitFor(() => expect(within(panel()).getAllByRole('button', { name: /^Mine/ }).length).toBeGreaterThan(0));
}
const buttonNames = () => within(panel()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');

describe('F1 sharing is wired into a period-only report', () => {
  it('Share on Mine; Leave on both shared rows; Update on the editor row only', async () => {
    mount([OWN, VIEWER, EDITOR]);
    await openViews();
    const names = buttonNames();
    expect(names).toEqual(expect.arrayContaining(['Share Mine', 'Leave Quinn view', 'Leave Robin view', 'Update Robin view with the current filters']));
    expect(names).not.toContain('Update Quinn view with the current filters');
  });
});

describe('F2 editor Update', () => {
  it('sends the page period and the fixed metric, never a name or pin', async () => {
    mount([OWN, VIEWER, EDITOR]);
    await openViews();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Update Robin view with the current filters' }));
    await waitFor(() => expect(stub.current!.calls('report_save_view')).toHaveLength(1));
    const args = stub.current!.calls('report_save_view')[0];
    expect(args).toEqual({
      p_report_key: 'funnel',
      p_name: null,
      p_filters: funnelViews.serialize(PERIOD),
      p_metric: PERIOD_ONLY_VIEW_METRIC,
      p_id: EDITOR.id,
    });
    expect(Object.keys(args)).not.toContain('p_pinned');
  });
});

describe('F3 4121 chip on a shared view', () => {
  it('the page period matches the shared view: the trigger names it, X clears to the built-in period', async () => {
    const { onNavigate } = mount([OWN, VIEWER]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Views: Quinn view' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Clear view Quinn view' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(String(onNavigate.mock.calls[0][0])).toContain('period=');
  });
});

describe('F4 a database before sharing', () => {
  it('rows without access: no Share, no Leave', async () => {
    mount([legacyRow({ name: 'Mine', filters: { period: { key: '7' } }, metric: PERIOD_ONLY_VIEW_METRIC })]);
    await openViews();
    const names = buttonNames();
    expect(names).toContain('Delete Mine');
    expect(names.some((n) => n.startsWith('Share') || n.startsWith('Leave') || n.startsWith('Update'))).toBe(false);
  });
});
