/**
 * Report kit — URL param helpers (BACKLOG-3502a). Pure functions, no React,
 * no Next: a report keeps its filter state in the query string so a reload,
 * a remount and a shared link all show the same thing.
 *
 * Generalised from admin-portal/lib/reports/report-url.ts (which stays).
 */
import type { SortDirection, SortState } from './use-sort-state';

/** Next.js `searchParams` shape. */
export type ParamRecord = Record<string, string | string[] | undefined>;

/** The first value of a param ('' when absent). */
export function readFirst(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** A comma-separated param: trimmed, de-duplicated, and limited to `allowed` when given. */
export function readList(value: string | string[] | undefined, allowed?: readonly string[]): string[] {
  const raw = readFirst(value)
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const unique = [...new Set(raw)];
  return allowed ? unique.filter((v) => allowed.includes(v)) : unique;
}

export interface SortParamOptions<K extends string> {
  keys: readonly K[];
  defaultKey: K;
  defaultDirectionFor: (key: K) => SortDirection;
  /** Param names. Default `sort` / `dir`. */
  sortParam?: string;
  dirParam?: string;
}

/** Read `sort` / `dir`; an unknown key falls back to the default, a missing dir to the key's default. */
export function readSort<K extends string>(params: ParamRecord, options: SortParamOptions<K>): SortState<K> {
  const raw = readFirst(params[options.sortParam ?? 'sort']);
  const key = (options.keys as readonly string[]).includes(raw) ? (raw as K) : options.defaultKey;
  const dir = readFirst(params[options.dirParam ?? 'dir']);
  const direction: SortDirection = dir === 'asc' || dir === 'desc' ? dir : options.defaultDirectionFor(key);
  return { key, direction };
}

/** Set a param, or delete it when the value is empty. Mutates and returns `params`. */
export function writeParam(params: URLSearchParams, name: string, value: string | null | undefined): URLSearchParams {
  if (value !== null && value !== undefined && value.length > 0) params.set(name, value);
  else params.delete(name);
  return params;
}

/** Write the sort, dropping the key and direction when they are the defaults. */
export function writeSort<K extends string>(
  params: URLSearchParams,
  sort: SortState<K>,
  options: SortParamOptions<K>
): URLSearchParams {
  writeParam(params, options.sortParam ?? 'sort', sort.key === options.defaultKey ? '' : sort.key);
  writeParam(
    params,
    options.dirParam ?? 'dir',
    sort.direction === options.defaultDirectionFor(sort.key) ? '' : sort.direction
  );
  return params;
}

/**
 * A query string with `updates` applied on top of `current`.
 *
 * It COPIES the current params. Building from a fresh `URLSearchParams()` is
 * the wrong implementation that looks right: the updated param works and
 * every other filter silently resets.
 */
export function buildParamUrl(
  current: URLSearchParams | string,
  updates: Record<string, string | null | undefined>
): string {
  const params = new URLSearchParams(typeof current === 'string' ? current : current.toString());
  for (const [name, value] of Object.entries(updates)) writeParam(params, name, value);
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '?';
}
