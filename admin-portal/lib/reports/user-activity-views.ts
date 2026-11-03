/**
 * User Activity report — saved views (BACKLOG-4084)
 *
 * PURE. No browser client here, so the server page and the tests can import it.
 * The same `report_saved_views` table and RPCs as iPhone sync and Exports,
 * under the report key 'user-activity'.
 *
 * A view stores the report's client filters (organizations, active only,
 * search) and the time range (`filters.period`, see view-period.ts). This
 * report has no pinned cards, so every view saves a fixed count metric
 * (the RPC requires one) and `pinned: false`.
 */

import type { PeriodRange } from './period';
import { hasExplicitState, resolveInitialView, type SearchParamsLike } from './default-view';
import {
  EMPTY_USER_ACTIVITY_FILTERS,
  type UserActivityFilters,
} from './user-activity';
import {
  parseViewPeriod,
  serializeViewPeriod,
  SHARED_VIEW_PERIODS,
  viewPeriodMatches,
  viewPeriodParams,
  type StoredViewPeriod,
} from './view-period';

export const USER_ACTIVITY_REPORT_KEY = 'user-activity';

/** The saved-view search text is capped like the other reports' blobs. */
export const USER_ACTIVITY_VIEW_SEARCH_MAX = 200;

export interface UserActivityViewMetric {
  col: 'rows';
  fn: 'count';
}

/** No cards on this report; the RPC still requires a metric. */
export const USER_ACTIVITY_VIEW_METRIC: UserActivityViewMetric = { col: 'rows', fn: 'count' };

export const USER_ACTIVITY_SAVE_HINT = 'Saves the filters and the time range.';

/** What goes into `report_saved_views.filters`. Organization NAMES, as the filter holds them. */
export interface StoredUserActivityFilters {
  orgs: string[];
  activeOnly: boolean;
  search: string;
  period: StoredViewPeriod;
}

export interface UserActivitySavedView {
  id: string;
  name: string;
  filters: UserActivityFilters;
  /** Null when the row has no readable period; applying it then keeps the page's period. */
  period: StoredViewPeriod | null;
  isDefault: boolean;
}

export function serializeUserActivityView(
  filters: UserActivityFilters,
  period: Pick<PeriodRange, 'key' | 'customFrom' | 'customTo'>
): StoredUserActivityFilters {
  return {
    orgs: [...filters.orgs],
    activeOnly: filters.activeOnly,
    search: filters.search.trim().slice(0, USER_ACTIVITY_VIEW_SEARCH_MAX),
    period: serializeViewPeriod(period),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string'))];
}

/** Read a stored blob back defensively. Anything unexpected becomes "no filter". */
export function parseUserActivityFilters(raw: unknown): UserActivityFilters {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_USER_ACTIVITY_FILTERS, orgs: [] };
  const blob = raw as Record<string, unknown>;
  return {
    orgs: stringList(blob.orgs),
    activeOnly: blob.activeOnly === true,
    search: typeof blob.search === 'string' ? blob.search.slice(0, USER_ACTIVITY_VIEW_SEARCH_MAX) : '',
  };
}

export function parseUserActivitySavedView(raw: unknown): UserActivitySavedView | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  const blob = row.filters != null && typeof row.filters === 'object' ? (row.filters as Record<string, unknown>) : null;
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name.length > 0 ? row.name : 'Untitled view',
    filters: parseUserActivityFilters(row.filters),
    period: parseViewPeriod(blob?.period, SHARED_VIEW_PERIODS),
    isDefault: row.is_default === true,
  };
}

export function parseUserActivitySavedViews(raw: unknown): UserActivitySavedView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseUserActivitySavedView).filter((v): v is UserActivitySavedView => v !== null);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

/** Is the page showing this view? Filters AND the time range. */
export function userActivityViewMatchesState(
  view: UserActivitySavedView,
  filters: UserActivityFilters,
  period: Pick<PeriodRange, 'key' | 'customFrom' | 'customTo'>
): boolean {
  return (
    sameSet(view.filters.orgs, filters.orgs) &&
    view.filters.activeOnly === filters.activeOnly &&
    view.filters.search.trim() === filters.search.trim() &&
    viewPeriodMatches(view.period, period)
  );
}

/** The period params the page resolves from. */
export interface PeriodInput {
  period?: string;
  from?: string;
  to?: string;
}

function paramString(params: SearchParamsLike, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * What the server page opens with: the default view (bare URL only) and the
 * period input to resolve. `listViews` is the raw RPC read; it is NOT called
 * when the URL is explicit, and a failure means "no default".
 */
export async function resolveUserActivityInitial(
  params: SearchParamsLike,
  listViews: () => Promise<unknown>
): Promise<{ initialView: UserActivitySavedView | null; periodInput: PeriodInput }> {
  const fromUrl: PeriodInput = {
    period: paramString(params, 'period'),
    from: paramString(params, 'from'),
    to: paramString(params, 'to'),
  };
  if (hasExplicitState(params)) return { initialView: null, periodInput: fromUrl };

  let views: UserActivitySavedView[] | null;
  try {
    views = parseUserActivitySavedViews(await listViews());
  } catch {
    views = null;
  }
  const initialView = resolveInitialView({ params, views });
  if (!initialView) return { initialView: null, periodInput: fromUrl };
  return {
    initialView,
    periodInput: initialView.period ? viewPeriodParams(initialView.period) : fromUrl,
  };
}
