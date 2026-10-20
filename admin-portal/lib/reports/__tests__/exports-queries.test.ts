/**
 * Exports report — query tests (BACKLOG-4004)
 *
 * Asserted against a recording stub: which filters were SENT.
 */

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { EXPORT_LIMIT, getExportEvents, getExportLookups } from '../exports-queries';
import { EXPORT_ROWS, PERIOD } from './exports.fixture';

interface Call {
  table: string;
  method: string;
  args: unknown[];
}

function stubClient(rows: unknown[] = [], failTables: string[] = []) {
  const calls: Call[] = [];
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      const builder: Record<string, unknown> = {
        then(resolve: (value: unknown) => unknown) {
          const result = failTables.includes(table)
            ? { data: null, error: { message: 'boom' } }
            : { data: rows, error: null };
          return Promise.resolve(result).then(resolve);
        },
      };
      for (const method of ['select', 'eq', 'neq', 'gte', 'gt', 'lt', 'lte', 'order', 'limit', 'in', 'not', 'is', 'filter', 'or', 'contains']) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return builder;
        };
      }
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls, tables };
}

const argsFor = (calls: Call[], method: string) => calls.filter((c) => c.method === method).map((c) => c.args);

describe('getExportEvents — the period query', () => {
  it('reads analytics_events for export-completed only', async () => {
    const { client, calls, tables } = stubClient();
    await getExportEvents(client, PERIOD);
    expect(tables).toEqual(['analytics_events']);
    expect(argsFor(calls, 'eq')).toEqual([['event_name', 'export-completed']]);
  });

  it('sends the period half-open on created_at, newest first, capped at 500', async () => {
    const { client, calls } = stubClient();
    await getExportEvents(client, PERIOD);
    expect(argsFor(calls, 'gte')).toEqual([['created_at', PERIOD.fromIso]]);
    expect(argsFor(calls, 'lt')).toEqual([['created_at', PERIOD.toIso]]);
    expect(argsFor(calls, 'lte')).toEqual([]);
    expect(argsFor(calls, 'order')).toEqual([['created_at', { ascending: false }]]);
    expect(EXPORT_LIMIT).toBe(500);
    expect(argsFor(calls, 'limit')).toEqual([[500]]);
  });

  it('never filters on event_data (mode and format are counted, not filtered)', async () => {
    const { client, calls } = stubClient();
    await getExportEvents(client, PERIOD);
    const touches = calls.filter(
      (c) => c.method !== 'select' && c.args.some((a) => typeof a === 'string' && a.includes('event_data'))
    );
    expect(touches).toEqual([]);
  });

  it('flags truncation at the cap, and a failure as a failure', async () => {
    const full = stubClient(new Array(3).fill(EXPORT_ROWS[0]));
    expect((await getExportEvents(full.client, PERIOD, 3)).truncated).toBe(true);
    const under = stubClient(new Array(2).fill(EXPORT_ROWS[0]));
    expect((await getExportEvents(under.client, PERIOD, 3)).truncated).toBe(false);
    const failed = stubClient([], ['analytics_events']);
    expect(await getExportEvents(failed.client, PERIOD)).toEqual({ rows: [], failed: true, truncated: false });
  });
});

describe('getExportLookups', () => {
  it('matches memberships on user_id and does not filter on license status', async () => {
    const { client, calls } = stubClient([]);
    await getExportLookups(client, EXPORT_ROWS);
    const members = calls.filter((c) => c.table === 'organization_members');
    expect(members.filter((c) => c.method === 'in').map((c) => c.args[0])).toEqual(['user_id']);
    expect(members.some((c) => c.args.some((a) => typeof a === 'string' && a.includes('license')))).toBe(false);
  });

  it('a failed lookup sets failed', async () => {
    const { client } = stubClient([], ['organization_members']);
    expect((await getExportLookups(client, EXPORT_ROWS)).failed).toBe(true);
  });
});
