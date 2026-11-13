/**
 * Broker shared reports: create, update, delete, take over — BACKLOG-3513 PR-3b.
 *
 * Browser session client only. Migration 20261112200000:
 *  - broker_report_def_create(p_org, p_dataset, p_name, p_description, p_definition, p_row_scope) -> uuid
 *    (any active member, agents included; the caller becomes the owner)
 *  - broker_report_def_update(p_def, p_name, p_description, p_definition, p_row_scope, p_expected_updated_at)
 *    (owner or editor; "Report changed" when updated_at moved on)
 *  - broker_report_def_delete(p_def) (owner only)
 *  - broker_report_take_over(p_def) (an active broker / admin / IT admin, only when the owner is gone)
 */

import { createClient } from '@/lib/supabase/client';
import { SHARE_RPC, type RowScope } from './sharing-api';

export interface ReportDefinitionsApi {
  create(input: { orgId: string; name: string; definition: unknown }): Promise<string>;
  update(input: {
    id: string;
    name: string;
    description: string | null;
    definition: unknown;
    rowScope: RowScope;
    expectedUpdatedAt: string;
  }): Promise<void>;
  remove(id: string): Promise<void>;
  takeOver(id: string): Promise<void>;
}

async function call(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await createClient().rpc(fn, args);
  if (error) throw error;
  return data;
}

export const reportDefinitionsApi: ReportDefinitionsApi = {
  async create({ orgId, name, definition }) {
    const id = await call(SHARE_RPC.create, {
      p_org: orgId,
      p_dataset: 'submissions',
      p_name: name,
      p_description: null,
      p_definition: definition,
      p_row_scope: 'all',
    });
    if (typeof id !== 'string' || !id) throw new Error('That report could not be saved.');
    return id;
  },
  async update(input) {
    await call(SHARE_RPC.update, {
      p_def: input.id,
      p_name: input.name,
      p_description: input.description,
      p_definition: input.definition,
      p_row_scope: input.rowScope,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
  },
  async remove(id) {
    await call(SHARE_RPC.remove_def, { p_def: id });
  },
  async takeOver(id) {
    await call(SHARE_RPC.takeOver, { p_def: id });
  },
};
