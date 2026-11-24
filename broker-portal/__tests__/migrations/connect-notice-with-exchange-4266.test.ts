/**
 * BACKLOG-4266 — CI tripwire for migration 20261123170000 (the AI-app connect notice is written with the exchange,
 * or the exchange fails).
 *
 * WHAT THIS CAN PROVE: what the migration file and its apply, rollback and harness files say. CI has no database.
 * Behaviour is proved by supabase/tests/backlog-4266/harness-4266.sql (controls and mutants in one rolled-back call).
 */

import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS = join(REPO, 'supabase/migrations');
const DIR = join(REPO, 'supabase/tests/backlog-4266');
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
const FILE = '20261123170000_backlog_4266_connect_notice_with_exchange.sql';
const RAW = read(join(MIGRATIONS, FILE));
const OLD_RAW = read(join(MIGRATIONS, '20261118180000_backlog_4263_ai_app_connect_notice.sql'));
const APPLY = read(join(DIR, 'apply-20261123170000.sql'));
const ROLLBACK = read(join(DIR, 'rollback-20261123170000.sql'));
const FACTS = JSON.parse(read(join(DIR, 'catalog-facts.json')));
const SIG_SPACED = 'public.mcp_exchange_code(text, bytea, text, text, text, text, bytea, bytea)';

function statementOf(sql: string): string {
  const m = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.mcp_exchange_code\([\s\S]*?AS \$fn\$[\s\S]*?\$fn\$;\n(?:(?:REVOKE|GRANT)[^\n]*\n)*/g)];
  if (m.length !== 1) throw new Error(`${m.length} statements`);
  return m[0][0];
}
const bodyOf = (stmt: string): string => {
  const m = /AS \$fn\$([\s\S]*?)\$fn\$;/.exec(stmt);
  if (!m) throw new Error('no body');
  return m[1];
};

const OLD = statementOf(OLD_RAW);
const NEW = statementOf(RAW);
const OLD_BLOCK =
  '  -- 4263 PR-10.7: one notice for the connection that just turned active, read later by the email job. In its own\n' +
  '  -- block: any error here discards the notice only; the exchange and its answer are unchanged.\n' +
  '  BEGIN\n' +
  '    INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced)\n' +
  '    SELECT c.user_id, c.provider, v_n > 0 FROM public.mcp_connections c WHERE c.id = v_code.connection_id;   /*NOTICE:exchange*/\n' +
  '  EXCEPTION WHEN OTHERS THEN\n' +
  '    NULL;\n' +
  '  END;\n';
const NEW_BLOCK =
  '  -- 4266: one notice for the connection that just turned active, read later by the email job. Written in the same\n' +
  '  -- transaction as the tokens; exactly one row or the exchange raises MC004 and nothing of it is kept.\n' +
  '  INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced)\n' +
  '  SELECT c.user_id, c.provider, v_n > 0 FROM public.mcp_connections c WHERE c.id = v_code.connection_id;   /*NOTICE:exchange*/\n' +
  '  GET DIAGNOSTICS v_k = ROW_COUNT;\n' +
  '  IF v_k IS DISTINCT FROM 1 THEN   /*NOTICE:count*/\n' +
  "    RAISE EXCEPTION USING ERRCODE = 'MC004', MESSAGE = 'mcp connect notice not written';\n" +
  '  END IF;\n';
const OLD_MD5 = '9a33bff2db31288bd77a57489558a65b';

