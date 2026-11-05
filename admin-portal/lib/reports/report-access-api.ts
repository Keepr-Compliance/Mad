/**
 * The report access RPCs (BACKLOG-4144)
 *
 * The server functions are the access guard: each checks the caller itself (owner only for list,
 * set and candidates) and answers every refusal with the same "Report not found".
 *
 * - `candidates`: who an owner may grant access to (`report_access_candidates`, id + display name
 *   only). The ONLY source of the report ShareDialog picker.
 * - `grants`: who has access now (`report_access_list`).
 * - `set` / `remove`: `report_access_set` / `report_access_remove`, always with the open report's key.
 */

import type { ShareCandidate, ShareGrant, ShareRole } from '@keepr/ui';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { parseShareCandidates, parseShareGrants } from './report-share-api';

export interface ReportAccessApi {
  candidates(reportKey: string): Promise<ShareCandidate[]>;
  grants(reportKey: string): Promise<ShareGrant[]>;
  set(reportKey: string, userId: string, role: ShareRole): Promise<void>;
  remove(reportKey: string, userId: string): Promise<void>;
}

export function createReportAccessApi(getClient: () => SupabaseClient = createClient): ReportAccessApi {
  async function call(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await getClient().rpc(fn, args);
    if (error) throw error;
    return data;
  }

  return {
    async candidates(reportKey) {
      return parseShareCandidates(await call('report_access_candidates', { p_key: reportKey }));
    },
    async grants(reportKey) {
      return parseShareGrants(await call('report_access_list', { p_key: reportKey }));
    },
    async set(reportKey, userId, role) {
      await call('report_access_set', { p_key: reportKey, p_user_id: userId, p_role: role });
    },
    async remove(reportKey, userId) {
      await call('report_access_remove', { p_key: reportKey, p_user_id: userId });
    },
  };
}

/** The portal's report access api. Created once at module scope, like the share api. */
export const reportAccessApi: ReportAccessApi = createReportAccessApi();
