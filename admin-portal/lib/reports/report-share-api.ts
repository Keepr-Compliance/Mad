/**
 * The saved-view sharing RPCs (BACKLOG-4087)
 *
 * Kept apart from the pure parsers so they can be tested without the browser Supabase client.
 *
 * The server functions are the access guard. Each one checks the caller itself and answers every
 * refusal with the same "Saved view not found"; nothing here decides who may share, edit or leave.
 *
 * - `candidates`: the people the OWNER may share one view with, from `report_share_candidates`
 *   (scoped server-side to that view and caller; id + display name only). This is the ONLY source
 *   of the ShareDialog picker: never a users list read any other way.
 * - `grants`: who has access now (`report_share_list`).
 * - `share` / `removeGrant`: `report_share_set` / `report_share_remove`.
 * - `leave`: the caller removes their own access (`report_share_remove` with their own id).
 * - `update`: an editor saves the page's filters and metric into a view shared with them
 *   (`report_save_view` with the view's id). `p_name` has no default in that function's signature,
 *   so it is sent as null; `p_pinned` is not sent. The function's editor path changes filters and
 *   metric only; on the owner path a null name is refused, so this call can never rename or unpin.
 */

import type { ShareCandidate, ShareGrant, ShareRole } from '@keepr/ui';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';

export interface ShareUpdateInput<F, M> {
  reportKey: string;
  id: string;
  filters: F;
  metric: M;
}

export interface ShareApi {
  candidates(viewId: string): Promise<ShareCandidate[]>;
  grants(viewId: string): Promise<ShareGrant[]>;
  share(viewId: string, userId: string, role: ShareRole): Promise<void>;
  removeGrant(viewId: string, userId: string): Promise<void>;
  leave(viewId: string): Promise<void>;
  update<F, M>(input: ShareUpdateInput<F, M>): Promise<void>;
}

function asRows(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data)) return [];
  return data.filter((r): r is Record<string, unknown> => r != null && typeof r === 'object' && !Array.isArray(r));
}

function displayName(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : 'Unnamed user';
}

/** `report_share_candidates` rows -> picker options. Rows without an id are left out. */
export function parseShareCandidates(data: unknown): ShareCandidate[] {
  return asRows(data)
    .filter((r) => typeof r.user_id === 'string' && r.user_id.length > 0)
    .map((r) => ({ id: r.user_id as string, name: displayName(r.display_name) }));
}

/** `report_share_list` rows -> grants. An unknown role reads as viewer. */
export function parseShareGrants(data: unknown): ShareGrant[] {
  return asRows(data)
    .filter((r) => typeof r.user_id === 'string' && r.user_id.length > 0)
    .map((r) => ({
      userId: r.user_id as string,
      name: displayName(r.display_name),
      role: r.role === 'editor' ? 'editor' : 'viewer',
    }));
}

/**
 * True when the database has no such function: a database that predates sharing. PostgREST says
 * PGRST202; Postgres itself says 42883.
 */
export function isMissingFunctionError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === 'PGRST202' || code === '42883') return true;
  return typeof message === 'string' && message.includes('Could not find the function');
}

export function createShareApi(getClient: () => SupabaseClient = createClient): ShareApi {
  async function call(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await getClient().rpc(fn, args);
    if (error) throw error;
    return data;
  }

  return {
    async candidates(viewId) {
      return parseShareCandidates(await call('report_share_candidates', { p_view_id: viewId }));
    },

    async grants(viewId) {
      return parseShareGrants(await call('report_share_list', { p_view_id: viewId }));
    },

    async share(viewId, userId, role) {
      await call('report_share_set', { p_view_id: viewId, p_user_id: userId, p_role: role });
    },

    async removeGrant(viewId, userId) {
      await call('report_share_remove', { p_view_id: viewId, p_user_id: userId });
    },

    async leave(viewId) {
      const {
        data: { user },
      } = await getClient().auth.getUser();
      if (!user) throw new Error('You are signed out. Sign in again to leave this view.');
      await call('report_share_remove', { p_view_id: viewId, p_user_id: user.id });
    },

    async update({ reportKey, id, filters, metric }) {
      await call('report_save_view', {
        p_report_key: reportKey,
        p_name: null,
        p_filters: filters,
        p_metric: metric,
        p_id: id,
      });
    },
  };
}

/** The portal's share api. Created once at module scope, like the views apis. */
export const reportShareApi: ShareApi = createShareApi();
