/**
 * iPhone Sync Performance — query tests (BACKLOG-3441)
 *
 * The derivation is filtered too, and it is the filter that makes the model
 * correct. This one is about the WINDOW: rows come back newest-first under a
 * 200-row cap, and runs in flight are the newest rows there are. Without
 * `neq('outcome', 'running')` a burst of live syncs fills the cap and pushes
 * finished runs off the page — invisible in the derivation tests, because by
 * then the rows are simply not there.
 *
 * Asserted against a recording stub rather than a network: this file is about
 * which filters were sent, and nothing else.
 */

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getIphoneSyncRuns, RUN_LIMIT } from '../iphone-sync-queries';

interface Call {
  method: string;
  args: unknown[];
}

/**
 * Minimal stand-in for the PostgREST builder: every method records its call and
 * returns `this`, and the builder itself is awaitable because the code under
 * test awaits the end of the chain.
 */
function stubClient(rows: unknown[] = []) {
  const calls: Call[] = [];
  const tables: string[] = [];

  const builder: Record<string, unknown> = {
    then(resolve: (value: { data: unknown; error: null }) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    },
  };
  for (const method of ['select', 'eq', 'neq', 'order', 'limit', 'in']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
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

function argsFor(calls: Call[], method: string): unknown[][] {
  return calls.filter((c) => c.method === method).map((c) => c.args);
}

describe('getIphoneSyncRuns', () => {
  it('asks the database to exclude runs that have not finished', () => {
    const { client, calls } = stubClient();
    void getIphoneSyncRuns(client);

    expect(argsFor(calls, 'neq')).toContainEqual(['outcome', 'running']);
  });

  it('still reads iPhone runs only, newest first, under the cap', () => {
    const { client, calls, tables } = stubClient();
    void getIphoneSyncRuns(client);

    expect(tables[0]).toBe('sync_outcomes');
    expect(argsFor(calls, 'eq')).toContainEqual(['source', 'iphone-backup']);
    expect(argsFor(calls, 'order')).toContainEqual(['created_at', { ascending: false }]);
    expect(argsFor(calls, 'limit')).toContainEqual([RUN_LIMIT]);
  });

  it('reports a query failure as a failure rather than as an empty table', async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            neq: () => ({
              order: () => ({
                limit: () =>
                  Promise.resolve({ data: null, error: { message: 'permission denied' } }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await getIphoneSyncRuns(client);
    expect(result.failed).toBe(true);
    expect(result.rows).toEqual([]);
  });
});
