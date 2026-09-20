/**
 * Saved views and pinned cards for the analytics reports (BACKLOG-3450)
 *
 * PURE. No Supabase import, no React — the three RPC wrappers live in
 * `report-views-api.ts` so that every test touching {@link computeMetric} or
 * {@link parseStoredFilters} stays free of the browser client and its env.
 *
 * A saved view is a set of client-side filters plus a column and a function.
 * THE PERIOD IS NOT PART OF IT: a pinned card keeps its saved filters and
 * follows whichever period is selected on the page, so a stored period would
 * let a card contradict the selector above it.
 */

import type { SyncRun, SyncType } from './iphone-sync';
import { applyFilters, EMPTY_FILTERS, type RunFilters } from './iphone-sync-filters';

/** Which report a saved view belongs to. One table serves them all. */
export const REPORT_KEY = 'iphone-sync';

/**
 * At most five pinned cards. Enforced HERE and again in `report_save_view` —
 * two tabs defeat a client-side guard, and the sixth card would then be a
 * permanent render bug with no way to reach it.
 */
export const MAX_PINNED = 5;

// ─── Columns and functions ───────────────────────────────────────

export type MetricColumn = 'runs' | 'duration' | 'backup' | 'rate' | 'messages' | 'deviceUsed';
export type MetricFunction = 'count' | 'average' | 'sum' | 'min' | 'max';

export interface ViewMetric {
  col: MetricColumn;
  fn: MetricFunction;
}

interface ColumnSpec {
  value: MetricColumn;
  label: string;
  /** Appended to a non-count value. Empty for a bare number. */
  unit: string;
  decimals: number;
  /** Null means "this run has no such measurement" and is SKIPPED, never zeroed. */
  valueOf: (run: SyncRun) => number | null;
}

export const METRIC_COLUMNS: ColumnSpec[] = [
  // Every run counts as one, so `count` over this column is the run count.
  { value: 'runs', label: 'Runs', unit: '', decimals: 0, valueOf: () => 1 },
  { value: 'duration', label: 'Duration (min)', unit: ' min', decimals: 1, valueOf: (r) => r.minutes },
  { value: 'backup', label: 'Backup (GB)', unit: ' GB', decimals: 1, valueOf: (r) => r.backupGb },
  { value: 'rate', label: 'Rate (MB/s)', unit: ' MB/s', decimals: 1, valueOf: (r) => r.rateMbPerSec },
  { value: 'messages', label: 'Messages', unit: '', decimals: 0, valueOf: (r) => r.messagesExtracted },
  { value: 'deviceUsed', label: 'Device used (GB)', unit: ' GB', decimals: 1, valueOf: (r) => r.deviceUsedGb },
];

const COLUMN_BY_VALUE = new Map(METRIC_COLUMNS.map((c) => [c.value, c]));

export const METRIC_FUNCTIONS: { value: MetricFunction; label: string }[] = [
  { value: 'count', label: 'count' },
  { value: 'average', label: 'average' },
  { value: 'sum', label: 'sum' },
  { value: 'min', label: 'min' },
  { value: 'max', label: 'max' },
];

/**
 * `runs` offers COUNT only.
 *
 * Every run's value is 1, so sum would restate the count and average, min and
 * max would all read 1.0 forever — five choices, one of which means anything.
 */
export function functionsFor(col: MetricColumn): MetricFunction[] {
  return col === 'runs' ? ['count'] : METRIC_FUNCTIONS.map((f) => f.value);
}

/**
 * The value a pinned card shows.
 *
 * NULLS ARE SKIPPED, NOT ZEROED, and an empty set returns null rather than 0.
 * Rate is null on 20 of the 24 rows on record: treating those as zero would
 * make an average Rate card read a number that describes nothing, and a Rate
 * card over a period with no backups would read "0.0 MB/s" instead of "—".
 *
 * `count` is the number of runs that HAVE a value for the column, which for
 * `runs` is the run count and for `rate` is "how many runs measured a rate".
 */
