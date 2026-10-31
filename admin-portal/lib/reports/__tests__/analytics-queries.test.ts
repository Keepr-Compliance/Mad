/**
 * Analytics report — query tests (BACKLOG-3723, SR R1 / R2 / R5, PLAN T1-T4)
 *
 * Run through ./postgrest-stub, which projects (with `alias:col`), filters,
 * sorts with per-request tie reshuffles, slices on range and caps an unpaged
 * read at 1000 — so a wrong query fails on behaviour, not only on call shape.
 */

import { describe, expect, it } from 'vitest';
import {
  getAnalyticsData,
  getPhonePrefs,
  getUsersByIds,
  getVersionDevices,
} from '../analytics-queries';
import { resolveAnalyticsPeriod } from '../analytics-period';
import { argsOn, stubClient, uuid } from './postgrest-stub';
import { bigTables, NOW, TABLES } from './analytics.fixture';

const SEVEN = resolveAnalyticsPeriod({ period: '7' }, NOW);
const THIRTY = resolveAnalyticsPeriod({}, NOW);

/** Calls of the request(s) that selected exactly `cols` on `table`. */
function requestsSelecting(calls: ReturnType<typeof stubClient>['calls'], table: string, cols: string) {
  // Calls arrive in builder order per request; split the table's calls at each select.
  const out: { method: string; args: unknown[] }[][] = [];
  let cur: { method: string; args: unknown[] }[] | null = null;
  for (const c of calls.filter((x) => x.table === table)) {
    if (c.method === 'select') {
      cur = String(c.args[0]) === cols ? [] : null;
      if (cur) out.push(cur);
    }
    if (cur) cur.push({ method: c.method, args: c.args });
  }
  return out;
}

const methodArgs = (req: { method: string; args: unknown[] }[], m: string) =>
  req.filter((c) => c.method === m).map((c) => c.args);

