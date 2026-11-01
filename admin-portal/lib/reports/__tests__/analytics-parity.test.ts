/**
 * Analytics report — move parity (BACKLOG-3723, PLAN v1 parity check (b))
 *
 * Below the marker is a VERBATIM copy of the query functions from the deleted
 * `lib/analytics-queries.ts` (at c54b39cef; only `export` removed). The old
 * copy and the new paged path run through the SAME behaving stub
 * (./postgrest-stub: projects, filters, sorts, slices, caps unpaged reads at
 * 1000) over the same fixture, and must agree on every section.
 *
 * Then the 2,500-device variant: the old copy returns 1000-capped numbers,
 * the new path the exact ones — the fix.
 */

process.env.TZ = 'UTC';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import type {
  LicenseUtilization,
  PhoneTypeBreakdown,
  PlatformBreakdown,
  SystemCounts,
  VersionDistribution,
  VersionUser,
} from '../analytics';
import { getAnalyticsData, type AnalyticsData } from '../analytics-queries';
import { resolveAnalyticsPeriod } from '../analytics-period';
import { stubClient, uuid } from './postgrest-stub';
import { bigTables, NOW, TABLES } from './analytics.fixture';

// ─── VERBATIM OLD COPY (lib/analytics-queries.ts @ c54b39cef) ────

// ─── Helpers ─────────────────────────────────────────────────────

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ─── Queries ─────────────────────────────────────────────────────

/**
 * Active users by app version (last 30 days).
 *
 * Fetches only app_version and user_id (two columns, no payloads),
 * then aggregates in JS. For 10K+ devices, migrate to an RPC.
 */
/**
 * Compare two semver strings numerically (e.g. "2.9.1" < "2.10.1").
 * Non-semver strings like "Unknown" sort to the end.
 */
function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const isNumA = partsA.every((n) => !isNaN(n));
  const isNumB = partsB.every((n) => !isNaN(n));
  // Non-numeric versions (e.g. "Unknown") sort to the end
  if (!isNumA && !isNumB) return a.localeCompare(b);
  if (!isNumA) return 1;
  if (!isNumB) return -1;
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function getVersionDistribution(
  supabase: SupabaseClient,
  days = 30
): Promise<VersionDistribution[]> {
  const { data: devices, error } = await supabase
    .from('devices')
    .select('app_version, user_id')
    .eq('is_active', true)
    .gte('last_seen_at', daysAgo(days));

  if (error || !devices) {
    console.error('getVersionDistribution error:', error?.message);
    return [];
  }

  // Collect unique user IDs per version
  const versionMap = new Map<string, Set<string>>();
  for (const d of devices) {
    const version = d.app_version || 'Unknown';
    if (!versionMap.has(version)) versionMap.set(version, new Set());
    versionMap.get(version)!.add(d.user_id);
  }

  const totalActive = new Set(devices.map((d) => d.user_id)).size || 1;

  // Fetch user details for all unique user IDs
  const allUserIds = [...new Set(devices.map((d) => d.user_id))];
  const { data: usersData } = await supabase
    .from('users')
    .select('id, email, display_name')
    .in('id', allUserIds);

  const userLookup = new Map<string, VersionUser>();
  for (const u of usersData ?? []) {
    userLookup.set(u.id, { id: u.id, email: u.email, display_name: u.display_name });
  }

  const results: VersionDistribution[] = [];
  for (const [version, userIds] of versionMap) {
    const users: VersionUser[] = [...userIds].map(
      (uid) => userLookup.get(uid) ?? { id: uid, email: null, display_name: null }
    );
    users.sort((a, b) => (a.display_name ?? a.email ?? '').localeCompare(b.display_name ?? b.email ?? ''));
    results.push({
      app_version: version,
      user_count: users.length,
      adoption_pct: Math.round((users.length / totalActive) * 100),
      users,
    });
  }

  // Sort old → newest, "Unknown" at the end
  results.sort((a, b) => compareSemver(a.app_version, b.app_version));
  return results;
}

/**
 * System-wide counts using count-only queries (no row data transferred).
 */
