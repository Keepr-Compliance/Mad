// @vitest-environment jsdom

/**
 * BACKLOG-4144 S1-S3: the report Share button and its dialog.
 *
 * S1 only an owner sees it. S2 the picker is report_access_candidates and nothing else.
 * S3 grant and remove call report_access_set / report_access_remove with the OPEN report's key,
 * and a reply from an earlier opening never reaches the dialog. Invented names and ids.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ShareGrant } from '@/lib/reports/report-share-api';

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: async () => ({ data: [], error: null }) }) }));

import {
  ReportShareButton,
  REPORT_SHARE_DESCRIPTION,
  REPORT_SHARE_ROLE_DESCRIPTIONS,
} from '@/components/reports/ReportShareButton';
import { createReportAccessApi, type ReportAccessApi } from '@/lib/reports/report-access-api';
import { withReportAccess } from '@/lib/reports/__tests__/report-access-wrapper';
import type { ReportAccess } from '@/lib/reports/report-access';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A fake browser client: records every rpc and answers from `answers`. */
function fakeClient(answers: Record<string, unknown>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const a = answers[fn];
      if (a instanceof Error || (a && typeof a === 'object' && 'code' in (a as object))) return { data: null, error: a };
      return { data: a ?? null, error: null };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const CANDIDATES = [
  { user_id: uid(1), display_name: 'Avery Quinn' },
  { user_id: uid(2), display_name: 'Bo Larkspur' },
];
const GRANTS = [{ user_id: uid(2), display_name: 'Bo Larkspur', role: 'viewer' }];

function mount(access: ReportAccess | 'none', api: ReportAccessApi) {
  const wrapper = access === 'none' ? undefined : withReportAccess(access, 'funnel', 'Paywall Funnel');
  return render(<ReportShareButton api={api} />, { wrapper });
}

const shareButton = () => screen.queryByRole('button', { name: 'Share Paywall Funnel' });

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('S1 only an owner sees report Share', () => {
  it.each(['viewer', 'editor', 'none'] as const)('%s: no button', (access) => {
    const { client } = fakeClient({});
    mount(access, createReportAccessApi(() => client));
    expect(shareButton()).toBeNull();
  });

  it('owner: the button', () => {
    const { client } = fakeClient({});
    mount('owner', createReportAccessApi(() => client));
    expect(shareButton()).toBeTruthy();
  });

  it('a database without the functions: the button goes away', async () => {
    const { client } = fakeClient({ report_access_candidates: { code: 'PGRST202', message: 'Could not find the function' } });
    mount('owner', createReportAccessApi(() => client));
    fireEvent.click(shareButton()!);
    // hidden: true — while the modal is open the page button is aria-hidden, so a plain role query
    // would miss it even if it were still there.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Share Paywall Funnel', hidden: true })).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Share “Paywall Funnel”' })).toBeNull();
  });
});

describe('S2 the picker comes only from report_access_candidates', () => {
  it('opens with the report copy, candidates for the open report, and its grants', async () => {
    const { client, calls } = fakeClient({ report_access_candidates: CANDIDATES, report_access_list: GRANTS });
    mount('owner', createReportAccessApi(() => client));
    fireEvent.click(shareButton()!);
    const dialog = await screen.findByRole('dialog', { name: 'Share “Paywall Funnel”' });
    expect(within(dialog).getByText(REPORT_SHARE_DESCRIPTION)).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByRole('list', { name: 'People with access' })).toBeTruthy());

    expect(calls.map((c) => c.fn).sort()).toEqual(['report_access_candidates', 'report_access_list']);
    expect(calls.find((c) => c.fn === 'report_access_candidates')!.args).toEqual({ p_key: 'funnel' });
    expect(calls.find((c) => c.fn === 'report_access_list')!.args).toEqual({ p_key: 'funnel' });

    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'Add people or roles' }), { key: 'ArrowDown' });
    // Bo already has access, so only Avery is offered: the candidates minus the grants, nothing else.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Avery Quinn']);
    // No owner row (owners are Super Admins), no roles, no general access.
    expect(dialog.querySelector('[data-slot="sharing-owner"]')).toBeNull();
    expect(within(dialog).queryByText(/^Role:/)).toBeNull();
    expect(within(dialog).queryByText('Who can open it')).toBeNull();
  });

  it('the report copy is exact', () => {
    expect(REPORT_SHARE_DESCRIPTION).toBe('People you add can open this report.');
    expect(REPORT_SHARE_ROLE_DESCRIPTIONS).toEqual({ viewer: 'Opens the report', editor: 'Also shares saved views on it' });
  });
});

