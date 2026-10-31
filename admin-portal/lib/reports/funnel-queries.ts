/**
 * Paywall Funnel — data access (BACKLOG-2014, paged in BACKLOG-3722)
 *
 * The authenticated server client only; cross-user rows come from the
 * internal-role SELECT policy on `analytics_events`. All maths stays in the
 * pure `computeFunnel` (lib/funnel-analytics.ts).
 *
 * The read is PAGED, never capped: a single read stops at 1000 rows with no
 * signal. Ascending `created_at` with `id` as the tiebreak is a total order,
 * so pages neither shift nor overlap; `id` is selected so the pager can drop
 * a row it has already seen.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { FUNNEL_STEP_EVENTS, type FunnelEventRow } from '@/lib/funnel-analytics';
import { fetchAllPages, MAX_PAGES, PAGE_SIZE, type PageResponse, type PagedResult } from './fetch-all-pages';

export const FUNNEL_EVENT_COLUMNS = 'id, event_name, user_id';

export type FunnelEventRecord = FunnelEventRow & { id: string };

export interface FunnelRange {
  /** Inclusive lower bound, or null for no lower bound. */
  fromIso: string | null;
  /** Exclusive upper bound. */
  toIso: string;
}

export function getFunnelEvents(
  supabase: SupabaseClient,
  range: FunnelRange,
  pageSize = PAGE_SIZE,
  maxPages = MAX_PAGES
): Promise<PagedResult<FunnelEventRecord>> {
  return fetchAllPages<FunnelEventRecord>(
    (from, to) => {
      let query = supabase
        .from('analytics_events')
        .select(FUNNEL_EVENT_COLUMNS)
        .in('event_name', [...FUNNEL_STEP_EVENTS]);
      if (range.fromIso) query = query.gte('created_at', range.fromIso);
      return query
        .lt('created_at', range.toIso)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResponse>;
    },
    'funnel analytics_events',
    pageSize,
    maxPages
  );
}
