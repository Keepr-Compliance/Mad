/**
 * BACKLOG-4244 — CI tripwire for the MCP data tools migration.
 *
 * WHAT THIS CAN PROVE: what the migration file and its rollback say. CI has no database.
 * Behaviour is proved by supabase/tests/backlog-4244/harness.py (controls and mutants in one
 * rolled-back call on the test project).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const FILE = join(REPO, 'supabase/migrations/20261114110000_backlog_4244_mcp_data_tools.sql');
const ROLLBACK = join(REPO, 'supabase/tests/backlog-4244/rollback-4244.sql');

const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
/** comments removed (line comments only; marker comments inside SQL kept), whitespace collapsed */
function statements(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const RAW = read(FILE);
const SQL = statements(RAW);
const RB = statements(read(ROLLBACK));

interface Fn {
  name: string;
  args: string;
  sig: string;
  header: string;
  body: string;
  start: number;
}
function argTypes(params: string): string {
  if (!params.trim()) return '';
  return params
    .split(',')
    .map((p) => p.trim().split(/\s+/).slice(1).join(' '))
    .join(', ');
}
function functionsOf(sql: string): Fn[] {
  const out: Fn[] = [];
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)([\s\S]*?)AS \$fn\$([\s\S]*?)\$fn\$;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const args = argTypes(m[2]);
    out.push({ name: m[1], args, sig: `public.${m[1]}(${args})`, header: m[3], body: m[4], start: m.index });
  }
  return out;
}
const FNS = functionsOf(SQL);
const fn = (name: string): Fn => {
  const f = FNS.filter((x) => x.name === name);
  expect(f).toHaveLength(1);
  return f[0];
};

const READERS = ['_mcp_r_list_deals', '_mcp_r_get_deal', '_mcp_r_deal_checklists'];
const TOOLS = ['mcp_list_deals', 'mcp_get_deal', 'mcp_get_deal_checklists'];
const HELPERS = ['_mcp_txt', '_mcp_mask', '_mcp_clean', '_mcp_ts', '_mcp_day'];

/** Functions a reader body may call (C30). */
const READER_CALLS = new Set([
  'if', 'get_my_cloud_autosave_state', 'to_jsonb', 'jsonb_build_object', 'jsonb_agg', 'jsonb_array_elements', 'jsonb_typeof',
  'jsonb_array_length', 'row_number', 'min', 'max', 'count', 'sum', 'coalesce', 'replace', 'octet_length', 'exists', 'in',
  '_mcp_txt', '_mcp_clean', '_mcp_ts', '_mcp_day', 'and', 'or', 'with', 'as', 'over', 'filter', 'ordinality', 'not',
  'uid', 'return', 'from', 't',
]);

function readerCalls(body: string): string[] {
  const unquoted = body.replace(/'[^']*'/g, "''").replace(/\/\*[^*]*\*\//g, '');
  return [...unquoted.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => m[1].toLowerCase());
}

/** jsonb keys whose values are free text and must go through _mcp_clean (C35). */
const FREE_TEXT_KEYS = [
  'address', 'street', 'city', 'state', 'zip', 'name', 'company', 'role', 'role_category', 'specific_role', 'notes', 'label',
  'title', 'description', 'note', 'expected_document',
];

function projections(body: string, key: string): string[] {
  const out: string[] = [];
  // the key of a jsonb_build_object pair, not a ->> 'key', argument
  const re = new RegExp(`(?<!->> |-> )'${key}', `, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < body.length; i++) {
      const c = body[i];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
    }
    out.push(body.slice(start, i).trim());
  }
  return out;
}

