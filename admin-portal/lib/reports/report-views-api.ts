/**
 * The three saved-view RPCs (BACKLOG-3450)
 *
 * Separated from `report-views.ts` so that the pure half — metrics, parsing,
 * matching — can be tested without importing the browser Supabase client.
 *
 * FAILS CLOSED, BY CONTRACT. The migration that creates these functions is
 * applied by the founder, not by the engineer, so between merge and apply
 * every call here returns PostgREST's "Could not find the function" error. The
 * caller turns any rejection into "saved views are not available yet" and the
 * rest of the report keeps working: a page whose charts and table are correct
 * must not look broken because a migration has not been applied.
 */

import { createClient } from '@/lib/supabase/client';
import { parseSavedViews, type ReportSavedView, type StoredFilters, type ViewMetric } from './report-views';

export interface SaveViewInput {
  id?: string | null;
  reportKey: string;
  name: string;
  filters: StoredFilters;
  metric: ViewMetric;
  pinned: boolean;
}

export interface ReportViewsApi {
  list(reportKey: string): Promise<ReportSavedView[]>;
  save(input: SaveViewInput): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
}

export const reportViewsApi: ReportViewsApi = {
  async list(reportKey) {
    const supabase = createClient();
    const { data, error } = await supabase.rpc('report_list_saved_views', {
      p_report_key: reportKey,
    });
    if (error) throw error;
    return parseSavedViews(data);
  },

  async save(input) {
    const supabase = createClient();
    const { data, error } = await supabase.rpc('report_save_view', {
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
    const { error } = await supabase.rpc('report_delete_saved_view', { p_id: id });
    if (error) throw error;
  },
};
