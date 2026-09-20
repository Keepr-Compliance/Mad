/**
 * iPhone Sync Performance — query tests (BACKLOG-3441, BACKLOG-3450)
 *
 * Two separate jobs are asserted here, and neither is visible in the
 * derivation tests.
 *
 * 1. The `running` exclusion keeps the WINDOW meaningful: rows come back
 *    newest-first under a 200-row cap, and runs in flight are the newest rows
 *    there are. Without it a burst of live syncs fills the cap and pushes
 *    finished runs off the page.
 *
 * 2. THE PERIOD REACHES THE DATABASE. This is the one the rest of the suite
 *    cannot see: if the range is resolved, labelled, rendered in the caption
 *    and then never sent, every row comes back, all three client consumers
 *    filter identically, and the page looks correct while being silently
 *    unfiltered. Only an assertion on what was SENT catches it.
 *
 * Asserted against a recording stub rather than a network: this file is about
 * which filters were sent, and nothing else. Every call is AWAITED — a
 * fire-and-forget `void` turns a throw inside the chain into an unhandled
 * rejection and records its assertions before the throw, so it can stay green
 * over a broken chain.
 */

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getIphoneSyncRuns, RUN_LIMIT } from '../iphone-sync-queries';
import { resolvePeriod, type PeriodRange } from '../period';

interface Call {
  method: string;
  args: unknown[];
}

/** Saturday 2026-09-19 22:07 UTC — the same instant `period.test.ts` pins. */
const NOW = new Date('2026-09-19T22:07:00.000Z');
const THIS_WEEK: PeriodRange = resolvePeriod({}, NOW);

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
  for (const method of ['select', 'eq', 'neq', 'gte', 'lt', 'order', 'limit', 'in']) {
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
  it('asks the database to exclude runs that have not finished', async () => {
    const { client, calls } = stubClient();
    await getIphoneSyncRuns(client, THIS_WEEK);

    expect(argsFor(calls, 'neq')).toContainEqual(['outcome', 'running']);
  });

  it('SENDS THE RESOLVED PERIOD to the database, half-open on created_at', async () => {
    const { client, calls } = stubClient();
    await getIphoneSyncRuns(client, THIS_WEEK);

    expect(argsFor(calls, 'gte')).toContainEqual(['created_at', THIS_WEEK.fromIso]);
    expect(argsFor(calls, 'lt')).toContainEqual(['created_at', THIS_WEEK.toIso]);
    // Not a hardcoded default: a different period sends different bounds.
    expect(THIS_WEEK.fromIso).toBe('2026-09-14T00:00:00.000Z');
  });

  it('sends the bounds of whichever period it is handed, not a fixed window', async () => {
    const lastMonth = resolvePeriod({ period: 'last-month' }, NOW);
    const { client, calls } = stubClient();
    await getIphoneSyncRuns(client, lastMonth);

    expect(argsFor(calls, 'gte')).toContainEqual(['created_at', '2026-08-01T00:00:00.000Z']);
    expect(argsFor(calls, 'lt')).toContainEqual(['created_at', '2026-09-01T00:00:00.000Z']);
    expect(argsFor(calls, 'gte')).not.toContainEqual(['created_at', THIS_WEEK.fromIso]);
  });

  it('still reads iPhone runs only, newest first, under the cap', async () => {
    const { client, calls, tables } = stubClient();
    await getIphoneSyncRuns(client, THIS_WEEK);

    expect(tables[0]).toBe('sync_outcomes');
    expect(argsFor(calls, 'eq')).toContainEqual(['source', 'iphone-backup']);
    expect(argsFor(calls, 'order')).toContainEqual(['created_at', { ascending: false }]);
    expect(argsFor(calls, 'limit')).toContainEqual([RUN_LIMIT]);
  });

  it('reads the run-evidence columns BACKLOG-3440 writes', async () => {
    const { client, calls } = stubClient();
    await getIphoneSyncRuns(client, THIS_WEEK);

    const selected = String(argsFor(calls, 'select')[0][0]);
    for (const column of [
      'started_at',
      'bytes_transferred',
      'bytes_last_increased_at',
      'last_phase',
      'reason_code',
      'ended_by',
    ]) {
      expect(selected).toContain(column);
    }
  });

  it('says the window was TRUNCATED when the cap was reached, and not when it was not', async () => {
    const atCap = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, user_id: null }));
    const capped = await getIphoneSyncRuns(stubClient(atCap).client, THIS_WEEK, 3);
    expect(capped.truncated).toBe(true);

    const under = await getIphoneSyncRuns(stubClient(atCap).client, THIS_WEEK, 10);
    expect(under.truncated).toBe(false);
  });

  it('reports a query failure as a failure rather than as an empty table', async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            neq: () => ({
              gte: () => ({
                lt: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({ data: null, error: { message: 'permission denied' } }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await getIphoneSyncRuns(client, THIS_WEEK);
    expect(result.failed).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
