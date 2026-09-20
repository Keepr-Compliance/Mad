/**
 * iPhone Sync Performance — filtering, sorting and counting (BACKLOG-3450)
 *
 * Pure functions over an already-built `SyncRun[]`. The period is NOT here: it
 * is applied on the database (see `iphone-sync-queries.ts`), so every consumer
 * on this page starts from the same rows and a period can never reach one
 * consumer and miss another.
 *
 * The STALLED TILE is deliberately not part of {@link applyFilters}. It filters
 * the TABLE only — the tiles and both charts must keep saying what they said
 * before it was clicked, or the number on the tile changes when you click the
 * tile, which is not a filter, it is a mirror.
 */

import type { SyncRun, SyncType } from './iphone-sync';

export interface RunFilters {
  types: SyncType[];
  outcomes: string[];
  platforms: string[];
  /** Matches `userLabel` only. No email ever reaches this page — see BACKLOG-3450 Q5. */
  search: string;
}

export const EMPTY_FILTERS: RunFilters = { types: [], outcomes: [], platforms: [], search: '' };

export function hasActiveFilters(filters: RunFilters): boolean {
  return (
    filters.types.length > 0 ||
    filters.outcomes.length > 0 ||
    filters.platforms.length > 0 ||
    filters.search.trim().length > 0
  );
}

/** Names of the active filters, for the caption above the cards. */
export function activeFilterNames(filters: RunFilters): string[] {
  const names: string[] = [];
  if (filters.types.length > 0) names.push(`type: ${filters.types.join(', ')}`);
  if (filters.outcomes.length > 0) names.push(`outcome: ${filters.outcomes.join(', ')}`);
  if (filters.platforms.length > 0) names.push(`platform: ${filters.platforms.join(', ')}`);
  if (filters.search.trim().length > 0) names.push(`user matching "${filters.search.trim()}"`);
  return names;
}

/**
 * The ONE filter predicate. Cards, both charts and the table all read the set
 * this returns — a consumer reading anything else is the failure mode this
 * report was rebuilt to avoid.
 */
export function applyFilters(runs: SyncRun[], filters: RunFilters): SyncRun[] {
  const needle = filters.search.trim().toLowerCase();
  return runs.filter((run) => {
    if (filters.types.length > 0 && !filters.types.includes(run.syncType)) return false;
    if (filters.outcomes.length > 0 && !filters.outcomes.includes(run.outcome)) return false;
    if (filters.platforms.length > 0 && !filters.platforms.includes(run.platform)) return false;
    if (needle.length > 0 && !run.userLabel.toLowerCase().includes(needle)) return false;
    return true;
  });
}

export interface RunCounts {
  finished: number;
  complete: number;
  cancelled: number;
  error: number;
  stalled: number;
}

/** Counted over whatever set it is handed — which must be the FILTERED one. */
export function computeCounts(runs: SyncRun[]): RunCounts {
  const counts: RunCounts = { finished: runs.length, complete: 0, cancelled: 0, error: 0, stalled: 0 };
  for (const run of runs) {
    if (run.outcome === 'complete') counts.complete += 1;
    else if (run.outcome === 'cancelled') counts.cancelled += 1;
    else if (run.outcome === 'error') counts.error += 1;
    if (run.stalled) counts.stalled += 1;
  }
  return counts;
}

// ─── Sorting ─────────────────────────────────────────────────────

export type SortKey =
  | 'when'
  | 'user'
  | 'platform'
  | 'version'
  | 'outcome'
  | 'duration'
  | 'backup'
  | 'rate'
  | 'messages'
  | 'type';

export type SortDirection = 'asc' | 'desc';

/**
 * Ordering for the Type column.
 *
 * `unknown` maps to NULL, not to 2. "Not recorded" is a MISSING value, not a
 * third kind of sync, so it sorts last in both directions exactly as a null
 * Rate does — otherwise descending puts the eleven rows that say nothing at
 * the top of a column you sorted to see what the types were.
 */
const TYPE_ORDER: Record<SyncType, number | null> = { first: 0, incremental: 1, unknown: null };

interface SortSpec {
  label: string;
  numeric: boolean;
  value: (run: SyncRun) => number | string | null;
}

export const SORT_SPECS: Record<SortKey, SortSpec> = {
  // `Date.parse`, NEVER a string compare. Postgres trims a whole-second
  // timestamp's fractional part, and "…:43Z" < "…:43.803Z" is FALSE — '.'
  // sorts before 'Z'. Every transcribed row carries a fraction, so the bug is
  // invisible in real data and in the fixture until a whole-second row exists.
  when: { label: 'When', numeric: true, value: (r) => Date.parse(r.createdAtIso) },
  user: { label: 'User', numeric: false, value: (r) => r.userLabel },
  platform: { label: 'Platform', numeric: false, value: (r) => r.platform },
  version: { label: 'Version', numeric: false, value: (r) => r.appVersion },
  outcome: { label: 'Outcome', numeric: false, value: (r) => r.outcome },
  duration: { label: 'Duration', numeric: true, value: (r) => r.elapsedMs },
  backup: { label: 'Backup', numeric: true, value: (r) => r.backupGb },
  rate: { label: 'Rate', numeric: true, value: (r) => r.rateMbPerSec },
  messages: { label: 'Messages', numeric: true, value: (r) => r.messagesExtracted },
  type: { label: 'Type', numeric: false, value: (r) => TYPE_ORDER[r.syncType] },
};

export const SORT_KEYS = Object.keys(SORT_SPECS) as SortKey[];

/** Numeric columns open descending (biggest first); text columns open A–Z. */
export function defaultDirectionFor(key: SortKey): SortDirection {
  return SORT_SPECS[key].numeric ? 'desc' : 'asc';
}

/**
 * Sort, with NULLS LAST IN BOTH DIRECTIONS.
 *
 * A missing value is not a small value. Rate is null on 20 of the 24 rows on
 * record and Type is unrecorded on 11 — under a naive `(a ?? 0) - (b ?? 0)`
 * the Rate column becomes twenty identical zeroes and no test can tell
 * ascending from descending.
 *
 * Ties fall back to newest-first so the order is total and a control can
 * assert an exact id sequence.
 */
export function sortRuns(runs: SyncRun[], key: SortKey, direction: SortDirection): SyncRun[] {
  const spec = SORT_SPECS[key];
  const sign = direction === 'asc' ? 1 : -1;

  return [...runs].sort((a, b) => {
    const av = spec.value(a);
    const bv = spec.value(b);

    const aNull = av == null || (typeof av === 'number' && Number.isNaN(av));
    const bNull = bv == null || (typeof bv === 'number' && Number.isNaN(bv));
    if (aNull && bNull) return Date.parse(b.createdAtIso) - Date.parse(a.createdAtIso);
    if (aNull) return 1;
    if (bNull) return -1;

    let cmp: number;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));

    if (cmp !== 0) return cmp * sign;
    return Date.parse(b.createdAtIso) - Date.parse(a.createdAtIso);
  });
}

// ─── Visible-row paging ──────────────────────────────────────────

export const INITIAL_VISIBLE_ROWS = 5;
export const SHOW_MORE_STEP = 5;

export function nextVisibleCount(current: number): number {
  return current + SHOW_MORE_STEP;
}
