/**
 * Google Messages Sync report — saved views (BACKLOG-3728, BACKLOG-4084)
 *
 * PURE. No browser client here, so the server page and the tests can import it.
 * The same `report_saved_views` table and RPCs as the iPhone sync report, but
 * under THIS report's registry slug: the two reports' views are kept apart.
 *
 * A view stores the report's client filters (type, outcome, platform, search)
 * and the time range (`filters.period`, see view-period.ts). This report has
 * no pinned cards, so every view saves a fixed count metric (the RPC requires
 * one) and `pinned: false`.
 */

import type { PeriodRange } from './period';
import type { SearchParamsLike } from './default-view';
import { GM_EMPTY_FILTERS, type GmFilters } from './google-messages-sync';
import { reportViewKey } from './registry';
import { resolveReportInitial, type PeriodInput } from './report-initial-view';
import {
  parseViewPeriod,
  serializeViewPeriod,
  SHARED_VIEW_PERIODS,
  viewPeriodMatches,
  type StoredViewPeriod,
} from './view-period';

export const GM_SYNC_REPORT_KEY = reportViewKey('google-messages-sync');

/** The saved-view search text is capped like the other reports' blobs. */
export const GM_VIEW_SEARCH_MAX = 200;

export interface GmViewMetric {
  col: 'runs';
  fn: 'count';
}

/** No cards on this report; the RPC still requires a metric. */
export const GM_VIEW_METRIC: GmViewMetric = { col: 'runs', fn: 'count' };

export const GM_SAVE_HINT = 'Saves the filters and the time range.';

/** What goes into `report_saved_views.filters`. */
export interface StoredGmFilters {
  types: string[];
  outcomes: string[];
  platforms: string[];
  search: string;
  period: StoredViewPeriod;
}

export interface GmSavedView {
  id: string;
  name: string;
  filters: GmFilters;
  /** Null when the row has no readable period; applying it then keeps the page's period. */
  period: StoredViewPeriod | null;
  isDefault: boolean;
}

type ListKey = 'types' | 'outcomes' | 'platforms';
const LIST_KEYS: readonly ListKey[] = ['types', 'outcomes', 'platforms'];

export function serializeGmView(
  filters: GmFilters,
  period: Pick<PeriodRange, 'key' | 'customFrom' | 'customTo'>
): StoredGmFilters {
  return {
    types: [...filters.types],
    outcomes: [...filters.outcomes],
    platforms: [...filters.platforms],
    search: filters.search.trim().slice(0, GM_VIEW_SEARCH_MAX),
    period: serializeViewPeriod(period),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string'))];
}

/** Read a stored blob back defensively. Anything unexpected becomes "no filter". */
export function parseGmFilters(raw: unknown): GmFilters {
  const blob = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    types: stringList(blob.types),
    outcomes: stringList(blob.outcomes),
    platforms: stringList(blob.platforms),
    search: typeof blob.search === 'string' ? blob.search.slice(0, GM_VIEW_SEARCH_MAX) : GM_EMPTY_FILTERS.search,
  };
}

export function parseGmSavedView(raw: unknown): GmSavedView | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  const blob = row.filters != null && typeof row.filters === 'object' ? (row.filters as Record<string, unknown>) : null;
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name.length > 0 ? row.name : 'Untitled view',
    filters: parseGmFilters(row.filters),
    period: parseViewPeriod(blob?.period, SHARED_VIEW_PERIODS),
    isDefault: row.is_default === true,
  };
}

export function parseGmSavedViews(raw: unknown): GmSavedView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseGmSavedView).filter((v): v is GmSavedView => v !== null);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

/** Is the page showing this view? Filters AND the time range. */
export function gmViewMatchesState(
  view: GmSavedView,
  filters: GmFilters,
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
export function resolveGmInitial(
  params: SearchParamsLike,
  listViews: () => Promise<unknown>
): Promise<{ initialView: GmSavedView | null; periodInput: PeriodInput }> {
  return resolveReportInitial(params, listViews, parseGmSavedViews);
}
