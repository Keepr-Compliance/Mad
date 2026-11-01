/**
 * User Activity report — pure builder (BACKLOG-3720)
 *
 * No IO. Takes the rows the queries read and returns one row per customer.
 *
 * WHO IS A ROW: every user in `public.users` who is NOT internal staff. A user
 * with no activity still appears (Active = no). Every audit event lands in
 * exactly one of three buckets:
 *   - a listed user  -> counted on that user's row
 *   - internal staff -> `staffEventCount`, never a row, never a total
 *   - anyone else    -> `orphanEventCount` (user no longer in Keepr)
 *
 * LATEST-ONLY COLUMNS (last sign-in, last seen, devices) are a snapshot. The
 * period never filters them and never removes a user — a user active last
 * month must not vanish because they were also seen this week.
 *
 * PERIOD COLUMNS come from `audit_logs` only:
 *   - Transactions created / edited = DISTINCT transactions (resource_id) per
 *     user, not audit rows. One transaction ticked three times is 1 edited.
 *   - Submissions = TRANSACTION_SUBMIT events.
 *   - Exports = DATA_EXPORT events on an EXPORT resource only. The personal
 *     "export my data" writes DATA_EXPORT on a USER resource and is excluded.
 *   - Active in period = at least one recorded app event of any kind.
 */

import { formatUtc } from './iphone-sync';

export const ACTION_TRANSACTION_CREATE = 'TRANSACTION_CREATE';
export const ACTION_TRANSACTION_UPDATE = 'TRANSACTION_UPDATE';
export const ACTION_TRANSACTION_SUBMIT = 'TRANSACTION_SUBMIT';
export const ACTION_DATA_EXPORT = 'DATA_EXPORT';
export const EXPORT_RESOURCE_TYPE = 'EXPORT';

/** Printed under the header and the cards. Kept here so tests read the same words. */
export const LATEST_ONLY_NOTE =
  'Last sign-in, Last seen and Devices are the latest value, not affected by period.';
export const ACTIVE_DEFINITION = 'At least one recorded app event in the period.';
export const CREATED_DEFINITION = 'Distinct transactions each user created in the period, summed.';
export const EDITED_DEFINITION = 'Distinct transactions each user edited in the period, not edit events.';
export const SUBMISSIONS_DEFINITION = 'Submit events in the period.';
export const ACTIVE_DEVICES_DEFINITION = 'Devices marked active now. Not affected by period.';

// ─── Input rows (shapes transcribed from the prod columns; see user-activity.fixture.ts) ───

export interface ActivityUserRow {
  id: string;
  email: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  last_login_at: string | null;
}

export interface ActivityDeviceRow {
  id: string;
  user_id: string;
  platform: string | null;
  app_version: string | null;
  is_active: boolean | null;
  last_seen_at: string | null;
}

export interface ActivityEventRow {
  id: string;
  user_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  created_at: string;
}

export interface ActivityMembershipRow {
  id: string;
  user_id: string | null;
  organization_id: string;
}

export interface ActivityOrgRow {
  id: string;
  name: string;
}

// ─── Output ──────────────────────────────────────────────────────

export interface UserActivityRow {
  userId: string;
  userLabel: string;
  email: string;
  orgNames: string[];
  orgLabel: string;
  lastSignInIso: string | null;
  lastSignInUtc: string;
  lastSeenIso: string | null;
  lastSeenUtc: string;
  activeDevices: number;
  totalDevices: number;
  platforms: string;
  activeInPeriod: boolean;
  eventCount: number;
  transactionsCreated: number;
  transactionsEdited: number;
  submissions: number;
  exports: number;
}

export interface UserActivityTotals {
  users: number;
  activeUsers: number;
  transactionsCreated: number;
  submissions: number;
  activeDevices: number;
}

export interface UserActivityReportModel {
  rows: UserActivityRow[];
  /** Events whose user is not in `public.users` (deleted or test users). */
  orphanEventCount: number;
  /** Events written by internal staff, who are not listed. */
  staffEventCount: number;
}

export interface UserActivityInput {
  users: ActivityUserRow[];
  devices: ActivityDeviceRow[];
  events: ActivityEventRow[];
  memberships: ActivityMembershipRow[];
  orgs: ActivityOrgRow[];
  staffIds: ReadonlySet<string>;
}

