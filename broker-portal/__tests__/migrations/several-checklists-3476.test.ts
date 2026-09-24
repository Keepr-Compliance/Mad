/**
 * BACKLOG-3476 — the CI tripwire for the "several checklists per submission"
 * migration.
 *
 * WHAT THIS CAN PROVE: what the migration file says. CI has no database, so
 * behaviour is checked after apply (read-only): the constraint is gone, the
 * index exists, and two checklists insert on one submission in a rolled-back
 * transaction.
 *
 * It pins the four statements a later edit is most likely to drop, and that
 * each one can run twice.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../../../supabase/migrations');
const SUFFIX = '_backlog_3476_several_checklists_per_submission.sql';

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(SUFFIX));
  expect(files).toHaveLength(1);
  const raw = readFileSync(join(MIGRATIONS_DIR, files[0]), 'utf8').replace(/\r\n?/g, '\n');
  // Comments out, whitespace collapsed: the checks read statements only.
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('BACKLOG-3476 — submission_checklists takes several checklists per submission', () => {
  it('its stamp sorts after the BACKLOG-3474 template-save migration', () => {
    const [file] = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(SUFFIX));
    expect(file.slice(0, 14) > '20260924190429').toBe(true);
  });

  it('drops the one-per-submission constraint, re-runnably', () => {
    expect(migrationSql()).toContain(
      'ALTER TABLE public.submission_checklists DROP CONSTRAINT IF EXISTS submission_checklists_submission_id_key;',
    );
  });

  it('replaces the index that constraint carried', () => {
    expect(migrationSql()).toContain(
      'CREATE INDEX IF NOT EXISTS submission_checklists_submission_id_idx ON public.submission_checklists (submission_id);',
    );
  });

  it('adds sort_order, NOT NULL with a default, re-runnably', () => {
    expect(migrationSql()).toContain(
      'ALTER TABLE public.submission_checklists ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;',
    );
  });

  it('adds template_id: nullable, no foreign key, no constraint', () => {
    const sql = migrationSql();
    expect(sql).toContain('ALTER TABLE public.submission_checklists ADD COLUMN IF NOT EXISTS template_id uuid;');
    expect(sql).not.toMatch(/template_id uuid[^;]*(NOT NULL|REFERENCES|UNIQUE|CHECK)/i);
  });

  it('adds no new uniqueness: brokers may add checklists at review with repeated names', () => {
    expect(migrationSql()).not.toMatch(/\bUNIQUE\b/i);
  });

  it('holds exactly these four statements', () => {
    expect(migrationSql().split(';').filter((s) => s.trim().length > 0)).toHaveLength(4);
  });
});
