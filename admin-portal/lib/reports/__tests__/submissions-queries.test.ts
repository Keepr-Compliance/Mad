/**
 * Submissions report — query tests (BACKLOG-3715)
 *
 * Asserted against a recording stub: which filters were SENT. Every call is
 * awaited. `not` and `in` are recorded too, so "no call touches outcome"
 * catches `.neq`, `.in` and `.not` alike.
 */

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getOpenAttempts,
  getSubmissionAttempts,
  OPEN_ATTEMPT_LIMIT,
  SUBMISSION_LIMIT,
} from '../submissions-queries';
import { resolvePeriod } from '../period';

interface Call {
  method: string;
  args: unknown[];
}

const NOW = new Date('2026-10-04T20:00:00.000Z');
const THIS_WEEK = resolvePeriod({}, NOW);

function stubClient(rows: unknown[] = []) {
  const calls: Call[] = [];
  const tables: string[] = [];
  const builder: Record<string, unknown> = {
    then(resolve: (value: { data: unknown; error: null }) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    },
  };
  for (const method of ['select', 'eq', 'neq', 'gte', 'gt', 'lt', 'lte', 'order', 'limit', 'in', 'not', 'is', 'filter', 'or']) {
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

const argsFor = (calls: Call[], method: string) => calls.filter((c) => c.method === method).map((c) => c.args);

describe('getSubmissionAttempts — the period query', () => {
  it('NEVER filters on outcome, so in_progress rows are counted (C1)', async () => {
    const { client, calls, tables } = stubClient();
    await getSubmissionAttempts(client, THIS_WEEK);
    expect(tables).toEqual(['submission_attempts']);
    const touchesOutcome = calls.filter(
      (c) => c.method !== 'select' && c.args.some((a) => typeof a === 'string' && a.includes('outcome'))
    );
    expect(touchesOutcome).toEqual([]);
  });

  it('sends the period half-open on started_at, newest first, capped', async () => {
    const { client, calls } = stubClient();
    await getSubmissionAttempts(client, THIS_WEEK);
    expect(argsFor(calls, 'gte')).toEqual([['started_at', THIS_WEEK.fromIso]]);
    expect(argsFor(calls, 'lt')).toEqual([['started_at', THIS_WEEK.toIso]]);
    expect(argsFor(calls, 'order')).toEqual([['started_at', { ascending: false }]]);
    expect(argsFor(calls, 'limit')).toEqual([[SUBMISSION_LIMIT]]);
  });

  it('reports truncation at the cap', async () => {
    const { client } = stubClient([{}, {}]);
    expect((await getSubmissionAttempts(client, THIS_WEEK, 2)).truncated).toBe(true);
    expect((await getSubmissionAttempts(client, THIS_WEEK, 3)).truncated).toBe(false);
  });
});

describe('getOpenAttempts — the open-attempts query', () => {
  it('has NO period: no started_at bound of any kind (C1b)', async () => {
    const { client, calls } = stubClient();
    await getOpenAttempts(client);
    const bounds = calls.filter((c) => ['gte', 'gt', 'lt', 'lte'].includes(c.method));
    expect(bounds).toEqual([]);
  });

  it('reads in_progress only, OLDEST first, capped', async () => {
    const { client, calls } = stubClient();
    await getOpenAttempts(client);
    expect(argsFor(calls, 'eq')).toEqual([['outcome', 'in_progress']]);
    expect(argsFor(calls, 'order')).toEqual([['started_at', { ascending: true }]]);
    expect(argsFor(calls, 'limit')).toEqual([[OPEN_ATTEMPT_LIMIT]]);
  });
});
