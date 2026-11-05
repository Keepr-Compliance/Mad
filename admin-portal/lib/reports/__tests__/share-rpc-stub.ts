/**
 * A fake browser Supabase client for the BACKLOG-4087 page tests: the real RPC names, rows shaped
 * like the PR 1 functions return them (migration 20261104200000), invented names.
 *
 * `report_share_candidates` answers with the candidates; any other read answers with OTHER people,
 * so a picker fed from anywhere else shows the wrong names.
 */

import { vi } from 'vitest';

export const vid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const SELF_ID = vid(900);

export const CANDIDATE_ROWS = [
  { user_id: vid(101), display_name: 'Avery Analyst' },
  { user_id: vid(102), display_name: 'Blake Builder' },
];
export const NOT_A_CANDIDATE = 'Casey Outsider';

export interface ShareRpcStub {
  rpc: ReturnType<typeof vi.fn>;
  client: { rpc: ShareRpcStub['rpc']; auth: { getUser: ReturnType<typeof vi.fn> } };
  /** The rows `report_list_saved_views` returns. */
  setListRows(rows: unknown[]): void;
  calls(fn: string): Record<string, unknown>[];
}

export function createShareRpcStub(): ShareRpcStub {
  let listRows: unknown[] = [];
  // The second parameter is unused here; it types the recorded calls as [fn, args].
  const rpc = vi.fn(async (fn: string, _args?: Record<string, unknown>) => {
    void _args;
    switch (fn) {
      case 'report_list_saved_views':
        return { data: listRows, error: null };
      case 'report_share_candidates':
        return { data: CANDIDATE_ROWS, error: null };
      case 'report_share_list':
        return { data: [], error: null };
      case 'report_save_view':
        return { data: { id: vid(1) }, error: null };
      case 'report_share_set':
      case 'report_share_remove':
      case 'report_delete_saved_view':
      case 'report_set_default_view':
        return { data: { success: true }, error: null };
      default:
        return { data: [{ user_id: vid(199), display_name: NOT_A_CANDIDATE }], error: null };
    }
  });
  const getUser = vi.fn(async () => ({ data: { user: { id: SELF_ID } }, error: null }));
  return {
    rpc,
    client: { rpc, auth: { getUser } },
    setListRows(rows) {
      listRows = rows;
    },
    calls(fn) {
      return rpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] ?? {});
    },
  };
}

/** Rows as report_list_saved_views returns them: own first (access owner), then shared (masked). */
export function ownRow(over: Record<string, unknown> = {}) {
  return {
    id: vid(1),
    name: 'My view',
    filters: {},
    metric: { col: 'events', fn: 'count' },
    pinned: false,
    is_default: false,
    created_at: '2026-11-01T00:00:00Z',
    access: 'owner',
    ...over,
  };
}

export function sharedRow(access: 'viewer' | 'editor', over: Record<string, unknown> = {}) {
  return {
    id: access === 'viewer' ? vid(2) : vid(3),
    name: access === 'viewer' ? 'Quinn view' : 'Robin view',
    filters: {},
    metric: { col: 'events', fn: 'count' },
    pinned: false,
    is_default: false,
    created_at: '2026-11-01T00:00:00Z',
    access,
    owner_name: access === 'viewer' ? 'Quinn Example' : 'Robin Sample',
    ...over,
  };
}

/** The same own row from a database before sharing: no access field. */
export function legacyRow(over: Record<string, unknown> = {}) {
  const { access: _a, ...rest } = ownRow(over);
  void _a;
  return rest;
}
