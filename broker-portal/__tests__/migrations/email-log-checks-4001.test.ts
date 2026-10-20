/**
 * BACKLOG-4001 — email_delivery_log's check constraints match what the email sender writes.
 *
 * WHAT THIS CAN PROVE: what the migration files say. CI has no database. The definitions
 * were applied and read back on keepr-test (pg_get_constraintdef, recorded on BACKLOG-4001).
 *
 * Before 4001 the email_type check lacked 'receipt' and 'ticket_resolved' and the status
 * check lacked 'queued'; PostgREST refused those inserts and the sender never read the
 * error, so the rows silently did not exist (agentReceipt's dedupe reads them).
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { EMAIL_LOG_STATUSES, EMAIL_TYPES } from '../../lib/email/types';

const MIGRATIONS = join(__dirname, '../../../supabase/migrations');
const FILE = '20261020120000_backlog_4001_email_log_type_status_checks.sql';
const read = (name: string): string =>
  readFileSync(join(MIGRATIONS, name), 'utf8')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join(' ');

/** The quoted values inside `ADD CONSTRAINT <name> CHECK (<column> IN ( ... ))`. */
function allowed(sql: string, name: string, column: string): string[] {
  const re = new RegExp(`ADD CONSTRAINT ${name} CHECK \\(\\s*${column} IN \\(([^)]*)\\)\\s*\\)`, 'g');
  const hits = [...sql.matchAll(re)];
  expect(hits).toHaveLength(1);
  return [...hits[0][1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const SQL = read(FILE);

describe('BACKLOG-4001 email_delivery_log checks', () => {
  it('email_type allows exactly EMAIL_TYPES', () => {
    const values = allowed(SQL, 'email_delivery_log_email_type_check', 'email_type');
    expect(new Set(values).size).toBe(values.length);
    expect(sorted(values)).toEqual(sorted(EMAIL_TYPES));
  });

  it("status allows exactly EMAIL_LOG_STATUSES plus the legacy 'attempted'", () => {
    const values = allowed(SQL, 'email_delivery_log_status_check', 'status');
    expect(new Set(values).size).toBe(values.length);
    expect(sorted(values)).toEqual(sorted([...EMAIL_LOG_STATUSES, 'attempted']));
  });

  it('drops and re-adds both checks in one ALTER TABLE', () => {
    const alters = SQL.match(/ALTER TABLE/g) ?? [];
    expect(alters).toHaveLength(1);
    expect(SQL).toMatch(
      /ALTER TABLE public\.email_delivery_log\s+DROP CONSTRAINT IF EXISTS email_delivery_log_email_type_check,\s+DROP CONSTRAINT IF EXISTS email_delivery_log_status_check,\s+ADD CONSTRAINT email_delivery_log_email_type_check/,
    );
  });

  it('is the latest migration that defines either check (a later one must move this test)', () => {
    const definers = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) => /email_delivery_log_(email_type|status)_check/.test(read(f)));
    expect(definers[definers.length - 1]).toBe(FILE);
  });
});
