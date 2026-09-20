/**
 * Report URL state (BACKLOG-3450)
 *
 * The URL is the ONE source of truth for what the page is showing. That is not
 * tidiness: changing the period calls `router.push`, which re-runs the server
 * component, and whether the client component's type / outcome / platform /
 * search state survives that soft navigation is not something to hope for. It
 * is read back out of the URL, so it survives a remount, a reload and a shared
 * link identically.
 *
 * The period goes through `router.push` because the server has to re-query.
 * The client filters are mirrored with `history.replaceState` instead — with
 * `force-dynamic` a push would be a database round trip per checkbox.
 */

import { EMPTY_FILTERS, type RunFilters } from './iphone-sync-filters';
import type { SyncType } from './iphone-sync';
import { defaultDirectionFor, SORT_KEYS, type SortDirection, type SortKey } from './iphone-sync-filters';

export type ParamRecord = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** A comma-separated param, emptied of anything not in `allowed`. */
function list(value: string | string[] | undefined, allowed?: readonly string[]): string[] {
  const raw = first(value)
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const unique = [...new Set(raw)];
  return allowed ? unique.filter((v) => allowed.includes(v)) : unique;
}

const SYNC_TYPES: readonly SyncType[] = ['first', 'incremental', 'unknown'];

/**
 * Read the client filters back out of the URL.
 *
 * Defensive by construction: an unknown type, a repeated param, a 400-character
 * search — none of them throws, and none of them reaches the predicate as
 * something it did not expect.
 */
export function parseRunFilters(params: ParamRecord): RunFilters {
  return {
    types: list(params.type, SYNC_TYPES) as SyncType[],
    outcomes: list(params.outcome),
    platforms: list(params.platform),
    search: first(params.q).slice(0, 120),
  };
}

export function parseSort(params: ParamRecord): { key: SortKey; direction: SortDirection } {
  const raw = first(params.sort);
  const key = (SORT_KEYS as string[]).includes(raw) ? (raw as SortKey) : 'when';
  const dir = first(params.dir);
  const direction: SortDirection = dir === 'asc' || dir === 'desc' ? dir : defaultDirectionFor(key);
  return { key, direction };
}

export function parseStalledOnly(params: ParamRecord): boolean {
  return first(params.stalled) === '1';
}

export interface ClientState {
  filters: RunFilters;
  sortKey: SortKey;
  sortDirection: SortDirection;
  stalledOnly: boolean;
}

export function parseClientState(params: ParamRecord): ClientState {
  const { key, direction } = parseSort(params);
  return {
    filters: parseRunFilters(params),
    sortKey: key,
    sortDirection: direction,
    stalledOnly: parseStalledOnly(params),
  };
}

/** Write the client state back, dropping anything at its default. */
export function applyClientState(target: URLSearchParams, state: ClientState): URLSearchParams {
  const params = new URLSearchParams(target.toString());
  const set = (name: string, value: string) => {
    if (value.length > 0) params.set(name, value);
    else params.delete(name);
  };
  set('type', state.filters.types.join(','));
  set('outcome', state.filters.outcomes.join(','));
  set('platform', state.filters.platforms.join(','));
  set('q', state.filters.search.trim());
  set('sort', state.sortKey === 'when' ? '' : state.sortKey);
  set('dir', state.sortDirection === defaultDirectionFor(state.sortKey) ? '' : state.sortDirection);
  set('stalled', state.stalledOnly ? '1' : '');
  return params;
}

/**
 * The URL a period change navigates to.
 *
 * It COPIES the current params. Building a fresh `URLSearchParams()` here is
 * the wrong implementation that looks right: the period would work perfectly
 * and every other filter would silently reset on each change.
 */
export function buildPeriodUrl(
  current: URLSearchParams | string,
  period: string,
  from?: string,
  to?: string
): string {
  const params = new URLSearchParams(typeof current === 'string' ? current : current.toString());

  if (period === 'week') params.delete('period');
  else params.set('period', period);

  if (period === 'custom') {
    if (from) params.set('from', from);
    if (to) params.set('to', to);
  } else {
    params.delete('from');
    params.delete('to');
  }

  const query = params.toString();
  return query.length > 0 ? `?${query}` : '?';
}

export const DEFAULT_CLIENT_STATE: ClientState = {
  filters: EMPTY_FILTERS,
  sortKey: 'when',
  sortDirection: 'desc',
  stalledOnly: false,
};