/** a free-text projection is wrapped: _mcp_clean(...), or a withheld CASE whose ELSE is _mcp_clean(...) */
function wrapped(expr: string): boolean {
  const e = expr.replace(/\/\*[^*]*\*\//g, '').trim();
  if (/^public\._mcp_clean\(/.test(e)) return true;
  return /^CASE WHEN p\.w THEN NULL ELSE public\._mcp_clean\([^]*\) END$/.test(e) || /^CASE WHEN jsonb_typeof\([^]*THEN public\._mcp_clean\(/.test(e);
}

function freeTextGaps(sql: string): string[] {
  const gaps: string[] = [];
  for (const f of functionsOf(sql).filter((x) => x.name.startsWith('_mcp_r_'))) {
    for (const k of FREE_TEXT_KEYS) {
      for (const p of projections(f.body, k)) {
        if (!wrapped(p)) gaps.push(`${f.name}:${k}:${p.slice(0, 60)}`);
      }
    }
  }
  return gaps;
}

describe('BACKLOG-4244 migration 20261114110000', () => {
  it('positive: the parser finds the eleven functions', () => {
    expect(FNS.map((f) => f.name).sort()).toEqual([...READERS, ...TOOLS, ...HELPERS].sort());
  });

  it('every function: EXECUTE revoked from PUBLIC, anon, authenticated, service_role, then granted to one role', () => {
    const expected: Record<string, string> = {};
    for (const n of READERS) expected[n] = 'postgres';
    for (const n of TOOLS) expected[n] = 'anon';
    for (const n of HELPERS) expected[n] = 'mcp_reader';
    for (const f of FNS) {
      const sig = f.sig.replace('timestamptz', 'timestamptz');
      const revoke = `REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`;
      const grant = `GRANT EXECUTE ON FUNCTION ${sig} TO ${expected[f.name]};`;
      expect(SQL.indexOf(revoke)).toBeGreaterThan(f.start);
      expect(SQL.indexOf(grant)).toBeGreaterThan(SQL.indexOf(revoke));
      const grants = [...SQL.matchAll(new RegExp(`GRANT [A-Z ,]+ ON FUNCTION public\\.${f.name}\\(`, 'g'))];
      expect(grants).toHaveLength(1);
    }
  });

  it('the anon tool functions carry the intentionally-public marker and check the portal secret first', () => {
    for (const n of TOOLS) {
      expect(RAW).toContain(`-- Intentionally callable by anon: MCP tool call ${n.replace('mcp_', '')} from the broker portal server`);
      const f = fn(n);
      expect(f.header).toMatch(/LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''/);
      const body = f.body;
      expect(body.indexOf('IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN')).toBeGreaterThan(0);
      expect(body.indexOf('IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN')).toBeLessThan(body.indexOf('public._mcp_enter('));
      expect(body.indexOf("IF g.outcome IS DISTINCT FROM 'ok' THEN")).toBeLessThan(body.indexOf('public._mcp_r_'));
      expect(body).toContain("PERFORM set_config('transaction_read_only', 'on', true);");
      expect(body).toContain("RAISE EXCEPTION USING ERRCODE = 'MC000'");
      expect(body).toContain("WHEN SQLSTATE 'MC000' THEN NULL;");
      expect(body).toContain("WHEN query_canceled THEN v_out := 'timeout';");
      const unquoted = body.replace(/'[^']*'/g, "''");
      expect(unquoted.indexOf("set_config('', '', true)")).toBeLessThan(unquoted.indexOf('public._mcp_r_'));
    }
  });

  it('readers: created as mcp_reader, STABLE SECURITY DEFINER, empty search_path, no user-id argument', () => {
    const setRole = SQL.indexOf('SET ROLE mcp_reader;');
    const resetRole = SQL.indexOf('RESET ROLE;');
    expect(setRole).toBeGreaterThan(0);
    expect(SQL.indexOf('SET ROLE mcp_reader;', setRole + 1)).toBe(-1);
    expect(SQL.indexOf(`REVOKE CREATE ON SCHEMA public FROM mcp_reader;`)).toBeGreaterThan(resetRole);
    const inside = FNS.filter((f) => f.start > setRole && f.start < resetRole).map((f) => f.name);
    expect(inside).toEqual(READERS);
    for (const n of READERS) {
      const f = fn(n);
      expect(f.header).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''/);
      expect(f.args).not.toMatch(/user/);
      expect(f.args.split(', ')).not.toContain('p_user_id');
    }
    for (const n of HELPERS) expect(fn(n).header).toMatch(/SECURITY INVOKER SET search_path = ''/);
  });

  it('readers: the first statements check the caller and the Cloud state (licensed, settings.enabled), before any table', () => {
    for (const n of READERS) {
      const b = fn(n).body;
      const first = b.indexOf('FROM public.cloud_');
      expect(b.indexOf(`IF v_uid IS NULL THEN RETURN '{"not_entitled":true}'::jsonb; END IF;`)).toBeGreaterThan(0);
      expect(b.indexOf('v_st := public.get_my_cloud_autosave_state();')).toBeLessThan(first);
      expect(b).toContain(
        "IF (v_st -> 'schema_version') IS DISTINCT FROM to_jsonb(1) OR (v_st -> 'licensed') IS DISTINCT FROM to_jsonb(true) OR (v_st -> 'settings' -> 'enabled') IS DISTINCT FROM to_jsonb(true) THEN RETURN '{\"not_entitled\":true}'::jsonb; END IF;"
      );
      expect(b).toContain('v_uid uuid := auth.uid();');
    }
  });

  it('readers: every cloud table reference carries the owner term', () => {
    for (const n of READERS) {
      const b = fn(n).body;
      const refs = [...b.matchAll(/FROM public\.(cloud_\w+) (\w+)/g)];
      expect(refs.length).toBeGreaterThan(2);
      for (const r of refs) {
        const after = b.slice(r.index ?? 0, (r.index ?? 0) + 400);
        expect(after).toContain(`${r[2]}.owner_user_id = v_uid`);
      }
      expect(b).not.toMatch(/JOIN public\.cloud_/);
    }
  });

  it('readers read only deals, parties, checklists and items; never messages, files, blobs or raw rows', () => {
    for (const n of READERS) {
      const b = fn(n).body;
      for (const m of b.matchAll(/public\.(cloud_\w+)/g)) {
        expect(['cloud_deals', 'cloud_deal_parties', 'cloud_deal_checklists', 'cloud_deal_checklist_items']).toContain(m[1]);
      }
      expect(b).not.toMatch(/to_jsonb\(\w+\.\*\)|to_jsonb\((?!true\)|1\))\w+\)|row_to_json/);
      for (const forbidden of ['source_install_id\'', "'owner_user_id'", "'content_hash'", "'organization_id'", "'contact_source'", "'links'", "'local_"]) {
        expect(b).not.toContain(forbidden);
      }
    }
  });

  it('C30: reader bodies call only allowlisted functions', () => {
    for (const n of READERS) {
      const unknown = readerCalls(fn(n).body).filter((c) => !READER_CALLS.has(c));
      expect(unknown).toEqual([]);
    }
  });

  it('C30 positive control: a planted write call in a reader is found', () => {
    const planted = SQL.replace('v_st := public.get_my_cloud_autosave_state();', "v_st := public.get_my_cloud_autosave_state(); PERFORM public.cloud_delete_deal(v_uid, p_deal_id);");
    expect(planted).not.toBe(SQL);
    const f = functionsOf(planted).find((x) => x.name === '_mcp_r_list_deals');
    expect(readerCalls(f?.body ?? '').filter((c) => !READER_CALLS.has(c))).toContain('cloud_delete_deal');
  });

  it('C35: every free-text projection in a reader goes through _mcp_clean', () => {
    expect(freeTextGaps(SQL)).toEqual([]);
    const counted = READERS.flatMap((n) => FREE_TEXT_KEYS.flatMap((k) => projections(fn(n).body, k)));
    expect(counted.length).toBe(23);
  });

  it('C35 positive control: a planted bare p.company is found', () => {
    const planted = SQL.replace(
      "'company', CASE WHEN p.w THEN NULL ELSE public._mcp_clean(p.company, 200) END /*WITHHELD:company*/,",
      "'company', p.company,"
    );
    expect(planted).not.toBe(SQL);
    expect(freeTextGaps(planted)).toEqual(['_mcp_r_get_deal:company:p.company']);
  });

  it('withheld people: name, company, emails and phones blanked; notes kept', () => {
    const b = fn('_mcp_r_get_deal').body;
    expect(b).toContain('x.details_withheld AS w /*WITHHELD:flag*/,');
    expect(b).not.toContain('contact_source');
    expect([...b.matchAll(/\bAS w\b/g)]).toHaveLength(1);
    expect(b).toContain("'name', CASE WHEN p.w THEN NULL ELSE public._mcp_clean(p.display_name, 200) END");
    expect(b).toContain("'company', CASE WHEN p.w THEN NULL ELSE public._mcp_clean(p.company, 200) END");
    expect(b).toContain("'emails', CASE WHEN p.w THEN '[]'::jsonb");
    expect(b).toContain("'phones', CASE WHEN p.w THEN '[]'::jsonb");
    expect(b).toContain("'notes', public._mcp_clean(p.notes, 1000),");
  });

  it('saved_from: the install join keeps a deal with no install, and no install is numbered', () => {
    const l = fn('_mcp_r_list_deals').body;
    expect(l).toContain('FROM pr LEFT JOIN inst i ON i.source_install_id IS NOT DISTINCT FROM pr.source_install_id');
    expect(l).toContain('x.source_install_id IS NOT NULL GROUP BY x.source_install_id');
    const g = fn('_mcp_r_get_deal').body;
    expect(g).toContain('WHERE i.source_install_id IS NOT DISTINCT FROM v_deal.source_install_id;');
    expect(g).toContain('x.source_install_id IS NOT NULL GROUP BY x.source_install_id');
  });

  it('copy_state: fully_saved only when both freshness columns hold the same instant', () => {
    for (const [n, a] of [['_mcp_r_list_deals', 'pr'], ['_mcp_r_get_deal', 'v_deal']]) {
      expect(fn(n).body).toContain(
        `'copy_state', CASE WHEN ${a}.last_full_sync_at IS NULL THEN 'never_fully_saved' WHEN ${a}.last_synced_at IS DISTINCT FROM ${a}.last_full_sync_at THEN 'changed_since_full_save' /*FRESH:${a === 'pr' ? 'list' : 'get'}*/ ELSE 'fully_saved' END`
      );
    }
  });

  it('the three result frames carry the same about text and v 1', () => {
    const abouts = READERS.map((n) => fn(n).body.match(/'about', ('(?:[^']|'')*')/)?.[1]);
    expect(abouts.every((a) => a && a === abouts[0])).toBe(true);
    for (const n of READERS) expect(fn(n).body).toMatch(/'kind', 'keepr\.\w+', 'v', 1, 'about'/);
  });

  it('C40: the call log gets no new column; its two CHECKs are widened by column', () => {
    expect(SQL).not.toMatch(/ALTER TABLE public\.mcp_call_log ADD COLUMN/i);
    expect(SQL).toContain(
      "ALTER TABLE public.mcp_call_log ADD CONSTRAINT mcp_call_log_tool_check CHECK (tool IS NULL OR tool IN ('get_status', 'list_deals', 'get_deal', 'get_deal_checklists'));"
    );
    expect(SQL).toContain(
      "ALTER TABLE public.mcp_call_log ADD CONSTRAINT mcp_call_log_outcome_check CHECK (outcome IN ('pending', 'ok', 'not_connected', 'disabled', 'rate_limited', 'busy', 'not_entitled', 'timeout', 'error', 'invalid_input', 'not_found', 'too_large'));"
    );
    for (const n of TOOLS) expect(fn(n).body).toContain(`public._mcp_enter(p_at_digest, p_resource, '${n.replace('mcp_', '')}')`);
  });

  it('no table, policy, table grant or role change', () => {
    expect(SQL).not.toMatch(/CREATE TABLE|CREATE POLICY|DROP POLICY|ALTER POLICY|GRANT (SELECT|INSERT|UPDATE|DELETE|ALL) ON TABLE|ALTER ROLE|CREATE ROLE|BYPASSRLS|DISABLE ROW LEVEL/i);
  });

  it('rollback: deletes the new log rows, restores the CHECKs, drops every function and the ledger row', () => {
    expect(RB.indexOf('DELETE FROM public.mcp_call_log')).toBeLessThan(RB.indexOf('ADD CONSTRAINT mcp_call_log_tool_check'));
    expect(RB).toContain("CHECK (tool IS NULL OR tool IN ('get_status'));");
    expect(RB).toContain("CHECK (outcome IN ('pending', 'ok', 'not_connected', 'disabled', 'rate_limited', 'busy', 'not_entitled', 'timeout', 'error'));");
    for (const f of FNS) expect(RB).toContain(`DROP FUNCTION IF EXISTS ${f.sig}`);
    expect(RB).toContain("version = '20261114110000'");
  });
});
