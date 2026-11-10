/**
 * Broker-portal saved views: the four RPCs (BACKLOG-3514).
 *
 * Browser client only (the caller's own session); never the service client.
 * Every call names the organization the page is showing; on update, remove
 * and set-default the database gates on the view's OWN organization anyway
 * (migration 20261108220000).
 *
 * The rows come back through {@link degradeView}: a stored filter, sort or
 * metric key the report no longer offers is stripped here, before anything
 * queries with it, and listed in `dropped` for the page's notice.
 *
 * FAILS CLOSED, BY CONTRACT. Between merge and the production apply every call
 * returns PostgREST's "Could not find the function" error; the copied hook
 * turns any rejection into "saved views are not available yet".
 */

import { createClient } from '@/lib/supabase/client';
import type { ReportSavedViewSpec } from '../registry';
import { degradeView, type DegradedView, type ViewMetric, type ViewState } from './degrade';
import type { ReportViewsApi } from './views-api-types';

/** One of the caller's saved views, already read against the report's spec. */
export interface BrokerSavedView extends DegradedView {
  id: string;
  name: string;
  pinned: boolean;
  isDefault: boolean;
}

export type BrokerViewsApi = ReportViewsApi<BrokerSavedView, ViewState, ViewMetric | null>;

export const BROKER_VIEW_RPC = {
  list: 'broker_report_list_views',
  save: 'broker_report_save_view',
  remove: 'broker_report_delete_view',
  setDefault: 'broker_report_set_default_view',
} as const;

/** Turn the list RPC's reply into views. Rows without an id are skipped; nothing throws. */
export function parseBrokerViews(raw: unknown, spec: ReportSavedViewSpec): BrokerSavedView[] {
  if (!Array.isArray(raw)) return [];
  const out: BrokerSavedView[] = [];
  for (const item of raw) {
    if (item === null || item === undefined || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || row.id.length === 0) continue;
    out.push({
      id: row.id,
      name: typeof row.name === 'string' && row.name.length > 0 ? row.name : 'Untitled view',
      pinned: row.pinned === true,
      isDefault: row.is_default === true,
      ...degradeView(row.filters, row.metric, spec),
    });
  }
  return out;
}

/** The api for one organization and one report spec. */
export function createBrokerViewsApi(orgId: string, spec: ReportSavedViewSpec): BrokerViewsApi {
  return {
    async list(reportKey) {
      const supabase = createClient();
      const { data, error } = await supabase.rpc(BROKER_VIEW_RPC.list, { p_org: orgId, p_report_key: reportKey });
      if (error) throw error;
      return parseBrokerViews(data, spec);
    },

    async save(input) {
      const supabase = createClient();
      const { data, error } = await supabase.rpc(BROKER_VIEW_RPC.save, {
        p_org: orgId,
        p_report_key: input.reportKey,
        p_name: input.name,
        p_filters: input.filters,
        p_metric: input.metric,
        p_pinned: input.pinned,
        p_id: input.id ?? null,
      });
      if (error) throw error;
      return data as unknown as { id: string };
    },

    async remove(id) {
      const supabase = createClient();
      const { error } = await supabase.rpc(BROKER_VIEW_RPC.remove, { p_org: orgId, p_id: id });
      if (error) throw error;
    },

    async setDefault(reportKey, id) {
      const supabase = createClient();
      const { error } = await supabase.rpc(BROKER_VIEW_RPC.setDefault, {
        p_org: orgId,
        p_report_key: reportKey,
        p_id: id,
      });
      if (error) throw error;
    },
  };
}
