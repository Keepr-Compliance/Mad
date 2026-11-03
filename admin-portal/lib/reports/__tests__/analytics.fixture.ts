/**
 * Analytics report — fixture (BACKLOG-3723). SYNTHETIC: all-zero UUIDs and
 * made-up names; no production row is copied.
 *
 * Shape transcribed from production columns (Supabase, project Keepr,
 * 2026-10-30, SELECT on information_schema.columns for devices / users /
 * organizations / organization_members / user_preferences):
 *   devices: id uuid NOT NULL, user_id uuid NOT NULL, platform text NULL,
 *            app_version text NULL, is_active boolean NULL,
 *            last_seen_at timestamptz NULL
 *   users: id uuid, email text NOT NULL, display_name text NULL
 *   organizations: id uuid, plan varchar NULL, max_seats integer NULL
 *   organization_members: id uuid, organization_id uuid NOT NULL,
 *            license_status varchar NULL
 *   user_preferences: user_id uuid NOT NULL (primary key — NO id column),
 *            preferences jsonb NOT NULL, updated_at timestamptz NULL
 * Values follow production's (PLAN v1 SQL 2, counts only): platforms are
 * `macos` / `windows`; phone_type is `iphone` / `android`; plans are
 * trial / pro / enterprise.
 *
 * Deliberately includes every case a filter must exclude: an inactive device
 * and a NULL-is_active device inside the window, devices outside 30d and 90d,
 * a device never seen (NULL last_seen_at), inactive and NULL-status members, a
 * member of a missing org, an org with NULL plan and NULL max_seats, a NULL
 * app_version, one user on two platforms, a pref without phone_type, a
 * version user missing from `users`, and two pre-release versions.
 */

import { uuid, type StubRow } from './postgrest-stub';

