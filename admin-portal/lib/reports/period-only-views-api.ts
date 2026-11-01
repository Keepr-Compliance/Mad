/**
 * Saved-view apis for Paywall Funnel, Analytics and Support SLA (BACKLOG-4084 PR F):
 * the shared RPCs with each report's own parser on the way out.
 *
 * Created ONCE at module scope. `useReportSavedViews` re-lists whenever the
 * api object changes identity, so building one inside a render would re-list
 * on every render.
 */

import { createReportViewsApi, type ReportViewsApi } from './report-views-api';
import {
  analyticsViews,
  funnelViews,
  supportSlaViews,
  type PeriodOnlySavedView,
  type PeriodOnlyViewMetric,
  type StoredPeriodOnlyFilters,
} from './period-only-views';

export type PeriodOnlyViewsApi = ReportViewsApi<PeriodOnlySavedView, StoredPeriodOnlyFilters, PeriodOnlyViewMetric>;

export const funnelViewsApi: PeriodOnlyViewsApi = createReportViewsApi<
  PeriodOnlySavedView,
  StoredPeriodOnlyFilters,
  PeriodOnlyViewMetric
>(funnelViews.parseRows);

export const analyticsViewsApi: PeriodOnlyViewsApi = createReportViewsApi<
  PeriodOnlySavedView,
  StoredPeriodOnlyFilters,
  PeriodOnlyViewMetric
>(analyticsViews.parseRows);

export const supportSlaViewsApi: PeriodOnlyViewsApi = createReportViewsApi<
  PeriodOnlySavedView,
  StoredPeriodOnlyFilters,
  PeriodOnlyViewMetric
>(supportSlaViews.parseRows);
