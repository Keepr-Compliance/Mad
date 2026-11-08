// @vitest-environment jsdom

/**
 * The share api and the sharing hook (BACKLOG-4087).
 *
 * The api runs against a fake Supabase client with the real RPC names and argument names from the
 * PR 1 migration (20261104200000). Returned rows are transcribed from those functions' jsonb_build_object
 * calls. Names are invented.
 *
 * P4 the editor update sends filters and metric only (p_name null, no p_pinned)
 * P5 no share functions in the database -> no sharing
 * P6 the picker options are report_share_candidates output and nothing else
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createShareApi, isMissingFunctionError, type ShareApi } from '../report-share-api';
import { useReportViewSharing } from '../use-report-view-sharing';
import { ReportAccessProvider } from '../report-access-context';
import type { ReportAccess } from '../report-access';
import type { ReactNode } from 'react';

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

const vid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SELF = vid(900);

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** report_share_candidates: user_id + display_name. Anything else the client might read: other people. */
const CANDIDATE_ROWS = [
  { user_id: vid(101), display_name: 'Avery Example' },
  { user_id: vid(102), display_name: 'Blake Builder' },
];
const OTHER_PEOPLE = [{ user_id: vid(199), display_name: 'Not A Candidate' }];
const GRANT_ROWS = [{ user_id: vid(101), display_name: 'Avery Example', role: 'editor', created_at: '2026-11-04T00:00:00Z' }];

function fakeClient() {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'report_share_candidates') return { data: CANDIDATE_ROWS, error: null };
    if (fn === 'report_share_list') return { data: GRANT_ROWS, error: null };
    if (fn.startsWith('report_')) return { data: { id: vid(1) }, error: null };
    return { data: OTHER_PEOPLE, error: null };
  });
  const getUser = vi.fn(async () => ({ data: { user: { id: SELF } }, error: null }));
  const client = { rpc, auth: { getUser } } as unknown as SupabaseClient;
  return { rpc, getUser, client };
}

