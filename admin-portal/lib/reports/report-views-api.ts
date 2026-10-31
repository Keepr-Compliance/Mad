/**
 * The saved-view RPCs (BACKLOG-3450; set-default BACKLOG-4084)
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

/**
 * One write. Generic over the stored filters blob and the metric so a second
 * report (BACKLOG-4004) can save its own shapes through the same three RPCs.
 * The defaults are the iPhone Sync shapes.
 */
export interface SaveViewInput<F = StoredFilters, M = ViewMetric> {
  id?: string | null;
  reportKey: string;
  name: string;
  filters: F;
  metric: M;
  pinned: boolean;
}

export interface ReportViewsApi<V = ReportSavedView, F = StoredFilters, M = ViewMetric> {
  list(reportKey: string): Promise<V[]>;
  save(input: SaveViewInput<F, M>): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
  /**
   * Make one of the caller's views the default for a report, or clear it
   * (`id` null). BACKLOG-4084. Refused by the server for another user's view
   * or a view of another report.
   */
  setDefault(reportKey: string, id: string | null): Promise<void>;
}

/**
 * The three RPCs, with the report's own parser on the way out. The RPCs are
 * keyed by `p_report_key`, so nothing here is specific to one report.
 */
export function createReportViewsApi<V, F, M>(
  parse: (raw: unknown) => V[]
): ReportViewsApi<V, F, M> {
  return {
    async list(reportKey) {
      const supabase = createClient();
      const { data, error } = await supabase.rpc('report_list_saved_views', {
        p_report_key: reportKey,
      });
      if (error) throw error;
      return parse(data);
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

    async setDefault(reportKey, id) {
      const supabase = createClient();
      const { error } = await supabase.rpc('report_set_default_view', {
        p_report_key: reportKey,
        p_id: id,
      });
      if (error) throw error;
    },
  };
}

/** The iPhone Sync report's api. */
export const reportViewsApi: ReportViewsApi = createReportViewsApi<
  ReportSavedView,
  StoredFilters,
  ViewMetric
>(parseSavedViews);