describe('S3 writes carry the open report key; stale replies are dropped', () => {
  it('grant -> report_access_set, remove -> report_access_remove, each then re-reads', async () => {
    const { client, calls } = fakeClient({
      report_access_candidates: CANDIDATES,
      report_access_list: GRANTS,
      report_access_set: { report_key: 'funnel' },
      report_access_remove: { success: true },
    });
    mount('owner', createReportAccessApi(() => client));
    fireEvent.click(shareButton()!);
    const dialog = await screen.findByRole('dialog', { name: 'Share “Paywall Funnel”' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Access for Bo Larkspur: Can view' })).toBeTruthy());

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Add people or roles' }), { target: { value: 'Av' } });
    fireEvent.click(screen.getByRole('option', { name: /Avery Quinn/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Access Can/ }));
    fireEvent.click(screen.getByRole('option', { name: /Can edit/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(calls.filter((c) => c.fn === 'report_access_list')).toHaveLength(2));
    expect(calls.find((c) => c.fn === 'report_access_set')!.args).toEqual({ p_key: 'funnel', p_user_id: uid(1), p_role: 'editor' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Access for Bo Larkspur: Can view' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Remove access$/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Remove access for Bo Larkspur' })).getByRole('button', { name: 'Remove access' }));
    await waitFor(() => expect(calls.filter((c) => c.fn === 'report_access_list')).toHaveLength(3));
    expect(calls.find((c) => c.fn === 'report_access_remove')!.args).toEqual({ p_key: 'funnel', p_user_id: uid(2) });
  });

  // BACKLOG-3513 PR-4 control A1 (builder 2): a level change is one upsert, in place.
  it('A1 changing a level is exactly one report_access_set with the new role; no remove, no Make owner', async () => {
    const { client, calls } = fakeClient({
      report_access_candidates: CANDIDATES,
      report_access_list: GRANTS,
      report_access_set: { report_key: 'funnel' },
      report_access_remove: { success: true },
    });
    mount('owner', createReportAccessApi(() => client));
    fireEvent.click(shareButton()!);
    const dialog = await screen.findByRole('dialog', { name: 'Share “Paywall Funnel”' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Access for Bo Larkspur: Can view' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /Make owner/ })).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /^Can edit/ }));
    await waitFor(() => expect(calls.filter((c) => c.fn === 'report_access_list')).toHaveLength(2));
    const writes = calls.filter((c) => c.fn === 'report_access_set' || c.fn === 'report_access_remove');
    expect(writes).toEqual([{ fn: 'report_access_set', args: { p_key: 'funnel', p_user_id: uid(2), p_role: 'editor' } }]);
  });

  it('a grants reply from an earlier opening never shows', async () => {
    let releaseFirst: (rows: { userId: string; name: string; role: 'viewer' }[]) => void = () => {};
    let opening = 0;
    const api: ReportAccessApi = {
      candidates: vi.fn(async () => []),
      grants: vi.fn((): Promise<ShareGrant[]> => {
        opening += 1;
        if (opening === 1) return new Promise<ShareGrant[]>((resolve) => (releaseFirst = resolve));
        return Promise.resolve([{ userId: uid(3), name: 'New Person', role: 'viewer' as const }]);
      }),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    mount('owner', api);
    fireEvent.click(shareButton()!);
    await screen.findByRole('dialog', { name: 'Share “Paywall Funnel”' });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share “Paywall Funnel”' })).toBeNull());

    fireEvent.click(shareButton()!);
    const dialog = await screen.findByRole('dialog', { name: 'Share “Paywall Funnel”' });
    await waitFor(() => expect(within(dialog).getByText('New Person')).toBeTruthy());
    await act(async () => releaseFirst([{ userId: uid(4), name: 'Old Person', role: 'viewer' }]));
    expect(within(dialog).queryByText('Old Person')).toBeNull();
    expect(within(dialog).getByText('New Person')).toBeTruthy();
    expect(api.grants).toHaveBeenCalledWith('funnel');
  });
});