describe('createShareApi', () => {
  it('P6a candidates come from report_share_candidates for that view, id + name only', async () => {
    const { rpc, client } = fakeClient();
    const api = createShareApi(() => client);
    expect(await api.candidates(vid(1))).toEqual([
      { id: vid(101), name: 'Avery Example' },
      { id: vid(102), name: 'Blake Builder' },
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('report_share_candidates', { p_view_id: vid(1) });
  });

  it('grants, share and remove use the share functions with their own argument names', async () => {
    const { rpc, client } = fakeClient();
    const api = createShareApi(() => client);
    expect(await api.grants(vid(1))).toEqual([{ userId: vid(101), name: 'Avery Example', role: 'editor' }]);
    await api.share(vid(1), vid(102), 'viewer');
    await api.removeGrant(vid(1), vid(101));
    expect(rpc.mock.calls).toEqual([
      ['report_share_list', { p_view_id: vid(1) }],
      ['report_share_set', { p_view_id: vid(1), p_user_id: vid(102), p_role: 'viewer' }],
      ['report_share_remove', { p_view_id: vid(1), p_user_id: vid(101) }],
    ]);
  });

  it('leave removes the CALLER own access', async () => {
    const { rpc, client, getUser } = fakeClient();
    await createShareApi(() => client).leave(vid(2));
    expect(getUser).toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('report_share_remove', { p_view_id: vid(2), p_user_id: SELF });
  });

  it('P4a the editor update sends filters and metric; p_name null, no p_pinned', async () => {
    const { rpc, client } = fakeClient();
    await createShareApi(() => client).update({
      reportKey: 'iphone-sync',
      id: vid(3),
      filters: { types: ['backup'], period: { key: 'week' } },
      metric: { col: 'runs', fn: 'count' },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(fn).toBe('report_save_view');
    expect(args).toEqual({
      p_report_key: 'iphone-sync',
      p_name: null,
      p_filters: { types: ['backup'], period: { key: 'week' } },
      p_metric: { col: 'runs', fn: 'count' },
      p_id: vid(3),
    });
    expect(Object.keys(args)).not.toContain('p_pinned');
  });

  it('a refusal throws, so the hook shows it', async () => {
    const client = { rpc: vi.fn(async () => ({ data: null, error: { message: 'Saved view not found' } })) } as unknown as SupabaseClient;
    await expect(createShareApi(() => client).share(vid(1), vid(2), 'viewer')).rejects.toMatchObject({
      message: 'Saved view not found',
    });
  });

  it('isMissingFunctionError: PostgREST and Postgres "no such function"; not a refusal', () => {
    expect(isMissingFunctionError({ code: 'PGRST202', message: 'x' })).toBe(true);
    expect(isMissingFunctionError({ code: '42883', message: 'x' })).toBe(true);
    expect(isMissingFunctionError({ message: 'Could not find the function public.report_share_list' })).toBe(true);
    expect(isMissingFunctionError({ code: 'P0001', message: 'Saved view not found' })).toBe(false);
    expect(isMissingFunctionError(null)).toBe(false);
  });
});

interface View {
  id: string;
  name: string;
  isDefault: boolean;
  access?: 'owner' | 'editor' | 'viewer';
  ownerName?: string;
  accessFromServer?: boolean;
}

const OWN: View = { id: vid(1), name: 'Mine', isDefault: false, access: 'owner', accessFromServer: true };
const EDITOR: View = { id: vid(3), name: 'Edit me', isDefault: false, access: 'editor', ownerName: 'Robin Sample', accessFromServer: true };
const VIEWER: View = { id: vid(2), name: 'From Quinn', isDefault: false, access: 'viewer', ownerName: 'Quinn Example', accessFromServer: true };

function fakeShareApi(): ShareApi & { [K in keyof ShareApi]: ReturnType<typeof vi.fn> } {
  return {
    candidates: vi.fn().mockResolvedValue([{ id: vid(101), name: 'Avery Example' }]),
    grants: vi.fn().mockResolvedValue([]),
    share: vi.fn().mockResolvedValue(undefined),
    removeGrant: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  } as never;
}

// BACKLOG-4144: the open report's access. 'owner' keeps every 4087 case below as it was.
function mount(views: View[] | null, api: ShareApi | 'none' = fakeShareApi(), access: ReportAccess | 'none' = 'owner') {
  const shareApi = api === 'none' ? undefined : api;
  const wrapper =
    access === 'none'
      ? undefined
      : ({ children }: { children: ReactNode }) => (
          <ReportAccessProvider reportKey="user-activity" title="User Activity" access={access}>
            {children}
          </ReportAccessProvider>
        );
  const write = vi.fn((op: () => Promise<unknown>) => void op().catch(() => undefined));
  const current = vi.fn(() => ({ filters: { orgs: ['Acme'] }, metric: { col: 'events', fn: 'count' } }));
  const hook = renderHook(() => useReportViewSharing(shareApi, { views, write }, 'user-activity', current), { wrapper });
  return { hook, write, current, shareApi };
}

describe('V1 (BACKLOG-4144) view Share follows the caller\'s report role', () => {
  it('V1a a report VIEWER gets no Share; Leave and Update stay', () => {
    const s = mount([OWN], fakeShareApi(), 'viewer').hook.result.current.sharing;
    expect(s).toBeDefined();
    expect(s!.onShare).toBeUndefined();
    expect(typeof s!.onLeave).toBe('function');
    expect(typeof s!.onUpdate).toBe('function');
  });

  it('V1b no report access in context (no provider): no Share', () => {
    expect(mount([OWN], fakeShareApi(), 'none').hook.result.current.sharing?.onShare).toBeUndefined();
  });

  it('V1c an EDITOR and an OWNER get Share', () => {
    expect(typeof mount([OWN], fakeShareApi(), 'editor').hook.result.current.sharing?.onShare).toBe('function');
    expect(typeof mount([OWN], fakeShareApi(), 'owner').hook.result.current.sharing?.onShare).toBe('function');
  });
});

describe('P5 sharing is offered only when the database has the share functions', () => {
  it('P5a rows from a database before sharing (no access field): no sharing', () => {
    const legacy = [{ id: vid(1), name: 'Mine', isDefault: false, access: 'owner' as const, accessFromServer: false }];
    expect(mount(legacy).hook.result.current.sharing).toBeUndefined();
  });

  it('P5b no rows, no list, no api: no sharing', () => {
    expect(mount([]).hook.result.current.sharing).toBeUndefined();
    expect(mount(null).hook.result.current.sharing).toBeUndefined();
    expect(mount([OWN], 'none').hook.result.current.sharing).toBeUndefined();
  });

  it('P5c rows from the sharing list function: sharing offered', () => {
    expect(mount([OWN]).hook.result.current.sharing).toBeDefined();
  });

  it('P5d a share function that does not exist turns sharing off', async () => {
    const api = fakeShareApi();
    api.candidates.mockRejectedValue({ code: 'PGRST202', message: 'Could not find the function public.report_share_candidates' });
    const { hook } = mount([OWN], api);
    act(() => hook.result.current.sharing!.onShare!(OWN));
    await waitFor(() => expect(hook.result.current.sharing).toBeUndefined());
  });
});

describe('P6 the ShareDialog picker is fed by candidates only', () => {
  it('P6b Share opens the dialog with the candidates for THAT view', async () => {
    const { hook, shareApi } = mount([OWN]);
    expect(hook.result.current.shareDialog.open).toBe(false);
    act(() => hook.result.current.sharing!.onShare!(OWN));
    expect(hook.result.current.shareDialog).toMatchObject({ open: true, viewName: 'Mine' });
    await waitFor(() => expect(hook.result.current.shareDialog.candidates).toEqual([{ id: vid(101), name: 'Avery Example' }]));
    expect(shareApi!.candidates).toHaveBeenCalledWith(vid(1));
    expect(hook.result.current.shareDialog.grants).toEqual([]);
  });

  it('grant and remove write, then re-read the grants; a refusal shows', async () => {
    const { hook, shareApi } = mount([OWN]);
    const api = shareApi as ReturnType<typeof fakeShareApi>;
    act(() => hook.result.current.sharing!.onShare!(OWN));
    await waitFor(() => expect(hook.result.current.shareDialog.candidates).not.toBeNull());
    act(() => hook.result.current.shareDialog.onGrant(vid(101), 'editor'));
    await waitFor(() => expect(api.grants).toHaveBeenCalledTimes(2));
    expect(api.share).toHaveBeenCalledWith(vid(1), vid(101), 'editor');
    api.removeGrant.mockRejectedValueOnce({ message: 'Saved view not found' });
    act(() => hook.result.current.shareDialog.onRemove({ userId: vid(101), name: 'Avery Example', role: 'editor' }));
    await waitFor(() => expect(hook.result.current.shareDialog.error).toBe('Saved view not found'));
    act(() => hook.result.current.shareDialog.onOpenChange(false));
    expect(hook.result.current.shareDialog.open).toBe(false);
  });
});

describe('R1 a late reply for another view is discarded', () => {
  it('A is opened, then B; A resolves last; B shows only B people and Remove acts on B', async () => {
    const OTHER: View = { ...OWN, id: vid(5), name: 'Mine too' };
    const api = fakeShareApi();
    let resolveA: (v: unknown) => void = () => undefined;
    let resolveACand: (v: unknown) => void = () => undefined;
    const A_GRANTS = [{ userId: vid(201), name: 'Avery Example', role: 'viewer' }];
    const B_GRANTS = [{ userId: vid(202), name: 'Robin Marsh', role: 'editor' }];
    api.grants.mockImplementation((id: string) =>
      id === vid(1) ? new Promise((r) => (resolveA = r)) : Promise.resolve(B_GRANTS)
    );
    api.candidates.mockImplementation((id: string) =>
      id === vid(1) ? new Promise((r) => (resolveACand = r)) : Promise.resolve([{ id: vid(102), name: 'Blake Builder' }])
    );
    const { hook } = mount([OWN, OTHER], api);
    act(() => hook.result.current.sharing!.onShare!(OWN));
    act(() => hook.result.current.sharing!.onShare!(OTHER));
    await waitFor(() => expect(hook.result.current.shareDialog.grants).toEqual(B_GRANTS));
    await act(async () => {
      resolveA(A_GRANTS);
      resolveACand([{ id: vid(101), name: 'Avery Example' }]);
      await Promise.resolve();
    });
    expect(hook.result.current.shareDialog).toMatchObject({ viewName: 'Mine too', grants: B_GRANTS });
    expect(hook.result.current.shareDialog.candidates).toEqual([{ id: vid(102), name: 'Blake Builder' }]);
    act(() => hook.result.current.shareDialog.onRemove(B_GRANTS[0] as never));
    act(() => hook.result.current.shareDialog.onGrant(vid(102), 'viewer'));
    expect(api.removeGrant).toHaveBeenCalledWith(vid(5), vid(202));
    expect(api.share).toHaveBeenCalledWith(vid(5), vid(102), 'viewer');
  });
});

describe('P4 Update and Leave', () => {
  it('P4b Update sends the report key, the view id and the payload, through the write runner', async () => {
    const { hook, write, shareApi } = mount([OWN, EDITOR]);
    const payload = { filters: { orgs: ['Acme'] }, metric: { col: 'events', fn: 'count' } };
    act(() => hook.result.current.sharing!.onUpdate(EDITOR, payload));
    expect(write).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(shareApi!.update).toHaveBeenCalledTimes(1));
    expect(shareApi!.update).toHaveBeenCalledWith({ reportKey: 'user-activity', id: vid(3), ...payload });
  });

  it('P4c a view with its own metric (a pinned card) keeps it; the page filters still go', async () => {
    const card = { ...EDITOR, metric: { col: 'duration', fn: 'p90' } };
    const { hook, shareApi } = mount([OWN, card]);
    act(() =>
      hook.result.current.sharing!.onUpdate(card, { filters: { types: ['backup'] }, metric: { col: 'runs', fn: 'count' } })
    );
    await waitFor(() => expect(shareApi!.update).toHaveBeenCalledTimes(1));
    expect(shareApi!.update).toHaveBeenCalledWith({
      reportKey: 'user-activity',
      id: vid(3),
      filters: { types: ['backup'] },
      metric: { col: 'duration', fn: 'p90' },
    });
  });

  // BACKLOG-4142: with a picker, the metric the editor picked is what reaches report_save_view.
  // The card's own metric, the page's metric and the picked one all differ, so an override shows.
  it('P4d with renderMetric: p_metric is the picked metric, p_name null, no p_pinned; the form starts from the view metric', async () => {
    const { rpc, client } = fakeClient();
    const shareApi = createShareApi(() => client);
    const card = { ...EDITOR, metric: { col: 'duration', fn: 'p90' } };
    const write = vi.fn((op: () => Promise<unknown>) => void op().catch(() => undefined));
    const current = vi.fn(() => ({ filters: { types: ['backup'] }, metric: { col: 'runs', fn: 'count' } }));
    const renderMetric = vi.fn(() => null);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ReportAccessProvider reportKey="iphone-sync" title="iPhone Sync" access="owner">
        {children}
      </ReportAccessProvider>
    );
    const hook = renderHook(
      () => useReportViewSharing(shareApi, { views: [OWN, card], write }, 'iphone-sync', current, renderMetric),
      { wrapper }
    );
    const sharing = hook.result.current.sharing!;
    expect(sharing.updateMetric).toBeDefined();
    expect(sharing.updateMetric!.initial(card)).toEqual({ col: 'duration', fn: 'p90' });
    const picked = { col: 'errors', fn: 'count' };
    act(() => sharing.onUpdate(card, { filters: { types: ['backup'] }, metric: picked }, { metricPicked: true }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    const [fn, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(fn).toBe('report_save_view');
    expect(args).toEqual({
      p_report_key: 'iphone-sync',
      p_name: null,
      p_filters: { types: ['backup'] },
      p_metric: picked,
      p_id: vid(3),
    });
    expect(Object.keys(args)).not.toContain('p_pinned');
  });

  // Security review (version skew): a payload without the kit's marker came from a one-click Update,
  // so even with a picker wired the view's own metric is what goes out.
  it('P4f with renderMetric but no metricPicked marker: the view own metric is sent, not the payload', async () => {
    const { rpc, client } = fakeClient();
    const shareApi = createShareApi(() => client);
    const card = { ...EDITOR, metric: { col: 'duration', fn: 'p90' } };
    const write = vi.fn((op: () => Promise<unknown>) => void op().catch(() => undefined));
    const current = vi.fn(() => ({ filters: { types: ['backup'] }, metric: { col: 'runs', fn: 'count' } }));
    const hook = renderHook(
      () => useReportViewSharing(shareApi, { views: [OWN, card], write }, 'iphone-sync', current, () => null),
      { wrapper: ({ children }: { children: ReactNode }) => <ReportAccessProvider reportKey="iphone-sync" title="iPhone Sync" access="owner">{children}</ReportAccessProvider> }
    );
    act(() => hook.result.current.sharing!.onUpdate(card, { filters: { types: ['backup'] }, metric: { col: 'runs', fn: 'count' } }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    const args = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args[1].p_metric).toEqual({ col: 'duration', fn: 'p90' });
  });

  // Security review (input validation): the picked metric and the seed go through the report's allowlist.
  it('P4g normalizeMetric is applied to the picked metric and to the seed', async () => {
    const { rpc, client } = fakeClient();
    const shareApi = createShareApi(() => client);
    const card = { ...EDITOR, metric: { col: 'not-a-column', fn: 'drop' } };
    const write = vi.fn((op: () => Promise<unknown>) => void op().catch(() => undefined));
    const current = vi.fn(() => ({ filters: { types: [] }, metric: { col: 'runs', fn: 'count' } }));
    const FALLBACK = { col: 'runs', fn: 'count' };
    const normalize = (raw: unknown) => {
      const m = raw as { col?: unknown; fn?: unknown };
      return m && (m.col === 'runs' || m.col === 'duration') && (m.fn === 'count' || m.fn === 'average')
        ? { col: m.col, fn: m.fn }
        : FALLBACK;
    };
    const hook = renderHook(
      () => useReportViewSharing(shareApi, { views: [OWN, card], write }, 'iphone-sync', current, () => null, normalize),
      { wrapper: ({ children }: { children: ReactNode }) => <ReportAccessProvider reportKey="iphone-sync" title="iPhone Sync" access="owner">{children}</ReportAccessProvider> }
    );
    const sharing = hook.result.current.sharing!;
    expect(sharing.updateMetric!.initial(card)).toEqual(FALLBACK);
    const hostile = { col: 'duration', fn: 'average', extra: '<script>' } as unknown;
    act(() => sharing.onUpdate(card, { filters: { types: [] }, metric: { col: 'evil', fn: 'x' } }, { metricPicked: true }));
    act(() => sharing.onUpdate(card, { filters: { types: [] }, metric: hostile }, { metricPicked: true }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    const metrics = rpc.mock.calls.map((c) => (c as unknown as [string, Record<string, unknown>])[1].p_metric);
    expect(metrics).toEqual([FALLBACK, { col: 'duration', fn: 'average' }]);
  });

  it('P4e without renderMetric there is no picker (the kit keeps one-click Update)', () => {
    const { hook } = mount([OWN, EDITOR]);
    expect(hook.result.current.sharing!.updateMetric).toBeUndefined();
  });

  it('Leave removes the caller access through the write runner', async () => {
    const { hook, write, shareApi } = mount([OWN, VIEWER]);
    act(() => hook.result.current.sharing!.onLeave(VIEWER));
    expect(write).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(shareApi!.leave).toHaveBeenCalledWith(vid(2)));
  });

  it('current() is the page own', () => {
    const { hook, current } = mount([OWN]);
    expect(hook.result.current.sharing!.current).toBe(current);
  });
});
