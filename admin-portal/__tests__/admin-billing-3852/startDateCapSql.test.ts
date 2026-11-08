/**
 * BACKLOG-4033: the database save path (_billing_save_deal) enforces the same start-date cap
 * as the admin form rule (checkStartDate). CI has no database, so this reads the migration text;
 * the behaviour controls run on keepr-test (supabase/tests/backlog-4033/controls.sql).
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { MAX_START_DAYS_AHEAD, dealErrorMessage } from '@/lib/billing/dealRules';

const MIGRATIONS = path.resolve(__dirname, '../../../supabase/migrations');
const FILE = '20261108210000_backlog_4033_deal_start_cap.sql';
const DEFINER = /CREATE OR REPLACE FUNCTION public\._billing_save_deal\(/;

/** SQL without `--` comments, so prose about `interval` or numbers is not counted. */
function code(sql: string): string {
  return sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
}

const sql = code(readFileSync(path.join(MIGRATIONS, FILE), 'utf8'));
const fnStart = sql.search(DEFINER);
const fn = sql.slice(fnStart, sql.indexOf('$function$;', fnStart));
const existing = fn.slice(fn.indexOf('IF FOUND THEN'), fn.indexOf('ELSE\n    IF p_expected_version IS NOT NULL'));
const created = fn.slice(fn.indexOf('ELSE\n    IF p_expected_version IS NOT NULL'));

describe('_billing_save_deal start-date cap (BACKLOG-4033)', () => {
  it('is the latest migration that defines _billing_save_deal', () => {
    const definers = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && DEFINER.test(readFileSync(path.join(MIGRATIONS, f), 'utf8')))
      .sort();
    expect(definers[definers.length - 1]).toBe(FILE);
  });

  it('caps both the changed date of an existing deal and a new deal at the business date + MAX_START_DAYS_AHEAD', () => {
    expect(fnStart).toBeGreaterThan(-1);
    const cap = `v_start > v_today + ${MAX_START_DAYS_AHEAD} THEN`;
    expect(existing).toContain(cap);
    expect(existing).toContain("'start_date_too_far'");
    expect(created).toContain(`v_start IS NOT NULL AND ${cap}`);
    expect(created).toContain("'start_date_too_far'");
    expect(fn.match(/v_today \+ (\d+)/g)?.map((m) => Number(m.split('+ ')[1]))).toEqual(
      Array(4).fill(MAX_START_DAYS_AHEAD),
    );
  });

  it('counts days, not a calendar year, and uses the business date, not the server date', () => {
    expect(fn).not.toMatch(/\binterval\b/i); // billing_interval (price lookup) is not a date interval
    expect(fn).not.toMatch(/\bcurrent_date\b/i);
    expect(fn).toContain('v_today date := public._billing_business_date();');
  });

  it('checks an existing deal only when the date changes, and after the lock and past checks', () => {
    const distinct = existing.indexOf('v_start IS DISTINCT FROM v_deal.start_date THEN');
    const locked = existing.indexOf("'start_date_locked'");
    const past = existing.indexOf("'start_date_past'");
    const far = existing.indexOf("'start_date_too_far'");
    const blockEnd = existing.indexOf('UPDATE public.org_deals SET');
    expect(distinct).toBeGreaterThan(-1);
    expect(distinct < locked && locked < past && past < far && far < blockEnd).toBe(true);
  });

  it('keeps the grants: no anon/authenticated execute, service_role only', () => {
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION public._billing_save_deal(uuid, jsonb, uuid, text, integer) FROM PUBLIC, anon, authenticated;',
    );
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public._billing_save_deal(uuid, jsonb, uuid, text, integer) TO service_role;');
  });

  it('the error code the database returns has the admin sentence', () => {
    expect(dealErrorMessage('start_date_too_far')).toBe('Pick a start date within 365 days from today.');
  });
});
