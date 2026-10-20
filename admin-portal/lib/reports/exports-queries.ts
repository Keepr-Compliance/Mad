/**
 * Exports report — data access (BACKLOG-4004)
 *
 * The authenticated server client only. Cross-org read of `analytics_events`,
 * `users`, `organization_members` and `organizations` comes from each table's
 * internal-role SELECT policy. No service-role client anywhere in this report.
 *
 * The period query applies the event name and the period on the database,
 * newest first, so when the cap is reached it keeps the most recent rows. The
 * builder sorts them oldest first.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  EXPORT_EVENT_NAME,
  type ExportEventRow,
  type ExportLookups,
  type ExportMembership,
  type ExportOrg,
  type ExportUser,
} from './exports';
import type { PeriodRange } from './period';

/** Row cap for the period query. Reaching it shows the "truncated" notice. */
export const EXPORT_LIMIT = 500;

export interface ExportQueryResult {
  rows: ExportEventRow[];
  /** The query itself failed — not the same as "no rows". */
  failed: boolean;
  /** The cap was reached, so there are more rows than are shown. */
  truncated: boolean;
}

export async function getExportEvents(
  supabase: SupabaseClient,
  range: PeriodRange,
  limit = EXPORT_LIMIT
): Promise<ExportQueryResult> {
  const { data, error } = await supabase
    .from('analytics_events')
    .select('id, user_id, event_name, event_data, created_at')
    .eq('event_name', EXPORT_EVENT_NAME)
    .gte('created_at', range.fromIso)
    .lt('created_at', range.toIso)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) {
    console.error('getExportEvents error:', error?.message);
    return { rows: [], failed: true, truncated: false };
  }
  const rows = data as unknown as ExportEventRow[];
  return { rows, failed: false, truncated: rows.length >= limit };
}

/**
 * Names, memberships and organization names for the users in `rows`.
 * Memberships match on `user_id`, so an invite row (no user yet) never
 * matches; license status is NOT filtered, so a lapsed member keeps their
 * organization. Any failed lookup sets `failed`.
 */
export async function getExportLookups(
  supabase: SupabaseClient,
  rows: ExportEventRow[]
): Promise<ExportLookups> {
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((v): v is string => !!v))];
  let users: ExportUser[] = [];
  let memberships: ExportMembership[] = [];
  let orgs: ExportOrg[] = [];
  let failed = false;
  if (userIds.length === 0) return { users, memberships, orgs, failed };

  const [usersResult, membersResult] = await Promise.all([
    supabase.from('users').select('id, email, display_name').in('id', userIds),
    supabase.from('organization_members').select('user_id, organization_id').in('user_id', userIds),
  ]);
  if (usersResult.error) {
    console.error('getExportLookups users error:', usersResult.error.message);
    failed = true;
  } else {
    users = (usersResult.data ?? []) as ExportUser[];
  }
  if (membersResult.error) {
    console.error('getExportLookups organization_members error:', membersResult.error.message);
    failed = true;
  } else {
    memberships = (membersResult.data ?? []) as ExportMembership[];
  }

  const orgIds = [...new Set(memberships.map((m) => m.organization_id).filter((v): v is string => !!v))];
  if (orgIds.length > 0) {
    const { data, error } = await supabase.from('organizations').select('id, name').in('id', orgIds);
    if (error) {
      console.error('getExportLookups organizations error:', error.message);
      failed = true;
    } else {
      orgs = (data ?? []) as ExportOrg[];
    }
  }
  return { users, memberships, orgs, failed };
}
