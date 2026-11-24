/**
 * BACKLOG-4263 — T-S harness: the structure call and the cast rule.
 *
 * harness-t-structure.sql runs, byte for byte, the statements of harness-t.sql that the fixtures-only call does not:
 * every helper and control definition, the fingerprint (twice), the negative control, one function-body mutant
 * (body_not_stripped), one ACL mutant (reader_granted_anon) and the rollback step. gen.py check asserts the identity
 * statement by statement; this test pins the same from the files. The cast rule: a pg_catalog column that is not text
 * ("char", boolean, oid, name, aclitem[]) is never an operand of || or a direct argument of concat / concat_ws /
 * string_agg / format without an explicit cast (supabase/tests/backlog-4263-sync2-t/casts.py; gen.py check runs it).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const DIR = join(__dirname, '../../../supabase/tests/backlog-4263-sync2-t');
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8').replace(/\r\n?/g, '\n');
const FULL = read('harness-t.sql');
const ST = read('harness-t-structure.sql');
const FX = read('harness-t-fixtures.sql');

const NON_TEXT = ['provolatile', 'prosecdef', 'proowner', 'proacl', 'prokind', 'proparallel', 'proleakproof', 'proisstrict', 'proretset',
  'relowner', 'relacl', 'relkind', 'relpersistence', 'contype', 'conname', 'confdeltype', 'convalidated', 'rolsuper', 'rolinherit',
  'inherit_option', 'set_option', 'admin_option', 'nspacl'];

/** comments and single-quoted literals blanked (same length) */
function blank(sql: string): string {
  return sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length)).replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length));
}

