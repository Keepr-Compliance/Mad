/**
 * Submissions report: URL filters, sort and saved-view mapping — BACKLOG-3513 PR-3a.
 *
 * PURE. No Supabase, no React. The server page and the client controls share it.
 *
 * The values here are exactly the ones public.broker_report_submissions_rows
 * accepts (migration 20261112200000): one status filter value with the
 * Submissions page's meanings, five sorts. Anything else in the URL is ignored.
 */

import { parseAgentParam } from '@/lib/submissions/listUrl';
import { SUBMISSIONS_SORT_KEYS } from '@/lib/reports/registry';
import type { FilterValue, ViewState } from '@/lib/reports/saved-views/degrade';

export const SUBMISSIONS_REPORT_PATH = '/dashboard/reports/submissions';

export const SUBMISSIONS_REPORT_PAGE_SIZE = 25;

/** Shown when the brokerage's service is off (broker_report_scope.service_off). */
export const SERVICE_OFF_LINE = "While the brokerage's service is off, reports show only submissions you sent yourself.";

/** Status filter values, labelled as on the Submissions page. */
export const SUBMISSIONS_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
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

export interface SubmissionsReportFilters {
  status: string;
  agent: string | null;
  /** YYYY-MM-DD, inclusive. */
  from: string | null;
  /** YYYY-MM-DD, inclusive. */
  to: string | null;
  sort: SubmissionsSort;
  page: number;
}

export const DEFAULT_SUBMISSIONS_FILTERS: SubmissionsReportFilters = {
  status: 'all',
  agent: null,
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

export function parseStatusParam(value: string | undefined | null): string {
  return SUBMISSIONS_STATUS_OPTIONS.some((o) => o.value === value) ? (value as string) : 'all';
}

export function parseSubmissionsSort(value: string | undefined | null): SubmissionsSort {
  return (SUBMISSIONS_SORT_KEYS as readonly string[]).includes(value ?? '') ? (value as SubmissionsSort) : 'newest';
}

/** The report's filters from the URL. Unknown or malformed values fall back to the defaults. */
export function parseSubmissionsReportParams(params: SubmissionsSearchParams): SubmissionsReportFilters {
  return {
    status: parseStatusParam(one(params.status)),
    agent: parseAgentParam(one(params.agent)),
    from: parseDateParam(one(params.from)),
    to: parseDateParam(one(params.to)),
    sort: parseSubmissionsSort(one(params.sort)),
    page: Math.max(1, Math.floor(Number(one(params.page))) || 1),
  };
}

/** The report URL for these filters. Defaults are left out. */
export function buildSubmissionsReportUrl(filters: SubmissionsReportFilters): string {
  const q = new URLSearchParams();
  if (filters.status !== 'all') q.set('status', filters.status);
  if (filters.agent) q.set('agent', filters.agent);
  if (filters.from) q.set('from', filters.from);
  if (filters.to) q.set('to', filters.to);
  if (filters.sort !== 'newest') q.set('sort', filters.sort);
  if (filters.page > 1) q.set('page', String(filters.page));
  const s = q.toString();
  return s ? `${SUBMISSIONS_REPORT_PATH}?${s}` : SUBMISSIONS_REPORT_PATH;
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

/** The page state a saved view stores. */
export function filtersToViewState(filters: SubmissionsReportFilters): ViewState {
  const f: Record<string, FilterValue> = {};
  if (filters.status !== 'all') f.status = filters.status;
  if (filters.agent) f.agent = filters.agent;
  if (filters.from) f.from = filters.from;
  if (filters.to) f.to = filters.to;
  const sort = filters.sort === 'newest' ? null : { key: filters.sort, direction: SORT_DIRECTION[filters.sort] };
  return { filters: f, sort };
}

/** A saved view's state back to report filters, through the same parsers as the URL. */
export function viewStateToFilters(view: ViewState): SubmissionsReportFilters {
  const str = (v: FilterValue | undefined) => (typeof v === 'string' ? v : undefined);
  return {
    status: parseStatusParam(str(view.filters.status)),
    agent: parseAgentParam(str(view.filters.agent)),
    from: parseDateParam(str(view.filters.from)),
    to: parseDateParam(str(view.filters.to)),
    sort: parseSubmissionsSort(view.sort?.key),
    page: 1,
  };
}
