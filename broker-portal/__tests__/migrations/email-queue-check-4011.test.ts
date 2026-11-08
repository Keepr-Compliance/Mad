/**
 * BACKLOG-4011 — email_delivery_queue.email_type has the same check as email_delivery_log.
 *
 * WHAT THIS CAN PROVE: what the migration files say. CI has no database. The definition was
 * applied and read back on keepr-test (pg_get_constraintdef, recorded on BACKLOG-4011).
 *
 * enqueueEmail is the only writer of email_delivery_queue; its email_type is an EmailType
 * (EMAIL_TYPES). A queued row whose type the log check refuses would retry into a refused log
 * insert, so the two lists must stay equal.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { EMAIL_TYPES } from '../../lib/email/types';

const MIGRATIONS = join(__dirname, '../../../supabase/migrations');
const FILE = '20261108200000_backlog_4011_email_queue_type_check.sql';
const LOG_FILE = '20261020120000_backlog_4001_email_log_type_status_checks.sql';
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

describe('BACKLOG-4011 email_delivery_queue email_type check', () => {
  it('allows exactly EMAIL_TYPES', () => {
    const values = allowed(SQL, 'email_delivery_queue_email_type_check', 'email_type');
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
    expect(sorted(values)).toEqual(sorted(EMAIL_TYPES));
  });

  it('allows exactly what email_delivery_log_email_type_check allows', () => {
    const queue = allowed(SQL, 'email_delivery_queue_email_type_check', 'email_type');
    const log = allowed(read(LOG_FILE), 'email_delivery_log_email_type_check', 'email_type');
    expect(sorted(queue)).toEqual(sorted(log));
  });

  it('pre-check list equals the constraint list', () => {
    const m = SQL.match(/WHERE email_type NOT IN \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const pre = [...m![1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    expect(sorted(pre)).toEqual(sorted(allowed(SQL, 'email_delivery_queue_email_type_check', 'email_type')));
  });

  it('is the latest migration that defines the check (a later one must move this test)', () => {
    const definers = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) => /email_delivery_queue_email_type_check/.test(read(f)));
    expect(definers[definers.length - 1]).toBe(FILE);
  });
});
