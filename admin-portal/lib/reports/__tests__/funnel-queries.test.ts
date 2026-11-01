/**
 * Paywall Funnel — query tests (BACKLOG-3722)
 *
 * The stub behaves like PostgREST, so a wrong query fails on BEHAVIOUR, not
 * only on its call shape:
 *   - `.select(cols)` PROJECTS each row to those columns (drop `id` and the
 *     pager's dedupe has nothing to key on);
 *   - `.in` / `.gte` / `.lt` FILTER;
 *   - `.order()` sorts, and rows still tied after every supplied order come
 *     back in a DIFFERENT arbitrary order on every request — a non-total
 *     order is not stable across pages, exactly as on the server;
 *   - `.range(from, to)` slices.
 */

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeFunnel, FUNNEL_STEP_EVENTS, type FunnelEventRow, type FunnelResult } from '@/lib/funnel-analytics';
import { FUNNEL_EVENT_COLUMNS, getFunnelEvents } from '../funnel-queries';
import { resolveFunnelPeriod } from '../funnel-period';
import {
  ALL_TIME_EXPECTED,
  ALL_TIME_ROWS,
  LAST_30_EXPECTED,
  LAST_30_ROWS,
  NOISE_ROWS,
  NOW,
  uuid,
  type FixtureRow,
} from './funnel.fixture';

interface Call {
  method: string;
  args: unknown[];
}

/** FNV-1a: a deterministic per-request shuffle key. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function stubClient(table: FixtureRow[], opts: { fail?: boolean } = {}) {
  const calls: Call[] = [];
  let request = 0;
  const client = {
    from(name: string) {
      const filters: ((r: FixtureRow) => boolean)[] = [];
      const orders: { col: string; asc: boolean }[] = [];
      let columns: string[] | null = null;
      let range: [number, number] | null = null;
      const builder: Record<string, unknown> = {
        then(resolve: (value: unknown) => unknown) {
          if (opts.fail) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve);
          const req = request;
          request += 1;
          const rows = name === 'analytics_events' ? table.filter((r) => filters.every((f) => f(r))) : [];
          const sorted = [...rows].sort((a, b) => {
            for (const o of orders) {
              const av = String(a[o.col]);
              const bv = String(b[o.col]);
              if (av !== bv) return (av < bv ? -1 : 1) * (o.asc ? 1 : -1);
            }
            return hash(`${req}:${a.id}`) - hash(`${req}:${b.id}`);
          });
          const page = range ? sorted.slice(range[0], range[1] + 1) : sorted;
          const projected = columns
            ? page.map((r) => Object.fromEntries(columns!.filter((c) => c in r).map((c) => [c, r[c]])))
            : page;
          return Promise.resolve({ data: projected, error: null }).then(resolve);
        },
      };
      const record = (method: string, fn: (...args: unknown[]) => void) => {
        builder[method] = (...args: unknown[]) => {
          calls.push({ method, args });
          fn(...args);
          return builder;
        };
      };
      record('select', (cols) => {
        columns = String(cols)
          .split(',')
          .map((c) => c.trim());
      });
      record('in', (col, values) => filters.push((r) => (values as unknown[]).includes(r[col as string])));
      record('gte', (col, v) => filters.push((r) => String(r[col as string]) >= String(v)));
      record('lt', (col, v) => filters.push((r) => String(r[col as string]) < String(v)));
      record('order', (col, o) =>
        orders.push({ col: col as string, asc: (o as { ascending?: boolean } | undefined)?.ascending !== false })
      );
      record('range', (from, to) => {
        range = [from as number, to as number];
      });
      for (const m of ['eq', 'gt', 'lte', 'limit']) record(m, () => undefined);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const argsFor = (calls: Call[], method: string) => calls.filter((c) => c.method === method).map((c) => c.args);

/**
 * 2,500 funnel rows; every THREE share one created_at, so the tie groups at
 * indices 999-1001 and 1998-2000 straddle the 1000-row page boundaries.
 */
function tiedRows(n: number): FixtureRow[] {
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  return Array.from({ length: n }, (_, i) => ({
    id: uuid(10_000 + i),
    user_id: uuid((i % 50) + 1),
    event_name: FUNNEL_STEP_EVENTS[i % 4],
    created_at: new Date(base + Math.floor(i / 3) * 1000).toISOString(),
  }));
}

const THIRTY = resolveFunnelPeriod({}, NOW);
const ALL = resolveFunnelPeriod({ period: 'all' }, NOW);

