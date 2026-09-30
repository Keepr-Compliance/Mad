/**
 * BACKLOG-3547 — the CI tripwire for the submission INSERT rule migration.
 *
 * WHAT THIS CAN PROVE: what the migration file says. CI has no database. The
 * behaviour is proved on a real Postgres by supabase/tests/backlog-3547
 * (controls c00-c08, 12 mutants); this file pins the terms a later edit is
 * most likely to drop or loosen, so that such a change fails in CI too.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../../../supabase/migrations');
const SUFFIX = '_backlog_3547_submission_insert_pre_review.sql';

function migrationFile(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(SUFFIX));
  expect(files).toHaveLength(1);
  return files[0];
}

function migrationSql(): string {
  const raw = readFileSync(join(MIGRATIONS_DIR, migrationFile()), 'utf8').replace(/\r\n?/g, '\n');
  // Comments out, whitespace collapsed: the checks read statements only.
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The CREATE POLICY statement, through its semicolon. */
function insertPolicy(sql: string): string {
  const start = sql.indexOf('CREATE POLICY agents_can_create_submissions ON public.transaction_submissions');
  expect(start).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf(';', start) + 1);
}

describe('BACKLOG-3547 — submission INSERT rule migration', () => {
  it('sorts after the BACKLOG-3477 migration', () => {
    expect(migrationFile().slice(0, 14) > '20260925073000').toBe(true);
  });

  it('opens no transaction of its own', () => {
    expect(migrationSql()).not.toMatch(/(^|;)\s*(BEGIN|COMMIT)\s*;/i);
  });

  it('replaces the existing policy rather than adding a second one beside it', () => {
    const sql = migrationSql();
    expect(sql).toContain(
      'DROP POLICY IF EXISTS agents_can_create_submissions ON public.transaction_submissions;',
    );
    expect(sql.match(/CREATE POLICY /g)).toHaveLength(1);
    expect(sql.indexOf('DROP POLICY IF EXISTS agents_can_create_submissions ON')).toBeLessThan(
      sql.indexOf('CREATE POLICY agents_can_create_submissions ON'),
    );
  });

  it('is an INSERT policy for every role, like the one it replaces', () => {
    const p = insertPolicy(migrationSql());
    expect(p).toContain('FOR INSERT');
    expect(p).not.toMatch(/\bTO\b/);
    expect(p).not.toMatch(/\bRESTRICTIVE\b/i);
  });

  it('keeps both existing conditions verbatim', () => {
    const p = insertPolicy(migrationSql());
    expect(p).toContain('(submitted_by = ( SELECT auth.uid() AS uid))');
    expect(p).toContain(
      'AND (organization_id IN ( SELECT om.organization_id FROM (organization_members om JOIN organizations o ON ((o.id = om.organization_id))) WHERE ((om.user_id = ( SELECT auth.uid() AS uid)) AND (o.personal_owner_user_id IS NULL))))',
    );
  });

  it('admits exactly uploading and submitted, with no NULL escape', () => {
    const p = insertPolicy(migrationSql());
    expect(p).toContain("AND ((status)::text = ANY (ARRAY['uploading'::text, 'submitted'::text]))");
    for (const s of ['under_review', 'needs_changes', 'resubmitted', 'approved', 'rejected']) {
      expect(p).not.toContain(`'${s}'`);
    }
    expect(p).not.toMatch(/COALESCE|status IS NULL|<> ALL|NOT IN/i);
  });

  it('requires every reviewer field to be empty, ANDed', () => {
    const p = insertPolicy(migrationSql());
    for (const col of ['reviewed_by', 'reviewed_at', 'review_notes']) {
      expect(p).toContain(`AND (${col} IS NULL)`);
    }
    expect(p).not.toMatch(/\bOR\b/);
  });

  it('leaves the four commission columns unconstrained', () => {
    const p = insertPolicy(migrationSql());
    for (const col of [
      'commission_offered_rate',
      'commission_actual_rate',
      'commission_gross_amount',
      'commission_adjustment_reason',
    ]) {
      expect(p).not.toContain(col);
    }
  });
});
