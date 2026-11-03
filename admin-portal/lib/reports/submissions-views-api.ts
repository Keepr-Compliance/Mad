/**
 * The Submissions report's saved-view api (BACKLOG-4084): the shared RPCs
 * with the Submissions parser on the way out.
 *
 * Created ONCE at module scope. `useReportSavedViews` re-lists whenever the
 * api object changes identity, so building it inside a render would re-list
 * on every render.
 */

import { createReportViewsApi, type ReportViewsApi } from './report-views-api';
import {
  parseSubmissionsSavedViews,
  type StoredSubmissionFilters,
  type SubmissionsSavedView,
  type SubmissionsViewMetric,
} from './submissions-views';

export type SubmissionsViewsApi = ReportViewsApi<
  SubmissionsSavedView,
  StoredSubmissionFilters,
  SubmissionsViewMetric
>;

export const submissionsViewsApi: SubmissionsViewsApi = createReportViewsApi<
  SubmissionsSavedView,
  StoredSubmissionFilters,
  SubmissionsViewMetric
>(parseSubmissionsSavedViews);