async function getSystemCounts(
  supabase: SupabaseClient
): Promise<SystemCounts> {
  const cutoff = daysAgo(30);

  const [devicesResult, orgsResult, totalUsersResult, activeDevicesResult] =
    await Promise.all([
      // Active users: need user_id for distinct count (minimal select)
      supabase
        .from('devices')
        .select('user_id')
        .eq('is_active', true)
        .gte('last_seen_at', cutoff),
      // Total orgs: count only, no data
      supabase
        .from('organizations')
        .select('id', { count: 'exact', head: true }),
      // Total users: count only
      supabase
        .from('users')
        .select('id', { count: 'exact', head: true }),
      // Active devices: count only
      supabase
        .from('devices')
        .select('id', { count: 'exact', head: true })
        .eq('is_active', true)
        .gte('last_seen_at', cutoff),
    ]);

  const distinctUsers = new Set(
    (devicesResult.data ?? []).map((d) => d.user_id)
  );

  return {
    active_users: distinctUsers.size,
    total_orgs: orgsResult.count ?? 0,
    active_devices: activeDevicesResult.count ?? 0,
    total_users: totalUsersResult.count ?? 0,
  };
}

/**
 * Platform breakdown using minimal select (two columns only).
 */
async function getPlatformBreakdown(
  supabase: SupabaseClient
): Promise<PlatformBreakdown[]> {
  const { data: devices, error } = await supabase
    .from('devices')
    .select('platform, user_id')
    .eq('is_active', true);

  if (error || !devices) {
    console.error('getPlatformBreakdown error:', error?.message);
    return [];
  }

  const platformMap = new Map<string, Set<string>>();
  for (const d of devices) {
    const platform = d.platform || 'Unknown';
    if (!platformMap.has(platform)) platformMap.set(platform, new Set());
    platformMap.get(platform)!.add(d.user_id);
  }

  const totalUsers = new Set(devices.map((d) => d.user_id)).size || 1;

  const results: PlatformBreakdown[] = [];
  for (const [platform, users] of platformMap) {
    results.push({
      platform,
      user_count: users.size,
      pct: Math.round((users.size / totalUsers) * 100),
    });
  }

  results.sort((a, b) => b.user_count - a.user_count);
  return results;
}

/**
 * License utilization — uses count-only for members, minimal select for orgs.
 */
async function getLicenseUtilization(
  supabase: SupabaseClient
): Promise<LicenseUtilization[]> {
  const { data: orgs, error: orgsError } = await supabase
    .from('organizations')
    .select('id, plan, max_seats');

  if (orgsError || !orgs) {
    console.error('getLicenseUtilization orgs error:', orgsError?.message);
    return [];
  }

  // Fetch only the org_id column for active members
  const { data: members, error: membersError } = await supabase
    .from('organization_members')
    .select('organization_id')
    .eq('license_status', 'active');

  if (membersError || !members) {
    console.error('getLicenseUtilization members error:', membersError?.message);
    return [];
  }

  const memberCountByOrg = new Map<string, number>();
  for (const m of members) {
    memberCountByOrg.set(
      m.organization_id,
      (memberCountByOrg.get(m.organization_id) ?? 0) + 1
    );
  }

  const planMap = new Map<
    string,
    { org_count: number; total_seats: number; active_seats: number }
  >();

  for (const org of orgs) {
    const plan = org.plan || 'trial';
    if (!planMap.has(plan)) {
      planMap.set(plan, { org_count: 0, total_seats: 0, active_seats: 0 });
    }
    const entry = planMap.get(plan)!;
    entry.org_count += 1;
    entry.total_seats += org.max_seats ?? 0;
    entry.active_seats += memberCountByOrg.get(org.id) ?? 0;
  }

  const results: LicenseUtilization[] = [];
  for (const [plan, data] of planMap) {
    results.push({
      plan,
      org_count: data.org_count,
      total_seats: data.total_seats,
      active_seats: data.active_seats,
      utilization_pct:
        data.total_seats > 0
          ? Math.round((data.active_seats / data.total_seats) * 100)
          : 0,
    });
  }

  const planOrder: Record<string, number> = {
    trial: 0,
    pro: 1,
    enterprise: 2,
  };
  results.sort(
    (a, b) => (planOrder[a.plan] ?? 99) - (planOrder[b.plan] ?? 99)
  );

  return results;
}

/**
 * Phone type breakdown — fetches preferences JSONB (unavoidable for JSONB field extraction).
 */