export function computeMetric(runs: SyncRun[], metric: ViewMetric): number | null {
  const spec = COLUMN_BY_VALUE.get(metric.col);
  if (!spec) return null;

  const values: number[] = [];
  for (const run of runs) {
    const value = spec.valueOf(run);
    if (value == null || Number.isNaN(value)) continue;
    values.push(value);
  }

  if (metric.fn === 'count') return values.length;
  if (values.length === 0) return null;

  switch (metric.fn) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'average':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    default:
      return null;
  }
}

/** "22.7 min", "24.6 MB/s", "24", "—". A count is a plain integer, always. */
export function formatMetricValue(value: number | null, metric: ViewMetric): string {
  if (value == null || Number.isNaN(value)) return '—';
  if (metric.fn === 'count') return Math.round(value).toLocaleString('en-US');
  const spec = COLUMN_BY_VALUE.get(metric.col);
  if (!spec) return '—';
  const rounded = value.toFixed(spec.decimals);
  return `${Number(rounded).toLocaleString('en-US', {
    minimumFractionDigits: spec.decimals,
    maximumFractionDigits: spec.decimals,
  })}${spec.unit}`;
}

/** "Average duration (min)" — what the card's own label says it is measuring. */
export function metricLabel(metric: ViewMetric): string {
  const spec = COLUMN_BY_VALUE.get(metric.col);
  if (!spec) return '';
  const fn = METRIC_FUNCTIONS.find((f) => f.value === metric.fn)?.label ?? metric.fn;
  return `${fn} · ${spec.label}`;
}

// ─── The stored blob ─────────────────────────────────────────────

/**
 * What goes into `report_saved_views.filters`, and NOTHING ELSE.
 *
 * Five keys. No run data, no user labels, no ids — a saved view describes what
 * the page was narrowed to, never who or what was in it. A user label falls
 * back to the account's email when there is no display name, so a payload that
 * carried one could put an email into a stored row.
 */
export interface StoredFilters {
  types: string[];
  outcomes: string[];
  platforms: string[];
  search: string;
  stalledOnly: boolean;
}

export const STORED_FILTER_KEYS: readonly (keyof StoredFilters)[] = [
  'types',
  'outcomes',
  'platforms',
  'search',
  'stalledOnly',
];

export function serializeFilters(filters: RunFilters, stalledOnly: boolean): StoredFilters {
  return {
    types: [...filters.types],
    outcomes: [...filters.outcomes],
    platforms: [...filters.platforms],
    search: filters.search.trim().slice(0, 120),
    stalledOnly,
  };
}

const SYNC_TYPES: readonly SyncType[] = ['first', 'incremental', 'unknown'];

function stringList(value: unknown, allowed?: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const strings = value.filter((v): v is string => typeof v === 'string');
  const unique = [...new Set(strings)];
  return allowed ? unique.filter((v) => allowed.includes(v)) : unique;
}

export interface ParsedView {
  filters: RunFilters;
  stalledOnly: boolean;
}

/**
 * Read a stored blob back DEFENSIVELY.
 *
 * `filters` is the only client-authored value that comes back out of the
 * database and is fed straight to a predicate. A renamed key, a hand-edited
 * row, a string where an array belongs — none of them may throw inside a
 * render. Anything unexpected becomes "no filter", which shows the whole
 * period rather than a blank page.
 */
export function parseStoredFilters(raw: unknown): ParsedView {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { filters: { ...EMPTY_FILTERS }, stalledOnly: false };
  }
  const blob = raw as Record<string, unknown>;
  return {
    filters: {
      types: stringList(blob.types, SYNC_TYPES) as SyncType[],
      outcomes: stringList(blob.outcomes),
      platforms: stringList(blob.platforms),
      search: typeof blob.search === 'string' ? blob.search.slice(0, 120) : '',
    },
    stalledOnly: blob.stalledOnly === true,
  };
}

/**
 * The stored metric, with a fallback rather than a throw.
 *
 * The column is NOT NULL in the table and the save form requires both halves,
 * so an unreadable one means a hand-edited row. A card labelled "count · Runs"
 * is a better outcome than a page that will not render.
 */
