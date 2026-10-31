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
  getSupportSlaSettings,
  getSupportTickets,
  parseSupportSlaSettings,
  periodOrFilter,
  POSTGREST_MAX_ROWS,
  SLA_SETTINGS_COLUMNS,
  SUPPORT_TICKET_LIMIT,
} from '../support-sla-queries';
import { TEST_SETTINGS } from './support-sla-attainment.fixture';
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
  let single = false;
  const builder: Record<string, unknown> = {
    then(resolve: (value: unknown) => unknown) {
      if (error) return Promise.resolve({ data: null, count: null, error: { message: 'boom' } }).then(resolve);
      if (head) return Promise.resolve({ data: null, count, error: null }).then(resolve);
      // maybeSingle(): one row or null, never an array (PostgREST behaviour).
      if (single) return Promise.resolve({ data: pool[0] ?? null, error: null }).then(resolve);
      const n = Math.min(requested, serverMaxRows, pool.length);
      return Promise.resolve({ data: pool.slice(0, n), error: null }).then(resolve);
    },
  };
  for (const method of ['select', 'eq', 'neq', 'gte', 'gt', 'lt', 'lte', 'order', 'limit', 'in', 'not', 'is', 'filter', 'or', 'maybeSingle']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      if (method === 'maybeSingle') single = true;
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

describe('getSupportSlaSettings (BACKLOG-4086)', () => {
  const DB_ROW = {
    first_response_target_minutes: 480,
    resolution_target_business_days: 3,
    business_day_start_minute: 540,
    business_day_end_minute: 1020,
    business_days: [1, 2, 3, 4, 5],
    time_zone: 'America/Los_Angeles',
  };

  it('reads one row of support_sla_settings with the six columns and maps it', async () => {
    const { client, calls, tables } = stubClient({ pool: [DB_ROW] });
    expect(await getSupportSlaSettings(client)).toEqual(TEST_SETTINGS);
    expect(tables).toEqual(['support_sla_settings']);
    expect(argsFor(calls, 'select')).toEqual([[SLA_SETTINGS_COLUMNS]]);
    expect(SLA_SETTINGS_COLUMNS.split(', ').sort()).toEqual(Object.keys(DB_ROW).sort());
    expect(argsFor(calls, 'maybeSingle')).toEqual([[]]);
  });

  it('non-default values pass through (a 60-minute target)', async () => {
    const { client } = stubClient({ pool: [{ ...DB_ROW, first_response_target_minutes: 60 }] });
    expect((await getSupportSlaSettings(client))?.firstResponseTargetMinutes).toBe(60);
  });

  it('a failed read is null, never code defaults', async () => {
    const { client } = stubClient({ error: true });
    expect(await getSupportSlaSettings(client)).toBeNull();
  });

  it('no row is null', async () => {
    const { client } = stubClient({ pool: [] });
    expect(await getSupportSlaSettings(client)).toBeNull();
  });

  it('an unknown time zone is null', async () => {
    const { client } = stubClient({ pool: [{ ...DB_ROW, time_zone: 'Mars/Olympus_Mons' }] });
    expect(await getSupportSlaSettings(client)).toBeNull();
  });

  it.each([
    ['target 0', { first_response_target_minutes: 0 }],
    ['days 0', { resolution_target_business_days: 0 }],
    ['end <= start', { business_day_end_minute: 540 }],
    ['start out of range', { business_day_start_minute: -1 }],
    ['end out of range', { business_day_end_minute: 1441 }],
    ['weekday 7', { business_days: [1, 7] }],
    ['no weekdays', { business_days: [] }],
    ['non-integer target', { first_response_target_minutes: 1.5 }],
    ['string target', { first_response_target_minutes: '480' }],
  ])('a value outside the table CHECKs is null: %s', (_label, patch) => {
    expect(parseSupportSlaSettings({ ...DB_ROW, ...patch })).toBeNull();
  });
});
