/**
 * The Exports report's saved-view api (BACKLOG-4004): the shared RPCs with
 * the Exports parser on the way out. Kept apart from `exports-views.ts` so the
 * pure half never imports the browser Supabase client.
 */

import { createReportViewsApi, type ReportViewsApi } from './report-views-api';
import {
  parseExportSavedViews,
  type ExportSavedView,
  type ExportViewMetric,
  type StoredExportFilters,
} from './exports-views';

export const exportsViewsApi: ReportViewsApi<ExportSavedView, StoredExportFilters, ExportViewMetric> =
  createReportViewsApi<ExportSavedView, StoredExportFilters, ExportViewMetric>(parseExportSavedViews);