function castFindings(sql: string): string[] {
  const t = blank(sql);
  const out: string[] = [];
  const re = new RegExp(`(?<![A-Za-z0-9_$])(?:[A-Za-z_][A-Za-z0-9_]*\\.)?(${NON_TEXT.join('|')})(?![A-Za-z0-9_])`, 'g');
  for (const m of t.matchAll(re)) {
    const at = m.index!;
    const after = t.slice(at + m[0].length);
    if (/^\s*::/.test(after)) continue;
    const before = t.slice(0, at);
    const direct = /(?:\b(?:concat|concat_ws|string_agg|format)\s*\(|,)\s*$/.test(before)
      && /\b(?:concat|concat_ws|string_agg|format)\s*\([^()]*$/.test(before);
    if (/\|\|\s*$/.test(before) || /^\s*\|\|/.test(after) || direct) out.push(`:${sql.slice(0, at).split('\n').length} ${m[1]}`);
  }
  return out;
}

describe('BACKLOG-4263 T-S structure call and cast rule', () => {
  it('a helper that reads a public table is VOLATILE (a STABLE one would not see rows a tool call in the same expression wrote)', () => {
    // every pg_temp function in the harness sources, any language, any dollar tag; a STABLE or IMMUTABLE one may not
    // read a public table (FROM or JOIN). Stated limit: a STABLE helper that reads through a product function call.
    const lib = read('lib/helpers.sql') + '\n' + read('lib/controls.sql') + '\n' + read('lib/fixtures.sql');
    const fns = [...lib.matchAll(/CREATE (?:OR REPLACE )?FUNCTION pg_temp\.(\w+)\(([\s\S]*?)\bAS\s+(\$\w*\$)([\s\S]*?)\3/g)];
    expect(fns.length).toBeGreaterThan(40);
    const bad: string[] = [];
    const readers: string[] = [];
    for (const m of fns) {
      const head = m[2];
      const body = blank(m[4]);
      const vol = /\b(STABLE|IMMUTABLE)\b/i.exec(head)?.[1]?.toUpperCase() ?? 'VOLATILE';
      if (/\b(?:FROM|JOIN)\s+public\.\w+\b(?!\s*\()/i.test(body)) {
        readers.push(`${m[1]} ${vol}`);
        if (vol !== 'VOLATILE') bad.push(`${m[1]} ${vol}`);
      }
    }
    expect(readers).toEqual(expect.arrayContaining(['reads VOLATILE', 'last_outcome VOLATILE']));
    expect(bad).toEqual([]);
  });

  it('no control makes a tool call and reads what it logged in one statement', () => {
    const t = blank(read('lib/controls.sql'));
    const stmts = t.split(';');
    const both = stmts.filter((st) => /pg_temp\.(?:lst|getm|access|tool|as_user|call_as|claim|tomb|walk|all_parts)\(/.test(st)
      && /pg_temp\.(?:reads|last_outcome)\(/.test(st));
    expect(both.map((x) => x.trim().slice(0, 80))).toEqual([]);
    expect(stmts.filter((st) => /pg_temp\.last_outcome\(/.test(st)).length).toBeGreaterThan(3);
  });

  it('no non-text catalogue column is concatenated without a cast, in any generated harness file', () => {
    for (const f of ['harness-t.sql', 'harness-t-controls.sql', 'harness-t-mutants.sql', 'harness-t-fixtures.sql', 'harness-t-structure.sql',
      'rollback-20261123140000.sql', 'lib/controls.sql', 'lib/helpers.sql', 'lib/fixtures.sql']) {
      expect(`${f} ${castFindings(read(f)).join(' ')}`).toBe(`${f} `);
    }
    // the rule can see the shape that failed on the database
    expect(castFindings("SELECT 'a' || p.provolatile || ':' || p.prosecdef, string_agg(k.conname, ',') FROM pg_proc p")).toHaveLength(3);
    expect(castFindings("SELECT 'a' || p.provolatile::text || p.prosecdef::text, string_agg(k.conname::text, ',')")).toHaveLength(0);
  });

  it('the fingerprint casts every operand to text and sorts ACL items', () => {
    const fp = FULL.slice(FULL.indexOf('CREATE FUNCTION pg_temp.fingerprint()'), FULL.indexOf('DO $controls4263t$'));
    for (const s of ['p.provolatile::text', 'p.prosecdef::text', 'pg_catalog.pg_get_userbyid(p.proowner)::text', 'k.conname::text',
      "string_agg(x.item::text, ',' ORDER BY x.item::text) FROM unnest(c.relacl) AS x(item)", 'FROM unnest(p.proacl) AS x(item)',
      'RETURNS text LANGUAGE sql STABLE']) {
      expect(fp).toContain(s);
    }
    expect(ST).toContain(fp);
  });

  it('the structure call: every statement before its driver is harness-t.sql\'s, its blocks are harness-t.sql\'s, nothing else runs', () => {
    const pre = FULL.slice(FULL.indexOf('DO $guard4263t$'), FULL.indexOf('DO $controls4263t$'));
    const fx0 = "DO $fxt0_4263t$ BEGIN PERFORM pg_temp.rec('t_fixture_start', to_jsonb(clock_timestamp())); END $fxt0_4263t$;\n";
    expect(FX).toContain(fx0);
    const fixtures = read('lib/fixtures.sql');
    expect(ST.slice(ST.indexOf('DO $guard4263t$'), ST.indexOf('DO $structure4263t$'))).toBe(pre.replace(fixtures, fx0 + fixtures));
    const blocks = [...ST.matchAll(/  -- (noop_probe|body_not_stripped|reader_granted_anon)\n  BEGIN\n[\s\S]*?MUTANT NOT RESTORED \1';\n  END IF;\n/g)].map((m) => m[0]);
    expect(blocks.map((b) => b.split('\n')[0])).toEqual(['  -- noop_probe', '  -- body_not_stripped', '  -- reader_granted_anon']);
    for (const b of blocks) expect(FULL).toContain(b);
    const rb = FULL.slice(FULL.indexOf('-- ================================================================ the rollback file, verbatim'), FULL.indexOf('DO $end4263t$'));
    expect(ST).toContain(rb + 'DO $endstructure4263t$');
    expect(ST.match(/pg_temp\.rec\('mutant:/g)).toHaveLength(3);
    const driver = ST.slice(ST.indexOf('DO $structure4263t$'), ST.indexOf('$structure4263t$;'));
    expect(driver).not.toContain("rec('controls', base)");
    expect(driver).not.toContain('c_prune_loop()');
    expect(driver).toContain("res := pg_temp.c_strip();");
    expect(driver).toContain("res := pg_temp.c_catalogue();");
    // c_strip and c_catalogue once without a mutant (chunks of harness-t.sql's plain pass), then under their mutant
    expect(driver.match(/res := pg_temp\.c_\w+\(\);/g)).toEqual(['res := pg_temp.c_strip();', 'res := pg_temp.c_catalogue();',
      'res := pg_temp.c_strip();', 'res := pg_temp.c_catalogue();']);
    expect(driver).toContain("PERFORM pg_temp.rec('controls_base', base);");
    for (const c of ['c_strip', 'c_catalogue']) {
      const chunk = `    BEGIN\n      res := pg_temp.${c}();\n      RAISE EXCEPTION 'undo-case';\n`;
      expect(FULL).toContain(chunk);
    }
    expect(ST.trimEnd().endsWith("RAISE EXCEPTION 'T4263_STRUCTURE_OK %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.t_out);\nEND\n$endstructure4263t$;")).toBe(true);
    expect(ST.split('\n')[1]).toContain('must never be run on production');
  });
});