describe('query shape (R2)', () => {
  it('selects exactly id, event_name, user_id; filters the four funnel events; orders created_at then id', async () => {
    const { client, calls } = stubClient([]);
    await getFunnelEvents(client, THIRTY);
    expect(argsFor(calls, 'select')).toEqual([['id, event_name, user_id']]);
    expect(FUNNEL_EVENT_COLUMNS).toBe('id, event_name, user_id');
    expect(argsFor(calls, 'in')).toEqual([['event_name', [...FUNNEL_STEP_EVENTS]]]);
    expect(argsFor(calls, 'order')).toEqual([
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ]);
  });

  it('a preset sends the period half-open on created_at', async () => {
    const { client, calls } = stubClient([]);
    await getFunnelEvents(client, THIRTY);
    expect(argsFor(calls, 'gte')).toEqual([['created_at', '2026-09-30T12:00:00.000Z']]);
    expect(argsFor(calls, 'lt')).toEqual([['created_at', NOW.toISOString()]]);
  });

  it('All time sends NO lower bound, and the upper bound now', async () => {
    const { client, calls } = stubClient([]);
    await getFunnelEvents(client, ALL);
    expect(argsFor(calls, 'gte')).toEqual([]);
    expect(argsFor(calls, 'lt')).toEqual([['created_at', NOW.toISOString()]]);
  });
});

describe('paging past the 1000-row limit (T1)', () => {
  it('reads all 2,500 rows in 1000-row pages, each exactly once, in (created_at, id) order', async () => {
    const rows = tiedRows(2500);
    const { client, calls } = stubClient(rows);
    const result = await getFunnelEvents(client, ALL);
    expect(argsFor(calls, 'range')).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    expect(result.failed).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.rows.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(computeFunnel(result.rows)).toEqual(computeFunnel(rows));
  });
});

describe('ceiling and failure (T2, T3)', () => {
  it('reaching the page ceiling with full pages sets truncated', async () => {
    const { client } = stubClient(tiedRows(25));
    const result = await getFunnelEvents(client, ALL, 10, 2);
    expect(result.rows).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  it('under the ceiling is not truncated', async () => {
    const { client } = stubClient(tiedRows(15));
    const result = await getFunnelEvents(client, ALL, 10, 2);
    expect(result.rows).toHaveLength(15);
    expect(result.truncated).toBe(false);
  });

  it('a failed page is a failure with no rows, not an empty funnel', async () => {
    const { client } = stubClient(ALL_TIME_ROWS, { fail: true });
    expect(await getFunnelEvents(client, ALL)).toEqual({ rows: [], failed: true, truncated: false });
  });
});

/**
 * The read this PR replaced (lib/funnel-queries.ts getPaywallFunnel at
 * ac97b15b3), copied verbatim minus logging, as the parity reference.
 */
async function legacyGetPaywallFunnel(
  supabase: SupabaseClient,
  range: { from: string | null; to: string | null }
): Promise<FunnelResult> {
  let query = supabase.from('analytics_events').select('event_name, user_id').in('event_name', [...FUNNEL_STEP_EVENTS]);
  if (range.from) query = query.gte('created_at', range.from);
  if (range.to) query = query.lt('created_at', range.to);
  const { data, error } = await query;
  if (error || !data) return computeFunnel([]);
  return computeFunnel(data as FunnelEventRow[]);
}

describe('parity (T5)', () => {
  const pick = (r: FunnelResult) => ({
    userCounts: r.steps.map((s) => s.userCount),
    conversionFromPrev: r.steps.map((s) => s.conversionFromPrev),
    conversionFromTop: r.steps.map((s) => s.conversionFromTop),
    exceedsPrevious: r.steps.map((s) => s.exceedsPrevious),
  });

  it('(a) maths pin: computeFunnel on the production shapes', () => {
    expect(pick(computeFunnel(ALL_TIME_ROWS))).toEqual(ALL_TIME_EXPECTED);
    expect(pick(computeFunnel(LAST_30_ROWS))).toEqual(LAST_30_EXPECTED);
  });

  it('(b) the old single read and the new paged read agree, with off-funnel and out-of-period rows present', async () => {
    const table = [...LAST_30_ROWS, ...NOISE_ROWS];
    const legacy = await legacyGetPaywallFunnel(stubClient(table).client, {
      from: THIRTY.fromIso,
      to: THIRTY.toIso,
    });
    const paged = await getFunnelEvents(stubClient(table).client, THIRTY);
    expect(computeFunnel(paged.rows)).toEqual(legacy);
    // The filters did work: the noise would change the counts.
    expect(pick(legacy)).toEqual(LAST_30_EXPECTED);
    expect(pick(computeFunnel(table))).not.toEqual(LAST_30_EXPECTED);
  });

  it('(b) All time: the old read with no bounds and the new read agree on the all-time shape', async () => {
    const table = [...ALL_TIME_ROWS, ...LAST_30_ROWS];
    const legacy = await legacyGetPaywallFunnel(stubClient(table).client, { from: null, to: null });
    const paged = await getFunnelEvents(stubClient(table).client, ALL);
    expect(computeFunnel(paged.rows)).toEqual(legacy);
  });
});
