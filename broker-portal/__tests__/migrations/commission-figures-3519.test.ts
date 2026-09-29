/**
 * BACKLOG-3519 — the CI tripwire for the commission-figures migration.
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 *
 * WHAT IT CANNOT: behaviour, or what a database actually runs. CI has no
 * database. Constraint evaluation is proved by the executable probes in
 * supabase/tests/backlog-3519/ (run against a real Postgres).
 *
 * FIGURES ONLY (founder decision, pm_comments 4d2e15df on BACKLOG-3519): the
 * split_* columns, the FK into agent_split_agreements and the split RPC were
 * removed. This suite pins the decisions a later edit is most likely to undo
 * quietly:
 *
 *   - the file references NO other table (no REFERENCES clause), so it
 *     depends on nothing unapplied and 3503 is not a prerequisite;
 *   - no split_* column or split_agreement_in_force reference creeps back;
 *   - rates are numeric(6,3) percentages, gross numeric(12,2);
 *   - the reason CHECK is BETWEEN 1 AND 2000 (zero-length rejected);
 *   - the file wraps itself in BEGIN/COMMIT with a bounded lock_timeout;
 *   - section 5 (the commission lock) is marked as reserved, not forgotten.
 *
 * Limits, stated: it reads repo text only; comments are stripped before
 * matching, so a rule written only in a comment cannot satisfy an assertion.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const SCHEMA_FILE = '20260925070000_backlog_3519_commission_figures.sql';

/** Read a migration with CRLF normalised (Windows CI checks out with CRLF). */
const readMigration = (file: string): string =>
  readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/\r\n?/g, '\n');

/** Remove block comments, then `--` comments (whole-line and trailing) outside single quotes. */
function stripSqlComments(sql: string): string {
  const noBlocks = sql.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .map((line) => {
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'") inQuote = !inQuote;
        else if (!inQuote && c === '-' && line[i + 1] === '-') return line.slice(0, i).replace(/\s+$/, '');
      }
      return line;
    })
    .join('\n');
}

/** Collapse runs of whitespace so multi-line SQL can be matched as one string. */
const flatten = (sql: string): string => sql.replace(/\s+/g, ' ');

const RAW = readMigration(SCHEMA_FILE);
const SQL = stripSqlComments(RAW);
const FLAT = flatten(SQL);

/** The full text of a named `ADD CONSTRAINT ... CHECK (...)` clause, up to the next comma or the closing `;`. */
function checkConstraint(name: string): string {
  const start = FLAT.indexOf(`ADD CONSTRAINT ${name}`);
  if (start === -1) throw new Error(`${SCHEMA_FILE}: no constraint named ${name}`);
  // The clause ends at the next top-level ", ADD CONSTRAINT" or the statement's ";" --
  // whichever comes first. A CHECK's own parens are always balanced by then in this file.
  const rest = FLAT.slice(start);
  const nextComma = rest.indexOf(', ADD CONSTRAINT');
  const semi = rest.indexOf(';');
  const end = nextComma === -1 ? semi : Math.min(nextComma, semi === -1 ? Infinity : semi);
  return rest.slice(0, end);
}

describe('BACKLOG-3519 commission figures migration', () => {
  it('the file is not empty and the harness reads the same file', () => {
    expect(RAW.length).toBeGreaterThan(2000);
    expect(SQL).toContain('ALTER TABLE public.transaction_submissions');
    const runner = readFileSync(
      join(REPO, 'supabase/tests/backlog-3519/run.sh'),
      'utf8',
    );
    expect(runner).toContain(SCHEMA_FILE);
  });

  it('adds all four commission_* columns with the declared types', () => {
    expect(FLAT).toMatch(/ADD COLUMN IF NOT EXISTS commission_offered_rate\s+numeric\(6,3\)/i);
    expect(FLAT).toMatch(/ADD COLUMN IF NOT EXISTS commission_actual_rate\s+numeric\(6,3\)/i);
    expect(FLAT).toMatch(/ADD COLUMN IF NOT EXISTS commission_gross_amount\s+numeric\(12,2\)/i);
    expect(FLAT).toMatch(/ADD COLUMN IF NOT EXISTS commission_adjustment_reason\s+text/i);
  });

  it('references NO other table: no REFERENCES clause, so it depends on nothing unapplied', () => {
    expect(SQL).not.toMatch(/REFERENCES/i);
    expect(SQL).not.toMatch(/agent_split_agreements/i);
    expect(SQL).not.toMatch(/split_agreement_in_force/i);
  });

  it('creates no split_* column, constraint or index', () => {
    expect(SQL).not.toMatch(/split_/i);
    expect(SQL).not.toMatch(/CREATE INDEX/i);
  });

  it('bounds both commission rates to 0-100', () => {
    expect(checkConstraint('transaction_submissions_offered_rate_check')).toMatch(
      /commission_offered_rate >= 0 AND commission_offered_rate <= 100/i,
    );
    expect(checkConstraint('transaction_submissions_actual_rate_check')).toMatch(
      /commission_actual_rate >= 0 AND commission_actual_rate <= 100/i,
    );
  });

  it('requires the gross amount to be non-negative when present', () => {
    expect(checkConstraint('transaction_submissions_gross_amount_check')).toMatch(
      /commission_gross_amount >= 0/i,
    );
  });

  it('bounds the adjustment reason to 1-2000 trimmed characters -- a zero-length string is REJECTED', () => {
    const clause = checkConstraint('transaction_submissions_adjustment_reason_check');
    expect(clause).toMatch(/char_length\(btrim\(commission_adjustment_reason\)\) BETWEEN 1 AND 2000/i);
  });

  it('opens and closes its own transaction, with a bounded lock_timeout', () => {
    // Unlike BACKLOG-3503's file, which deliberately opens none because that
    // migration's own harness supplies the transaction: this file has no such
    // harness at real apply time, so losing the wrapper would let a mid-file
    // failure leave a partial column/constraint set on a live table.
    expect(SQL).toMatch(/^\s*BEGIN\s*;\s*$/m);
    expect(SQL).toMatch(/^\s*COMMIT\s*;\s*$/m);
    expect(FLAT).toMatch(/SET LOCAL lock_timeout = '5s'/i);
  });

  it('the header says the split is gone and that the submit needs this applied first', () => {
    expect(RAW).toContain('FIGURES ONLY');
    expect(RAW).toContain('PGRST204');
    expect(RAW).toContain('depends on NOTHING unapplied');
  });

  it('marks section 5 (the commission lock) as reserved, with its spec, so its absence is not read as an oversight', () => {
    expect(RAW).toContain('COMMISSION LOCK -- INTENTIONALLY NOT WRITTEN IN THIS COMMIT');
    expect(RAW).toContain('42501');
    expect(RAW).toContain('SECURITY INVOKER');
    // The lock is not present yet: no trigger, no function in the executable SQL.
    expect(SQL).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|TRIGGER)/i);
  });

  it('says this migration is not applied to any environment by this PR', () => {
    expect(RAW).toContain('NOT APPLIED TO ANY ENVIRONMENT BY THIS PR');
  });
});
