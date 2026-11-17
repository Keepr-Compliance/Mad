/**
 * BACKLOG-4263 PR-1 — CI tripwire for the list_all_deals migration.
 *
 * WHAT THIS CAN PROVE: what the migration file and its rollback say. CI has no database.
 * Behaviour is proved by supabase/tests/backlog-4263/harness.py (controls and mutants in one
 * rolled-back call on the test project).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const FILE = join(REPO, 'supabase/migrations/20261118100000_backlog_4263_mcp_list_all_deals.sql');
const ROLLBACK = join(REPO, 'supabase/tests/backlog-4263/rollback-4263.sql');
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const statements = (raw: string): string =>
  raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
const RAW = read(FILE);
const SQL = statements(RAW);
const RB = statements(read(ROLLBACK));

const READER_SIG = 'public._mcp_r_list_all_deals(text, date, date, uuid)';
const TOOL_SIG = 'public.mcp_list_all_deals(text, bytea, text, text, text, text, text)';

function body(name: string): string {
  const m = [...SQL.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([^)]*\\)([\\s\\S]*?)AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;`, 'g'))];
  expect(m).toHaveLength(1);
  return `${m[0][1].trim()} AS ${m[0][2].trim()}`;
}

describe('BACKLOG-4263 migration file', () => {
  it('creates exactly the reader and the tool, and changes no other function', () => {
    const names = [...SQL.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(names).toEqual(['_mcp_r_list_all_deals', 'mcp_list_all_deals']);
    expect(SQL).not.toMatch(/DROP FUNCTION|ALTER FUNCTION|CREATE TABLE|ALTER TABLE public\.(?!mcp_call_log )/);
  });

  it('the reader is created as mcp_reader, STABLE SECURITY DEFINER with an empty search_path, EXECUTE postgres only', () => {
    const i = SQL.indexOf('SET ROLE mcp_reader;');
    const j = SQL.indexOf('CREATE OR REPLACE FUNCTION public._mcp_r_list_all_deals(');
    const k = SQL.indexOf('RESET ROLE;');
    expect(i).toBeGreaterThan(-1);
    expect(i < j && j < k).toBe(true);
    expect(body('_mcp_r_list_all_deals')).toMatch(/^RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS/);
    expect(SQL).toContain(`REVOKE ALL ON FUNCTION ${READER_SIG} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION ${READER_SIG} TO postgres;`);
    expect(SQL.match(/GRANT EXECUTE ON FUNCTION public\._mcp_r_list_all_deals/g)).toHaveLength(1);
    expect(SQL).toContain('REVOKE CREATE ON SCHEMA public FROM mcp_reader;');
  });

  it('the tool is anon only, documented as intentionally public, and checks the secret before anything else', () => {
    expect(RAW).toContain('-- Intentionally callable by anon: MCP tool call list_all_deals from the broker portal server');
    expect(SQL).toContain(`REVOKE ALL ON FUNCTION ${TOOL_SIG} FROM PUBLIC, anon, authenticated, service_role;`);
    expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION ${TOOL_SIG} TO anon;`);
    expect(SQL.match(/GRANT EXECUTE ON FUNCTION public\.mcp_list_all_deals/g)).toHaveLength(1);
    const b = body('mcp_list_all_deals');
    expect(b).toMatch(/^RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS/);
    const secret = b.indexOf('_mcp_secret_ok(p_secret)');
    const enter = b.indexOf("_mcp_enter(p_at_digest, p_resource, 'list_all_deals')");
    const ro = b.indexOf("set_config('transaction_read_only', 'on', true)");
    const read = b.indexOf('_mcp_r_list_all_deals(p_status');
    expect(secret).toBeGreaterThan(-1);
    expect(secret < enter && enter < ro && ro < read).toBe(true);
    expect(b).toContain("RAISE EXCEPTION USING ERRCODE = 'MC000'");
    expect(b).toContain("octet_length(v_res::text) > 90000 THEN 'too_large'");
    expect(b).toContain("_mcp_reader_ok('public._mcp_r_list_all_deals(text,date,date,uuid)'::regprocedure)");
  });

  it('the reader reads only cloud_deals, the owner\'s confirmed rows, keyset on id, bounded by bytes and rows', () => {
    const b = body('_mcp_r_list_all_deals');
    const tables = [...new Set([...b.matchAll(/public\.(cloud_\w+)/g)].map((m) => m[1]))];
    expect(tables).toEqual(['cloud_deals']);
    expect(b).toContain('dl.owner_user_id = v_uid /*OWN:all_deals*/ AND dl.is_confirmed /*CONF:all*/');
    expect(b).toContain('x.owner_user_id = v_uid /*OWN:all_inst*/');
    expect(b).toContain('dl.id > p_after_id) /*KEY:after*/');
    expect(b).toContain('ORDER BY dl.id /*ORDER:all*/');
    expect(b).toContain('s.rk <= 500 /*BOUND:rows*/ AND s.cum <= 85000 /*BOUND:bytes*/');
    expect(b).toContain('sum(octet_length(r.j::text) + 2)');
    expect(b).toContain('public._mcp_clean(c.property_address, 300)');
    expect(b).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  it('every number column keeps the JSON-number rule and the 30-character bound', () => {
    const b = body('_mcp_r_list_all_deals');
    for (const k of ['listing_price', 'sale_price', 'earnest_money_amount', 'commission_offered_rate', 'commission_actual_rate', 'commission_gross_amount']) {
      expect(b).toContain(`CASE WHEN jsonb_typeof(c.details -> '${k}') = 'number' AND octet_length(c.details ->> '${k}') <= 30 THEN c.details -> '${k}' END`);
    }
  });

  it('the tool CHECK keeps the four earlier tools and adds list_all_deals; the outcome CHECK is untouched', () => {
    expect(SQL).toContain(
      "CHECK (tool IS NULL OR tool IN ('get_status', 'list_deals', 'get_deal', 'get_deal_checklists', 'list_all_deals'))"
    );
    expect(SQL).not.toContain('mcp_call_log_outcome_check');
  });
});

describe('BACKLOG-4263 rollback file', () => {
  it('deletes the tool\'s log rows before restoring the earlier CHECK, drops both functions and the ledger row', () => {
    const del = RB.indexOf("DELETE FROM public.mcp_call_log WHERE tool = 'list_all_deals';");
    const add = RB.indexOf("CHECK (tool IS NULL OR tool IN ('get_status', 'list_deals', 'get_deal', 'get_deal_checklists'))");
    expect(del).toBeGreaterThan(-1);
    expect(del < add).toBe(true);
    expect(RB).toContain('DROP FUNCTION IF EXISTS public._mcp_r_list_all_deals(text, date, date, uuid)');
    expect(RB).toContain('DROP FUNCTION IF EXISTS public.mcp_list_all_deals(text, bytea, text, text, text, text, text);');
    expect(RB).toContain("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261118100000';");
  });
});
