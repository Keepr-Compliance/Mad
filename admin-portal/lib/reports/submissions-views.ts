/**
 * Submissions report — saved views (BACKLOG-4084)
 *
 * PURE. No browser client here, so the server page and the tests can import it.
 * The same `report_saved_views` table and RPCs as the other reports, under
 * this report's registry slug.
 *
 * A view stores the report's client filters (outcome, organization, agent,
 * reason, platform, search) and the time range (`filters.period`, see
 * view-period.ts). This report has no pinned cards, so every view saves a
 * fixed count metric (the RPC requires one) and `pinned: false`.
 */

import type { PeriodRange } from './period';
import type { SearchParamsLike } from './default-view';
import { reportViewKey } from './registry';
import { resolveReportInitial, type PeriodInput } from './report-initial-view';
import { EMPTY_SUBMISSION_FILTERS, type SubmissionFilters } from './submissions';
import {
  parseViewPeriod,
  serializeViewPeriod,
  SHARED_VIEW_PERIODS,
  viewPeriodMatches,
  type StoredViewPeriod,
} from './view-period';

export const SUBMISSIONS_REPORT_KEY = reportViewKey('submissions');

/** The saved-view search text is capped like the other reports' blobs. */
export const SUBMISSIONS_VIEW_SEARCH_MAX = 200;

export interface SubmissionsViewMetric {
  col: 'attempts';
  fn: 'count';
}

/** No cards on this report; the RPC still requires a metric. */
export const SUBMISSIONS_VIEW_METRIC: SubmissionsViewMetric = { col: 'attempts', fn: 'count' };

export const SUBMISSIONS_SAVE_HINT = 'Saves the filters and the time range.';

/** What goes into `report_saved_views.filters`. Values as the filters hold them. */
export interface StoredSubmissionFilters {
  statuses: string[];
  orgs: string[];
  agents: string[];
  reasons: string[];
  platforms: string[];
  search: string;
  period: StoredViewPeriod;
}

export interface SubmissionsSavedView {
  id: string;
  name: string;
  filters: SubmissionFilters;
  /** Null when the row has no readable period; applying it then keeps the page's period. */
  period: StoredViewPeriod | null;
  isDefault: boolean;
}

type ListKey = 'statuses' | 'orgs' | 'agents' | 'reasons' | 'platforms';
const LIST_KEYS: readonly ListKey[] = ['statuses', 'orgs', 'agents', 'reasons', 'platforms'];

export function serializeSubmissionsView(
  filters: SubmissionFilters,
  period: Pick<PeriodRange, 'key' | 'customFrom' | 'customTo'>
): StoredSubmissionFilters {
  return {
    statuses: [...filters.statuses],
    orgs: [...filters.orgs],
    agents: [...filters.agents],
    reasons: [...filters.reasons],
    platforms: [...filters.platforms],
    search: filters.search.trim().slice(0, SUBMISSIONS_VIEW_SEARCH_MAX),
    period: serializeViewPeriod(period),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string'))];
}

/** Read a stored blob back defensively. Anything unexpected becomes "no filter". */
export function parseSubmissionFilters(raw: unknown): SubmissionFilters {
  const blob = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    statuses: stringList(blob.statuses),
    orgs: stringList(blob.orgs),
    agents: stringList(blob.agents),
    reasons: stringList(blob.reasons),
    platforms: stringList(blob.platforms),
    search: typeof blob.search === 'string' ? blob.search.slice(0, SUBMISSIONS_VIEW_SEARCH_MAX) : EMPTY_SUBMISSION_FILTERS.search,
  };
}

export function parseSubmissionsSavedView(raw: unknown): SubmissionsSavedView | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  const blob = row.filters != null && typeof row.filters === 'object' ? (row.filters as Record<string, unknown>) : null;
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name.length > 0 ? row.name : 'Untitled view',
    filters: parseSubmissionFilters(row.filters),
    period: parseViewPeriod(blob?.period, SHARED_VIEW_PERIODS),
    isDefault: row.is_default === true,
  };
}

export function parseSubmissionsSavedViews(raw: unknown): SubmissionsSavedView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseSubmissionsSavedView).filter((v): v is SubmissionsSavedView => v !== null);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

/** Is the page showing this view? Filters AND the time range. */
export function submissionsViewMatchesState(
  view: SubmissionsSavedView,
  filters: SubmissionFilters,
  period: Pick<PeriodRange, 'key' | 'customFrom' | 'customTo'>
): boolean {
  return (
    LIST_KEYS.every((k) => sameSet(view.filters[k], filters[k])) &&
    view.filters.search.trim() === filters.search.trim() &&
    viewPeriodMatches(view.period, period)
  );
}

/**
 * What the server page opens with: the default view (bare URL only) and the
 * period input to resolve. `listViews` is not called when the URL is explicit.
 */
export function resolveSubmissionsInitial(
  params: SearchParamsLike,
  listViews: () => Promise<unknown>
): Promise<{ initialView: SubmissionsSavedView | null; periodInput: PeriodInput }> {
  return resolveReportInitial(params, listViews, parseSubmissionsSavedViews);
}
