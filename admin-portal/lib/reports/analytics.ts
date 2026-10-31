/**
 * Analytics report — pure maths (BACKLOG-3723)
 *
 * Moved verbatim out of the old `lib/analytics-queries.ts`: the reads now live
 * in ./analytics-queries.ts (paged), and these builders turn their rows into
 * the numbers the page shows. No maths changed in the move. Two known oddities
 * are kept on purpose and pinned by tests (follow-ups filed):
 *   - the Platform bar uses `pct` (denominator = distinct users across all
 *     platforms) while the legend recomputes over the sum of per-platform
 *     counts, so the two percentages differ when a user is on two platforms;
 *   - `compareSemver` treats pre-release versions (`2.40.0-beta.3`) as
 *     non-numeric, so they sort after every numeric version.
 */

// ─── Types ───────────────────────────────────────────────────────

export interface VersionUser {
  id: string;
  email: string | null;
  display_name: string | null;
}

export interface VersionDistribution {
  app_version: string;
  user_count: number;
  adoption_pct: number;
  users: VersionUser[];
}

export interface SystemCounts {
  active_users: number;
  total_orgs: number;
  active_devices: number;
  total_users: number;
}

export interface PlatformBreakdown {
  platform: string;
  user_count: number;
  pct: number;
}

export interface LicenseUtilization {
  plan: string;
  org_count: number;
  total_seats: number;
  active_seats: number;
  utilization_pct: number;
}

export interface PhoneTypeBreakdown {
  phone_type: string;
  user_count: number;
  pct: number;
}

// ─── Row shapes the reads return ─────────────────────────────────

export interface VersionDeviceRow {
  app_version: string | null;
  user_id: string;
}

export interface UserIdRow {
  user_id: string;
}

export interface PlatformDeviceRow {
  platform: string | null;
  user_id: string;
}

export interface LicenseOrgRow {
  id: string;
  plan: string | null;
  max_seats: number | null;
}

export interface LicenseMemberRow {
  organization_id: string;
}

export interface PhonePrefRow {
  preferences: unknown;
}

// ─── Builders ────────────────────────────────────────────────────

/**
 * Compare two semver strings numerically (e.g. "2.9.1" < "2.10.1").
 * Non-semver strings like "Unknown" sort to the end.
 */
export function compareSemver(a: string, b: string): number {
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

/** The distinct user ids a version read covers (the users lookup input). */
export function versionUserIds(devices: VersionDeviceRow[]): string[] {
  return [...new Set(devices.map((d) => d.user_id))];
}

export function buildVersionDistribution(
  devices: VersionDeviceRow[],
  usersData: VersionUser[]
): VersionDistribution[] {
  // Collect unique user IDs per version
  const versionMap = new Map<string, Set<string>>();
  for (const d of devices) {
    const version = d.app_version || 'Unknown';
    if (!versionMap.has(version)) versionMap.set(version, new Set());
    versionMap.get(version)!.add(d.user_id);
  }

  const totalActive = new Set(devices.map((d) => d.user_id)).size || 1;

  const userLookup = new Map<string, VersionUser>();
  for (const u of usersData) {
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

/** Active users = distinct user_id over the period's active devices. */
export function buildActiveUserCount(rows: UserIdRow[]): number {
  return new Set(rows.map((d) => d.user_id)).size;
}

export function buildPlatformBreakdown(devices: PlatformDeviceRow[]): PlatformBreakdown[] {
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

export function buildLicenseUtilization(
  orgs: LicenseOrgRow[],
  members: LicenseMemberRow[]
): LicenseUtilization[] {
  const memberCountByOrg = new Map<string, number>();
  for (const m of members) {
    memberCountByOrg.set(m.organization_id, (memberCountByOrg.get(m.organization_id) ?? 0) + 1);
  }

  const planMap = new Map<string, { org_count: number; total_seats: number; active_seats: number }>();

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
      utilization_pct: data.total_seats > 0 ? Math.round((data.active_seats / data.total_seats) * 100) : 0,
    });
  }

  const planOrder: Record<string, number> = {
    trial: 0,
    pro: 1,
    enterprise: 2,
  };
  results.sort((a, b) => (planOrder[a.plan] ?? 99) - (planOrder[b.plan] ?? 99));

  return results;
}

export function buildPhoneTypeBreakdown(prefs: PhonePrefRow[]): PhoneTypeBreakdown[] {
  const typeMap = new Map<string, number>();
  for (const p of prefs) {
    const phoneType = (p.preferences as Record<string, unknown>)?.phone_type as string | undefined;
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
