/**
 * The Google Messages Sync report's saved-view api (BACKLOG-4084): the shared
 * RPCs with the Google Messages Sync parser on the way out.
 *
 * Created ONCE at module scope. `useReportSavedViews` re-lists whenever the
 * api object changes identity, so building it inside a render would re-list
 * on every render.
 */

import { createReportViewsApi, type ReportViewsApi } from './report-views-api';
import {
  parseGmSavedViews,
  type GmSavedView,
  type GmViewMetric,
  type StoredGmFilters,
} from './google-messages-sync-views';

export type GmViewsApi = ReportViewsApi<GmSavedView, StoredGmFilters, GmViewMetric>;

export const gmViewsApi: GmViewsApi = createReportViewsApi<GmSavedView, StoredGmFilters, GmViewMetric>(
  parseGmSavedViews
);