async function getPhoneTypeBreakdown(
  supabase: SupabaseClient
): Promise<PhoneTypeBreakdown[]> {
  const { data: prefs, error } = await supabase
    .from('user_preferences')
    .select('user_id, preferences');

  if (error || !prefs) {
    console.error('getPhoneTypeBreakdown error:', error?.message);
    return [];
  }

  const typeMap = new Map<string, number>();
  for (const p of prefs) {
    const phoneType =
      (p.preferences as Record<string, unknown>)?.phone_type as
        | string
        | undefined;
    const label = phoneType || 'Not set';
    typeMap.set(label, (typeMap.get(label) ?? 0) + 1);
  }

  const total = prefs.length || 1;
  const results: PhoneTypeBreakdown[] = [];
  for (const [phoneType, count] of typeMap) {
    results.push({
      phone_type: phoneType,
      user_count: count,
      pct: Math.round((count / total) * 100),
    });
  }

  results.sort((a, b) => b.user_count - a.user_count);
  return results;
}

// ─── END VERBATIM OLD COPY ───────────────────────────────────────

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

async function oldPage(client: SupabaseClient, days: number) {
  const [versions, counts, platform, license, phone] = await Promise.all([
    getVersionDistribution(client, days),
    getSystemCounts(client),
    getPlatformBreakdown(client),
    getLicenseUtilization(client),
    getPhoneTypeBreakdown(client),
  ]);
  return { versions, counts, platform, license, phone };
}

function newCounts(d: AnalyticsData): SystemCounts {
  return {
    active_users: d.counts.active_users.value as number,
    total_orgs: d.counts.total_orgs.value as number,
    active_devices: d.counts.active_devices.value as number,
    total_users: d.counts.total_users.value as number,
  };
}

const THIRTY = resolveAnalyticsPeriod({}, NOW);

describe('parity (b): old and new agree on the same data', () => {
  it('30 days: every section deep-equals the old code', async () => {
    const old = await oldPage(stubClient(TABLES).client, 30);
    const now = await getAnalyticsData(stubClient(TABLES).client, THIRTY.fromIso);
    expect(now.versions.data).toEqual(old.versions);
    expect(newCounts(now)).toEqual(old.counts);
    expect(now.platform.data).toEqual(old.platform);
    expect(now.license.data).toEqual(old.license);
    expect(now.phone.data).toEqual(old.phone);
    expect([now.versions.failed, now.platform.failed, now.phone.failed, now.license.failed]).toEqual([
      false, false, false, false,
    ]);
  });

  it.each(['1', '7', '90'] as const)('period %s: the version section deep-equals the old code', async (key) => {
    const old = await getVersionDistribution(stubClient(TABLES).client, Number(key));
    const now = await getAnalyticsData(stubClient(TABLES).client, resolveAnalyticsPeriod({ period: key }, NOW).fromIso);
    expect(now.versions.data).toEqual(old);
  });

  it('maths pin: the 30-day numbers on the fixture', async () => {
    const d = await getAnalyticsData(stubClient(TABLES).client, THIRTY.fromIso);
    // Active, seen in 30d: D1,D2,D3,D4,D5,D6,D7,D12,D14 -> users 1-6; D10 inactive, D11 NULL, D8/D9 old, D13 never seen.
    expect(newCounts(d)).toEqual({ active_users: 6, active_devices: 9, total_users: 9, total_orgs: 5 });
    expect(d.versions.data.map((v) => [v.app_version, v.user_count, v.adoption_pct])).toEqual([
      ['2.41.0', 3, 50],
      ['2.44.0', 2, 33],
      ['2.40.0-beta.3', 1, 17],
      ['2.44.0-pre.2', 1, 17],
      ['Unknown', 1, 17],
    ]);
    expect(d.versions.data.find((v) => v.app_version === 'Unknown')?.users).toEqual([
      { id: uuid(6), email: null, display_name: null },
    ]);
    // Platform: every ACTIVE device, no window. 8 distinct users; U5 and U1 on two platforms; D13 platform NULL -> Unknown.
    // The per-platform counts sum to 11 > 8, so the pcts sum past 100 (the pinned bar/legend oddity).
    expect(d.platform.data).toEqual([
      { platform: 'windows', user_count: 6, pct: 75 },
      { platform: 'macos', user_count: 3, pct: 38 },
      { platform: 'Unknown', user_count: 1, pct: 13 },
      { platform: 'linux', user_count: 1, pct: 13 },
    ]);
    // License: inactive / NULL-status members not counted; NULL plan -> trial with 0 seats; missing-org member ignored.
    expect(d.license.data).toEqual([
      { plan: 'trial', org_count: 3, total_seats: 8, active_seats: 3, utilization_pct: 38 },
      { plan: 'pro', org_count: 1, total_seats: 10, active_seats: 1, utilization_pct: 10 },
      { plan: 'enterprise', org_count: 1, total_seats: 50, active_seats: 3, utilization_pct: 6 },
    ]);
    // Phone: a pref without phone_type and an empty phone_type are both "Not set".
    expect(d.phone.data).toEqual([
      { phone_type: 'iphone', user_count: 3, pct: 50 },
      { phone_type: 'Not set', user_count: 2, pct: 33 },
      { phone_type: 'android', user_count: 1, pct: 17 },
    ]);
  });

  it('All time: the version section and tiles cover every active device seen at any time', async () => {
    const d = await getAnalyticsData(stubClient(TABLES).client, null);
    // + D8, D9, D13 (never seen: NULL last_seen_at is included when there is no window).
    expect(d.counts.active_devices.value).toBe(12);
    expect(d.counts.active_users.value).toBe(8);
    expect(d.versions.data.map((v) => v.app_version)).toEqual([
      '2.9.1', '2.10.1', '2.39.0', '2.41.0', '2.44.0', '2.40.0-beta.3', '2.44.0-pre.2', 'Unknown',
    ]);
  });
});

