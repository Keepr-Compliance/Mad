/**
 * User Activity report — query tests (BACKLOG-3720)
 *
 * A recording stub that behaves like PostgREST paging: it SORTS its table by
 * the `.order()` calls it was sent, then SLICES by the `.range(from, to)`
 * arguments. A page is therefore what the arguments ask for — an off-by-one
 * offset skips or repeats a real row instead of passing unnoticed.
 */

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  EVENT_COLUMNS,
  fetchAllPages,
  getActivityEvents,
  getActivityUsers,
  getStaffIds,
} from '../user-activity-queries';
import { LAST_WEEK } from './user-activity.fixture';

interface Call {
  table: string;
  method: string;
  args: unknown[];
}

type Row = Record<string, unknown> & { id: string };

interface StubOptions {
  tables?: Record<string, Row[]>;
  failTables?: string[];
  rpc?: Record<string, { data: unknown; error: unknown }>;
  /** Called after each page is served, with the 0-based page number. */
  afterPage?: (table: string, page: number, rows: Row[]) => void;
}

function stubClient(opts: StubOptions = {}) {
  const calls: Call[] = [];
  const pagesServed: Record<string, number> = {};
  const client = {
    rpc(name: string, args: unknown) {
      calls.push({ table: 'rpc', method: name, args: [args] });
      return Promise.resolve(opts.rpc?.[name] ?? { data: null, error: { message: 'no stub' } });
    },
    from(table: string) {
      const orders: { col: string; asc: boolean }[] = [];
      let range: [number, number] | null = null;
      const builder: Record<string, unknown> = {
        then(resolve: (value: unknown) => unknown) {
          if (opts.failTables?.includes(table)) {
            return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve);
          }
          const rows = opts.tables?.[table] ?? [];
          const sorted = [...rows].sort((a, b) => {
            for (const o of orders) {
              const av = String(a[o.col]);
              const bv = String(b[o.col]);
              if (av !== bv) return (av < bv ? -1 : 1) * (o.asc ? 1 : -1);
            }
            return 0;
          });
          const page = range ? sorted.slice(range[0], range[1] + 1) : sorted;
          const n = pagesServed[table] ?? 0;
          pagesServed[table] = n + 1;
          opts.afterPage?.(table, n, rows);
          return Promise.resolve({ data: page, error: null }).then(resolve);
        },
      };
      for (const method of ['select', 'eq', 'gte', 'gt', 'lt', 'lte', 'in', 'limit', 'order', 'range']) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          if (method === 'order') {
            const o = (args[1] as { ascending?: boolean } | undefined) ?? {};
            orders.push({ col: args[0] as string, asc: o.ascending !== false });
          }
          if (method === 'range') range = [args[0] as number, args[1] as number];
          return builder;
        };
      }
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls, pagesServed };
}

const argsFor = (calls: Call[], method: string, table = 'audit_logs') =>
  calls.filter((c) => c.method === method && c.table === table).map((c) => c.args);

/** n events, created_at strictly increasing, ids zero-padded so string order = numeric order. */
function events(n: number): Row[] {
  const base = Date.parse('2026-10-19T00:00:00.000Z');
  return Array.from({ length: n }, (_, i) => ({
    id: `e-${String(i).padStart(6, '0')}`,
    user_id: 'u',
    action: 'TRANSACTION_UPDATE',
    resource_type: 'TRANSACTION',
    resource_id: 'r',
    created_at: new Date(base + i * 1000).toISOString(),
  }));
}

describe('getActivityEvents — the period query (C4, C6)', () => {
  it('sends the period half-open on created_at', async () => {
    const { client, calls } = stubClient();
    await getActivityEvents(client, LAST_WEEK);
    expect(argsFor(calls, 'gte')).toEqual([['created_at', LAST_WEEK.fromIso]]);
    expect(argsFor(calls, 'lt')).toEqual([['created_at', LAST_WEEK.toIso]]);
    expect(argsFor(calls, 'gt')).toEqual([]);
    expect(argsFor(calls, 'lte')).toEqual([]);
  });

  it('orders ascending on created_at with id as the tiebreak (shape only)', async () => {
    const { client, calls } = stubClient();
    await getActivityEvents(client, LAST_WEEK);
    expect(argsFor(calls, 'order')).toEqual([
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ]);
  });

  it('never selects metadata', async () => {
    const { client, calls } = stubClient();
    await getActivityEvents(client, LAST_WEEK);
    expect(argsFor(calls, 'select')).toEqual([[EVENT_COLUMNS]]);
    expect(EVENT_COLUMNS).not.toContain('metadata');
    expect(EVENT_COLUMNS).toContain('resource_type');
    expect(EVENT_COLUMNS).toContain('resource_id');
  });
});

