/**
 * Broker shared reports: the browser-side RPCs — BACKLOG-3513 PR-3b.
 *
 * Browser session client only (the caller's own session); never the service
 * client. Every function is in migration 20261112200000 and refuses with
 * "Report not found" for anyone without the right level; the UI hides what the
 * caller may not do, the database decides. Replies go through the pure parsers
 * in lib/reports/definitions/parse.ts.
 */

import type { SharingLevel, SharingPrincipal } from '@keepr/ui';
import { createClient } from '@/lib/supabase/client';
import {
  parseCandidates,
  parseDefinition,
  parseShareState,
  type DefinitionRecord,
  type GeneralAccess,
  type RowScope,
  type ShareState,
} from '@/lib/reports/definitions/parse';

export * from '@/lib/reports/definitions/parse';

export const SHARE_RPC = {
  list: 'broker_report_share_list',
  candidates: 'broker_report_share_candidates',
  set: 'broker_report_share_set',
  remove: 'broker_report_share_remove',
  generalAccess: 'broker_report_set_general_access',
  transfer: 'broker_report_transfer',
  get: 'broker_report_def_get',
  update: 'broker_report_def_update',
  create: 'broker_report_def_create',
  remove_def: 'broker_report_def_delete',
  takeOver: 'broker_report_take_over',
} as const;

export interface ReportSharingApi {
  state(defId: string): Promise<ShareState>;
  candidates(defId: string): Promise<SharingPrincipal[]>;
  definition(defId: string): Promise<DefinitionRecord | null>;
  /** One call for every principal picked. */
  share(defId: string, principals: readonly Pick<SharingPrincipal, 'kind' | 'id'>[], level: SharingLevel): Promise<void>;
  remove(defId: string, kind: SharingPrincipal['kind'], id: string): Promise<void>;
  setGeneralAccess(defId: string, value: GeneralAccess): Promise<void>;
  transfer(defId: string, newOwner: string): Promise<void>;
  /** def_update with every stored field sent back unchanged and the new row scope. */
  setRowScope(def: DefinitionRecord, rowScope: RowScope): Promise<void>;
}

async function call(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await createClient().rpc(fn, args);
  if (error) throw error;
  return data;
}

export const reportSharingApi: ReportSharingApi = {
  async state(defId) {
    return parseShareState(await call(SHARE_RPC.list, { p_def: defId }));
  },
  async candidates(defId) {
    return parseCandidates(await call(SHARE_RPC.candidates, { p_def: defId }));
  },
  async definition(defId) {
    return parseDefinition(await call(SHARE_RPC.get, { p_def: defId }));
  },
  async share(defId, principals, lvl) {
    await call(SHARE_RPC.set, {
      p_def: defId,
      p_principals: principals.map((p) => ({ kind: p.kind, id: p.id })),
      p_level: lvl,
    });
  },
  async remove(defId, kind, id) {
    await call(SHARE_RPC.remove, { p_def: defId, p_kind: kind, p_id: id });
  },
  async setGeneralAccess(defId, value) {
    await call(SHARE_RPC.generalAccess, { p_def: defId, p_value: value });
  },
  async transfer(defId, newOwner) {
    await call(SHARE_RPC.transfer, { p_def: defId, p_new_owner: newOwner });
  },
  async setRowScope(def, rowScope) {
    await call(SHARE_RPC.update, {
      p_def: def.id,
      p_name: def.name,
      p_description: def.description,
      p_definition: def.definition,
      p_row_scope: rowScope,
      p_expected_updated_at: def.updatedAt,
    });
  },
};