export const NOW = new Date('2026-10-15T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const U = (n: number) => uuid(n);
const D = (n: number) => uuid(100 + n);
const O = (n: number) => uuid(200 + n);
const M = (n: number) => uuid(300 + n);

export const DEVICES: StubRow[] = [
  { id: D(1), user_id: U(1), platform: 'macos', app_version: '2.44.0', is_active: true, last_seen_at: ago(HOUR) },
  { id: D(2), user_id: U(2), platform: 'windows', app_version: '2.44.0', is_active: true, last_seen_at: ago(2 * DAY) },
  { id: D(3), user_id: U(3), platform: 'windows', app_version: '2.41.0', is_active: true, last_seen_at: ago(5 * DAY) },
  { id: D(4), user_id: U(4), platform: 'windows', app_version: '2.41.0', is_active: true, last_seen_at: ago(10 * DAY) },
  { id: D(5), user_id: U(5), platform: 'macos', app_version: '2.40.0-beta.3', is_active: true, last_seen_at: ago(20 * DAY) },
  { id: D(6), user_id: U(5), platform: 'windows', app_version: '2.41.0', is_active: true, last_seen_at: ago(25 * DAY) },
  { id: D(7), user_id: U(6), platform: 'windows', app_version: null, is_active: true, last_seen_at: ago(3 * DAY) },
  { id: D(8), user_id: U(7), platform: 'macos', app_version: '2.9.1', is_active: true, last_seen_at: ago(40 * DAY) },
  { id: D(9), user_id: U(8), platform: 'windows', app_version: '2.10.1', is_active: true, last_seen_at: ago(100 * DAY) },
  { id: D(10), user_id: U(9), platform: 'macos', app_version: '2.44.0', is_active: false, last_seen_at: ago(DAY) },
  { id: D(11), user_id: U(10), platform: 'windows', app_version: '2.44.0', is_active: null, last_seen_at: ago(DAY) },
  { id: D(12), user_id: U(2), platform: 'windows', app_version: '2.44.0', is_active: true, last_seen_at: ago(6 * DAY) },
  { id: D(13), user_id: U(3), platform: null, app_version: '2.39.0', is_active: true, last_seen_at: null },
  { id: D(14), user_id: U(1), platform: 'linux', app_version: '2.44.0-pre.2', is_active: true, last_seen_at: ago(12 * HOUR) },
];

/** U(6) is deliberately missing: its version row shows "Unknown User". */
export const USERS: StubRow[] = [
  { id: U(1), email: 'ada@example.test', display_name: 'Ada' },
  { id: U(2), email: 'ben@example.test', display_name: 'Ben' },
  { id: U(3), email: 'cy@example.test', display_name: 'Cy' },
  { id: U(4), email: 'dee@example.test', display_name: null },
  { id: U(5), email: 'eve@example.test', display_name: 'Eve' },
  { id: U(7), email: 'gus@example.test', display_name: 'Gus' },
  { id: U(8), email: 'hal@example.test', display_name: 'Hal' },
  { id: U(9), email: 'ivy@example.test', display_name: 'Ivy' },
  { id: U(10), email: 'jo@example.test', display_name: 'Jo' },
];

export const ORGS: StubRow[] = [
  { id: O(1), plan: 'trial', max_seats: 5 },
  { id: O(2), plan: 'pro', max_seats: 10 },
  { id: O(3), plan: 'enterprise', max_seats: 50 },
  { id: O(4), plan: null, max_seats: null },
  { id: O(5), plan: 'trial', max_seats: 3 },
];

export const MEMBERS: StubRow[] = [
  { id: M(1), organization_id: O(1), license_status: 'active' },
  { id: M(2), organization_id: O(1), license_status: 'active' },
  { id: M(3), organization_id: O(1), license_status: 'inactive' },
  { id: M(4), organization_id: O(2), license_status: 'active' },
  { id: M(5), organization_id: O(3), license_status: 'active' },
  { id: M(6), organization_id: O(3), license_status: 'active' },
  { id: M(7), organization_id: O(3), license_status: 'active' },
  { id: M(8), organization_id: O(4), license_status: 'active' },
  { id: M(9), organization_id: O(5), license_status: null },
  { id: M(10), organization_id: uuid(299), license_status: 'active' },
];

export const PREFS: StubRow[] = [
  { user_id: U(1), preferences: { phone_type: 'iphone' }, updated_at: ago(DAY) },
  { user_id: U(2), preferences: { phone_type: 'iphone' }, updated_at: ago(DAY) },
  { user_id: U(3), preferences: { phone_type: 'android' }, updated_at: ago(DAY) },
  { user_id: U(4), preferences: {}, updated_at: ago(DAY) },
  { user_id: U(5), preferences: { phone_type: '' }, updated_at: null },
  { user_id: U(6), preferences: { phone_type: 'iphone', theme: 'dark' }, updated_at: ago(DAY) },
];

export const TABLES: Record<string, StubRow[]> = {
  devices: DEVICES,
  users: USERS,
  organizations: ORGS,
  organization_members: MEMBERS,
  user_preferences: PREFS,
};

/**
 * 2,500 active devices seen in the last 30 days, one user each; every THREE
 * share one last_seen_at so tie groups straddle the 1000-row page boundaries
 * (a read ordered on last_seen_at would skip or repeat rows). 2,500 users,
 * 1,100 orgs, 1,200 active members, 1,300 prefs: every table is past the cap.
 */
export function bigTables(): Record<string, StubRow[]> {
  const versions = ['2.41.0', '2.43.0', '2.44.0', '2.44.0-pre.2', null];
  const devices = Array.from({ length: 2500 }, (_, i) => ({
    id: uuid(10_000 + i),
    user_id: uuid(20_000 + i),
    platform: i % 3 === 0 ? 'macos' : 'windows',
    app_version: versions[i % versions.length],
    is_active: true,
    last_seen_at: ago(HOUR + Math.floor(i / 3) * 1000),
  }));
  const users = devices.map((d, i) => ({ id: d.user_id, email: `u${i}@example.test`, display_name: `User ${i}` }));
  const orgs = Array.from({ length: 1100 }, (_, i) => ({
    id: uuid(30_000 + i),
    plan: i % 2 === 0 ? 'trial' : 'pro',
    max_seats: 2,
  }));
  const members = Array.from({ length: 1200 }, (_, i) => ({
    id: uuid(40_000 + i),
    organization_id: orgs[i % orgs.length].id,
    license_status: 'active',
  }));
  const prefs = Array.from({ length: 1300 }, (_, i) => ({
    user_id: devices[i].user_id,
    preferences: { phone_type: i % 4 === 0 ? 'android' : 'iphone' },
    updated_at: null,
  }));
  return { devices, users, organizations: orgs, organization_members: members, user_preferences: prefs };
}
