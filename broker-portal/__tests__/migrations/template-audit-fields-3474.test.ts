/**
 * BACKLOG-3474 PR 3 — CI tripwire for the checklist template audit fields.
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 *
 * WHAT IT CANNOT: behaviour. CI has no database. The behaviour is proved by
 * controls c37-c39 and mutants m65-m69 in supabase/tests/backlog-3473/, run
 * against a real Postgres (never production). This file guards the lines a
 * later edit is most likely to change quietly: the migration's place in the
 * order, that no client grant ever names the two columns, that the trigger
 * fires on every UPDATE, and that it decides no authority of its own.
 *
 * Comments are removed before any check (block, then `--` outside single
 * quotes), so a commented-out line never satisfies one.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../../../supabase/migrations');
const FILE = '20260924224113_backlog_3474_template_audit_fields.sql';
const COLUMNS = ['updated_by', 'archived_by'];

const readMigration = (file: string): string =>
  readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/\r\n?/g, '\n');

function stripSqlComments(sql: string): string {
  const noBlocks = sql.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .map((line) => {
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'") inQuote = !inQuote;
        else if (!inQuote && c === '-' && line[i + 1] === '-') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

const SQL = stripSqlComments(readMigration(FILE));

/** Text between the trigger function's opening and closing $$. */
function body(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public._checklist_templates_audit(');
  if (start === -1) throw new Error('_checklist_templates_audit definition not found');
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  return sql.slice(open + 2, close);
}

function header(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public._checklist_templates_audit(');
  return sql.slice(start, sql.indexOf('$$', start));
}

describe('BACKLOG-3474 template audit fields migration', () => {
  it('has a 14-digit stamp that sorts after save_checklist_template and the production ledger tail', () => {
    expect(FILE).toMatch(/^\d{14}_backlog_3474_/);
    expect(FILE > '20260924190429_backlog_3474_save_checklist_template.sql').toBe(true);
    expect(FILE > '20260924183422_backlog_3535_checklists_min_tier_individual.sql').toBe(true);
    // save_checklist_template was applied to production as ledger version 20260924202654.
    expect(FILE.slice(0, 14) > '20260924202654').toBe(true);
  });

  it('adds both columns as nullable uuids referencing auth.users, re-runnably', () => {
    for (const col of COLUMNS) {
      expect(SQL).toMatch(
        new RegExp(`ADD COLUMN IF NOT EXISTS ${col} uuid NULL\\s+CONSTRAINT checklist_templates_${col}_fkey REFERENCES auth\\.users\\(id\\) ON DELETE SET NULL`)
      );
    }
  });

  it('never grants a client INSERT or UPDATE on either column, in any migration', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    let seen = 0;
    for (const f of files) {
      const sql = stripSqlComments(readMigration(f));
      const grants = sql.match(/GRANT[^;]*ON\s+(TABLE\s+)?public\.checklist_templates\b[^;]*;/gi) ?? [];
      for (const g of grants) {
        seen++;
        for (const col of COLUMNS) expect({ file: f, grant: g, names: g.includes(col) }).toEqual({ file: f, grant: g, names: false });
        // A whole-table INSERT/UPDATE grant would include them too.
        expect(g).not.toMatch(/GRANT\s+(ALL|[^;(]*\b(INSERT|UPDATE)\b(?!\s*\())[^;]*ON/i);
      }
    }
    // 3473 grants SELECT, INSERT (…) and UPDATE (…) on the table: the scan must see them.
    expect(seen).toBeGreaterThanOrEqual(3);
  });

  it('fires BEFORE every UPDATE of the row, not only an UPDATE OF one column', () => {
    expect(SQL).toMatch(
      /CREATE OR REPLACE TRIGGER checklist_templates_audit\s+BEFORE UPDATE ON public\.checklist_templates\s+FOR EACH ROW\s+EXECUTE FUNCTION public\._checklist_templates_audit\(\);/
    );
  });

  it('runs SECURITY INVOKER with a pinned search_path and is not client-callable', () => {
    expect(header(SQL)).toMatch(/\bSECURITY INVOKER\b/);
    expect(header(SQL)).toMatch(/\bSET search_path = public\b/);
    expect(SQL).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(SQL).toContain('REVOKE EXECUTE ON FUNCTION public._checklist_templates_audit() FROM PUBLIC, anon, authenticated;');
    expect(SQL).not.toMatch(/GRANT EXECUTE/i);
  });

  it('sets updated_by from auth.uid() always; archived_by on archive, cleared on restore, never written back from OLD', () => {
    const b = body(SQL);
    expect(b).toContain('NEW.updated_by := auth.uid();');
    expect(b).toMatch(/IF NEW\.archived_at IS NULL THEN\s+NEW\.archived_by := NULL;/);
    expect(b).toMatch(/ELSIF OLD\.archived_at IS NULL THEN\s+NEW\.archived_by := auth\.uid\(\);/);
    // Writing OLD.archived_by back would undo the foreign key's ON DELETE SET
    // NULL, so deleting a user who archived a still-archived template fails.
    expect(b).not.toMatch(/OLD\.archived_by/);
    expect(b).not.toMatch(/\bELSE\b/);
  });

  it('names no role and no tier: authority stays with RLS and save_checklist_template', () => {
    for (const literal of ["'broker'", "'admin'", "'it_admin'", "'agent'", "'team'", "'individual'", "'enterprise'"]) {
      expect(SQL).not.toContain(literal);
    }
  });

  it('does not redefine save_checklist_template or the shared updated_at trigger function', () => {
    expect(SQL).not.toMatch(/save_checklist_template/);
    expect(SQL).not.toMatch(/update_updated_at_column/);
  });
});
