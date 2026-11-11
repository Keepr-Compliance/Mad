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

  // BACKLOG-3513 PR-4 fix-up M2: Share sends one upsert per person picked.
  it('M2 two people picked -> exactly two report_access_set at the chosen level, then one re-read', async () => {
    const { client, calls } = fakeClient({
      report_access_candidates: [...CANDIDATES, { user_id: uid(3), display_name: 'Cal Moreno' }],
      report_access_list: GRANTS,
      report_access_set: { report_key: 'funnel' },
    });
    mount('owner', createReportAccessApi(() => client));
    fireEvent.click(shareButton()!);
    const dialog = await screen.findByRole('dialog', { name: 'Share “Paywall Funnel”' });
    const field = await within(dialog).findByRole('combobox', { name: 'Add people or roles' });
    await waitFor(() => expect((field as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(field, { target: { value: 'Av' } });
    fireEvent.click(screen.getByRole('option', { name: /Avery Quinn/ }));
    fireEvent.change(field, { target: { value: 'Cal' } });
    fireEvent.click(screen.getByRole('option', { name: /Cal Moreno/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Access Can/ }));
    fireEvent.click(screen.getByRole('option', { name: /Can edit/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(calls.filter((c) => c.fn === 'report_access_list')).toHaveLength(2));
    expect(calls.filter((c) => c.fn === 'report_access_set').map((c) => c.args)).toEqual([
      { p_key: 'funnel', p_user_id: uid(1), p_role: 'editor' },
      { p_key: 'funnel', p_user_id: uid(3), p_role: 'editor' },
    ]);
    for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
    expect(calls.filter((c) => c.fn === 'report_access_list')).toHaveLength(2);
  });

  // BACKLOG-3513 PR-4 fix-up M1 (builder 2).
  it('M1 person 1 refused now, person 2 written later -> one re-read after person 2, error shown', async () => {
    let finishSecond: () => void = () => {};
    const api: ReportAccessApi = {
      candidates: vi.fn(async () => [
        { id: uid(1), name: 'Avery Quinn' },
        { id: uid(3), name: 'Cal Moreno' },
      ]),
      grants: vi.fn(async (): Promise<ShareGrant[]> => []),
      set: vi.fn((_key: string, user: string) =>
        user === uid(1)
          ? Promise.reject({ message: 'Report not found' })
          : new Promise<void>((resolve) => (finishSecond = () => resolve()))
      ),
      remove: vi.fn(async () => {}),
    };
    mount('owner', api);
    fireEvent.click(shareButton()!);
    const dialog = await screen.findByRole('dialog', { name: 'Share “Paywall Funnel”' });
    const field = await within(dialog).findByRole('combobox', { name: 'Add people or roles' });
    await waitFor(() => expect((field as HTMLInputElement).disabled).toBe(false));
    await waitFor(() => expect(api.grants).toHaveBeenCalledTimes(1));
    fireEvent.change(field, { target: { value: 'Av' } });
    fireEvent.click(screen.getByRole('option', { name: /Avery Quinn/ }));
    fireEvent.change(field, { target: { value: 'Cal' } });
    fireEvent.click(screen.getByRole('option', { name: /Cal Moreno/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    expect(api.set).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
    expect(api.grants).toHaveBeenCalledTimes(1);
    await act(async () => finishSecond());
    await waitFor(() => expect(api.grants).toHaveBeenCalledTimes(2));
    expect(within(dialog).getByRole('alert').textContent).toContain('Report not found');
    for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
    expect(api.grants).toHaveBeenCalledTimes(2);
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

// BACKLOG-3513 PR-6: Remove looked stuck. The write returns well before the re-read; the row must
// show the write in flight, block a second remove, and apply a success at once.
describe('H the report dialog while a write is in flight', () => {
  function deferred<T = void>() {
    let resolve: (v: T) => void = () => undefined;
    let reject: (e: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const BO: ShareGrant = { userId: uid(2), name: 'Bo Larkspur', role: 'viewer' };

  /** First grants read answers at once; later reads wait for `reread`. */
  function heldApi(write: { set?: Promise<void>; remove?: Promise<void> }, reread: Promise<ShareGrant[]>) {
    let reads = 0;
    const api = {
      candidates: vi.fn(async () => [{ id: uid(1), name: 'Avery Quinn' }]),
      grants: vi.fn((): Promise<ShareGrant[]> => (++reads === 1 ? Promise.resolve([BO]) : reread)),
      set: vi.fn(() => write.set ?? Promise.resolve()),
      remove: vi.fn(() => write.remove ?? Promise.resolve()),
    };
    return api;
  }
  async function openDialog(api: ReportAccessApi) {
    mount('owner', api);
    fireEvent.click(shareButton()!);
    const dialog = await screen.findByRole('dialog', { name: 'Share “Paywall Funnel”' });
    await within(dialog).findByRole('button', { name: 'Access for Bo Larkspur: Can view' });
    return dialog;
  }
  function confirmRemoveBo(dialog: HTMLElement) {
    fireEvent.click(within(dialog).getByRole('button', { name: /^Access for Bo Larkspur: / }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Remove access$/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Remove access for Bo Larkspur' })).getByRole('button', { name: 'Remove access' }));
  }
  const boTrigger = (dialog: HTMLElement) => within(dialog).queryByRole('button', { name: /^Access for Bo Larkspur: / });

  it('H1 remove held: the row reads Removing…, its menu does not open, and no second remove is sent', async () => {
    const remove = deferred();
    const api = heldApi({ remove: remove.promise }, new Promise(() => undefined));
    const dialog = await openDialog(api);
    confirmRemoveBo(dialog);
    const t = boTrigger(dialog)!;
    expect(t.getAttribute('aria-label')).toBe('Access for Bo Larkspur: Removing…');
    expect(t.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(t);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Remove access for Bo Larkspur' })).toBeNull();
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  it('H2 remove succeeds while the re-read is still out: the row is gone at once', async () => {
    const remove = deferred();
    const reread = deferred<ShareGrant[]>();
    const api = heldApi({ remove: remove.promise }, reread.promise);
    const dialog = await openDialog(api);
    confirmRemoveBo(dialog);
    await act(async () => remove.resolve());
    expect(api.grants).toHaveBeenCalledTimes(2); // the re-read was sent and is still out
    expect(boTrigger(dialog)).toBeNull();
    expect(within(dialog).queryByText('Bo Larkspur')).toBeNull();
    // The re-read stays the source of truth.
    await act(async () => reread.resolve([]));
    expect(boTrigger(dialog)).toBeNull();
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  it('H3 level change succeeds while the re-read is still out: the new level shows at once', async () => {
    const set = deferred();
    const api = heldApi({ set: set.promise }, new Promise(() => undefined));
    const dialog = await openDialog(api);
    fireEvent.click(boTrigger(dialog)!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /^Can edit/ }));
    expect(boTrigger(dialog)!.getAttribute('aria-label')).toBe('Access for Bo Larkspur: Saving…');
    expect(boTrigger(dialog)!.getAttribute('aria-disabled')).toBe('true');
    await act(async () => set.resolve());
    expect(boTrigger(dialog)!.getAttribute('aria-label')).toBe('Access for Bo Larkspur: Can edit');
    expect(api.set).toHaveBeenCalledTimes(1);
  });

  // SR R1 (pm_comments cb3517d7): an older re-read landing last must not bring a removed row back.
  it('H5 change Cal (re-read 1 held), remove Bo (re-read 2 held), re-read 2 lands, then the older re-read 1: Bo stays gone', async () => {
    const CAL: ShareGrant = { userId: uid(3), name: 'Cal Moreno', role: 'viewer' };
    const r1 = deferred<ShareGrant[]>();
    const r2 = deferred<ShareGrant[]>();
    const answers = [Promise.resolve([BO, CAL]), r1.promise, r2.promise];
    const api = {
      candidates: vi.fn(async () => [{ id: uid(1), name: 'Avery Quinn' }]),
      grants: vi.fn((): Promise<ShareGrant[]> => answers.shift() ?? new Promise(() => undefined)),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    const dialog = await openDialog(api);
    const cal = () => within(dialog).queryByRole('button', { name: /^Access for Cal Moreno: / });
    fireEvent.click(cal()!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /^Can edit/ }));
    await waitFor(() => expect(api.grants).toHaveBeenCalledTimes(2));
    confirmRemoveBo(dialog);
    await waitFor(() => expect(api.grants).toHaveBeenCalledTimes(3));
    expect(boTrigger(dialog)).toBeNull();
    await act(async () => r2.resolve([{ ...CAL, role: 'editor' }]));
    expect(boTrigger(dialog)).toBeNull();
    await act(async () => r1.resolve([BO, CAL]));
    expect(boTrigger(dialog)).toBeNull();
    expect(cal()!.getAttribute('aria-label')).toBe('Access for Cal Moreno: Can edit');
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  it('H4 remove refused: the row comes back and the refusal shows', async () => {
    const remove = deferred();
    const api = heldApi({ remove: remove.promise }, Promise.resolve([BO]));
    const dialog = await openDialog(api);
    confirmRemoveBo(dialog);
    await act(async () => remove.reject({ message: 'Report not found' }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('Report not found'));
    expect(boTrigger(dialog)!.getAttribute('aria-label')).toBe('Access for Bo Larkspur: Can view');
    expect(boTrigger(dialog)!.getAttribute('aria-disabled')).toBeNull();
  });
});
