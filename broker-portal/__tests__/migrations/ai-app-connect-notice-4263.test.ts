/**
 * BACKLOG-4263 PR-10.7 — CI tripwire for the AI-app connect notice migration (20261118180000).
 *
 * WHAT THIS CAN PROVE: what the migration file and its apply and rollback files say. CI has no database.
 * Behaviour is proved by supabase/tests/backlog-4263-notice/harness-notice.sql (controls and mutations in one
 * rolled-back call on the test project).
 */

import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS = join(REPO, 'supabase/migrations');
const FILE = join(MIGRATIONS, '20261118180000_backlog_4263_ai_app_connect_notice.sql');
const PR5 = join(MIGRATIONS, '20261118130000_backlog_4263_mcp_todo_write_tools.sql');
const DIR = join(REPO, 'supabase/tests/backlog-4263-notice');
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
const RAW = read(FILE);
const APPLY = read(join(DIR, 'apply-20261118180000.sql'));
const ROLLBACK = read(join(DIR, 'rollback-20261118180000.sql'));
const FACTS = JSON.parse(read(join(DIR, 'catalog-facts.json')));

/** The CREATE OR REPLACE statement of a function and the REVOKE/GRANT lines after it. */
function statementOf(sql: string, name: string): string {
  const m = [...sql.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$fn\\$[\\s\\S]*?\\$fn\\$;\\n(?:(?:REVOKE|GRANT)[^\\n]*\\n)*`, 'g'))];
  if (m.length !== 1) throw new Error(`${name}: ${m.length} statements`);
  return m[0][0];
}
const bodyOf = (stmt: string): string => {
  const m = /AS \$fn\$([\s\S]*?)\$fn\$;/.exec(stmt);
  if (!m) throw new Error('no body');
  return m[1];
};

const EXCHANGE = statementOf(RAW, 'mcp_exchange_code');
const OLD_EXCHANGE = statementOf(read(PR5), 'mcp_exchange_code');
const CLAIM = statementOf(RAW, 'ai_app_notice_claim');
const DONE = statementOf(RAW, 'ai_app_notice_done');
const TABLE = RAW.slice(RAW.indexOf('CREATE TABLE IF NOT EXISTS public.ai_app_connect_notices ('), RAW.indexOf('CREATE INDEX IF NOT EXISTS ai_app_connect_notices_due_idx'));
const RETURN_LINE = "  RETURN jsonb_build_object('ok', true, 'token_type', 'Bearer', 'expires_in', 3600, 'scope', v_scope);   /*SCOPE:exchange*/\n";

describe('BACKLOG-4263 AI-app connect notice migration file', () => {
  it('is the only file with its version and creates exactly the expected objects', () => {
    expect(readdirSync(MIGRATIONS).filter((f) => f.startsWith('20261118180000'))).toHaveLength(1);
    expect([...RAW.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/g)].map((m) => m[1])).toEqual([
      'mcp_exchange_code',
      'ai_app_notice_claim',
      'ai_app_notice_done',
    ]);
    expect([...RAW.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1])).toEqual(['ai_app_connect_notices']);
    expect(RAW).not.toMatch(/DROP |CREATE POLICY|pg_cron|cron\.schedule|net\.http|\bBEGIN\s*;|\bCOMMIT\s*;/);
  });

  it('the table has no column for app-supplied text, no token and no connection id', () => {
    const cols = [...TABLE.matchAll(/^ {2}(\w+) +\w+/gm)].map((m) => m[1]);
    expect(cols).toEqual(['id', 'user_id', 'provider', 'replaced', 'connected_at', 'status', 'attempts', 'lease_until', 'sent_at', 'last_error']);
    expect(TABLE).not.toMatch(/client_name|redirect|token|connection_id|email|REFERENCES public\./);
    expect(TABLE).toContain("provider     text NOT NULL CHECK (provider IN ('anthropic', 'openai')),");
    expect(TABLE).toContain('user_id      uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,');
    expect(TABLE).toContain('CHECK (last_error IS NULL OR char_length(last_error) <= 40)');
  });

  it('closes the table: RLS on, no policy, every API role revoked, no TRUNCATE for anon or authenticated', () => {
    expect(RAW).toContain('ALTER TABLE public.ai_app_connect_notices ENABLE ROW LEVEL SECURITY;');
    expect(RAW).toContain('REVOKE ALL ON TABLE public.ai_app_connect_notices FROM PUBLIC, anon, authenticated, service_role;');
    expect(RAW).toContain('REVOKE TRUNCATE ON TABLE public.ai_app_connect_notices FROM anon, authenticated;');
    expect(RAW).not.toMatch(/GRANT [A-Z, ]+ ON (?:TABLE )?public\.ai_app_connect_notices/);
  });

  it('the exchange differs from 20261118130000 only by its marker, its comment and the notice block before the RETURN', () => {
    const block = EXCHANGE.slice(EXCHANGE.indexOf('  -- 4263 PR-10.7: one notice'), EXCHANGE.indexOf(RETURN_LINE));
    expect(block.length).toBeGreaterThan(0);
    const back = EXCHANGE.replace(block, '')
      .replace('/*BODY:4263-10.7*/', '/*BODY:4263-5*/')
      .replace(' 4263 PR-10.7: records one notice when the connection turns active.', '');
    expect(back).toBe(OLD_EXCHANGE);
  });

  it('the notice insert sits in its own block that swallows any error, after the tokens are stored', () => {
    const b = bodyOf(EXCHANGE);
    const ins = b.indexOf('INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced)');
    expect(b.split('INSERT INTO public.ai_app_connect_notices')).toHaveLength(2);
    const blockStart = b.lastIndexOf('  BEGIN\n', ins);
    expect(b.slice(blockStart, ins)).toBe('  BEGIN\n    ');
    expect(b.slice(ins)).toMatch(/^INSERT [^;]*;   \/\*NOTICE:exchange\*\/\n {2}EXCEPTION WHEN OTHERS THEN\n {4}NULL;\n {2}END;\n/);
    expect(ins).toBeGreaterThan(b.indexOf("RAISE EXCEPTION USING ERRCODE = 'MC001'"));
    expect(ins).toBeLessThan(b.indexOf(RETURN_LINE.trim()));
    expect(b).toContain('SELECT c.user_id, c.provider, v_n > 0 FROM public.mcp_connections c WHERE c.id = v_code.connection_id;');
    expect(b.indexOf('GET DIAGNOSTICS v_n = ROW_COUNT;')).toBeLessThan(ins);
  });

  it('keeps the exchange anon-callable, portal secret checked first, grants restated', () => {
    const sig = 'public.mcp_exchange_code(text, bytea, text, text, text, text, bytea, bytea)';
    expect(EXCHANGE).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(EXCHANGE).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO anon;`);
    const above = RAW.slice(0, RAW.indexOf('CREATE OR REPLACE FUNCTION public.mcp_exchange_code(')).trimEnd().split('\n').pop() ?? '';
    expect(above).toMatch(/^-- Intentionally callable by anon: \S/);
    expect(bodyOf(EXCHANGE)).toMatch(/\nBEGIN\n {2}\/\*BODY:4263-10\.7\*\/\n {2}IF public\._mcp_secret_ok\(p_secret\) IS NOT TRUE THEN\n/);
  });

  it('grants claim and done to service_role only, and each checks its caller inside', () => {
    for (const [stmt, sig, tag] of [
      [CLAIM, 'public.ai_app_notice_claim(integer)', 'claim'],
      [DONE, 'public.ai_app_notice_done(uuid, integer, text, text)', 'done'],
    ]) {
      expect(stmt).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`);
      expect([...stmt.matchAll(/GRANT EXECUTE ON FUNCTION [^;]* TO (\w+);/g)].map((m) => m[1])).toEqual(['service_role']);
      expect(stmt).toMatch(/LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS \$fn\$/);
      expect(bodyOf(stmt).trimStart()).toMatch(
        new RegExp(`^DECLARE\\n[\\s\\S]*?\\nBEGIN\\n {2}IF auth\\.role\\(\\) IS DISTINCT FROM 'service_role' THEN {3}/\\*CALLER:${tag}\\*/\\n {4}RAISE EXCEPTION 'Unauthorized';\\n {2}END IF;\\n`),
      );
    }
    expect(RAW).not.toMatch(/GRANT [^;]* TO (?:anon|authenticated|PUBLIC)[,;][^\n]*ai_app/);
  });

  it('claim: capped, leased, skips locked rows, never returns an email', () => {
    const b = bodyOf(CLAIM);
    expect(b).toContain('LIMIT least(greatest(coalesce(p_limit, 0), 0), 50)');
    expect(b).toContain("lease_until = now() + interval '5 minutes'");
    expect(b).toContain('AND x.attempts < 5');
    expect(b).toContain("x.connected_at >= now() - interval '2 days'");
    expect(b).toContain("x.connected_at < now() - interval '30 days'");
    expect(b.match(/FOR UPDATE SKIP LOCKED/g)).toHaveLength(4);
    expect(b).toContain(
      "jsonb_build_object('id', u.id, 'user_id', u.user_id, 'provider', u.provider, 'replaced', u.replaced,\n                                               'connected_at', u.connected_at, 'attempts', u.attempts)",
    );
    expect(b).not.toMatch(/email|auth\.users/);
  });

  it('done: guarded on attempts and on due; status vocabulary; error cut to 40', () => {
    const b = bodyOf(DONE);
    expect(b).toContain("IF (p_status IN ('due', 'sent', 'queued', 'failed', 'skipped')) IS NOT TRUE THEN");
    expect(b).toContain('AND n.attempts = p_attempts');
    expect(b).toContain("AND n.status = 'due';");
    expect(b).toContain('last_error = left(p_error, 40)');
  });

  it('the pre-check and post-check name the old and the new exchange body md5', () => {
    const oldMd5 = md5(bodyOf(OLD_EXCHANGE));
    const newMd5 = md5(bodyOf(EXCHANGE));
    expect(FACTS.exchange_md5_before).toBe(oldMd5);
    expect(FACTS.exchange_md5_after).toBe(newMd5);
    expect(RAW).toContain(`v_md5 NOT IN ('${oldMd5}', '${newMd5}')`);
    expect(RAW).toContain(`md5(p.prosrc) = '${newMd5}'`);
  });
});

describe('BACKLOG-4263 AI-app connect notice locks and assumptions', () => {
  it('bounds the wait for the auth.users lock: lock_timeout after the pre-check, before CREATE TABLE', () => {
    const pre = RAW.indexOf('$pre4263notice$;');
    const lt = RAW.indexOf("SET LOCAL lock_timeout = '3s';");
    expect(pre).toBeGreaterThan(-1);
    expect(RAW.split("SET LOCAL lock_timeout = '3s';")).toHaveLength(2);
    expect(pre < lt && lt < RAW.indexOf('CREATE TABLE IF NOT EXISTS public.ai_app_connect_notices')).toBe(true);
    const rl = ROLLBACK.indexOf("SET LOCAL lock_timeout = '3s';");
    expect(rl).toBeGreaterThan(-1);
    expect(rl).toBeLessThan(ROLLBACK.indexOf('DROP FUNCTION public.ai_app_notice_claim(integer);'));
    expect(rl).toBeLessThan(ROLLBACK.indexOf('DROP TABLE public.ai_app_connect_notices;'));
  });

  it('the stale skip leaves a row with a live lease alone', () => {
    const b = bodyOf(CLAIM);
    const stale = b.slice(b.indexOf("SET status = 'skipped'"), b.indexOf("SET status = 'failed'"));
    expect(stale).toContain("x.connected_at < now() - interval '2 days'");
    expect(stale).toContain('AND (x.lease_until IS NULL OR x.lease_until <= now())   /*LEASE:stale*/');
  });

  it("the migration's own post-check compares the 17 anon-callable mcp names", () => {
    const post = RAW.slice(RAW.indexOf('DO $post4263notice$'));
    expect(FACTS.anon_callable_mcp).toHaveLength(17);
    const listed = [...post.matchAll(/'(mcp_\w+\([^)]*\))'/g)].map((m) => m[1]);
    expect(listed).toEqual([...(FACTS.anon_callable_mcp as string[])].sort());
    expect(post).toContain("(v ->> 'anon_mcp')::boolean IS NOT TRUE");
  });

  it('the redirect allowlist is keyed by redirect_uri alone (the assumption behind replaced)', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    const defs = files.filter((f) => read(join(MIGRATIONS, f)).includes('CREATE TABLE IF NOT EXISTS public.mcp_redirect_allowlist ('));
    expect(defs).toEqual(['20261112170000_backlog_4238_mcp_oauth_server.sql']);
    expect(read(join(MIGRATIONS, defs[0]))).toContain('  redirect_uri text PRIMARY KEY CHECK');
    const altered = files.filter((f) => /ALTER TABLE (?:IF EXISTS )?(?:ONLY )?public\.mcp_redirect_allowlist (?!ENABLE ROW LEVEL SECURITY)/.test(read(join(MIGRATIONS, f))));
    expect(altered).toEqual([]);
  });
});

describe('BACKLOG-4263 AI-app connect notice apply and rollback files', () => {
  it('the apply file holds the migration verbatim, the ledger row and the post-check', () => {
    expect(APPLY).toContain(RAW);
    expect(APPLY).toContain("VALUES ('20261118180000', 'backlog_4263_ai_app_connect_notice', ARRAY[]::text[]);");
    expect(APPLY).toContain('APPLY POST-CHECK 20261118180000 FAILED');
    expect(FACTS.migration_md5).toBe(md5(RAW));
    expect(FACTS.apply_md5).toBe(md5(APPLY));
  });

  it('the rollback puts back the exchange of 20261118130000 exactly, drops the new objects and the ledger row', () => {
    expect(statementOf(ROLLBACK, 'mcp_exchange_code')).toBe(OLD_EXCHANGE);
    expect(ROLLBACK).toContain(`IS DISTINCT FROM '${md5(bodyOf(EXCHANGE))}'`);
    expect(ROLLBACK).toContain('DROP FUNCTION public.ai_app_notice_claim(integer);');
    expect(ROLLBACK).toContain('DROP FUNCTION public.ai_app_notice_done(uuid, integer, text, text);');
    expect(ROLLBACK).toContain('DROP TABLE public.ai_app_connect_notices;');
    expect(ROLLBACK).toContain("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261118180000';");
    expect(FACTS.rollback_md5).toBe(md5(ROLLBACK));
  });

  it('pins the 17 anon-callable mcp functions', () => {
    expect(FACTS.anon_callable_mcp).toHaveLength(17);
    for (const f of FACTS.anon_callable_mcp as string[]) expect(APPLY).toContain(`'${f}'`);
  });
});
