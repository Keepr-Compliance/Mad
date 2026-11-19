/**
 * BACKLOG-4263 PR-10.4 — CI tripwire for the registration / refresh bounds and the unused-registration cleanup
 * (migration 20261118190000).
 *
 * WHAT THIS CAN PROVE: what the migration file and its apply and rollback files say. CI has no database.
 * Behaviour is proved by supabase/tests/backlog-4263-bounds/harness-bounds.sql (controls and mutations in one
 * rolled-back call on the test project).
 */

import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS = join(REPO, 'supabase/migrations');
const FILE = join(MIGRATIONS, '20261118190000_backlog_4263_mcp_register_refresh_bounds.sql');
const OAUTH = join(MIGRATIONS, '20261112170000_backlog_4238_mcp_oauth_server.sql');
const PR5 = join(MIGRATIONS, '20261118130000_backlog_4263_mcp_todo_write_tools.sql');
const DIR = join(REPO, 'supabase/tests/backlog-4263-bounds');
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
const RAW = read(FILE);
const APPLY = read(join(DIR, 'apply-20261118190000.sql'));
const ROLLBACK = read(join(DIR, 'rollback-20261118190000.sql'));
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
/** Replace exactly one occurrence, failing when the text is absent or repeated. */
function once(s: string, from: string, to: string): string {
  expect(s.split(from)).toHaveLength(2);
  return s.replace(from, to);
}

const REGISTER = statementOf(RAW, 'mcp_register_client');
const REFRESH = statementOf(RAW, 'mcp_refresh');
const CLEANUP = statementOf(RAW, '_mcp_prune_unused_clients');
const OLD_REGISTER = statementOf(read(OAUTH), 'mcp_register_client');
const OLD_REFRESH = statementOf(read(PR5), 'mcp_refresh');

const DAY_BLOCK =
  "  IF v_b IS NOT DISTINCT FROM 'ok' THEN\n" +
  "    v_b := public._mcp_bump('reg_ip_day:' || encode(p_ip_sha256, 'hex'), interval '1 day', 200);   /*BOUND:reg_ip_day*/\n" +
  '  END IF;\n';
const REFRESH_BOUND =
  '  -- 4263 PR-10.4: at most 60 refreshes per connection per hour. Over the bound this block is rolled back: no token\n' +
  '  -- is issued and the presented refresh token stays unused.\n' +
  "  IF public._mcp_bump('refresh_conn:' || v_conn::text, interval '1 hour', 60) IS DISTINCT FROM 'ok' THEN   /*BOUND:refresh_conn*/\n" +
  "    RAISE EXCEPTION USING ERRCODE = 'MC003', MESSAGE = 'mcp refresh bound reached';\n" +
  '  END IF;\n\n';
const REFRESH_HANDLER = "  WHEN SQLSTATE 'MC003' THEN\n    RETURN public._mcp_refuse('rate_limited');   /*REFUSE:refresh_conn*/\n";

