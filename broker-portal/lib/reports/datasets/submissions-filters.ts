/**
 * Submissions report: URL filters, sort and saved-view mapping — BACKLOG-3513 PR-3a.
 *
 * PURE. No Supabase, no React. The server page and the client controls share it.
 *
 * The values here are exactly the ones public.broker_report_submissions_rows_multi
 * accepts (migration 20261114100000): a list of status filter values with the
 * Submissions page's meanings, a list of agents, five sorts. Anything else in
 * the URL is ignored.
 *
 * BACKLOG-3513 PR-3h: Status and Agent are multi-select. The URL carries each as
 * a comma list (`?status=approved,rejected&agent=<uuid>,<uuid>`); an old
 * single-value URL or stored definition reads as a one-item list.
 */

import { parseAgentParam } from '@/lib/submissions/listUrl';
import { SUBMISSIONS_SORT_KEYS } from '@/lib/reports/registry';
import type { FilterValue, ViewState } from '@/lib/reports/datasets/view-state';

export const SUBMISSIONS_REPORT_PATH = '/dashboard/reports/submissions';

export const SUBMISSIONS_REPORT_PAGE_SIZE = 25;

/** Shown when the brokerage's service is off (broker_report_scope.service_off). */
export const SERVICE_OFF_LINE = "While the brokerage's service is off, reports show only submissions you sent yourself.";

/** Status filter values, labelled as on the Submissions page. None selected = every status. */
export const SUBMISSIONS_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'submitted', label: 'Pending' },
  { value: 'pending', label: 'Pending Review' },
  { value: 'new', label: 'New' },
  { value: 'resubmitted', label: 'Resubmitted' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'needs_changes', label: 'Needs Changes' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

export type SubmissionsSort = (typeof SUBMISSIONS_SORT_KEYS)[number];

export const SUBMISSIONS_SORT_OPTIONS: ReadonlyArray<{ value: SubmissionsSort; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'status', label: 'Status' },
  { value: 'price_desc', label: 'Price high to low' },
  { value: 'price_asc', label: 'Price low to high' },
];

const SORT_DIRECTION: Record<SubmissionsSort, 'asc' | 'desc'> = {
  newest: 'desc',
  oldest: 'asc',
  status: 'asc',
  price_desc: 'desc',
  price_asc: 'asc',
};

/** At most this many agents are kept from a URL or a stored definition. */
export const MAX_AGENT_FILTERS = 50;

export interface SubmissionsReportFilters {
  /** Status filter values in SUBMISSIONS_STATUS_OPTIONS order. Empty = every status. */
  statuses: string[];
  /** Agent ids, lower case, sorted. Empty = every agent. */
  agents: string[];
  /** YYYY-MM-DD, inclusive. */
  from: string | null;
  /** YYYY-MM-DD, inclusive. */
  to: string | null;
  sort: SubmissionsSort;
  page: number;
}

export const DEFAULT_SUBMISSIONS_FILTERS: SubmissionsReportFilters = {
  statuses: [],
  agents: [],
  from: null,
  to: null,
  sort: 'newest',
  page: 1,
};

export type SubmissionsSearchParams = Partial<Record<'status' | 'agent' | 'from' | 'to' | 'sort' | 'page', string | string[]>>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

