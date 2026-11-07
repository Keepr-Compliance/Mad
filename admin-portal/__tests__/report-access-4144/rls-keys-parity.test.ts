/**
 * BACKLOG-4144 M2: the event names and sync sources the RLS policies key on equal the ones the
 * report queries read. A funnel step or source added in code but not in the migration reads as
 * zero rows for every viewer, Super Admins included, with no other test going red.
 */

import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { FUNNEL_STEP_EVENTS } from '@/lib/funnel-analytics';
import { EXPORT_EVENT_NAME } from '@/lib/reports/exports';
import { GM_SOURCE } from '@/lib/reports/google-messages-sync';
import { EP_SOURCE } from '@/lib/reports/email-precache';

const MIGRATION = path.resolve(
  __dirname,
  '../../../supabase/migrations/20261105110000_backlog_4144_report_rls.sql'
);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');
const IPHONE_QUERIES = path.resolve(__dirname, '../../lib/reports/iphone-sync-queries.ts');

/** A Windows checkout converts LF to CRLF; every expectation below is written with LF. */
function lf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function policy(name: string, raw: string = readFileSync(MIGRATION, 'utf8')): string {
  const sql = lf(raw);
  const start = sql.indexOf(`ALTER POLICY ${name}`);
  if (start < 0) throw new Error(`policy ${name} not found in the M2 migration`);
  const end = sql.indexOf('COMMENT ON POLICY', start);
  return sql.slice(start, end);
}

/**
 * The policy as the LAST migration (version order) that alters it leaves it. ALTER POLICY replaces
 * the whole USING expression, so only the latest one counts (BACKLOG-4130: 20261105160000 restates
 * the sync_outcomes policy with a third branch).
 */
function latestPolicy(name: string): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let found: string | null = null;
  for (const file of files) {
    const raw = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    if (lf(raw).includes(`ALTER POLICY ${name}`)) found = raw;
  }
  if (found === null) throw new Error(`policy ${name} not altered by any migration`);
  return policy(name, found);
}

describe('M2 RLS keys == report queries', () => {
  function funnelNames(text: string): string[] {
    const m = text.match(/event_name IN \(([^)]*)\)\s*AND \(SELECT public\.report_my_access\('funnel'\)\)/);
    if (!m) throw new Error('funnel branch not found');
    return Array.from(m[1].matchAll(/'([^']+)'/g), (x) => x[1]).sort();
  }

  it('funnel branch lists exactly FUNNEL_STEP_EVENTS', () => {
    expect(funnelNames(policy('analytics_events_select_own_or_internal'))).toEqual([...FUNNEL_STEP_EVENTS].sort());
  });

  it('reads a CRLF checkout of the migration the same way', () => {
    const crlf = readFileSync(MIGRATION, 'utf8').replace(/\r?\n/g, '\r\n');
    expect(crlf).toContain('\r\n');
    const text = policy('analytics_events_select_own_or_internal', crlf);
    expect(funnelNames(text)).toEqual([...FUNNEL_STEP_EVENTS].sort());
    expect(text).toContain(
      `event_name = '${EXPORT_EVENT_NAME}'\n      AND (SELECT public.report_my_access('exports')) IS NOT NULL`
    );
  });

  it('exports branch keys on EXPORT_EVENT_NAME', () => {
    const text = policy('analytics_events_select_own_or_internal');
    expect(text).toContain(
      `event_name = '${EXPORT_EVENT_NAME}'\n      AND (SELECT public.report_my_access('exports')) IS NOT NULL`
    );
  });

  it('sync_outcomes branches key on the three report sources (latest migration)', () => {
    const text = latestPolicy('"Internal roles can read sync outcomes"');
    const iphone = lf(readFileSync(IPHONE_QUERIES, 'utf8')).match(/getSyncRuns<SyncOutcomeRow>\([^]*?source: '([^']+)'/);
    if (!iphone) throw new Error('iPhone source not found in iphone-sync-queries.ts');
    expect(text).toContain(`source = '${iphone[1]}'\n      AND (SELECT public.report_my_access('iphone-sync')) IS NOT NULL`);
    expect(text).toContain(
      `source = '${GM_SOURCE}'\n      AND (SELECT public.report_my_access('google-messages-sync')) IS NOT NULL`
    );
    expect(text).toContain(
      `source = '${EP_SOURCE}'\n      AND (SELECT public.report_my_access('email-precache')) IS NOT NULL`
    );
    // Exactly three source branches: a fourth source would need its own report key.
    expect(text.match(/source = '/g)).toHaveLength(3);
  });
});
