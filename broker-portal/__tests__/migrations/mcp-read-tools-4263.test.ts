/**
 * BACKLOG-4263 PR-8 — CI tripwire for the find_people / list_todos migration.
 *
 * WHAT THIS CAN PROVE: what the migration file and its rollback say. CI has no database.
 * Behaviour is proved by supabase/tests/backlog-4263-pr8/harness-8.sql (controls and mutations in one rolled-back
 * call on the test project).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const FILE = join(REPO, 'supabase/migrations/20261118150000_backlog_4263_mcp_read_tools.sql');
const PR5 = join(REPO, 'supabase/migrations/20261118130000_backlog_4263_mcp_todo_write_tools.sql');
const CORE = join(REPO, 'supabase/migrations/20261118110000_backlog_4263_todo_server_core.sql');
const ROLLBACK = join(REPO, 'supabase/tests/backlog-4263-pr8/rollback-20261118150000.sql');
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
const RB_RAW = read(ROLLBACK);
const RB = statements(RB_RAW);

const SIG = {
  rfp: 'public._mcp_r_find_people(text, text, uuid, text, text, uuid)',
  rtd: 'public._mcp_r_list_todos(text, text, date, date, boolean, boolean, date, uuid)',
  fp: 'public.mcp_find_people(text, bytea, text, text, text, text, text, text, text)',
  td: 'public.mcp_list_todos(text, bytea, text, text, text, text, text, boolean, boolean, text)',
};

function bodyIn(sql: string, name: string): string {
  const m = [...sql.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([^)]*\\)([\\s\\S]*?)AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;`, 'g'))];
  if (m.length === 0) throw new Error(`${name} not found`);
  const last = m[m.length - 1];
  return `${last[1].trim()} AS ${last[2].trim()}`;
}
const body = (name: string) => bodyIn(SQL, name);

describe('BACKLOG-4263 PR-8 migration file', () => {
  it('creates exactly the two readers and the two tools, and changes no other object', () => {
    const names = [...SQL.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(names).toEqual(['_mcp_r_find_people', '_mcp_r_list_todos', 'mcp_find_people', 'mcp_list_todos']);
    expect(SQL).not.toMatch(/DROP FUNCTION|ALTER FUNCTION|CREATE TABLE|CREATE POLICY|GRANT SELECT|ALTER TABLE public\.(?!mcp_call_log )/);
    expect(SQL).not.toContain('cloud_todo_history');
  });

  it('the readers are created as mcp_reader, STABLE SECURITY DEFINER with an empty search_path, EXECUTE postgres only', () => {
    const i = SQL.indexOf('SET ROLE mcp_reader;');
    const k = SQL.indexOf('RESET ROLE;');
    for (const [name, sig] of [['_mcp_r_find_people', SIG.rfp], ['_mcp_r_list_todos', SIG.rtd]]) {
      const j = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      expect(i < j && j < k).toBe(true);
      expect(body(name)).toMatch(/^RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS/);
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO postgres;`);
      expect(SQL.match(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(`, 'g'))).toHaveLength(1);
      expect(body(name)).not.toMatch(/\b(INSERT|UPDATE|DELETE|EXECUTE|LIKE|ILIKE|SIMILAR)\b/);
    }
    expect(SQL).toContain('REVOKE CREATE ON SCHEMA public FROM mcp_reader;');
  });

  it('the tools are anon only, documented as intentionally public, and check the portal secret before anything else', () => {
    for (const [name, sig, tool, reader] of [
      ['mcp_find_people', SIG.fp, 'find_people', '_mcp_r_find_people(v_name'],
      ['mcp_list_todos', SIG.td, 'list_todos', '_mcp_r_list_todos(coalesce(p_state'],
    ]) {
      expect(RAW).toContain(`-- Intentionally callable by anon: MCP tool call ${tool} from the broker portal server\nCREATE OR REPLACE FUNCTION public.${name}(`);
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO anon;`);
      expect(SQL.match(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(`, 'g'))).toHaveLength(1);
      const b = body(name);
      expect(b).toMatch(/^RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS/);
      const secret = b.indexOf('_mcp_secret_ok(p_secret)');
      const enter = b.indexOf(`_mcp_enter(p_at_digest, p_resource, '${tool}')`);
      const ro = b.indexOf("set_config('transaction_read_only', 'on', true)");
      const rd = b.indexOf(reader);
      expect(secret).toBeGreaterThan(-1);
      expect(secret < enter && enter < ro && ro < rd).toBe(true);
      expect(b).toContain("RAISE EXCEPTION USING ERRCODE = 'MC000'");
      expect(b).toContain("octet_length(v_res::text) > 90000 THEN 'too_large'");
    }
  });

  it('find_people: the day cap is counted after the argument checks and before the read, and refuses with day_limit', () => {
    const b = body('mcp_find_people');
    const args = b.indexOf('/*ARG:one*/');
    const bump = b.indexOf("public._mcp_bump('find_people_user:' || g.user_id::text, interval '1 day', 1000)");
    const ro = b.indexOf("set_config('transaction_read_only', 'on', true)");
    expect(args > -1 && args < bump && bump < ro).toBe(true);
    expect(b).toContain("RETURN public._mcp_refuse(CASE WHEN v_b = 'rate_limited' THEN 'day_limit' ELSE 'busy' END);");
    expect(b).toContain("PERFORM public._mcp_finish(g.call_id, coalesce(v_b, 'busy'), 0, v_t0);");
  });

  it('find_people matches on the text it returns, never with a pattern built from input', () => {
    const b = body('_mcp_r_find_people');
    expect(b).toContain('strpos(lower(s.s_name), lower(p_name)) > 0 OR strpos(lower(s.s_company), lower(p_name)) > 0');
    expect(b).toContain("CASE WHEN l.w THEN NULL ELSE public._mcp_clean(l.display_name, 200) END /*WITHHELD:name*/ AS s_name");
    expect(b).toContain("CASE WHEN l.w THEN NULL ELSE public._mcp_clean(l.company, 200) END /*WITHHELD:company*/ AS s_company");
    expect(b).toContain("jsonb_array_elements(s.s_emails) e WHERE lower(btrim(e ->> 'email')) = p_email");
    expect(b).toContain('jsonb_array_elements(s.s_phones) e');
    expect(b).toContain("WHERE o <= 10 AND jsonb_typeof(el) = 'object'), '[]'::jsonb) END AS s_emails");
    expect(b).not.toMatch(/emails::text|phones::text|~\*?\s*p_|position\(/);
    expect(b).toContain('CASE WHEN l.w THEN NULL /*REF:withheld*/');
  });

  it('find_people shows a person exactly as get_deal does (field expressions copied from _mcp_r_get_deal)', () => {
    const gd = bodyIn(statements(read(CORE)), '_mcp_r_get_deal');
    for (const expr of [
      "public._mcp_clean(p.display_name, 200)",
      "'email', CASE WHEN jsonb_typeof(el -> 'email') = 'string' THEN public._mcp_txt(el ->> 'email', 320) END",
      "'e164', CASE WHEN jsonb_typeof(el -> 'e164') = 'string' THEN public._mcp_txt(el ->> 'e164', 40) END",
      "'label', CASE WHEN jsonb_typeof(el -> 'label') = 'string' THEN public._mcp_clean(el ->> 'label', 50) END",
      "'notes', public._mcp_clean(p.notes, 1000)",
      "public._mcp_clean(p.role, 100)",
    ]) {
      expect(gd).toContain(expr);
      expect(body('_mcp_r_find_people')).toContain(expr.replace(/\bp\.(display_name|role)/, 'l.$1').replace("public._mcp_clean(p.notes, 1000)", "public._mcp_clean(h.notes, 1000)"));
    }
  });

  it('list_todos uses the checklist, deal and todo terms of _mcp_r_deal_checklists (tripwire: text-equal), without its 30-list cut', () => {
    const cl = bodyIn(statements(read(PR5)), '_mcp_r_deal_checklists');
    const td = body('_mcp_r_list_todos');
    for (const f of [
      'x.owner_user_id = v_uid /*OWN:cl_deal*/ AND x.is_confirmed /*CONF:cl*/ AND x.removed_at IS NULL /*LIVE:cl_deal*/',
      'x.owner_user_id = v_uid /*OWN:cl_lists*/ AND x.removed_at IS NULL /*LIVE:cl_lists*/',
      't.owner_user_id = v_uid /*OWN:cl_items*/ AND t.removed_at IS NULL /*LIVE:cl_items*/',
      't.is_checked IS NOT TRUE',
    ]) {
      expect(cl).toContain(f);
      expect(td).toContain(f);
    }
    expect(td).not.toMatch(/LIMIT 30\b/);
    expect(td).not.toContain('_mcp_writes_on');
    expect(td).toContain("to_char(i.due_date, 'YYYY-MM-DD'),");
  });

  it('both readers open with the entitlement checks of the existing readers (text-equal)', () => {
    const gd = bodyIn(statements(read(CORE)), '_mcp_r_get_deal');
    const prologue = (b: string) => b.slice(b.indexOf('IF v_uid IS NULL THEN'), b.indexOf("RETURN '{\"not_entitled\":true}'::jsonb; END IF;", b.indexOf('get_my_cloud_autosave_state')));
    expect(prologue(gd).length).toBeGreaterThan(200);
    expect(prologue(body('_mcp_r_find_people'))).toBe(prologue(gd));
    expect(prologue(body('_mcp_r_list_todos'))).toBe(prologue(gd));
  });

  it('list_todos pages on (due date with undated last, item id), and a cursor date must be a stored due date', () => {
    const b = body('_mcp_r_list_todos');
    expect(b).toContain("(coalesce(t.due_date, DATE '9999-12-31'), t.id) > (p_after_key, p_after_id)) /*KEY:after*/");
    expect(b).toContain("ORDER BY coalesce(t.due_date, DATE '9999-12-31'), t.id /*ORDER:td*/");
    expect(b).toContain('s.rk <= 500 /*BOUND:rows*/ AND s.cum <= 85000 /*BOUND:bytes*/');
    expect(body('mcp_list_todos')).toContain("v_key NOT BETWEEN DATE '2000-01-01' AND DATE '2100-12-31') /*ARG:cursor_bounds*/");
  });

  it('the tool CHECK swap is the last statement, by the tool column only, after a 3 s lock timeout; the outcome CHECK is untouched', () => {
    const swap = SQL.indexOf("SET LOCAL lock_timeout = '3s';");
    expect(swap).toBeGreaterThan(SQL.lastIndexOf('$fn$;'));
    const tail = SQL.slice(swap);
    expect(tail).toContain("a.attname = 'tool'");
    expect(tail).not.toContain("'outcome'");
    expect(SQL).not.toContain('mcp_call_log_outcome_check');
    expect(SQL.trim().endsWith(
      "CHECK (tool IS NULL OR tool IN ('get_status', 'list_deals', 'get_deal', 'get_deal_checklists', 'list_all_deals', 'update_todo', 'add_todo', 'remove_todo', 'restore_todo', 'find_people', 'list_todos'));"
    )).toBe(true);
    expect(RAW).toContain('ACCESS EXCLUSIVE lock on mcp_call_log');
  });
});

describe('BACKLOG-4263 PR-8 rollback file', () => {
  it('runs before any PR-5 rollback, deletes the two tools\' log rows first, drops the four functions, restores the 9-name CHECK', () => {
    expect(RB_RAW).toContain('run this BEFORE any rollback of 20261118130000');
    const del = RB.indexOf("DELETE FROM public.mcp_call_log WHERE tool IN ('find_people', 'list_todos');");
    const drop = RB.indexOf('DROP FUNCTION IF EXISTS public.mcp_find_people(');
    const add = RB.indexOf(
      "CHECK (tool IS NULL OR tool IN ('get_status', 'list_deals', 'get_deal', 'get_deal_checklists', 'list_all_deals', 'update_todo', 'add_todo', 'remove_todo', 'restore_todo'))"
    );
    expect(del).toBeGreaterThan(-1);
    expect(del < drop && drop < add).toBe(true);
    for (const sig of Object.values(SIG)) expect(RB).toContain(`DROP FUNCTION IF EXISTS ${sig};`);
    expect(RB).toContain("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261118150000';");
    expect(RB).not.toMatch(/(DROP|ADD) CONSTRAINT (IF EXISTS )?mcp_call_log_outcome_check/);
  });
});