/** A real calendar date as YYYY-MM-DD, or null. */
export function parseDateParam(value: string | undefined | null): string | null {
  if (!value || !DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

/** The comma-separated items of a URL value (a repeated param is read the same way). */
function items(value: string | string[] | undefined | null): string[] {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw.flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v !== '');
}

/**
 * Status filter values from a URL value or a stored definition. Unknown items are dropped;
 * 'all' anywhere, or every status picked, is no filter ([]). Deduped, in option order.
 */
export function parseStatusesParam(value: string | string[] | undefined | null): string[] {
  const picked = items(value);
  if (picked.includes('all')) return [];
  const kept = SUBMISSIONS_STATUS_OPTIONS.map((o) => o.value).filter((v) => picked.includes(v));
  return kept.length === SUBMISSIONS_STATUS_OPTIONS.length ? [] : kept;
}

/** Agent ids from a URL value or a stored definition: uuids only, lower case, deduped, sorted, at most MAX_AGENT_FILTERS. */
export function parseAgentsParam(value: string | string[] | undefined | null): string[] {
  const ids = new Set<string>();
  for (const item of items(value)) {
    const id = parseAgentParam(item);
    if (id) ids.add(id);
  }
  return Array.from(ids).sort().slice(0, MAX_AGENT_FILTERS);
}

export function parseSubmissionsSort(value: string | undefined | null): SubmissionsSort {
  return (SUBMISSIONS_SORT_KEYS as readonly string[]).includes(value ?? '') ? (value as SubmissionsSort) : 'newest';
}

/** The report's filters from the URL. Unknown or malformed values fall back to the defaults. */
export function parseSubmissionsReportParams(params: SubmissionsSearchParams): SubmissionsReportFilters {
  return {
    statuses: parseStatusesParam(params.status),
    agents: parseAgentsParam(params.agent),
    from: parseDateParam(one(params.from)),
    to: parseDateParam(one(params.to)),
    sort: parseSubmissionsSort(one(params.sort)),
    page: Math.max(1, Math.floor(Number(one(params.page))) || 1),
  };
}

/**
 * The report URL for these filters. Defaults are left out, except on a shared
 * report (BACKLOG-3513 PR-3b): there `explicit` keeps `status` in the URL
 * (`status=all` when no status is picked) so the page can tell "the person
 * changed the filters" from "use the saved ones".
 */
export function buildSubmissionsReportUrl(
  filters: SubmissionsReportFilters,
  path: string = SUBMISSIONS_REPORT_PATH,
  explicit = false
): string {
  const q = new URLSearchParams();
  const statuses = parseStatusesParam(filters.statuses);
  const agents = parseAgentsParam(filters.agents);
  if (statuses.length > 0) q.set('status', statuses.join(','));
  else if (explicit) q.set('status', 'all');
  if (agents.length > 0) q.set('agent', agents.join(','));
  if (filters.from) q.set('from', filters.from);
  if (filters.to) q.set('to', filters.to);
  if (filters.sort !== 'newest') q.set('sort', filters.sort);
  if (filters.page > 1) q.set('page', String(filters.page));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * The row function's date bounds. `from` is the start of that UTC day; `to` is
 * inclusive, so the bound is the start of the NEXT UTC day (the function's upper
 * bound is exclusive).
 */
export function dateBounds(filters: Pick<SubmissionsReportFilters, 'from' | 'to'>): { from: string | null; to: string | null } {
  const from = filters.from ? `${filters.from}T00:00:00Z` : null;
  let to: string | null = null;
  if (filters.to) {
    const d = new Date(`${filters.to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    to = d.toISOString();
  }
  return { from, to };
}

/** None: left out. One: the plain value, exactly as a single-select definition stored it. More: the list. */
function listValue(list: string[]): FilterValue | undefined {
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : [...list];
}

/** The page state a saved view stores. */
export function filtersToViewState(filters: SubmissionsReportFilters): ViewState {
  const f: Record<string, FilterValue> = {};
  const status = listValue(filters.statuses);
  const agent = listValue(filters.agents);
  if (status !== undefined) f.status = status;
  if (agent !== undefined) f.agent = agent;
  if (filters.from) f.from = filters.from;
  if (filters.to) f.to = filters.to;
  const sort = filters.sort === 'newest' ? null : { key: filters.sort, direction: SORT_DIRECTION[filters.sort] };
  return { filters: f, sort };
}

/** A saved view's state back to report filters, through the same parsers as the URL. */
export function viewStateToFilters(view: ViewState): SubmissionsReportFilters {
  const str = (v: FilterValue | undefined) => (typeof v === 'string' ? v : undefined);
  // A single-select definition stored a string; a multi-select one stores a string, or a list for 2+.
  const list = (v: FilterValue | undefined) =>
    typeof v === 'string' ? v : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  return {
    statuses: parseStatusesParam(list(view.filters.status)),
    agents: parseAgentsParam(list(view.filters.agent)),
    from: parseDateParam(str(view.filters.from)),
    to: parseDateParam(str(view.filters.to)),
    sort: parseSubmissionsSort(view.sort?.key),
    page: 1,
  };
}

// ---------------------------------------------------------------------------
// Shared reports (BACKLOG-3513 PR-3b): a definition stores filtersToViewState().
// ---------------------------------------------------------------------------

/** The page of one shared report. */
export function definitionReportPath(id: string): string {
  return `/dashboard/reports/d/${encodeURIComponent(id)}`;
}

/** A stored definition back to filters. Anything malformed falls back to the defaults. */
export function definitionToFilters(definition: unknown): SubmissionsReportFilters {
  const obj = definition !== null && typeof definition === 'object' && !Array.isArray(definition) ? (definition as Record<string, unknown>) : {};
  const rawFilters = obj.filters;
  const filters =
    rawFilters !== null && typeof rawFilters === 'object' && !Array.isArray(rawFilters) ? (rawFilters as Record<string, FilterValue>) : {};
  const rawSort = obj.sort;
  const sort =
    rawSort !== null && typeof rawSort === 'object' && typeof (rawSort as { key?: unknown }).key === 'string'
      ? { key: (rawSort as { key: string }).key, direction: 'asc' as const }
      : null;
  return viewStateToFilters({ filters, sort });
}

/**
 * The filters a shared report opens with: the URL's when the person changed
 * them on this page (the URL carries `status`), else the saved ones.
 */
export function resolveDefinitionFilters(params: SubmissionsSearchParams, definition: unknown): SubmissionsReportFilters {
  if (typeof params.status === 'string' || Array.isArray(params.status)) return parseSubmissionsReportParams(params);
  const page = parseSubmissionsReportParams(params).page;
  return { ...definitionToFilters(definition), page };
}
