/**
 * Saved views: read a stored view back against what the report offers TODAY
 * (BACKLOG-3514).
 *
 * PURE. No Supabase, no React.
 *
 * A saved view outlives the report it was saved on: a filter is renamed, a
 * column is removed. A stored key the report no longer knows must be removed
 * BEFORE it reaches the query builder. Passed through, it becomes an
 * unknown-column error from the database, a catch renders an empty report,
 * and that reads as "no data" (PR-SOP 6.4). So:
 *
 *   - every filter key, sort key and metric column not in the report's
 *     `savedView` spec is STRIPPED, and named in `dropped` for a notice;
 *   - a value of the wrong shape (an object, null, a mixed array) is stripped
 *     the same way;
 *   - nothing here throws, whatever the stored JSON holds.
 */

import type { ReportSavedViewSpec } from '../registry';

/** One filter's value. Anything else read from storage is malformed and stripped. */
export type FilterValue = string | number | boolean | string[];

export type SortDirection = 'asc' | 'desc';

export interface ViewSort {
  key: string;
  direction: SortDirection;
}

export type MetricFunction = 'count' | 'sum' | 'average' | 'min' | 'max';

export const METRIC_FUNCTIONS: readonly MetricFunction[] = ['count', 'sum', 'average', 'min', 'max'];

export interface ViewMetric {
  col: string;
  fn: MetricFunction;
}

/** The page state a view restores. This is what goes into the `filters` column. */
export interface ViewState {
  filters: Record<string, FilterValue>;
  sort: ViewSort | null;
}

export const EMPTY_VIEW_STATE: ViewState = { filters: {}, sort: null };

export interface DegradedView extends ViewState {
  metric: ViewMetric | null;
  /** What was stripped, e.g. "filter status", "sort age", "metric column rate". Empty: nothing. */
  dropped: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function asFilterValue(value: unknown): FilterValue | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return [...(value as string[])];
  return undefined;
}

/**
 * The stored `filters` blob and `metric`, reduced to what `spec` allows.
 * `rawFilters` is the whole `filters` column: `{ filters: {...}, sort: {...} }`.
 */
export function degradeView(rawFilters: unknown, rawMetric: unknown, spec: ReportSavedViewSpec): DegradedView {
  const dropped: string[] = [];
  const filters: Record<string, FilterValue> = {};
  let sort: ViewSort | null = null;
  let metric: ViewMetric | null = null;

  const blob = isPlainObject(rawFilters) ? rawFilters : {};
  if (rawFilters !== null && rawFilters !== undefined && !isPlainObject(rawFilters)) dropped.push('filters');

  const storedFilters = blob.filters;
  if (isPlainObject(storedFilters)) {
    for (const [key, value] of Object.entries(storedFilters)) {
      if (!spec.filterKeys.includes(key)) {
        dropped.push(`filter ${key}`) /*STRIP_UNKNOWN_FILTER*/;
        continue;
      }
      const parsed = asFilterValue(value);
      if (parsed === undefined) {
        dropped.push(`filter ${key}`);
        continue;
      }
      filters[key] = parsed;
    }
  } else if (storedFilters !== undefined) {
    dropped.push('filters');
  }

  const storedSort = blob.sort;
  if (isPlainObject(storedSort)) {
    const key = storedSort.key;
    const direction = storedSort.direction;
    if (typeof key === 'string' && spec.sortKeys.includes(key) && (direction === 'asc' || direction === 'desc')) {
      sort = { key, direction };
    } else {
      dropped.push(typeof key === 'string' ? `sort ${key}` : 'sort');
    }
  } else if (storedSort !== null && storedSort !== undefined) {
    dropped.push('sort');
  }

  if (isPlainObject(rawMetric)) {
    const col = rawMetric.col;
    const fn = rawMetric.fn;
    if (typeof col === 'string' && spec.metricColumns.includes(col) && METRIC_FUNCTIONS.includes(fn as MetricFunction)) {
      metric = { col, fn: fn as MetricFunction };
    } else {
      dropped.push(typeof col === 'string' ? `metric column ${col}` : 'metric');
    }
  } else if (rawMetric !== null && rawMetric !== undefined) {
    dropped.push('metric');
  }

  return { filters, sort, metric, dropped };
}

/** The `filters` column for a save: the page state, already limited to the spec. */
export function serializeViewState(state: ViewState, spec: ReportSavedViewSpec): ViewState {
  const { filters, sort } = degradeView(state, null, spec);
  return { filters, sort };
}

function sameValue(a: FilterValue, b: FilterValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const left = [...a].sort();
    const right = [...b].sort();
    return left.every((v, i) => v === right[i]);
  }
  return a === b;
}

/** Is the page showing this state? Derived at every render, never remembered. */
export function viewMatchesState(view: ViewState, current: ViewState): boolean {
  const keys = new Set([...Object.keys(view.filters), ...Object.keys(current.filters)]);
  for (const key of keys) {
    const a = view.filters[key];
    const b = current.filters[key];
    if (a === undefined || b === undefined) {
      if (a !== b) return false;
      continue;
    }
    if (!sameValue(a, b)) return false;
  }
  const s1 = view.sort;
  const s2 = current.sort;
  if (s1 === null || s2 === null) return s1 === s2;
  return s1.key === s2.key && s1.direction === s2.direction;
}