const EM_DASH = '—';

function userLabel(u: ActivityUserRow): string {
  if (u.display_name && u.display_name.trim().length > 0) return u.display_name.trim();
  const full = [u.first_name, u.last_name].filter((p) => p && p.trim().length > 0).join(' ').trim();
  return full.length > 0 ? full : u.email;
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

interface Tally {
  events: number;
  created: Set<string>;
  edited: Set<string>;
  submissions: number;
  exports: number;
}

function emptyTally(): Tally {
  return { events: 0, created: new Set(), edited: new Set(), submissions: 0, exports: 0 };
}

export function buildUserActivityReport(input: UserActivityInput): UserActivityReportModel {
  const { users, devices, events, memberships, orgs, staffIds } = input;

  const listed = users.filter((u) => !staffIds.has(u.id));
  const knownIds = new Set(users.map((u) => u.id));
  const tallies = new Map<string, Tally>(listed.map((u) => [u.id, emptyTally()]));

  let orphanEventCount = 0;
  let staffEventCount = 0;
  for (const e of events) {
    if (staffIds.has(e.user_id)) {
      staffEventCount += 1;
      continue;
    }
    const t = tallies.get(e.user_id);
    if (!t) {
      if (!knownIds.has(e.user_id)) orphanEventCount += 1;
      continue;
    }
    t.events += 1;
    if (e.action === ACTION_TRANSACTION_CREATE && e.resource_id) t.created.add(e.resource_id);
    else if (e.action === ACTION_TRANSACTION_UPDATE && e.resource_id) t.edited.add(e.resource_id);
    else if (e.action === ACTION_TRANSACTION_SUBMIT) t.submissions += 1;
    else if (e.action === ACTION_DATA_EXPORT && e.resource_type === EXPORT_RESOURCE_TYPE) t.exports += 1;
  }

  const devicesByUser = new Map<string, ActivityDeviceRow[]>();
  for (const d of devices) {
    const list = devicesByUser.get(d.user_id) ?? [];
    list.push(d);
    devicesByUser.set(d.user_id, list);
  }

  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const orgsByUser = new Map<string, Set<string>>();
  for (const m of memberships) {
    if (!m.user_id) continue;
    const set = orgsByUser.get(m.user_id) ?? new Set<string>();
    set.add(orgName.get(m.organization_id) ?? 'Unknown organization');
    orgsByUser.set(m.user_id, set);
  }

  const rows = listed.map((u): UserActivityRow => {
    const t = tallies.get(u.id) ?? emptyTally();
    const own = devicesByUser.get(u.id) ?? [];
    const lastSeenIso = own.reduce<string | null>((acc, d) => latest(acc, d.last_seen_at), null);
    const platforms = [...new Set(own.map((d) => d.platform).filter((p): p is string => !!p))].sort();
    const userOrgs = [...(orgsByUser.get(u.id) ?? [])].sort((a, b) => a.localeCompare(b));
    return {
      userId: u.id,
      userLabel: userLabel(u),
      email: u.email,
      orgNames: userOrgs,
      orgLabel: userOrgs.length === 0 ? EM_DASH : userOrgs.join(', '),
      lastSignInIso: u.last_login_at,
      lastSignInUtc: u.last_login_at ? formatUtc(u.last_login_at) : EM_DASH,
      lastSeenIso,
      lastSeenUtc: lastSeenIso ? formatUtc(lastSeenIso) : EM_DASH,
      activeDevices: own.filter((d) => d.is_active === true).length,
      totalDevices: own.length,
      platforms: platforms.length === 0 ? EM_DASH : platforms.join(', '),
      activeInPeriod: t.events > 0,
      eventCount: t.events,
      transactionsCreated: t.created.size,
      transactionsEdited: t.edited.size,
      submissions: t.submissions,
      exports: t.exports,
    };
  });

  return { rows, orphanEventCount, staffEventCount };
}

/** Cards read the same rows the table shows, so staff can never reach a card. */
export function computeTotals(rows: UserActivityRow[]): UserActivityTotals {
  return {
    users: rows.length,
    activeUsers: rows.filter((r) => r.activeInPeriod).length,
    transactionsCreated: rows.reduce((n, r) => n + r.transactionsCreated, 0),
    submissions: rows.reduce((n, r) => n + r.submissions, 0),
    activeDevices: rows.reduce((n, r) => n + r.activeDevices, 0),
  };
}

// ─── Filters ─────────────────────────────────────────────────────

export interface UserActivityFilters {
  orgs: string[];
  activeOnly: boolean;
  search: string;
}

export const EMPTY_USER_ACTIVITY_FILTERS: UserActivityFilters = { orgs: [], activeOnly: false, search: '' };

export function hasActiveUserActivityFilters(f: UserActivityFilters): boolean {
  return f.orgs.length > 0 || f.activeOnly || f.search.trim().length > 0;
}

export function activeUserActivityFilterNames(f: UserActivityFilters): string[] {
  const names: string[] = [];
  if (f.orgs.length > 0) names.push('Organization');
  if (f.activeOnly) names.push('Active in period only');
  if (f.search.trim().length > 0) names.push(`Search "${f.search.trim()}"`);
  return names;
}

export function applyUserActivityFilters(rows: UserActivityRow[], f: UserActivityFilters): UserActivityRow[] {
  const search = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.orgs.length > 0 && !r.orgNames.some((o) => f.orgs.includes(o))) return false;
    if (f.activeOnly && !r.activeInPeriod) return false;
    if (search && !r.userLabel.toLowerCase().includes(search) && !r.email.toLowerCase().includes(search)) {
      return false;
    }
    return true;
  });
}

