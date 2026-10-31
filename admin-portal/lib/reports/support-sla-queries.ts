/**
 * Support analytics — data access (BACKLOG-3651)
 *
 * Reads `support_tickets` and `users` through the caller's client; the
 * internal-role SELECT policies on both tables allow the cross-org read.
 *
 * - The OPEN-NOW headline is an exact head count, so it is right however many
 *   rows the row query returns.
 * - The ROW query excludes deleted tickets and keeps a ticket that is open, or
 *   was created, resolved or closed in the period. It is a superset prefilter;
 *   the builder applies coalesce(resolved_at, closed_at) and the status rule.
 * - PostgREST returns at most 1000 rows per request (supabase/config.toml
 *   max_rows), so the cap must not exceed that or truncation goes unreported.
 * - BACKLOG-4086: the SLA targets and business window are one row of
 *   `public.support_sla_settings`. Any failure (error, no row, a value outside
 *   the table's CHECKs, an unknown time zone) returns null, and the report
 *   shows "-" for every duration rather than falling back to code defaults.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidTimeZone } from './business-hours';
import {
  DELETED_STATUS,
  OPEN_EXCLUDES,
  type SlaPeriod,
  type SupportAgentUser,
  type SupportSlaSettings,
  type SupportTicketRow,
} from './support-sla';

const TICKET_COLUMNS = 'id, status, assignee_id, created_at, first_response_at, resolved_at, closed_at';

/** PostgREST max_rows. A larger cap would be silently clipped to this. */
export const POSTGREST_MAX_ROWS = 1000;

/** Row cap for the ticket query. Reaching it shows the "truncated" notice. */
export const SUPPORT_TICKET_LIMIT = 1000;

const OPEN_FILTER = `(${OPEN_EXCLUDES.join(',')})`;

export interface TicketQueryResult {
  rows: SupportTicketRow[];
  /** The query itself failed — not the same as "no rows". */
  failed: boolean;
  /** The cap was reached, so there are more rows than were read. */
  truncated: boolean;
}

export function periodOrFilter(period: SlaPeriod): string {
  const f = period.fromIso;
  const t = period.toIso;
  return [
    `status.not.in.${OPEN_FILTER}`,
    `and(created_at.gte.${f},created_at.lt.${t})`,
    `and(resolved_at.gte.${f},resolved_at.lt.${t})`,
    `and(closed_at.gte.${f},closed_at.lt.${t})`,
  ].join(',');
}

export async function getSupportTickets(
  supabase: SupabaseClient,
  period: SlaPeriod,
  limit = SUPPORT_TICKET_LIMIT
): Promise<TicketQueryResult> {
  const { data, error } = await supabase
    .from('support_tickets')
    .select(TICKET_COLUMNS)
    .neq('status', DELETED_STATUS)
    .or(periodOrFilter(period))
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) {
    console.error('getSupportTickets error:', error?.message);
    return { rows: [], failed: true, truncated: false };
  }
  const rows = data as unknown as SupportTicketRow[];
  return { rows, failed: false, truncated: rows.length >= limit };
}

/** Exact number of open tickets, or null when the count could not be read. */
export async function getOpenTicketCount(supabase: SupabaseClient): Promise<number | null> {
  const { count, error } = await supabase
    .from('support_tickets')
    .select('id', { count: 'exact', head: true })
    .not('status', 'in', OPEN_FILTER);
  if (error || count === null || count === undefined) {
    console.error('getOpenTicketCount error:', error?.message);
    return null;
  }
  return count;
}

/** Agent names. A failed lookup leaves the rows readable as "Unknown agent". */
export async function getAgentUsers(
  supabase: SupabaseClient,
  rows: SupportTicketRow[]
): Promise<SupportAgentUser[]> {
  const ids = [...new Set(rows.map((r) => r.assignee_id).filter((v): v is string => !!v))];
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('users')
    .select('id, email, display_name, first_name, last_name')
    .in('id', ids);
  if (error) {
    console.error('getAgentUsers error:', error.message);
    return [];
  }
  return (data ?? []) as SupportAgentUser[];
}

export const SLA_SETTINGS_COLUMNS =
  'first_response_target_minutes, resolution_target_business_days, business_day_start_minute, business_day_end_minute, business_days, time_zone';

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Validates one `support_sla_settings` row with the same rules as the table's
 * CHECK constraints. Anything else -> null.
 */
export function parseSupportSlaSettings(row: unknown): SupportSlaSettings | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const fr = r.first_response_target_minutes;
  const days = r.resolution_target_business_days;
  const start = r.business_day_start_minute;
  const end = r.business_day_end_minute;
  const weekdays = r.business_days;
  const tz = r.time_zone;
  if (!isInt(fr) || fr <= 0) return null;
  if (!isInt(days) || days <= 0) return null;
  if (!isInt(start) || start < 0 || start > 1439) return null;
  if (!isInt(end) || end < 1 || end > 1440 || end <= start) return null;
  if (!Array.isArray(weekdays) || weekdays.length < 1 || weekdays.length > 7) return null;
  if (!weekdays.every((d) => isInt(d) && d >= 0 && d <= 6)) return null;
  if (!isValidTimeZone(tz)) return null;
  return {
    firstResponseTargetMinutes: fr,
    resolutionTargetBusinessDays: days,
    businessDayStartMinute: start,
    businessDayEndMinute: end,
    businessDays: [...new Set(weekdays as number[])].sort((a, b) => a - b),
    timeZone: tz,
  };
}

/** The SLA settings row, or null when it could not be read or is invalid. */
export async function getSupportSlaSettings(supabase: SupabaseClient): Promise<SupportSlaSettings | null> {
  const { data, error } = await supabase
    .from('support_sla_settings')
    .select(SLA_SETTINGS_COLUMNS)
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    console.error('getSupportSlaSettings error:', error?.message ?? 'no row');
    return null;
  }
  const settings = parseSupportSlaSettings(data);
  if (!settings) console.error('getSupportSlaSettings error: invalid settings row');
  return settings;
}
