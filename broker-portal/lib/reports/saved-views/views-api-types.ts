/**
 * The saved-view api shape the copied hook expects (BACKLOG-3514).
 *
 * Same contract as admin-portal/lib/reports/report-views-api.ts
 * `ReportViewsApi` / `SaveViewInput`; extract to packages/ui later with the
 * hook. Type-only: no Supabase import here.
 */

export interface SaveViewInput<F, M> {
  id?: string | null;
  reportKey: string;
  name: string;
  filters: F;
  metric: M;
  pinned: boolean;
}

export interface ReportViewsApi<V, F, M> {
  list(reportKey: string): Promise<V[]>;
  save(input: SaveViewInput<F, M>): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
  /** Make one of the caller's views the default for a report, or clear it (`id` null). */
  setDefault(reportKey: string, id: string | null): Promise<void>;
}
