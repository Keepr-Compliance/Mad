// @vitest-environment jsdom
/**
 * Exports report: an editor changes a shared view's card metric (BACKLOG-4142).
 *
 * The real views api, parser and share api against a fake client (share-rpc-stub.ts). Invented names.
 *
 * X1 Update opens the form seeded with the card's own column; confirming unchanged sends it back
 * X2 a picked column is sent with fn 'count' (every Exports column is a count)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const stub = vi.hoisted(() => ({ current: null as null | import('@/lib/reports/__tests__/share-rpc-stub').ShareRpcStub }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => stub.current!.client }));

import { buildExportsReport } from '@/lib/reports/exports';
import { exportsViewsApi } from '@/lib/reports/exports-views-api';
import { reportShareApi } from '@/lib/reports/report-share-api';
import { EXPORT_ROWS, LOOKUPS, PERIOD } from '@/lib/reports/__tests__/exports.fixture';
import { createShareRpcStub, ownRow, sharedRow } from '@/lib/reports/__tests__/share-rpc-stub';
import { withReportAccess } from '@/lib/reports/__tests__/report-access-wrapper';
import { ExportsReport } from '../ExportsReport';

const REPORT = buildExportsReport(EXPORT_ROWS, LOOKUPS);
const blob = (formats: string[]) => ({ orgs: [], users: [], formats, search: '', period: { key: 'week' } });
const OWN_CARD = ownRow({ name: 'PDF', filters: blob(['pdf']), metric: { col: 'exports', fn: 'count' }, pinned: true });
// The editor's card column is NOT the save form's fallback (exports), so a reset would show.
const CARD_METRIC = { col: 'unique', fn: 'count' };
const SHARED_EDITOR = sharedRow('editor', { name: 'Team folders', filters: blob(['folder']), metric: CARD_METRIC });

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState(null, '', '/dashboard/reports/exports');
  stub.current = createShareRpcStub();
});

function mount(rows: unknown[]) {
  stub.current!.setListRows(rows);
  render(
    <ExportsReport report={REPORT} period={PERIOD} rowCap={500} onNavigate={vi.fn()} viewsApi={exportsViewsApi} shareApi={reportShareApi} />,
    { wrapper: withReportAccess('owner') }
  );
}

const panel = () => screen.getByRole('dialog', { name: 'Saved views' });
async function openUpdateForm() {
  await waitFor(() => expect(stub.current!.calls('report_list_saved_views').length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
  await waitFor(() => expect(within(panel()).getByText('Shared with you')).toBeTruthy());
  fireEvent.click(within(panel()).getByRole('button', { name: 'Update Team folders' }));
  return within(panel()).getByRole('group', { name: 'Update filters and card metric' });
}

describe('Exports editor metric picker (BACKLOG-4142)', () => {
  it('X1 the form starts from the card own column; confirming unchanged sends it back', async () => {
    mount([OWN_CARD, SHARED_EDITOR]);
    const form = await openUpdateForm();
    expect(within(form).getByRole('combobox', { name: 'Column' })).toHaveProperty('value', 'unique');
    fireEvent.click(within(form).getByRole('button', { name: 'Update view' }));
    await waitFor(() => expect(stub.current!.calls('report_save_view')).toHaveLength(1));
    const args = stub.current!.calls('report_save_view')[0];
    expect(args).toMatchObject({ p_report_key: 'exports', p_name: null, p_metric: CARD_METRIC, p_id: SHARED_EDITOR.id });
    expect(Object.keys(args)).not.toContain('p_pinned');
  });

  it('X2 a picked column is sent with fn count', async () => {
    mount([OWN_CARD, SHARED_EDITOR]);
    const form = await openUpdateForm();
    fireEvent.change(within(form).getByRole('combobox', { name: 'Column' }), { target: { value: 'users' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Update view' }));
    await waitFor(() => expect(stub.current!.calls('report_save_view')).toHaveLength(1));
    expect(stub.current!.calls('report_save_view')[0]).toMatchObject({ p_metric: { col: 'users', fn: 'count' } });
  });
});