describe('R2 query shape', () => {
  it('each paged read selects exactly its columns, orders on id alone, and pages', async () => {
    const { client, calls } = stubClient(TABLES);
    await getAnalyticsData(client, THIRTY.fromIso);
    const expectRead = (table: string, cols: string, eq: unknown[][], order: unknown[][]) => {
      const reqs = requestsSelecting(calls, table, cols);
      expect(reqs.length).toBeGreaterThan(0);
      for (const r of reqs) {
        expect(methodArgs(r, 'select')).toEqual([[cols]]);
        expect(methodArgs(r, 'eq')).toEqual(eq);
        expect(methodArgs(r, 'order')).toEqual(order);
        expect(methodArgs(r, 'range')).toEqual([[0, 999]]);
      }
    };
    const byId = [['id', { ascending: true }]];
    expectRead('devices', 'id, app_version, user_id', [['is_active', true]], byId);
    expectRead('devices', 'id, user_id', [['is_active', true]], byId);
    expectRead('devices', 'id, platform, user_id', [['is_active', true]], byId);
    expectRead('organizations', 'id, plan, max_seats', [], byId);
    expectRead('organization_members', 'id, organization_id', [['license_status', 'active']], byId);
    expectRead('user_preferences', 'id:user_id, preferences', [], [['user_id', { ascending: true }]]);
  });

  it('the three totals are exact head counts', async () => {
    const { client, calls } = stubClient(TABLES);
    await getAnalyticsData(client, THIRTY.fromIso);
    const head = calls.filter((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head);
    expect(head.map((c) => [c.table, c.args])).toEqual(
      expect.arrayContaining([
        ['devices', ['id', { count: 'exact', head: true }]],
        ['users', ['id', { count: 'exact', head: true }]],
        ['organizations', ['id', { count: 'exact', head: true }]],
      ])
    );
    expect(head).toHaveLength(3);
  });
});

describe('R5 which reads follow the period', () => {
  it('at 7d the active-users read, the active-devices count and the version read share one gte; nothing else has one', async () => {
    const { client, calls } = stubClient(TABLES);
    await getAnalyticsData(client, SEVEN.fromIso);
    const gte = [['last_seen_at', SEVEN.fromIso]];
    expect(SEVEN.fromIso).toBe('2026-10-08T12:00:00.000Z');
    for (const r of requestsSelecting(calls, 'devices', 'id, app_version, user_id')) expect(methodArgs(r, 'gte')).toEqual(gte);
    for (const r of requestsSelecting(calls, 'devices', 'id, user_id')) expect(methodArgs(r, 'gte')).toEqual(gte);
    for (const r of requestsSelecting(calls, 'devices', 'id')) expect(methodArgs(r, 'gte')).toEqual(gte);
    for (const r of requestsSelecting(calls, 'devices', 'id, platform, user_id')) expect(methodArgs(r, 'gte')).toEqual([]);
    for (const t of ['users', 'organizations', 'organization_members', 'user_preferences']) {
      expect(argsOn(calls, t, 'gte')).toEqual([]);
    }
    // Lower bound only, as before: no upper bound on any read.
    expect(calls.filter((c) => ['lt', 'lte'].includes(c.method))).toEqual([]);
  });

  it('All time sends no gte at all', async () => {
    const { client, calls } = stubClient(TABLES);
    await getAnalyticsData(client, resolveAnalyticsPeriod({ period: 'all' }, NOW).fromIso);
    expect(calls.filter((c) => c.method === 'gte')).toEqual([]);
  });

  it('at 7d the numbers move with the period (period-driven tiles and versions), the rest do not', async () => {
    const seven = await getAnalyticsData(stubClient(TABLES).client, SEVEN.fromIso);
    const thirty = await getAnalyticsData(stubClient(TABLES).client, THIRTY.fromIso);
    // 7d: D1, D2, D3, D7, D12, D14 -> users 1, 2, 3, 6.
    expect(seven.counts.active_users.value).toBe(4);
    expect(seven.counts.active_devices.value).toBe(6);
    expect(seven.versions.data.reduce((s, v) => s + v.user_count, 0)).toBe(5);
    expect(seven.counts.total_users).toEqual(thirty.counts.total_users);
    expect(seven.counts.total_orgs).toEqual(thirty.counts.total_orgs);
    expect(seven.platform).toEqual(thirty.platform);
    expect(seven.phone).toEqual(thirty.phone);
    expect(seven.license).toEqual(thirty.license);
  });
});

describe('T1 paging past the 1000-row cap', () => {
  it('2,500 devices read exactly, over three pages, with no truncation', async () => {
    const { client, calls } = stubClient(bigTables());
    const r = await getVersionDevices(client, THIRTY.fromIso);
    expect(r.failed).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.rows).toHaveLength(2500);
    expect(new Set(r.rows.map((x) => x.id)).size).toBe(2500);
    expect(argsOn(calls, 'devices', 'range')).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('every period-driven and platform number is exact on 2,500 devices', async () => {
    const d = await getAnalyticsData(stubClient(bigTables()).client, THIRTY.fromIso);
    expect(d.counts.active_users.value).toBe(2500);
    expect(d.platform.data.reduce((s, p) => s + p.user_count, 0)).toBe(2500);
  });

  it('hitting the page ceiling sets truncated on that section only', async () => {
    const d = await getAnalyticsData(stubClient(bigTables()).client, THIRTY.fromIso, { pageSize: 500, maxPages: 2 });
    expect(d.versions.truncated).toBe(true);
    expect(d.counts.truncated).toBe(true);
    expect(d.platform.truncated).toBe(true);
    expect(d.phone.truncated).toBe(true);
    expect(d.license.truncated).toBe(true);
    const small = await getAnalyticsData(stubClient(TABLES).client, THIRTY.fromIso, { pageSize: 500, maxPages: 2 });
    expect([small.versions.truncated, small.platform.truncated, small.phone.truncated, small.license.truncated]).toEqual([
      false, false, false, false,
    ]);
  });
});

describe('T2 user_preferences has no id column', () => {
  it('31 prefs read as 31 rows through the id:user_id alias', async () => {
    const prefs = Array.from({ length: 31 }, (_, i) => ({ user_id: uuid(500 + i), preferences: { phone_type: 'iphone' } }));
    const r = await getPhonePrefs(stubClient({ user_preferences: prefs }).client, { pageSize: 10 });
    expect(r.rows).toHaveLength(31);
    expect(r.rows[0].id).toBe(uuid(500));
  });
});

describe('T4 user names: chunked lookup', () => {
  it('450 ids -> 3 in() reads of at most 200', async () => {
    const users = Array.from({ length: 450 }, (_, i) => ({ id: uuid(600 + i), email: `n${i}@example.test`, display_name: null }));
    const { client, calls } = stubClient({ users });
    const r = await getUsersByIds(client, users.map((u) => u.id));
    expect(r.failed).toBe(false);
    expect(r.users).toHaveLength(450);
    expect(argsOn(calls, 'users', 'in').map((a) => (a[1] as string[]).length)).toEqual([200, 200, 50]);
  });

  it('a failed chunk sets namesFailed; the version counts are unchanged', async () => {
    const ok = await getAnalyticsData(stubClient(TABLES).client, THIRTY.fromIso);
    const bad = await getAnalyticsData(
      stubClient(TABLES, { failWhen: (t, c) => t === 'users' && c.some((x) => x.method === 'in') }).client,
      THIRTY.fromIso
    );
    expect(bad.versions.namesFailed).toBe(true);
    expect(bad.versions.failed).toBe(false);
    expect(bad.versions.data.map((v) => [v.app_version, v.user_count, v.adoption_pct])).toEqual(
      ok.versions.data.map((v) => [v.app_version, v.user_count, v.adoption_pct])
    );
  });
});

describe('failed is not empty', () => {
  it('a devices error fails the version, platform and period tiles, never as 0 or []', async () => {
    const d = await getAnalyticsData(stubClient(TABLES, { failTables: ['devices'] }).client, THIRTY.fromIso);
    expect(d.versions.failed).toBe(true);
    expect(d.platform.failed).toBe(true);
    expect(d.counts.active_users).toEqual({ value: null, failed: true });
    expect(d.counts.active_devices).toEqual({ value: null, failed: true });
    expect(d.counts.total_users.failed).toBe(false);
  });

  it('a members error fails the licence section; a prefs error fails phone; a users count error fails that tile', async () => {
    const m = await getAnalyticsData(stubClient(TABLES, { failTables: ['organization_members'] }).client, THIRTY.fromIso);
    expect(m.license).toEqual({ data: [], failed: true, truncated: false });
    const p = await getAnalyticsData(stubClient(TABLES, { failTables: ['user_preferences'] }).client, THIRTY.fromIso);
    expect(p.phone).toEqual({ data: [], failed: true, truncated: false });
    const u = await getAnalyticsData(
      stubClient(TABLES, { failWhen: (t, c) => t === 'users' && !c.some((x) => x.method === 'in') }).client,
      THIRTY.fromIso
    );
    expect(u.counts.total_users).toEqual({ value: null, failed: true });
  });
});
