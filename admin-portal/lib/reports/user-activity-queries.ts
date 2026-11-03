/**
 * User Activity report — data access (BACKLOG-3720)
 *
 * The authenticated server client only. Cross-user reads come from each
 * table's internal-role SELECT policy. No service-role client in this report.
 *
 * EVERY READ IS PAGED, never capped. The API returns at most 1000 rows per
 * request, so a single read would silently drop rows past that.
 * `fetchAllPages` (./fetch-all-pages) reads `.range(from, to)` pages until a short page, in a
 * stable ASCENDING order with `id` as the tiebreak, and drops any id it has
 * already seen. Ascending matters: `audit_logs.created_at` is the arrival
 * time, so a row that arrives mid-read lands past the cursor instead of
 * shifting every later page by one.
 *
 * No `.in(user_id, …)` lookups: the whole user list in a GET URL outgrows URL
 * limits. Memberships and organizations are read whole, paged.
 *
 * `audit_logs.metadata` is never selected.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActivityDeviceRow,
  ActivityEventRow,
  ActivityMembershipRow,
  ActivityOrgRow,
  ActivityUserRow,
} from './user-activity';
import type { PeriodRange } from './period';
import { fetchAllPages, MAX_PAGES, PAGE_SIZE, type PageResponse, type PagedResult } from './fetch-all-pages';

export { fetchAllPages, MAX_PAGES, PAGE_SIZE };
export type { PagedResult };

export const EVENT_COLUMNS = 'id, user_id, action, resource_type, resource_id, created_at';
export const USER_COLUMNS = 'id, email, display_name, first_name, last_name, last_login_at';
export const DEVICE_COLUMNS = 'id, user_id, platform, app_version, is_active, last_seen_at';

export function getActivityEvents(
  supabase: SupabaseClient,
  range: PeriodRange,
  pageSize = PAGE_SIZE,
  maxPages = MAX_PAGES
): Promise<PagedResult<ActivityEventRow>> {
  return fetchAllPages<ActivityEventRow>(
    (from, to) =>
      supabase
        .from('audit_logs')
        .select(EVENT_COLUMNS)
        .gte('created_at', range.fromIso)
        .lt('created_at', range.toIso)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResponse>,
    'user-activity audit_logs',
    pageSize,
    maxPages
  );
}

function readWhole<T extends { id: string }>(
  supabase: SupabaseClient,
  table: string,
  columns: string
): Promise<PagedResult<T>> {
  return fetchAllPages<T>(
    (from, to) =>
      supabase
        .from(table)
        .select(columns)
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResponse>,
    `user-activity ${table}`
  );
}

export const getActivityUsers = (supabase: SupabaseClient) =>
  readWhole<ActivityUserRow>(supabase, 'users', USER_COLUMNS);

export const getActivityDevices = (supabase: SupabaseClient) =>
  readWhole<ActivityDeviceRow>(supabase, 'devices', DEVICE_COLUMNS);

export const getActivityMemberships = (supabase: SupabaseClient) =>
  readWhole<ActivityMembershipRow>(supabase, 'organization_members', 'id, user_id, organization_id');

export const getActivityOrgs = (supabase: SupabaseClient) =>
  readWhole<ActivityOrgRow>(supabase, 'organizations', 'id, name');

export interface StaffLookup {
  staffIds: Set<string>;
  /**
   * False when the viewer cannot see every internal_roles row (only super
   * admins can) or the read failed. The page then says staff may be listed.
   */
  complete: boolean;
}

/**
 * Internal staff to leave out of the report. `internal_roles` shows a
 * non-super-admin ONLY their own row, with no error — so a partial list is
 * never treated as the whole list.
 */
export async function getStaffIds(supabase: SupabaseClient, viewerId: string): Promise<StaffLookup> {
  const { data: isSuper, error: superError } = await supabase.rpc('is_super_admin', {
    check_user_id: viewerId,
  });
  const result = await readWhole<{ id: string; user_id: string }>(supabase, 'internal_roles', 'id, user_id');
  const staffIds = new Set(result.rows.map((r) => r.user_id));
  const complete = !superError && isSuper === true && !result.failed;
  return { staffIds, complete };
}
