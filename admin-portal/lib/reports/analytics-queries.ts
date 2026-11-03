/**
 * Analytics report — data access (BACKLOG-3723)
 *
 * The authenticated server client only; cross-org rows come from each table's
 * internal-role SELECT policy. No service-role client.
 *
 * EVERY ROW READ IS PAGED, never capped: the API returns at most 1000 rows per
 * request (supabase/config.toml max_rows), so a single read would silently
 * drop rows past that. Each read orders on `id` ALONE — an immutable total
 * order. Never on `last_seen_at`: every device heartbeat rewrites it, so a row
 * could move between pages mid-read and another row would be skipped.
 * `user_preferences` has no `id` column (its key is `user_id`), so it selects
 * `id:user_id` for the pager's dedupe and orders on `user_id`.
 *
 * The three totals (active devices, users, organizations) are exact head
 * counts, which cannot cap. A read that fails is reported as `failed` — never
 * as an empty section or a 0.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildActiveUserCount,
  buildLicenseUtilization,
  buildPhoneTypeBreakdown,
  buildPlatformBreakdown,
  buildVersionDistribution,
  versionUserIds,
  type LicenseMemberRow,
  type LicenseOrgRow,
  type LicenseUtilization,
  type PhonePrefRow,
  type PhoneTypeBreakdown,
  type PlatformBreakdown,
  type PlatformDeviceRow,
  type UserIdRow,
  type VersionDeviceRow,
  type VersionDistribution,
  type VersionUser,
} from './analytics';
import { fetchAllPages, MAX_PAGES, PAGE_SIZE, type PageResponse, type PagedResult } from './fetch-all-pages';

export const VERSION_DEVICE_COLUMNS = 'id, app_version, user_id';
export const ACTIVE_USER_DEVICE_COLUMNS = 'id, user_id';
export const PLATFORM_DEVICE_COLUMNS = 'id, platform, user_id';
export const ORG_COLUMNS = 'id, plan, max_seats';
export const MEMBER_COLUMNS = 'id, organization_id';
export const PREF_COLUMNS = 'id:user_id, preferences';
export const USER_COLUMNS = 'id, email, display_name';
/** Ids per `users` lookup: keeps the GET URL short and each read far below 1000 rows. */
export const USER_CHUNK = 200;

type WithId<T> = T & { id: string };

interface PageOpts {
  pageSize?: number;
  maxPages?: number;
}

/** Devices that are active and (unless All time) seen since `fromIso`. */
function readActiveDevices<T>(
  supabase: SupabaseClient,
  columns: string,
  fromIso: string | null,
  label: string,
  { pageSize = PAGE_SIZE, maxPages = MAX_PAGES }: PageOpts = {}
): Promise<PagedResult<WithId<T>>> {
  return fetchAllPages<WithId<T>>(
    (from, to) => {
      let query = supabase.from('devices').select(columns).eq('is_active', true);
      if (fromIso) query = query.gte('last_seen_at', fromIso);
      return query.order('id', { ascending: true }).range(from, to) as unknown as PromiseLike<PageResponse>;
    },
    label,
    pageSize,
    maxPages
  );
}

export const getVersionDevices = (supabase: SupabaseClient, fromIso: string | null, opts?: PageOpts) =>
  readActiveDevices<VersionDeviceRow>(supabase, VERSION_DEVICE_COLUMNS, fromIso, 'analytics devices (versions)', opts);

export const getActiveUserDevices = (supabase: SupabaseClient, fromIso: string | null, opts?: PageOpts) =>
  readActiveDevices<UserIdRow>(supabase, ACTIVE_USER_DEVICE_COLUMNS, fromIso, 'analytics devices (active users)', opts);

/** Platform has no date window: every active device. */
export const getPlatformDevices = (supabase: SupabaseClient, opts?: PageOpts) =>
  readActiveDevices<PlatformDeviceRow>(supabase, PLATFORM_DEVICE_COLUMNS, null, 'analytics devices (platform)', opts);

export function getLicenseOrgs(
  supabase: SupabaseClient,
  { pageSize = PAGE_SIZE, maxPages = MAX_PAGES }: PageOpts = {}
): Promise<PagedResult<LicenseOrgRow>> {
  return fetchAllPages<LicenseOrgRow>(
    (from, to) =>
      supabase
        .from('organizations')
        .select(ORG_COLUMNS)
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResponse>,
    'analytics organizations',
    pageSize,
    maxPages
  );
}

export function getLicenseMembers(
  supabase: SupabaseClient,
  { pageSize = PAGE_SIZE, maxPages = MAX_PAGES }: PageOpts = {}
): Promise<PagedResult<WithId<LicenseMemberRow>>> {
  return fetchAllPages<WithId<LicenseMemberRow>>(
    (from, to) =>
      supabase
        .from('organization_members')
        .select(MEMBER_COLUMNS)
        .eq('license_status', 'active')
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResponse>,
    'analytics organization_members',
    pageSize,
    maxPages
  );
}

