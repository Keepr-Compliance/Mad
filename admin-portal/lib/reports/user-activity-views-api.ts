/**
 * The User Activity report's saved-view api (BACKLOG-4084): the shared RPCs
 * with the User Activity parser on the way out.
 *
 * Created ONCE at module scope. `useReportSavedViews` re-lists whenever the
 * api object changes identity, so building it inside a render would re-list
 * on every render.
 */

import { createReportViewsApi, type ReportViewsApi } from './report-views-api';
import {
  parseUserActivitySavedViews,
  type StoredUserActivityFilters,
  type UserActivitySavedView,
  type UserActivityViewMetric,
} from './user-activity-views';

export type UserActivityViewsApi = ReportViewsApi<
  UserActivitySavedView,
  StoredUserActivityFilters,
  UserActivityViewMetric
>;

export const userActivityViewsApi: UserActivityViewsApi = createReportViewsApi<
  UserActivitySavedView,
  StoredUserActivityFilters,
  UserActivityViewMetric
>(parseUserActivitySavedViews);
