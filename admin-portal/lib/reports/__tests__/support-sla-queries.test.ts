/**
 * Support analytics query tests (BACKLOG-3651)
 *
 * A recording stub asserts which filters were SENT. The truncation stub models
 * PostgREST max_rows: it never returns more than 1000 rows, whatever limit is
 * asked for — the way the hosted API behaves (supabase/config.toml max_rows).
 */

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getOpenTicketCount,
  getSupportTickets,
  periodOrFilter,
  POSTGREST_MAX_ROWS,
  SUPPORT_TICKET_LIMIT,
} from '../support-sla-queries';
import { lastDays } from '../support-sla';
import { NOW } from './support-sla.fixture';

interface Call {
  method: string;
  args: unknown[];
}

const D30 = lastDays(30, NOW);

/** Stub that returns min(requested limit, serverMaxRows) rows from `pool`. */
function stubClient(opts: { pool?: unknown[]; serverMaxRows?: number; error?: boolean; count?: number } = {}) {
  const { pool = [], serverMaxRows = POSTGREST_MAX_ROWS, error = false, count = 0 } = opts;
  const calls: Call[] = [];
  const tables: string[] = [];
  let requested = Infinity;
  let head = false;
  const builder: Record<string, unknown> = {
    then(resolve: (value: unknown) => unknown) {
      if (error) return Promise.resolve({ data: null, count: null, error: { message: 'boom' } }).then(resolve);
      if (head) return Promise.resolve({ data: null, count, error: null }).then(resolve);
      const n = Math.min(requested, serverMaxRows, pool.length);
      return Promise.resolve({ data: pool.slice(0, n), error: null }).then(resolve);
    },
  };
  for (const method of ['select', 'eq', 'neq', 'gte', 'gt', 'lt', 'lte', 'order', 'limit', 'in', 'not', 'is', 'filter', 'or']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      if (method === 'limit') requested = args[0] as number;
      if (method === 'select' && (args[1] as { head?: boolean } | undefined)?.head) head = true;
      return builder;
    };
  }
  const client = {
    from(table: string) {
      tables.push(table);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls, tables };
}

const argsFor = (calls: Call[], method: string) => calls.filter((c) => c.method === method).map((c) => c.args);

describe('getSupportTickets — row cap vs PostgREST max_rows (SR change 1)', () => {
  it('the cap does not exceed max_rows', () => {
    expect(SUPPORT_TICKET_LIMIT).toBeLessThanOrEqual(POSTGREST_MAX_ROWS);
  });

  it('with more matching rows than the server returns, truncated is TRUE', async () => {
    const pool = Array.from({ length: 1500 }, (_, i) => ({ id: String(i) }));
    const { client } = stubClient({ pool });
    const result = await getSupportTickets(client, D30);
    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it('fewer rows than the cap: not truncated', async () => {
    const { client } = stubClient({ pool: Array.from({ length: 107 }, (_, i) => ({ id: String(i) })) });
    const result = await getSupportTickets(client, D30);
    expect(result.rows).toHaveLength(107);
    expect(result.truncated).toBe(false);
  });
});

describe('getSupportTickets — filters sent (SR change 2)', () => {
  it('excludes deleted and keeps open OR created/resolved/closed in [from, to)', async () => {
    const { client, calls, tables } = stubClient();
    await getSupportTickets(client, D30);
    expect(tables).toEqual(['support_tickets']);
    expect(argsFor(calls, 'neq')).toEqual([['status', 'deleted']]);
    expect(argsFor(calls, 'or')).toEqual([[periodOrFilter(D30)]]);
    expect(periodOrFilter(D30)).toBe(
      [
        'status.not.in.(resolved,closed,deleted)',
        `and(created_at.gte.${D30.fromIso},created_at.lt.${D30.toIso})`,
        `and(resolved_at.gte.${D30.fromIso},resolved_at.lt.${D30.toIso})`,
        `and(closed_at.gte.${D30.fromIso},closed_at.lt.${D30.toIso})`,
      ].join(',')
    );
    expect(argsFor(calls, 'limit')).toEqual([[SUPPORT_TICKET_LIMIT]]);
  });

  it('a failed query reports failed, never an empty success (C5)', async () => {
    const { client } = stubClient({ error: true });
    expect(await getSupportTickets(client, D30)).toEqual({ rows: [], failed: true, truncated: false });
  });
});

describe('getOpenTicketCount', () => {
  it('is an exact head count of tickets not resolved, closed or deleted', async () => {
    const { client, calls } = stubClient({ count: 76 });
    expect(await getOpenTicketCount(client)).toBe(76);
    expect(argsFor(calls, 'select')).toEqual([['id', { count: 'exact', head: true }]]);
    expect(argsFor(calls, 'not')).toEqual([['status', 'in', '(resolved,closed,deleted)']]);
  });

  it('a failed count returns null', async () => {
    const { client } = stubClient({ error: true });
    expect(await getOpenTicketCount(client)).toBeNull();
  });
});
