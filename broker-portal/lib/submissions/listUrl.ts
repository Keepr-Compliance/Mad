/**
 * Broker Submissions list URLs — BACKLOG-3904.
 *
 * One builder for every link the list makes (status tabs, pagination base,
 * filter sheet, desktop controls), on URLSearchParams so a search holding
 * `&`, `#` or `+` round-trips. Defaults are left out: status `all`, no agent,
 * empty search, page 1.
 */

import { MAX_SEARCH_LENGTH } from './dealList';

export const SUBMISSIONS_PATH = '/dashboard/submissions';

export interface ListFilters {
  status: string;
  agent: string | null;
  search: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid, or null. Anything else would be an invalid filter, so it is ignored. */
export function parseAgentParam(value: string | undefined | null): string | null {
  if (!value) return null;
  const v = value.trim();
  return UUID.test(v) ? v.toLowerCase() : null;
}

/** Trimmed and capped at MAX_SEARCH_LENGTH. */
export function parseSearchParam(value: string | undefined | null): string {
  return (value ?? '').trim().slice(0, MAX_SEARCH_LENGTH);
}

export function buildListUrl(filters: ListFilters, page = 1): string {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.agent) params.set('agent', filters.agent);
  if (filters.search) params.set('search', filters.search);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `${SUBMISSIONS_PATH}?${query}` : SUBMISSIONS_PATH;
}

export function hasActiveFilters(filters: ListFilters): boolean {
  return filters.status !== 'all' || filters.agent !== null || filters.search !== '';
}
