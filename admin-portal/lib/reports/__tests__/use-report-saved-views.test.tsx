// @vitest-environment jsdom

/**
 * useReportSavedViews (BACKLOG-4084): load, write, default.
 *
 * The api is a fake with the real method names; no Supabase client here.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportViewsApi } from '../report-views-api';
import { useReportSavedViews } from '../use-report-saved-views';

interface View {
  id: string;
  name: string;
  isDefault: boolean;
}

afterEach(cleanup);
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const TWO_SAME_NAME: View[] = [
  { id: 'v-a', name: 'Same', isDefault: false },
  { id: 'v-b', name: 'Same', isDefault: true },
];

function fakeApi(rows: View[] = TWO_SAME_NAME) {
  return {
    list: vi.fn().mockResolvedValue(rows),
    save: vi.fn().mockResolvedValue({ id: 'new-id' }),
    remove: vi.fn().mockResolvedValue(undefined),
    setDefault: vi.fn().mockResolvedValue(undefined),
  } satisfies ReportViewsApi<View, Record<string, unknown>, { col: string; fn: string }>;
}

function mount(api: ReturnType<typeof fakeApi> | undefined, key = 'user-activity') {
  return renderHook(() => useReportSavedViews(api, key));
}

describe('loading', () => {
  it('lists under its own report key and derives the default by id', async () => {
    const api = fakeApi();
    const { result } = mount(api);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.list).toHaveBeenCalledWith('user-activity');
    expect(result.current.views).toHaveLength(2);
    expect(result.current.defaultViewId).toBe('v-b');
  });

  it('no flagged row means no default', async () => {
    const { result } = mount(fakeApi(TWO_SAME_NAME.map((v) => ({ ...v, isDefault: false }))));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.defaultViewId).toBeNull();
  });

  it('fails closed with no api', () => {
    const { result } = mount(undefined);
    expect(result.current.views).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.defaultViewId).toBeNull();
  });

  it('fails closed when the list is refused (migration not applied)', async () => {
    const api = fakeApi();
    api.list.mockRejectedValue(new Error('Could not find the function public.report_list_saved_views'));
    const { result } = mount(api);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.views).toBeNull();
    expect(result.current.defaultViewId).toBeNull();
  });
});

describe('setDefault', () => {
  it('sends the report key and the view id, then re-reads', async () => {
    const api = fakeApi();
    const { result } = mount(api);
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setDefault(TWO_SAME_NAME[0]));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(api.setDefault).toHaveBeenCalledWith('user-activity', 'v-a');
  });

  it('null clears the default', async () => {
    const api = fakeApi();
    const { result } = mount(api);
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setDefault(null));
    await waitFor(() => expect(api.setDefault).toHaveBeenCalledWith('user-activity', null));
  });

  it('a refusal says what the database said and re-reads; the next write clears it', async () => {
    const api = fakeApi();
    api.setDefault.mockRejectedValueOnce(Object.assign(new Error('Saved view not found'), { code: 'P0001' }));
    const { result } = mount(api);
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setDefault(TWO_SAME_NAME[0]));
    await waitFor(() => expect(result.current.writeError).toBe('Saved view not found'));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    act(() => result.current.remove(TWO_SAME_NAME[0]));
    expect(result.current.writeError).toBeNull();
  });
});

describe('save and remove', () => {
  it('save adds the report key; remove sends the id', async () => {
    const api = fakeApi();
    const { result } = mount(api, 'submissions');
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() =>
      result.current.save({ name: 'Mine', filters: { period: { key: 'month' } }, metric: { col: 'rows', fn: 'count' }, pinned: false })
    );
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0][0]).toEqual({
      reportKey: 'submissions',
      name: 'Mine',
      filters: { period: { key: 'month' } },
      metric: { col: 'rows', fn: 'count' },
      pinned: false,
    });
    act(() => result.current.remove(TWO_SAME_NAME[1]));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('v-b'));
  });
});