// ─── Sorting ─────────────────────────────────────────────────────

export type UserActivitySortKey =
  | 'user'
  | 'org'
  | 'lastSignIn'
  | 'lastSeen'
  | 'devices'
  | 'active'
  | 'created'
  | 'edited'
  | 'submissions'
  | 'exports';

export type SortDirection = 'asc' | 'desc';
type SortValue = string | number | null;

export const USER_ACTIVITY_SORT_SPECS: Record<
  UserActivitySortKey,
  { label: string; value: (r: UserActivityRow) => SortValue; numeric: boolean }
> = {
  user: { label: 'User', value: (r) => r.userLabel.toLowerCase(), numeric: false },
  org: { label: 'Organization', value: (r) => (r.orgLabel === EM_DASH ? null : r.orgLabel.toLowerCase()), numeric: false },
  lastSignIn: { label: 'Last sign-in', value: (r) => (r.lastSignInIso ? Date.parse(r.lastSignInIso) : null), numeric: true },
  lastSeen: { label: 'Last seen', value: (r) => (r.lastSeenIso ? Date.parse(r.lastSeenIso) : null), numeric: true },
  devices: { label: 'Devices active / total', value: (r) => r.activeDevices * 1000 + r.totalDevices, numeric: true },
  active: { label: 'Active in period', value: (r) => (r.activeInPeriod ? 1 : 0), numeric: true },
  created: { label: 'Transactions created', value: (r) => r.transactionsCreated, numeric: true },
  edited: { label: 'Transactions edited (distinct)', value: (r) => r.transactionsEdited, numeric: true },
  submissions: { label: 'Submissions', value: (r) => r.submissions, numeric: true },
  exports: { label: 'Exports', value: (r) => r.exports, numeric: true },
};

export function defaultUserActivityDirection(key: UserActivitySortKey): SortDirection {
  return USER_ACTIVITY_SORT_SPECS[key].numeric ? 'desc' : 'asc';
}

/** Stable sort; rows with no value always sink to the bottom, either direction. */
export function sortUserActivity(
  rows: UserActivityRow[],
  key: UserActivitySortKey,
  direction: SortDirection
): UserActivityRow[] {
  const spec = USER_ACTIVITY_SORT_SPECS[key];
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i, v: spec.value(r) }))
    .sort((a, b) => {
      if (a.v == null && b.v == null) return a.i - b.i;
      if (a.v == null) return 1;
      if (b.v == null) return -1;
      const cmp =
        typeof a.v === 'number' && typeof b.v === 'number'
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v));
      return cmp === 0 ? a.i - b.i : cmp * sign;
    })
    .map((x) => x.r);
}

export const INITIAL_VISIBLE_USERS = 25;
export const USER_SHOW_MORE_STEP = 25;
