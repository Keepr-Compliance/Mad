// @vitest-environment jsdom
/**
 * iPhone sync report: shared saved views (BACKLOG-4087), a report with pinning.
 *
 * The real views api, parser and share api against a fake client (share-rpc-stub.ts). Invented names.
 *
 * I1 sharing is wired; a shared view is never a pinned card and never counts toward the cap
 * I2 4132: both save rows still offered, and "Save current view as a card" still pins
 * I3 editor Update sends the page filters + the card's own metric; p_name null, no p_pinned
 * I4 (BACKLOG-4142) the editor picks a card metric in the Update form; the picked one is sent
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const stub = vi.hoisted(() => ({ current: null as null | import('@/lib/reports/__tests__/share-rpc-stub').ShareRpcStub }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => stub.current!.client }));

import { buildIphoneSyncReport } from '@/lib/reports/iphone-sync';
import { resolvePeriod } from '@/lib/reports/period';
import { DEFAULT_CLIENT_STATE } from '@/lib/reports/report-url';
import { reportViewsApi } from '@/lib/reports/report-views-api';
import { reportShareApi } from '@/lib/reports/report-share-api';
import { FIXTURE_ROWS_24, FIXTURE_USERS_24 } from '@/lib/reports/__tests__/iphone-sync.fixture';
import { createShareRpcStub, ownRow, sharedRow } from '@/lib/reports/__tests__/share-rpc-stub';
import { IphoneSyncReport } from '../IphoneSyncReport';
import { withReportAccess } from '@/lib/reports/__tests__/report-access-wrapper';

const NOW = new Date('2026-09-19T22:07:00.000Z');
const WEEK = resolvePeriod({ period: 'week' }, NOW);
const REPORT = buildIphoneSyncReport(FIXTURE_ROWS_24, FIXTURE_USERS_24);

const blob = (outcomes: string[]) => ({ types: [], outcomes, platforms: [], search: '', stalledOnly: false, period: { key: 'week' } });
const METRIC = { col: 'runs', fn: 'count' };
const OWN_CARD = ownRow({ name: 'Errors', filters: blob(['error']), metric: METRIC, pinned: true });
// Shared rows as the server sends them, plus one whose mask failed (pinned true): never a card.
// The editor's card metric is NOT the save form's fallback (runs/count), so Update must keep it.
const CARD_METRIC = { col: 'duration', fn: 'average' };
const SHARED_EDITOR = sharedRow('editor', { name: 'Team cancelled', filters: blob(['cancelled']), metric: CARD_METRIC });
const SHARED_UNMASKED = sharedRow('viewer', { name: 'Team complete', filters: blob(['complete']), metric: METRIC, pinned: true });

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState(null, '', '/dashboard/reports/iphone-sync');
  stub.current = createShareRpcStub();
});

function mount(rows: unknown[]) {
  stub.current!.setListRows(rows);
  render(
    <IphoneSyncReport
      report={REPORT}
      period={WEEK}
      rowCap={200}
      initialState={DEFAULT_CLIENT_STATE}
      onNavigate={vi.fn()}
      viewsApi={reportViewsApi}
      shareApi={reportShareApi}
    />,
    { wrapper: withReportAccess('owner') }
  );
}

const panel = () => screen.getByRole('dialog', { name: 'Saved views' });
async function openViews() {
  await waitFor(() => expect(stub.current!.calls('report_list_saved_views').length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
  await waitFor(() => expect(within(panel()).getByText('Shared with you')).toBeTruthy());
}
const cards = () => [...document.querySelectorAll<HTMLElement>('[data-view-id]')].map((c) => c.getAttribute('data-view-id'));

describe('I1 sharing on a pinning report', () => {
  it('Share on the own row, Update on the editor row; only the own pinned view is a card', async () => {
    mount([OWN_CARD, SHARED_EDITOR, SHARED_UNMASKED]);
    await openViews();
    expect(within(panel()).getByRole('button', { name: 'Share Errors' })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: 'Update Team cancelled' })).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: /^(Pin|Unpin) Team/ })).toBeNull();
    expect(cards()).toEqual([OWN_CARD.id]);
  });
});

describe('I2 4132 save rows', () => {
  it('both save rows are offered with sharing on, and the card row pins', async () => {
    mount([OWN_CARD, SHARED_EDITOR, SHARED_UNMASKED]);
    await openViews();
    expect(within(panel()).getByRole('button', { name: 'Save current view' })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Save current view as a card' }));
    fireEvent.change(within(panel()).getByRole('textbox', { name: 'View name' }), { target: { value: 'New card' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Save and pin' }));
    await waitFor(() => expect(stub.current!.calls('report_save_view')).toHaveLength(1));
    expect(stub.current!.calls('report_save_view')[0]).toMatchObject({ p_name: 'New card', p_pinned: true, p_id: null });
  });
});

describe('I3 editor Update', () => {
  it('the page filters and the card own metric under the view id; never name or pin', async () => {
    mount([OWN_CARD, SHARED_EDITOR, SHARED_UNMASKED]);
    await openViews();
    // BACKLOG-4142: Update opens the form seeded with the card's own metric; confirming unchanged keeps it.
    fireEvent.click(within(panel()).getByRole('button', { name: 'Update Team cancelled' }));
    const form = within(panel()).getByRole('group', { name: 'Update filters and card metric' });
    expect(within(form).getByRole('combobox', { name: 'Column' })).toHaveProperty('value', 'duration');
    expect(within(form).getByRole('combobox', { name: 'Function' })).toHaveProperty('value', 'average');
    expect(stub.current!.calls('report_save_view')).toHaveLength(0);
    fireEvent.click(within(form).getByRole('button', { name: 'Update view' }));
    await waitFor(() => expect(stub.current!.calls('report_save_view')).toHaveLength(1));
    const args = stub.current!.calls('report_save_view')[0];
    expect(args).toEqual({
      p_report_key: 'iphone-sync',
      p_name: null,
      p_filters: { types: [], outcomes: [], platforms: [], search: '', stalledOnly: false, period: { key: 'week' } },
      p_metric: CARD_METRIC,
      p_id: SHARED_EDITOR.id,
    });
    expect(Object.keys(args)).not.toContain('p_pinned');
  });
});

describe('I4 editor picks the card metric (BACKLOG-4142)', () => {
  it('a picked column and function are sent as p_metric; p_name null, no p_pinned', async () => {
    mount([OWN_CARD, SHARED_EDITOR, SHARED_UNMASKED]);
    await openViews();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Update Team cancelled' }));
    const form = within(panel()).getByRole('group', { name: 'Update filters and card metric' });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Column' }), { target: { value: 'backup' } });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Function' }), { target: { value: 'sum' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Update view' }));
    await waitFor(() => expect(stub.current!.calls('report_save_view')).toHaveLength(1));
    const args = stub.current!.calls('report_save_view')[0];
    expect(args).toMatchObject({ p_name: null, p_metric: { col: 'backup', fn: 'sum' }, p_id: SHARED_EDITOR.id });
    expect(Object.keys(args)).not.toContain('p_pinned');
  });
});

describe('I5 the picked metric goes through the iPhone Sync allowlist (BACKLOG-4142)', () => {
  it('a column outside the list falls back to the report default metric', async () => {
    mount([OWN_CARD, SHARED_EDITOR, SHARED_UNMASKED]);
    await openViews();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Update Team cancelled' }));
    const form = within(panel()).getByRole('group', { name: 'Update filters and card metric' });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Column' }), { target: { value: 'not-a-column' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Update view' }));
    await waitFor(() => expect(stub.current!.calls('report_save_view')).toHaveLength(1));
    expect(stub.current!.calls('report_save_view')[0]).toMatchObject({ p_metric: { col: 'runs', fn: 'count' } });
  });
});
