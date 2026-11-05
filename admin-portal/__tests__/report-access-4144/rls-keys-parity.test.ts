/**
 * BACKLOG-4144 M2: the event names and sync sources the RLS policies key on equal the ones the
 * report queries read. A funnel step or source added in code but not in the migration reads as
 * zero rows for every viewer, Super Admins included, with no other test going red.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { FUNNEL_STEP_EVENTS } from '@/lib/funnel-analytics';
import { EXPORT_EVENT_NAME } from '@/lib/reports/exports';
import { GM_SOURCE } from '@/lib/reports/google-messages-sync';

const MIGRATION = path.resolve(
  __dirname,
  '../../../supabase/migrations/20261105110000_backlog_4144_report_rls.sql'
);
const IPHONE_QUERIES = path.resolve(__dirname, '../../lib/reports/iphone-sync-queries.ts');

function policy(name: string): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf(`ALTER POLICY ${name}`);
  if (start < 0) throw new Error(`policy ${name} not found in the M2 migration`);
  const end = sql.indexOf('COMMENT ON POLICY', start);
  return sql.slice(start, end);
}

describe('M2 RLS keys == report queries', () => {
  it('funnel branch lists exactly FUNNEL_STEP_EVENTS', () => {
    const text = policy('analytics_events_select_own_or_internal');
    const m = text.match(/event_name IN \(([^)]*)\)\s*AND \(SELECT public\.report_my_access\('funnel'\)\)/);
    if (!m) throw new Error('funnel branch not found');
    const names = Array.from(m[1].matchAll(/'([^']+)'/g), (x) => x[1]);
    expect(names.sort()).toEqual([...FUNNEL_STEP_EVENTS].sort());
  });

  it('exports branch keys on EXPORT_EVENT_NAME', () => {
    const text = policy('analytics_events_select_own_or_internal');
    expect(text).toContain(
      `event_name = '${EXPORT_EVENT_NAME}'\n      AND (SELECT public.report_my_access('exports')) IS NOT NULL`
    );
  });

  it('sync_outcomes branches key on the two report sources', () => {
    const text = policy('"Internal roles can read sync outcomes"');
    const iphone = readFileSync(IPHONE_QUERIES, 'utf8').match(/getSyncRuns<SyncOutcomeRow>\([^]*?source: '([^']+)'/);
    if (!iphone) throw new Error('iPhone source not found in iphone-sync-queries.ts');
    expect(text).toContain(`source = '${iphone[1]}'\n      AND (SELECT public.report_my_access('iphone-sync')) IS NOT NULL`);
    expect(text).toContain(
      `source = '${GM_SOURCE}'\n      AND (SELECT public.report_my_access('google-messages-sync')) IS NOT NULL`
    );
  });
});
