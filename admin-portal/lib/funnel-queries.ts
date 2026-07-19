/**
 * Paywall Funnel — Supabase fetch wrapper (BACKLOG-2014)
 *
 * Thin I/O layer around the pure `computeFunnel` aggregation. Pulls the raw
 * funnel events from `analytics_events` (internal-role SELECT policy added by
 * the BACKLOG-2014 migration) over a date range and delegates ALL math to
 * `computeFunnel`, so the aggregation stays unit-testable without Supabase.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  computeFunnel,
  FUNNEL_STEP_EVENTS,
  type FunnelEventRow,
  type FunnelResult,
} from './funnel-analytics';

export interface FunnelDateRange {
  /** Inclusive lower bound (ISO string) or null for no lower bound. */
  from: string | null;
  /** Exclusive upper bound (ISO string) or null for no upper bound. */
  to: string | null;
}

/**
 * Fetch funnel events in range and aggregate them.
 *
 * Selects only the two columns the funnel needs (`event_name`, `user_id`) and
 * filters to the four funnel event names server-side so we never pull unrelated
 * analytics rows into memory. Returns a zeroed funnel on error rather than
 * throwing — the dashboard degrades gracefully like the existing analytics page.
 */
export async function getPaywallFunnel(
  supabase: SupabaseClient,
  range: FunnelDateRange
): Promise<FunnelResult> {
  let query = supabase
    .from('analytics_events')
    .select('event_name, user_id')
    .in('event_name', [...FUNNEL_STEP_EVENTS]);

  if (range.from) query = query.gte('created_at', range.from);
  if (range.to) query = query.lt('created_at', range.to);

  const { data, error } = await query;

  if (error || !data) {
    console.error('getPaywallFunnel error:', error?.message);
    return computeFunnel([]);
  }

  return computeFunnel(data as FunnelEventRow[]);
}