describe('BACKLOG-4266 migration 20261123170000', () => {
  it('is the only file with its version and replaces exactly one function', () => {
    expect(readdirSync(MIGRATIONS).filter((f) => f.startsWith('20261123170000'))).toEqual([FILE]);
    expect([...RAW.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/g)].map((m) => m[1])).toEqual(['mcp_exchange_code']);
    expect(RAW).not.toMatch(/DROP |CREATE TABLE|ALTER TABLE|CREATE POLICY|TO PUBLIC|TO authenticated|TO service_role|cron\.|\bBEGIN\s*;|\bCOMMIT\s*;/);
  });

  it('sets lock_timeout as its first statement', () => {
    const code = RAW.replace(/--[^\n]*\n/g, '\n').trimStart();
    expect(code.startsWith("SET LOCAL lock_timeout = '3s';\n")).toBe(true);
    expect(RAW.split("SET LOCAL lock_timeout = '3s';")).toHaveLength(2);
  });

  it('the exchange equals the 20261118180000 statement with exactly three edits', () => {
    expect(md5(bodyOf(OLD))).toBe(OLD_MD5);
    const derived = OLD.replace('/*BODY:4263-10.7*/', '/*BODY:4266*/')
      .replace('  v_scope  text;\n', '  v_scope  text;\n  v_k      integer;\n')
      .replace(OLD_BLOCK, NEW_BLOCK);
    expect(OLD.split(OLD_BLOCK)).toHaveLength(2);
    expect(NEW).toBe(derived);
    expect(bodyOf(NEW)).not.toMatch(/EXCEPTION\s+WHEN\s+OTHERS/i);
    expect(md5(bodyOf(NEW))).toBe(FACTS.exchange_md5_after);
  });

  it('keeps the signature, SECURITY DEFINER, empty search_path and the grants exactly as 20261118180000 wrote them', () => {
    const head = (s: string): string => s.slice(0, s.indexOf(' AS $fn$'));
    expect(head(NEW)).toBe(head(OLD));
    const grants = (s: string): string[] => s.split('\n').filter((l) => /^(REVOKE|GRANT) /.test(l));
    expect(grants(NEW)).toEqual(grants(OLD));
    expect(grants(NEW)).toEqual([
      `REVOKE ALL ON FUNCTION ${SIG_SPACED} FROM PUBLIC, anon, authenticated, service_role;`,
      `GRANT EXECUTE ON FUNCTION ${SIG_SPACED} TO anon;`,
    ]);
    const above = RAW.slice(0, RAW.indexOf('CREATE OR REPLACE FUNCTION public.mcp_exchange_code(')).trimEnd().split('\n').pop() ?? '';
    expect(above).toMatch(/^-- Intentionally callable by anon: \S/);
  });

  it('pre-check accepts only the old or this body; post-check pins this body, owner and grants', () => {
    const newMd5 = md5(bodyOf(NEW));
    expect(RAW).toContain(`v_md5 IS NULL OR v_md5 NOT IN ('${OLD_MD5}', '${newMd5}')`);
    const pre = RAW.indexOf('DO $pre4266$');
    expect(pre).toBeGreaterThan(RAW.indexOf("SET LOCAL lock_timeout = '3s';"));
    expect(pre).toBeLessThan(RAW.indexOf('CREATE OR REPLACE FUNCTION public.mcp_exchange_code('));
    const post = RAW.slice(RAW.indexOf('DO $post4266$'));
    expect(post).toContain(`md5(p.prosrc) = '${newMd5}'`);
    expect(post).toContain("p.proowner = 'postgres'::regrole::oid");
    expect(post).toContain("= ARRAY['anon', 'postgres']");
    expect(post).toContain('NOT c.relforcerowsecurity');
  });

  it('the apply file is the migration verbatim plus its ledger row', () => {
    expect(APPLY.split(RAW)).toHaveLength(2);
    expect(APPLY).toContain("VALUES ('20261123170000', 'backlog_4266_connect_notice_with_exchange', ARRAY[]::text[]);");
    expect(md5(APPLY)).toBe(FACTS.apply_md5);
  });

  it('the rollback sets lock_timeout first, refuses unless this body is live, restores 20261118180000 byte-for-byte', () => {
    const code = ROLLBACK.replace(/--[^\n]*\n/g, '\n').trimStart();
    expect(code.startsWith("SET LOCAL lock_timeout = '3s';\n")).toBe(true);
    expect(ROLLBACK.split(OLD)).toHaveLength(2);
    expect(ROLLBACK).toContain(`IF v_md5 IS DISTINCT FROM '${md5(bodyOf(NEW))}' THEN`);
    expect(ROLLBACK).toContain("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261123170000';");
    expect(ROLLBACK.slice(ROLLBACK.indexOf('DO $post4266r$'))).toContain(`md5(p.prosrc) = '${OLD_MD5}'`);
    expect(md5(ROLLBACK)).toBe(FACTS.rollback_md5);
  });

  it('the harness files are the ones the generator wrote, each with the test-database guard once', () => {
    for (const f of ['harness-4266.sql', 'harness-4266-structure.sql', 'harness-4266-fixtures.sql']) {
      const t = read(join(DIR, f));
      expect(md5(t)).toBe(FACTS.files[f]);
      expect(t.split("md5(u.id::text) = '53a385187695375e2e8695625a20a77a'")).toHaveLength(2);
    }
    const full = read(join(DIR, 'harness-4266.sql'));
    expect(full.split(APPLY)).toHaveLength(2);
    expect(Object.keys(FACTS.mutants)).toEqual(expect.arrayContaining(['M01_swallow_restored', 'M03_reraised_as_mc001', 'M04_no_row_count_check',
      'M05_token_fail_answer', 'M02_warning_then_continue', 'N01_noop_probe']));
  });
});
