// @vitest-environment jsdom
/**
 * User Activity report: shared saved views (BACKLOG-4087), a filter report.
 *
 * Through the browser seam (UserActivityReportClient), so the real views api, the real parser and
 * the real share api run against a fake client (share-rpc-stub.ts). Names are invented.
 *
 * W1 sharing is wired: Share on own rows, "Shared with you" with Leave, Update on editor rows only
 * W2 the picker shows report_share_candidates and nothing else (P6, page level)
 * W3 editor Update sends filters + metric only (P4, page level)
 * W4 Leave removes the caller's own access after the confirm
 * W5 a database before sharing: no Share or Leave (P5, page level)
 * W6 4121 chip + clear still work on a shared view
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const stub = vi.hoisted(() => ({ current: null as null | import('@/lib/reports/__tests__/share-rpc-stub').ShareRpcStub }));
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => stub.current!.client }));

import { buildUserActivityReport } from '@/lib/reports/user-activity';
import { serializeUserActivityView, USER_ACTIVITY_VIEW_METRIC } from '@/lib/reports/user-activity-views';
import {
  createShareRpcStub,
  legacyRow,
  NOT_A_CANDIDATE,
  ownRow,
  SELF_ID,
  sharedRow,
  vid,
} from '@/lib/reports/__tests__/share-rpc-stub';
import {
  DEVICES,
  EVENTS,
  LAST_WEEK,
  MEMBERSHIPS,
  ORGS,
  STAFF_IDS,
  USERS,
} from '@/lib/reports/__tests__/user-activity.fixture';
import { UserActivityReportClient } from '../UserActivityReportClient';
import { withReportAccess } from '@/lib/reports/__tests__/report-access-wrapper';

const REPORT = buildUserActivityReport({
  users: USERS,
  devices: DEVICES,
  events: EVENTS,
  memberships: MEMBERSHIPS,
  orgs: ORGS,
  staffIds: STAFF_IDS,
});

const PERIOD_BLOB = { period: { key: 'last-week' } };
const OWN = ownRow({ name: 'Mine', filters: { orgs: [], activeOnly: false, search: '', ...PERIOD_BLOB } });
const VIEWER = sharedRow('viewer', { filters: { orgs: ['Beta Homes'], activeOnly: false, search: '', ...PERIOD_BLOB } });
const EDITOR = sharedRow('editor', { filters: { orgs: ['Acme Realty'], activeOnly: false, search: '', ...PERIOD_BLOB } });

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stub.current = createShareRpcStub();
  push.mockReset();
});

function mount(rows: unknown[]) {
  stub.current!.setListRows(rows);
  render(<UserActivityReportClient report={REPORT} period={LAST_WEEK} rowCap={20000} />, { wrapper: withReportAccess('owner') });
}

const panel = () => screen.getByRole('dialog', { name: 'Saved views' });
async function openViews(firstRow: string) {
  await waitFor(() => expect(stub.current!.calls('report_list_saved_views').length).toBeGreaterThan(0));
  if (!screen.queryByRole('dialog', { name: 'Saved views' })) fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
  await waitFor(() => expect(within(panel()).getAllByRole('button', { name: new RegExp(`^${firstRow}`) }).length).toBeGreaterThan(0));
}
const buttonNames = () => within(panel()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');

describe('W1 sharing is wired into the report', () => {
  it('own row: Share; viewer row: Leave only; editor row: Update and Leave', async () => {
    mount([OWN, VIEWER, EDITOR]);
    await openViews('Mine');
    const names = buttonNames();
    expect(names).toContain('Share Mine');
    expect(within(panel()).getByText('Shared with you')).toBeTruthy();
    expect(names).toContain('Leave Quinn view');
    expect(names).toContain('Leave Robin view');
    expect(names).toContain('Update Robin view with the current filters');
    expect(names).not.toContain('Update Quinn view with the current filters');
    expect(names.filter((n) => /^(Delete|Make|Share) (Quinn|Robin) view/.test(n))).toEqual([]);
  });
});

describe('W2 the picker is fed by report_share_candidates only', () => {
  it('Share opens the dialog with exactly the candidates for that view', async () => {
    mount([OWN, VIEWER]);
    await openViews('Mine');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Share Mine' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share “Mine”' });
    const field = within(dialog).getByRole('combobox', { name: 'Add people or roles' }) as HTMLInputElement;
    await waitFor(() => expect(field.disabled).toBe(false));
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Avery Analyst', 'Blake Builder']);
    expect(options).not.toContain(NOT_A_CANDIDATE);
    expect(stub.current!.calls('report_share_candidates')).toEqual([{ p_view_id: OWN.id }]);
    fireEvent.click(screen.getByRole('option', { name: 'Blake Builder' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(stub.current!.calls('report_share_set')).toHaveLength(1));
    expect(stub.current!.calls('report_share_set')[0]).toEqual({
      p_view_id: OWN.id,
      p_user_id: vid(102),
      p_role: 'viewer',
    });
  });
});

describe('W3 editor Update', () => {
  it('sends the page filters and metric under the view id; p_name null, no p_pinned; then re-lists', async () => {
    mount([OWN, VIEWER, EDITOR]);
    await openViews('Mine');
    const listsBefore = stub.current!.calls('report_list_saved_views').length;
    fireEvent.click(within(panel()).getByRole('button', { name: 'Update Robin view with the current filters' }));
    await waitFor(() => expect(stub.current!.calls('report_save_view')).toHaveLength(1));
    const args = stub.current!.calls('report_save_view')[0];
    expect(args).toEqual({
      p_report_key: 'user-activity',
      p_name: null,
      p_filters: serializeUserActivityView({ orgs: [], activeOnly: false, search: '' }, LAST_WEEK),
      p_metric: USER_ACTIVITY_VIEW_METRIC,
      p_id: EDITOR.id,
    });
    expect(Object.keys(args)).not.toContain('p_pinned');
    await waitFor(() => expect(stub.current!.calls('report_list_saved_views').length).toBeGreaterThan(listsBefore));
  });
});

describe('W4 Leave', () => {
  it('asks first, then removes the caller own access', async () => {
    mount([OWN, VIEWER]);
    await openViews('Mine');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Leave Quinn view' }));
    expect(stub.current!.calls('report_share_remove')).toHaveLength(0);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Leave view' }));
    await waitFor(() => expect(stub.current!.calls('report_share_remove')).toHaveLength(1));
    expect(stub.current!.calls('report_share_remove')[0]).toEqual({ p_view_id: VIEWER.id, p_user_id: SELF_ID });
  });
});

describe('W5 a database before sharing', () => {
  it('rows without access: no Share, no Leave, owner buttons as before', async () => {
    mount([legacyRow({ name: 'Mine', filters: { orgs: [], activeOnly: false, search: '', ...PERIOD_BLOB } })]);
    await openViews('Mine');
    const names = buttonNames();
    expect(names).toContain('Delete Mine');
    expect(names.some((n) => n.startsWith('Share') || n.startsWith('Leave') || n.startsWith('Update'))).toBe(false);
  });
});

describe('W6 4121 chip and clear on a shared view', () => {
  it('applying a shared view names it on the trigger; X clears to the built-in state', async () => {
    mount([OWN, VIEWER]);
    await openViews('Mine');
    fireEvent.click(within(panel()).getAllByRole('button', { name: /^Quinn view/ })[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Views: Quinn view' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Clear view Quinn view' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(String(push.mock.calls.at(-1)?.[0])).toContain('period=');
    expect(screen.queryByRole('button', { name: 'Views: Quinn view' })).toBeNull();
  });
});