describe('BACKLOG-4263 registration and refresh bounds migration file', () => {
  it('is the only file with its version and creates exactly the expected functions and one cron job', () => {
    expect(readdirSync(MIGRATIONS).filter((f) => f.startsWith('20261118190000'))).toHaveLength(1);
    expect([...RAW.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/g)].map((m) => m[1])).toEqual([
      'mcp_register_client',
      'mcp_refresh',
      '_mcp_prune_unused_clients',
    ]);
    expect(RAW).not.toMatch(/DROP |CREATE TABLE|ALTER TABLE|CREATE POLICY|net\.http|\bBEGIN\s*;|\bCOMMIT\s*;/);
    expect(RAW.match(/cron\.schedule\(/g)).toHaveLength(1);
    expect(RAW).toContain("PERFORM cron.schedule('mcp-unused-client-prune', '53 3 * * *', 'SELECT public._mcp_prune_unused_clients()');");
  });

  it('registration differs from 20261112170000 only by its marker, the daily bound per address and the global bound', () => {
    let back = once(REGISTER, '  /*BODY:4263-10.4-register*/\n', '');
    back = once(back, DAY_BLOCK, '');
    back = once(back, "v_b := public._mcp_bump('reg_all', interval '1 day', 5000);   /*BOUND:reg_all*/", "v_b := public._mcp_bump('reg_all', interval '1 day', 500);");
    expect(back).toBe(OLD_REGISTER);
  });

  it('registration: the portal secret is checked before any counter; reg_ip, then reg_ip_day, then reg_all', () => {
    const b = bodyOf(REGISTER);
    expect(b).toMatch(/\nBEGIN\n {2}\/\*BODY:4263-10\.4-register\*\/\n {2}IF public\._mcp_secret_ok\(p_secret\) IS NOT TRUE THEN\n {4}RETURN public\._mcp_refuse\('invalid_client_metadata'\);\n/);
    const secret = b.indexOf('public._mcp_secret_ok(p_secret)');
    const bumps = [...b.matchAll(/public\._mcp_bump\(/g)].map((m) => m.index ?? -1);
    expect(bumps).toHaveLength(3);
    for (const i of bumps) expect(i).toBeGreaterThan(secret);
    const ip = b.indexOf("'reg_ip:' || encode(p_ip_sha256, 'hex'), interval '1 hour', 60)");
    const day = b.indexOf("'reg_ip_day:' || encode(p_ip_sha256, 'hex'), interval '1 day', 200)");
    const all = b.indexOf("'reg_all', interval '1 day', 5000)");
    expect(ip).toBeGreaterThan(secret);
    expect(ip < day && day < all).toBe(true);
    expect(b).toContain("RETURN public._mcp_refuse(coalesce(v_b, 'busy'));");
  });

  it('refresh differs from 20261118130000 only by its marker, the bound and its refusal', () => {
    let back = once(REFRESH, '/*BODY:4263-10.4-refresh*/', '/*BODY:4263-5*/');
    back = once(back, REFRESH_BOUND, '');
    back = once(back, REFRESH_HANDLER, '');
    expect(back).toBe(OLD_REFRESH);
  });

  it('refresh: the bound is counted only after the presented token was accepted, inside the block that a refusal rolls back', () => {
    const b = bodyOf(REFRESH);
    const update = b.indexOf('UPDATE public.mcp_tokens t\n     SET used_at = now()');
    const invalid = b.indexOf("    RETURN public._mcp_token_fail(p_client_id, 'invalid_grant');\n  END IF;\n");
    const bound = b.indexOf("public._mcp_bump('refresh_conn:' || v_conn::text, interval '1 hour', 60)");
    const insert = b.indexOf('INSERT INTO public.mcp_tokens');
    const blockStart = b.indexOf('  -- token insert failure: everything in this block is rolled back');
    expect(blockStart > -1 && blockStart < update).toBe(true);
    expect(update < invalid && invalid < bound && bound < insert).toBe(true);
    expect(b.match(/_mcp_bump\(/g)).toHaveLength(1);
    expect(b.match(/'MC003'/g)).toHaveLength(2);
    expect(b).toContain("EXCEPTION WHEN SQLSTATE 'MC001' THEN\n    RETURN public._mcp_token_fail(p_client_id, 'invalid_request');\n" + REFRESH_HANDLER + '  END;\nEND\n');
    expect(b).not.toMatch(/tok_fail/);
  });

  it('keeps both replaced functions anon-callable with the grants restated and the marker comment above', () => {
    for (const [stmt, name, sig] of [
      [REGISTER, 'mcp_register_client', 'public.mcp_register_client(text, text, text, text[], bytea)'],
      [REFRESH, 'mcp_refresh', 'public.mcp_refresh(text, bytea, text, text, bytea, bytea)'],
    ]) {
      expect(stmt).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`);
      expect([...stmt.matchAll(/GRANT EXECUTE ON FUNCTION [^;]* TO (\w+);/g)].map((m) => m[1])).toEqual(['anon']);
      expect(stmt).toMatch(/LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS \$fn\$/);
      const above = RAW.slice(0, RAW.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)).trimEnd().split('\n').pop() ?? '';
      expect(above).toMatch(/^-- Intentionally callable by anon: \S/);
    }
  });

  it('cleanup: no API grant, definer with an empty search path, volatile', () => {
    expect(CLEANUP).toContain('REVOKE ALL ON FUNCTION public._mcp_prune_unused_clients() FROM PUBLIC, anon, authenticated, service_role;');
    expect(CLEANUP).not.toMatch(/GRANT/);
    expect(RAW).not.toMatch(/GRANT [^;]*_mcp_prune_unused_clients/);
    expect(CLEANUP).toMatch(/^CREATE OR REPLACE FUNCTION public\._mcp_prune_unused_clients\(\)\nRETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS \$fn\$/);
  });

  it('cleanup: candidates capped at 500; each locked FOR UPDATE SKIP LOCKED, then checked again in the delete', () => {
    const b = bodyOf(CLEANUP);
    expect(b).toContain('LIMIT 500   /*CAP:run*/');
    expect(b).toContain('ORDER BY k.created_at, k.client_id');
    const lock = b.indexOf('FOR UPDATE SKIP LOCKED;   /*LOCK:client*/');
    const skip = b.indexOf('CONTINUE WHEN v_lock IS NULL;');
    const del = b.indexOf('DELETE FROM public.mcp_oauth_clients k');
    expect(lock > -1 && lock < skip && skip < del).toBe(true);
    expect(b.match(/DELETE /g)).toHaveLength(1);
    const recheck = b.slice(del, b.indexOf(';', b.indexOf('/*RECHECK:connections*/')));
    expect(recheck).toContain('WHERE k.client_id = v_lock');
    expect(recheck).toContain("AND k.created_at < now() - interval '30 days'");
    expect(recheck).toContain('AND NOT EXISTS (SELECT 1 FROM public.mcp_connections c WHERE c.client_id = k.client_id)');
    expect(recheck).toContain('AND NOT EXISTS (SELECT 1 FROM public.mcp_authorization_requests r WHERE r.client_id = k.client_id)');
    expect(recheck).not.toMatch(/status/);
    const select = b.slice(b.indexOf('FOR v_id IN'), lock);
    expect(select).toContain("WHERE k.created_at < now() - interval '30 days'");
    expect(select).toContain('AND NOT EXISTS (SELECT 1 FROM public.mcp_connections c WHERE c.client_id = k.client_id)');
    expect(select).toContain('AND NOT EXISTS (SELECT 1 FROM public.mcp_authorization_requests r WHERE r.client_id = k.client_id)');
    expect(select).not.toMatch(/status/);
  });

  it('cleanup: deletes nothing when a third table references mcp_oauth_clients', () => {
    const b = bodyOf(CLEANUP);
    const guard = b.indexOf("k.confrelid = 'public.mcp_oauth_clients'::regclass");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(b.indexOf('FOR v_id IN'));
    expect(b).toContain(
      "AND k.conrelid NOT IN ('public.mcp_connections'::regclass, 'public.mcp_authorization_requests'::regclass)) THEN   /*GUARD:children*/\n    RETURN 0;",
    );
  });

  it('pre-check and post-check name the old and the new body md5 of each function', () => {
    const r = [md5(bodyOf(OLD_REGISTER)), md5(bodyOf(REGISTER))];
    const f = [md5(bodyOf(OLD_REFRESH)), md5(bodyOf(REFRESH))];
    expect([FACTS.register_md5_before, FACTS.register_md5_after]).toEqual(r);
    expect([FACTS.refresh_md5_before, FACTS.refresh_md5_after]).toEqual(f);
    expect(FACTS.cleanup_md5).toBe(md5(bodyOf(CLEANUP)));
    expect(RAW).toContain(`v_r NOT IN ('${r[0]}', '${r[1]}')`);
    expect(RAW).toContain(`v_f NOT IN ('${f[0]}', '${f[1]}')`);
    expect(RAW).toContain(`md5(p.prosrc) = '${r[1]}'`);
    expect(RAW).toContain(`md5(p.prosrc) = '${f[1]}'`);
    expect(RAW).toContain(`md5(p.prosrc) = '${md5(bodyOf(CLEANUP))}'`);
  });
});

describe('BACKLOG-4263 registration and refresh bounds: locks and post-check', () => {
  it('sets lock_timeout after the pre-check and before the first replaced function', () => {
    const pre = RAW.indexOf('$pre4263bounds$;');
    const lt = RAW.indexOf("SET LOCAL lock_timeout = '3s';");
    expect(RAW.split("SET LOCAL lock_timeout = '3s';")).toHaveLength(2);
    expect(pre > -1 && pre < lt && lt < RAW.indexOf('CREATE OR REPLACE FUNCTION public.mcp_register_client(')).toBe(true);
    expect(RAW.slice(0, pre)).toContain("IF to_regclass('cron.job') IS NULL THEN");
  });

  it("the migration's own post-check: the 17 anon-callable names, the two child tables, the cron job", () => {
    const post = RAW.slice(RAW.indexOf('DO $post4263bounds$'));
    expect(FACTS.anon_callable_mcp).toHaveLength(17);
    const listed = [...post.matchAll(/'(mcp_\w+\([^)]*\))'/g)].map((m) => m[1]);
    expect(listed).toEqual([...(FACTS.anon_callable_mcp as string[])].sort());
    expect(post).toContain("= ARRAY['public.mcp_authorization_requests', 'public.mcp_connections']");
    expect(post).toContain("(SELECT count(*) FROM cron.job j WHERE j.jobname = 'mcp-unused-client-prune') = 1");
    expect(post).toContain("j.username = 'postgres' AND j.active");
    for (const k of ['register', 'refresh', 'prune', 'children', 'cron', 'anon_mcp']) expect(post).toContain(`(v ->> '${k}')::boolean IS NOT TRUE`);
  });
});

describe('BACKLOG-4263 registration and refresh bounds: apply and rollback files', () => {
  it('the apply file holds the migration verbatim, the ledger row and the post-check', () => {
    expect(APPLY).toContain(RAW);
    expect(APPLY).toContain("VALUES ('20261118190000', 'backlog_4263_mcp_register_refresh_bounds', ARRAY[]::text[]);");
    expect(APPLY).toContain('APPLY POST-CHECK 20261118190000 FAILED');
    expect(FACTS.migration_md5).toBe(md5(RAW));
    expect(FACTS.apply_md5).toBe(md5(APPLY));
  });

  it('the rollback unschedules the job, drops the cleanup, puts back both bodies exactly, deletes only the two new buckets', () => {
    expect(statementOf(ROLLBACK, 'mcp_register_client')).toBe(OLD_REGISTER);
    expect(statementOf(ROLLBACK, 'mcp_refresh')).toBe(OLD_REFRESH);
    const lt = ROLLBACK.indexOf("SET LOCAL lock_timeout = '3s';");
    const unschedule = ROLLBACK.indexOf("PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'mcp-unused-client-prune';");
    const drop = ROLLBACK.indexOf('DROP FUNCTION public._mcp_prune_unused_clients();');
    expect(lt > -1 && lt < unschedule && unschedule < drop).toBe(true);
    expect(drop).toBeLessThan(ROLLBACK.indexOf('CREATE OR REPLACE FUNCTION public.mcp_register_client('));
    expect(ROLLBACK).toContain("DELETE FROM public.mcp_rate_counters WHERE left(bucket, 11) = 'reg_ip_day:' OR left(bucket, 13) = 'refresh_conn:';");
    expect(ROLLBACK.match(/DELETE FROM public\.mcp_rate_counters/g)).toHaveLength(1);
    expect(ROLLBACK).toContain("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261118190000';");
    expect(ROLLBACK).toContain(`v_r IS DISTINCT FROM '${md5(bodyOf(REGISTER))}' OR v_f IS DISTINCT FROM '${md5(bodyOf(REFRESH))}'`);
    expect(FACTS.rollback_md5).toBe(md5(ROLLBACK));
  });
});