export function getPhonePrefs(
  supabase: SupabaseClient,
  { pageSize = PAGE_SIZE, maxPages = MAX_PAGES }: PageOpts = {}
): Promise<PagedResult<WithId<PhonePrefRow>>> {
  return fetchAllPages<WithId<PhonePrefRow>>(
    (from, to) =>
      supabase
        .from('user_preferences')
        .select(PREF_COLUMNS)
        .order('user_id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResponse>,
    'analytics user_preferences',
    pageSize,
    maxPages
  );
}

export interface CountResult {
  /** null when the count failed. */
  value: number | null;
  failed: boolean;
}

interface CountResponse {
  count: number | null;
  error: { message: string } | null;
}

async function exactCount(query: PromiseLike<CountResponse>, label: string): Promise<CountResult> {
  const { count, error } = await query;
  if (error || count === null || count === undefined) {
    console.error(`${label} error:`, error?.message);
    return { value: null, failed: true };
  }
  return { value: count, failed: false };
}

export function getActiveDeviceCount(supabase: SupabaseClient, fromIso: string | null): Promise<CountResult> {
  let query = supabase.from('devices').select('id', { count: 'exact', head: true }).eq('is_active', true);
  if (fromIso) query = query.gte('last_seen_at', fromIso);
  return exactCount(query as unknown as PromiseLike<CountResponse>, 'analytics devices (count)');
}

export const getTotalUserCount = (supabase: SupabaseClient) =>
  exactCount(
    supabase.from('users').select('id', { count: 'exact', head: true }) as unknown as PromiseLike<CountResponse>,
    'analytics users (count)'
  );

export const getTotalOrgCount = (supabase: SupabaseClient) =>
  exactCount(
    supabase.from('organizations').select('id', { count: 'exact', head: true }) as unknown as PromiseLike<CountResponse>,
    'analytics organizations (count)'
  );

/**
 * Names for the version section's user lists, in chunks of USER_CHUNK ids.
 * A failed chunk sets `failed`; the counts never depend on this read.
 */
export async function getUsersByIds(
  supabase: SupabaseClient,
  ids: string[],
  chunk = USER_CHUNK
): Promise<{ users: VersionUser[]; failed: boolean }> {
  const users: VersionUser[] = [];
  let failed = false;
  for (let i = 0; i < ids.length; i += chunk) {
    const { data, error } = (await supabase
      .from('users')
      .select(USER_COLUMNS)
      .in('id', ids.slice(i, i + chunk))) as unknown as { data: VersionUser[] | null; error: { message: string } | null };
    if (error || !data) {
      console.error('analytics users (names) error:', error?.message);
      failed = true;
      continue;
    }
    users.push(...data);
  }
  return { users, failed };
}

// ─── The whole page ──────────────────────────────────────────────

export interface Section<T> {
  data: T;
  failed: boolean;
  truncated: boolean;
}

export interface AnalyticsData {
  counts: {
    active_users: CountResult;
    active_devices: CountResult;
    total_users: CountResult;
    total_orgs: CountResult;
    truncated: boolean;
  };
  versions: Section<VersionDistribution[]> & { namesFailed: boolean };
  platform: Section<PlatformBreakdown[]>;
  phone: Section<PhoneTypeBreakdown[]>;
  license: Section<LicenseUtilization[]>;
}

/** Every read the Analytics page makes, in parallel. `fromIso` is the period's lower bound. */
export async function getAnalyticsData(
  supabase: SupabaseClient,
  fromIso: string | null,
  opts?: PageOpts
): Promise<AnalyticsData> {
  const [versionDevices, activeUserDevices, activeDevices, totalUsers, totalOrgs, platformDevices, orgs, members, prefs] =
    await Promise.all([
      getVersionDevices(supabase, fromIso, opts),
      getActiveUserDevices(supabase, fromIso, opts),
      getActiveDeviceCount(supabase, fromIso),
      getTotalUserCount(supabase),
      getTotalOrgCount(supabase),
      getPlatformDevices(supabase, opts),
      getLicenseOrgs(supabase, opts),
      getLicenseMembers(supabase, opts),
      getPhonePrefs(supabase, opts),
    ]);

  const ids = versionDevices.failed ? [] : versionUserIds(versionDevices.rows);
  const names = ids.length > 0 ? await getUsersByIds(supabase, ids) : { users: [], failed: false };

  const licenseFailed = orgs.failed || members.failed;

  return {
    counts: {
      active_users: activeUserDevices.failed
        ? { value: null, failed: true }
        : { value: buildActiveUserCount(activeUserDevices.rows), failed: false },
      active_devices: activeDevices,
      total_users: totalUsers,
      total_orgs: totalOrgs,
      truncated: activeUserDevices.truncated,
    },
    versions: {
      data: versionDevices.failed ? [] : buildVersionDistribution(versionDevices.rows, names.users),
      failed: versionDevices.failed,
      truncated: versionDevices.truncated,
      namesFailed: names.failed,
    },
    platform: {
      data: platformDevices.failed ? [] : buildPlatformBreakdown(platformDevices.rows),
      failed: platformDevices.failed,
      truncated: platformDevices.truncated,
    },
    phone: {
      data: prefs.failed ? [] : buildPhoneTypeBreakdown(prefs.rows),
      failed: prefs.failed,
      truncated: prefs.truncated,
    },
    license: {
      data: licenseFailed ? [] : buildLicenseUtilization(orgs.rows, members.rows),
      failed: licenseFailed,
      truncated: orgs.truncated || members.truncated,
    },
  };
}
