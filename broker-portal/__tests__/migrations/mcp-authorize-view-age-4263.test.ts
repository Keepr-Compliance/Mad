/**
 * BACKLOG-4263 — CI tripwire for the mcp_authorize_view age migration (20261118170000).
 *
 * WHAT THIS CAN PROVE: what the migration file and its apply and rollback files say. CI has no database.
 * Behaviour is proved by supabase/tests/backlog-4263-age/harness-age.sql (controls and mutations in one
 * rolled-back call on the test project).
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const FILE = join(REPO, 'supabase/migrations/20261118170000_backlog_4263_mcp_authorize_view_age.sql');
const PREV = join(REPO, 'supabase/migrations/20261118130000_backlog_4263_mcp_todo_write_tools.sql');
const DIR = join(REPO, 'supabase/tests/backlog-4263-age');
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
const RAW = read(FILE);
const ROLLBACK = read(join(DIR, 'rollback-20261118170000.sql'));
const APPLY = read(join(DIR, 'apply-20261118170000.sql'));
const FACTS = JSON.parse(read(join(DIR, 'catalog-facts.json')));

const SIG = 'public.mcp_authorize_view(text, bytea)';
const NONCE_LINE = "           'nonce', v_nonce,\n";
const AGE_LINE = "           'age_seconds', greatest(0, floor(extract(epoch FROM now() - v_req.created_at)))::int,\n";

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

const NEW = statementOf(RAW, 'mcp_authorize_view');
const OLD = statementOf(read(PREV), 'mcp_authorize_view');

describe('BACKLOG-4263 mcp_authorize_view age migration file', () => {
  it('replaces exactly one function, mcp_authorize_view, and touches no other object', () => {
    const names = [...RAW.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(names).toEqual(['mcp_authorize_view']);
    expect(RAW.replace(NEW, '')).not.toMatch(/DROP |ALTER |CREATE TABLE|CREATE POLICY|CREATE INDEX|INSERT INTO|UPDATE public|DELETE FROM|SET ROLE/);
  });

  it('equals the statement of 20261118130000 with only the age_seconds line added', () => {
    expect(OLD.split(NONCE_LINE)).toHaveLength(2);
    expect(NEW).toBe(OLD.replace(NONCE_LINE, NONCE_LINE + AGE_LINE));
  });

  it('measures the age on now(), the clock of the expiry check, never clock_timestamp()', () => {
    expect(RAW).not.toContain('clock_timestamp');
    expect(bodyOf(NEW)).toContain('AND r.expires_at > now()');
    expect(bodyOf(NEW).split("'age_seconds'")).toHaveLength(2);
  });

  it('keeps the signature and attributes and restates the grants', () => {
    expect(NEW).toContain(
      "CREATE OR REPLACE FUNCTION public.mcp_authorize_view(p_request_id text, p_browser_binding_sha256 bytea)\nRETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$",
    );
    expect(NEW).toContain(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC, anon, authenticated, service_role;\nGRANT EXECUTE ON FUNCTION ${SIG} TO authenticated;\n`);
    expect(RAW).not.toMatch(/TO anon|TO service_role|TO PUBLIC/);
  });

  it('the pre-check and post-check name the old and the new body md5', () => {
    const oldMd5 = md5(bodyOf(OLD));
    const newMd5 = md5(bodyOf(NEW));
    expect(FACTS.view_md5_before).toBe(oldMd5);
    expect(FACTS.view_md5_after).toBe(newMd5);
    expect(RAW.indexOf('DO $pre4263age$')).toBeLessThan(RAW.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(RAW).toContain(`v_md5 NOT IN ('${oldMd5}', '${newMd5}')`);
    expect(RAW).toContain(`md5(p.prosrc) = '${newMd5}' AS is_body`);
    expect(RAW).toContain("p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres}' AS is_acl");
  });
});

describe('BACKLOG-4263 mcp_authorize_view age apply and rollback files', () => {
  it('the apply file holds the migration verbatim, the ledger row and the post-check', () => {
    expect(APPLY).toContain(RAW);
    expect(APPLY).toContain("VALUES ('20261118170000', 'backlog_4263_mcp_authorize_view_age', ARRAY[]::text[]);");
    expect(APPLY).toContain('APPLY POST-CHECK 20261118170000 FAILED');
    expect(FACTS.migration_md5).toBe(md5(RAW));
    expect(FACTS.apply_md5).toBe(md5(APPLY));
  });

  it('the rollback puts back the statement of 20261118130000 exactly and removes the ledger row', () => {
    expect(statementOf(ROLLBACK, 'mcp_authorize_view')).toBe(OLD);
    expect(ROLLBACK).toContain("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261118170000';");
    expect(ROLLBACK).toContain(`IS DISTINCT FROM '${md5(bodyOf(NEW))}'`);
    expect(FACTS.rollback_md5).toBe(md5(ROLLBACK));
  });

  it('pins the 17 anon-callable mcp functions, mcp_authorize_view not among them', () => {
    expect(FACTS.anon_callable_mcp).toHaveLength(17);
    for (const f of FACTS.anon_callable_mcp as string[]) expect(APPLY).toContain(`'${f}'`);
    expect((FACTS.anon_callable_mcp as string[]).some((f) => f.startsWith('mcp_authorize_view('))).toBe(false);
  });
});