describe('parity (b): past the 1000-row cap the old code undercounts, the new path does not', () => {
  it('2,500 devices / 2,500 users / 1,100 orgs / 1,200 members / 1,300 prefs', async () => {
    const big = bigTables();
    const old = await oldPage(stubClient(big).client, 30);
    const now = await getAnalyticsData(stubClient(big).client, THIRTY.fromIso);

    // Old: every row read capped at 1000; the head counts were always exact.
    expect(old.counts.active_users).toBe(1000);
    expect(old.counts.active_devices).toBe(2500);
    expect(old.platform.reduce((s, p) => s + p.user_count, 0)).toBe(1000);
    expect(old.phone.reduce((s, p) => s + p.user_count, 0)).toBe(1000);

    // New: exact.
    expect(newCounts(now)).toEqual({ active_users: 2500, active_devices: 2500, total_users: 2500, total_orgs: 1100 });
    expect(now.versions.data.reduce((s, v) => s + v.user_count, 0)).toBe(2500);
    expect(now.versions.data.map((v) => [v.app_version, v.user_count])).toEqual([
      ['2.41.0', 500],
      ['2.43.0', 500],
      ['2.44.0', 500],
      ['2.44.0-pre.2', 500],
      ['Unknown', 500],
    ]);
    expect(now.platform.data).toEqual([
      { platform: 'windows', user_count: 1666, pct: 67 },
      { platform: 'macos', user_count: 834, pct: 33 },
    ]);
    expect(now.phone.data).toEqual([
      { phone_type: 'iphone', user_count: 975, pct: 75 },
      { phone_type: 'android', user_count: 325, pct: 25 },
    ]);
    expect(now.license.data).toEqual([
      { plan: 'trial', org_count: 550, total_seats: 1100, active_seats: 600, utilization_pct: 55 },
      { plan: 'pro', org_count: 550, total_seats: 1100, active_seats: 600, utilization_pct: 55 },
    ]);
    // Every user name resolved through the chunked lookup.
    expect(now.versions.namesFailed).toBe(false);
    expect(now.versions.data.flatMap((v) => v.users).every((u) => u.email !== null)).toBe(true);
    expect([now.counts.truncated, now.versions.truncated, now.platform.truncated, now.phone.truncated, now.license.truncated]).toEqual([
      false, false, false, false, false,
    ]);
  });
});

// Type-only use keeps the old copy's referenced types in scope.
export type _OldTypes = [VersionUser, VersionDistribution, PlatformBreakdown, LicenseUtilization, PhoneTypeBreakdown];
