/**
 * BACKLOG-4263 — CI tripwire for the list_deals address match migration (20261118160000).
 *
 * WHAT THIS CAN PROVE: what the migration file and its rollback say. CI has no database.
 * Behaviour is proved by supabase/tests/backlog-4263-addr/harness-addr.sql (controls and mutations in one
 * rolled-back call on the test project).
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const FILE = join(REPO, 'supabase/migrations/20261118160000_backlog_4263_mcp_list_deals_match.sql');
const CORE = join(REPO, 'supabase/migrations/20261118110000_backlog_4263_todo_server_core.sql');
const DIR = join(REPO, 'supabase/tests/backlog-4263-addr');
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
const RAW = read(FILE);
const ROLLBACK = read(join(DIR, 'rollback-20261118160000.sql'));
const APPLY = read(join(DIR, 'apply-20261118160000.sql'));
const FACTS = JSON.parse(read(join(DIR, 'catalog-facts.json')));

const SIG = 'public._mcp_r_list_deals(text, text, integer, timestamptz, uuid)';
const OLD_PRED = "AND (p_q IS NULL OR dl.property_address ILIKE '%' ||";
const NEW_PRED = "AND (p_q IS NULL OR public._mcp_clean(dl.property_address, 300) ILIKE '%' ||";

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
/** The address expression with its table alias replaced, so the filter and the answer can be compared as text. */
const addressExpr = (text: string, alias: string): string[] =>
  [...text.matchAll(new RegExp(`public\\._mcp_clean\\(${alias}\\.property_address, (\\d+)\\)`, 'g'))].map((m) => m[0].replace(`${alias}.`, 'X.'));

const NEW = statementOf(RAW, '_mcp_r_list_deals');
const OLD = statementOf(read(CORE), '_mcp_r_list_deals');

describe('BACKLOG-4263 list_deals address match migration file', () => {
  it('replaces exactly one function, _mcp_r_list_deals, and touches no other object', () => {
    const names = [...RAW.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(names).toEqual(['_mcp_r_list_deals']);
    expect(RAW).not.toMatch(/DROP |ALTER |CREATE TABLE|CREATE POLICY|CREATE INDEX|GRANT SELECT|INSERT INTO|UPDATE public|DELETE FROM/);
  });

  it('differs from the body of 20261118110000 in the address predicate only', () => {
    expect(OLD.split(OLD_PRED)).toHaveLength(2);
    expect(NEW).toBe(OLD.replace(OLD_PRED, NEW_PRED));
    expect(NEW).not.toContain('dl.property_address ILIKE');
  });

  it('the filter matches on the same expression and length the answer returns as address', () => {
    const body = bodyOf(NEW);
    const inFilter = addressExpr(body.slice(body.indexOf(NEW_PRED)), 'dl');
    const inAnswer = addressExpr(body.slice(body.indexOf("'address', ")), 'pr');
    expect(inFilter[0]).toBe('public._mcp_clean(X.property_address, 300)');
    expect(inFilter[0]).toBe(inAnswer[0]);
    expect(body).toContain("'address', public._mcp_clean(pr.property_address, 300),");
  });

  it('keeps the escaping of %, _ and \\ and the case-insensitive match', () => {
    expect(NEW).toContain(`${NEW_PRED} replace(replace(replace(p_q, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')`);
  });

  it('is created as mcp_reader, STABLE SECURITY DEFINER with an empty search_path, EXECUTE postgres only', () => {
    const i = RAW.indexOf('GRANT CREATE ON SCHEMA public TO mcp_reader;\nSET ROLE mcp_reader;');
    const j = RAW.indexOf('CREATE OR REPLACE FUNCTION public._mcp_r_list_deals(');
    const k = RAW.indexOf('RESET ROLE;\nREVOKE CREATE ON SCHEMA public FROM mcp_reader;');
    expect(i).toBeGreaterThan(-1);
    expect(i < j && j < k).toBe(true);
    expect(NEW).toContain("RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$");
    expect(NEW).toContain(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(NEW).toContain(`GRANT EXECUTE ON FUNCTION ${SIG} TO postgres;`);
  });

  it('the pre-check and post-check name the old and the new body md5', () => {
    const oldMd5 = md5(bodyOf(OLD));
    const newMd5 = md5(bodyOf(NEW));
    expect(FACTS.reader_md5_before).toBe(oldMd5);
    expect(FACTS.reader_md5_after).toBe(newMd5);
    expect(RAW).toContain(`v_md5 NOT IN ('${oldMd5}', '${newMd5}')`);
    expect(RAW).toContain(`md5(p.prosrc) = '${newMd5}' AS is_body`);
  });
});

describe('BACKLOG-4263 list_deals address match apply and rollback files', () => {
  it('the apply file holds the migration verbatim, the ledger row and the post-check', () => {
    expect(APPLY).toContain(RAW);
    expect(APPLY).toContain("VALUES ('20261118160000', 'backlog_4263_mcp_list_deals_match', ARRAY[]::text[]);");
    expect(APPLY).toContain('APPLY POST-CHECK 20261118160000 FAILED');
    expect(FACTS.migration_md5).toBe(md5(RAW));
    expect(FACTS.apply_md5).toBe(md5(APPLY));
  });

  it('the rollback puts back the body of 20261118110000 exactly and removes the ledger row', () => {
    expect(statementOf(ROLLBACK, '_mcp_r_list_deals')).toBe(OLD);
    expect(ROLLBACK).toContain("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261118160000';");
    expect(ROLLBACK).toContain(`IS DISTINCT FROM '${md5(bodyOf(NEW))}'`);
    expect(FACTS.rollback_md5).toBe(md5(ROLLBACK));
  });

  it('pins the 17 anon-callable mcp functions', () => {
    expect(FACTS.anon_callable_mcp).toHaveLength(17);
    for (const f of FACTS.anon_callable_mcp as string[]) expect(APPLY).toContain(`'${f}'`);
  });
});