export const FALLBACK_METRIC: ViewMetric = { col: 'runs', fn: 'count' };

export function parseMetric(raw: unknown): ViewMetric {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { ...FALLBACK_METRIC };
  const blob = raw as Record<string, unknown>;
  const col = METRIC_COLUMNS.find((c) => c.value === blob.col)?.value;
  if (!col) return { ...FALLBACK_METRIC };
  const allowed = functionsFor(col);
  const fn = allowed.find((f) => f === blob.fn);
  if (!fn) return { col, fn: allowed[0] };
  return { col, fn };
}

// ─── The view itself ─────────────────────────────────────────────

/** A row of `report_saved_views`, already parsed. */
export interface ReportSavedView {
  id: string;
  name: string;
  filters: RunFilters;
  stalledOnly: boolean;
  metric: ViewMetric;
  pinned: boolean;
}

/** Turn one RPC row into a view, or null when it is not one. */
export function parseSavedView(raw: unknown): ReportSavedView | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  const { filters, stalledOnly } = parseStoredFilters(row.filters);
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name.length > 0 ? row.name : 'Untitled view',
    filters,
    stalledOnly,
    metric: parseMetric(row.metric),
    pinned: row.pinned === true,
  };
}

export function parseSavedViews(raw: unknown): ReportSavedView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseSavedView).filter((v): v is ReportSavedView => v !== null);
}

export function pinnedViews(views: ReportSavedView[]): ReportSavedView[] {
  return views.filter((v) => v.pinned).slice(0, MAX_PINNED);
}

/** True when pinning one more would exceed the cap. */
export function pinWouldExceedCap(views: ReportSavedView[], viewId?: string): boolean {
  return views.filter((v) => v.pinned && v.id !== viewId).length >= MAX_PINNED;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, i) => value === right[i]);
}

/**
 * Is this view the one the page is currently showing?
 *
 * DERIVED, not a flag. The page state lives in the URL (BACKLOG-3450 PR 1), so
 * a remembered "active card" id would not survive a reload and would go stale
 * the moment a filter is edited by hand. Comparing the filters answers the
 * question at every render instead.
 */
export function viewMatchesState(
  view: ReportSavedView,
  filters: RunFilters,
  stalledOnly: boolean
): boolean {
  return (
    sameSet(view.filters.types, filters.types) &&
    sameSet(view.filters.outcomes, filters.outcomes) &&
    sameSet(view.filters.platforms, filters.platforms) &&
    view.filters.search.trim() === filters.search.trim() &&
    view.stalledOnly === stalledOnly
  );
}

/**
 * The value a pinned card shows, over THE PERIOD'S ROWS.
 *
 * `runs` here must be `report.runs` — every row the server returned for the
 * selected period — and never the page's already-filtered set. A card carries
 * its own filters; layering the page's on top would make two cards disagree
 * with their own labels the moment anything is filtered by hand.
 */
export function cardValue(runs: SyncRun[], view: ReportSavedView): number | null {
  const narrowed = applyFilters(runs, view.filters);
  const rows = view.stalledOnly ? narrowed.filter((r) => r.stalled) : narrowed;
  return computeMetric(rows, view.metric);
}

/**
 * The sentence a REFUSED write puts in the dropdown.
 *
 * The server-side pin cap exists for the case the client cannot see — a second
 * tab whose count is stale — so its message is the only thing that explains
 * why a card did not appear. Swallowing it into `console.error` leaves the user
 * with a card that silently is not there.
 *
 * Both shapes are handled on purpose. `PostgrestError extends Error` in
 * postgrest-js 2.110.2, so `instanceof` catches the real one; a bare
 * `{ message }` object is what an older client and every hand-rolled fake
 * produce, and losing the cap sentence to a fallback would be the same silence
 * in a different place.
 */
export function writeFailureMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : '';
  const message = raw.trim();
  return message.length > 0 ? message : 'That change could not be saved.';
}