describe('paging (C5)', () => {
  it('reads every row of a 2344-row table in 1000-row pages, each exactly once', async () => {
    const rows = events(2344);
    const { client, calls } = stubClient({ tables: { audit_logs: rows } });
    const result = await getActivityEvents(client, LAST_WEEK);
    expect(argsFor(calls, 'range')).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    expect(result.failed).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(2344);
    expect(result.rows.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it('a table of exactly one full page reads a second, empty page and stops', async () => {
    const { client, calls } = stubClient({ tables: { audit_logs: events(1000) } });
    const result = await getActivityEvents(client, LAST_WEEK);
    expect(argsFor(calls, 'range')).toHaveLength(2);
    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(false);
  });

  it('the lookups page too (users past 1000 are not dropped)', async () => {
    const users = Array.from({ length: 1500 }, (_, i) => ({ id: `u-${String(i).padStart(6, '0')}` }));
    const { client, calls } = stubClient({ tables: { users } });
    const result = await getActivityUsers(client);
    expect(result.rows).toHaveLength(1500);
    expect(argsFor(calls, 'range', 'users')).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(argsFor(calls, 'order', 'users')).toEqual([
      ['id', { ascending: true }],
      ['id', { ascending: true }],
    ]);
    expect(argsFor(calls, 'in', 'users')).toEqual([]);
  });
});

describe('a row arriving mid-read (C5b)', () => {
  it('no row is repeated or skipped when a new event lands between pages', async () => {
    const rows = events(2344);
    const original = rows.map((r) => r.id);
    const { client } = stubClient({
      tables: { audit_logs: rows },
      afterPage: (table, page, live) => {
        // A newly arrived row has the newest created_at (arrival time).
        if (table === 'audit_logs' && page === 0) {
          live.push({ ...live[0], id: 'e-new', created_at: '2026-10-25T23:59:59.000Z' });
        }
      },
    });
    const result = await getActivityEvents(client, LAST_WEEK);
    const ids = result.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of original) expect(ids).toContain(id);
  });
});

describe('page ceiling and failure (C7, C8)', () => {
  it('reaching the page ceiling with full pages sets truncated', async () => {
    const { client } = stubClient({ tables: { audit_logs: events(30) } });
    const result = await getActivityEvents(client, LAST_WEEK, 10, 2);
    expect(result.rows).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  it('under the ceiling is not truncated', async () => {
    const { client } = stubClient({ tables: { audit_logs: events(15) } });
    const result = await getActivityEvents(client, LAST_WEEK, 10, 2);
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(15);
  });

  it('a failed page is a failure with no rows, not a zero', async () => {
    const { client } = stubClient({ failTables: ['audit_logs'] });
    expect(await getActivityEvents(client, LAST_WEEK)).toEqual({ rows: [], failed: true, truncated: false });
  });

  it('a failure on a later page discards the earlier pages', async () => {
    let n = 0;
    const result = await fetchAllPages<{ id: string }>(
      () => {
        n += 1;
        return Promise.resolve(
          n === 1
            ? { data: [{ id: 'a' }, { id: 'b' }], error: null }
            : { data: null, error: { message: 'boom' } }
        );
      },
      'test',
      2,
      5
    );
    expect(result).toEqual({ rows: [], failed: true, truncated: false });
  });
});

describe('staff lookup (C18)', () => {
  const roles = { internal_roles: [{ id: 'r1', user_id: 'staff-1' }, { id: 'r2', user_id: 'staff-2' }] };

  it('a super admin gets the whole list and it is complete', async () => {
    const { client, calls } = stubClient({
      tables: roles,
      rpc: { is_super_admin: { data: true, error: null } },
    });
    const r = await getStaffIds(client, 'viewer');
    expect(r.complete).toBe(true);
    expect([...r.staffIds].sort()).toEqual(['staff-1', 'staff-2']);
    expect(calls.find((c) => c.table === 'rpc')).toEqual({
      table: 'rpc',
      method: 'is_super_admin',
      args: [{ check_user_id: 'viewer' }],
    });
  });

  it('a non-super-admin is never told the list is complete', async () => {
    const { client } = stubClient({ tables: roles, rpc: { is_super_admin: { data: false, error: null } } });
    expect((await getStaffIds(client, 'viewer')).complete).toBe(false);
  });

  it('an rpc error or a failed read is not complete', async () => {
    const rpcErr = stubClient({ tables: roles, rpc: { is_super_admin: { data: null, error: { message: 'x' } } } });
    expect((await getStaffIds(rpcErr.client, 'viewer')).complete).toBe(false);
    const readErr = stubClient({ failTables: ['internal_roles'], rpc: { is_super_admin: { data: true, error: null } } });
    expect((await getStaffIds(readErr.client, 'viewer')).complete).toBe(false);
  });
});
