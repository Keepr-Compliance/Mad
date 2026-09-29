/**
 * BACKLOG-3474 — CI tripwire for save_checklist_template.
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 *
 * WHAT IT CANNOT: behaviour. CI has no database. The behaviour is proved by
 * controls c26-c36 and mutants m52-m64 in supabase/tests/backlog-3473/, run
 * against a real Postgres (never production). This file guards the lines a
 * later edit is most likely to change quietly: how the function runs, who may
 * execute it, the authority check it starts with, the full-precision stale
 * check, the item cap, and that it swallows no error.
 *
 * Comments are removed before any check (block, then `--` outside single
 * quotes), so a commented-out line never satisfies one.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../../../supabase/migrations');
const FILE = '20260924190429_backlog_3474_save_checklist_template.sql';
const SIGNATURE = 'public.save_checklist_template(uuid, uuid, text, text, text, jsonb)';

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

/** Text between the function's opening and closing $$. */
function body(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.save_checklist_template(');
  if (start === -1) throw new Error('save_checklist_template definition not found');
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  if (open === -1 || close === -1) throw new Error('save_checklist_template body tags not found');
  return sql.slice(open + 2, close);
}

/** The header between CREATE and the opening $$ (LANGUAGE, SECURITY, SET). */
function header(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.save_checklist_template(');
  return sql.slice(start, sql.indexOf('$$', start));
}

describe('BACKLOG-3474 save_checklist_template migration (A14)', () => {
  it('has a 14-digit stamp that sorts after every other migration it depends on', () => {
    expect(FILE).toMatch(/^\d{14}_backlog_3474_/);
    // 3535 (checklists min tier) must apply first.
    expect(FILE > '20260924183422_backlog_3535_checklists_min_tier_individual.sql').toBe(true);
    expect(FILE > '20260921101757_backlog_3473_transaction_checklists.sql').toBe(true);
  });

  it('is the last migration that defines save_checklist_template', () => {
    const definers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) => /FUNCTION\s+("?public"?\.)?"?save_checklist_template"?\s*\(/i.test(stripSqlComments(readMigration(f))));
    expect(definers[definers.length - 1]).toBe(FILE);
  });

  it('runs SECURITY INVOKER with a pinned search_path, never SECURITY DEFINER', () => {
    expect(header(SQL)).toMatch(/\bSECURITY INVOKER\b/);
    expect(header(SQL)).toMatch(/\bSET search_path = public\b/);
    expect(SQL).not.toMatch(/SECURITY\s+DEFINER/i);
  });

  it('is executable by authenticated only: revoked from PUBLIC and anon', () => {
    expect(SQL).toContain(`REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM PUBLIC, anon;`);
    expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO authenticated;`);
    expect(SQL).not.toMatch(/GRANT EXECUTE[^;]*\b(anon|PUBLIC)\b/);
  });

  it('starts with the can_edit_checklist_templates authority check, raising 42501', () => {
    const b = body(SQL);
    const check = b.indexOf('IF NOT public.can_edit_checklist_templates(p_org_id) THEN');
    expect(check).toBeGreaterThan(-1);
    expect(b.slice(check, check + 160)).toContain("RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501'");
    // Before any write.
    for (const write of ['INSERT INTO', 'UPDATE public.', 'DELETE FROM']) {
      expect(b.indexOf(write)).toBeGreaterThan(check);
    }
  });

  it('names no role and no tier of its own: authority lives in can_edit_checklist_templates', () => {
    const b = body(SQL);
    for (const literal of ["'broker'", "'admin'", "'it_admin'", "'agent'", "'team'", "'individual'", "'enterprise'"]) {
      expect(b).not.toContain(literal);
    }
  });

  it('compares the stale token at full precision on the template UPDATE', () => {
    const b = body(SQL);
    expect(b).toContain('AND t.updated_at = p_expected_updated_at::timestamptz');
    expect(b).not.toMatch(/date_trunc/i);
    // The template UPDATE runs before any item write.
    const tplUpdate = b.indexOf('UPDATE public.checklist_templates');
    expect(tplUpdate).toBeGreaterThan(-1);
    expect(b.indexOf('checklist_template_items')).toBeGreaterThan(tplUpdate);
  });

  it('caps the item list at 1..200 in SQL', () => {
    expect(body(SQL)).toContain('OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 200');
  });

  it('swallows no error and controls no transaction', () => {
    const b = body(SQL);
    expect(b).not.toMatch(/\bEXCEPTION\s+WHEN\b/i);
    expect(SQL).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
  });

  it('returns the new updated_at as text', () => {
    expect(header(SQL)).toContain('RETURNS TABLE (id uuid, updated_at text)');
    expect(body(SQL)).toContain("RETURN QUERY SELECT v_template_id, to_json(v_updated_at) #>> '{}';");
  });
});
