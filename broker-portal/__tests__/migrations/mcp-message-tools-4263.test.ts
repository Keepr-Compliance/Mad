/**
 * BACKLOG-4263 sync 2.49, P9 (T-S) — CI tripwire for the AI read tools for a deal's emails and texts.
 *
 * WHAT THIS CAN PROVE: what the migration file, its apply file, its rollback and its harness say. CI has no database.
 * Behaviour is proved by supabase/tests/backlog-4263-sync2-t/harness-t.sql (controls and mutants in one rolled-back
 * call on the test project).
 */

import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGDIR = join(REPO, 'supabase/migrations');
const NAME = '20261123140000_backlog_4263_mcp_message_tools';
const FILE = join(MIGDIR, `${NAME}.sql`);
const DIR = join(REPO, 'supabase/tests/backlog-4263-sync2-t');
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
const statements = (raw: string): string =>
  raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
const RAW = read(FILE);
const SQL = statements(RAW);
const ROLLBACK = read(join(DIR, 'rollback-20261123140000.sql'));
const APPLY = read(join(DIR, 'apply-20261123140000.sql'));
const HARNESS = read(join(DIR, 'harness-t.sql'));

const SIG: Record<string, string> = {
  _mcp_conn_reads_messages: 'public._mcp_conn_reads_messages(uuid)',
  _mcp_msg_people: 'public._mcp_msg_people(jsonb, boolean)',
  _mcp_r_list_deal_messages: 'public._mcp_r_list_deal_messages(uuid, text, boolean, integer, timestamptz, uuid)',
  _mcp_r_get_message: 'public._mcp_r_get_message(uuid, integer)',
  mcp_list_deal_messages: 'public.mcp_list_deal_messages(text, bytea, text, text, text, text, integer, text)',
  mcp_get_message: 'public.mcp_get_message(text, bytea, text, text, integer)',
  mcp_message_access: 'public.mcp_message_access(text, bytea, text)',
  mcp_list_my_message_reads: 'public.mcp_list_my_message_reads(text, integer)',
  _mcp_prune_message_reads: 'public._mcp_prune_message_reads()',
};
const GRANTEE: Record<string, string | null> = {
  _mcp_conn_reads_messages: null,
  _mcp_msg_people: 'mcp_reader',
  _mcp_r_list_deal_messages: 'postgres',
  _mcp_r_get_message: 'postgres',
  mcp_list_deal_messages: 'anon',
  mcp_get_message: 'anon',
  mcp_message_access: 'anon',
  mcp_list_my_message_reads: 'authenticated',
  _mcp_prune_message_reads: null,
};
const READERS = ['_mcp_r_list_deal_messages', '_mcp_r_get_message'];
const TOOLS = ['mcp_list_deal_messages', 'mcp_get_message'];

/** Raw text of one function (header and body, from CREATE to the closing $fn$;) and its body. */
function fn(name: string): { all: string; body: string } {
  const start = RAW.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const b0 = RAW.indexOf('AS $fn$', start) + 'AS $fn$'.length;
  const b1 = RAW.indexOf('$fn$;', b0);
  return { all: RAW.slice(start, b1 + 5), body: RAW.slice(b0, b1) };
}
/** plpgsql body with comments and string literals blanked (same length). */
function code(s: string): string {
  return s
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/'(?:[^']|'')*'/g, (m) => "'" + ' '.repeat(m.length - 2) + "'");
}
/**
 * BEGIN/END nesting depth at offset i of a plpgsql body. A CASE expression opens and its END closes; END IF / END LOOP
 * do not close a block (the bodies here hold no CASE statement).
 */
function depth(body: string, i: number): number {
  const c = code(body).slice(0, i);
  let d = 0;
  for (const m of c.matchAll(/\bBEGIN\b|\bCASE\b|\bEND\b(?!\s+(IF|LOOP|CASE)\b)/gi)) d += /^END$/i.test(m[0]) ? -1 : 1;
  return d;
}

describe('BACKLOG-4263 P9 migration file', () => {
  it('creates nine new functions and one table, and replaces or drops nothing that exists', () => {
    const names = [...RAW.matchAll(/^CREATE OR REPLACE FUNCTION public\.(\w+)\(/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(Object.keys(SIG).sort());
    expect(SQL).not.toMatch(/DROP FUNCTION|ALTER FUNCTION|DROP TABLE|CREATE POLICY|GRANT SELECT|GRANT INSERT|GRANT ALL/);
    const earlier = readdirSync(MIGDIR)
      .filter((f) => f.endsWith('.sql') && f < `${NAME}.sql`)
      .map((f) => read(join(MIGDIR, f)));
    for (const n of names) {
      const re = new RegExp(`FUNCTION public\\.${n}\\(`);
      expect(`${n} ${earlier.some((t) => re.test(t))}`).toBe(`${n} false`);
    }
    expect([...SQL.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1])).toEqual(['mcp_message_reads']);
    expect(SQL).not.toMatch(/ALTER TABLE public\.(?!mcp_call_log |mcp_message_reads )/);
  });

  it('refuses to apply, first, unless the columns, the state keys, the refused outcome and pg_cron are there', () => {
    expect(SQL.startsWith('DO $pre4263t$')).toBe(true);
    const pre = SQL.slice(0, SQL.indexOf('$pre4263t$;'));
    for (const t of ["'active_install_id'", "'one_computer', 'messages_upload'", "'link_state'", "'hidden_from_export'", "'cloud_message_id'",
      "'''switches'''", "'''active_install_id'''", "'''messages_upload'''", "'''entitled'''", "%''refused''%", "extname = 'pg_cron'",
      'RAISE EXCEPTION']) {
      expect(`${t} ${pre.includes(t)}`).toBe(`${t} true`);
    }
  });

  it('every function: EXECUTE revoked from PUBLIC, anon, authenticated and service_role on its full signature, then granted to one role at most', () => {
    for (const [name, sig] of Object.entries(SIG)) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`);
      const grants = [...SQL.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(([^)]*)\\) TO (\\w+);`, 'g'))];
      const want = GRANTEE[name];
      expect(`${name} ${grants.map((g) => g[2]).join(',')}`).toBe(`${name} ${want ?? ''}`);
      if (want) expect(grants[0][0]).toBe(`GRANT EXECUTE ON FUNCTION ${sig} TO ${want};`);
    }
  });

  it('the anon functions are documented as intentionally public and check the portal secret first', () => {
    for (const [name, flow] of [
      ['mcp_list_deal_messages', 'MCP tool call list_deal_messages from the broker portal server'],
      ['mcp_get_message', 'MCP tool call get_message from the broker portal server'],
      ['mcp_message_access', 'MCP message tool listing from the broker portal server'],
    ]) {
      expect(RAW).toContain(`-- Intentionally callable by anon: ${flow}\nCREATE OR REPLACE FUNCTION public.${name}(`);
      const b = code(fn(name).body);
      const first = b.search(/\bIF\b/);
      expect(b.slice(first, first + 60)).toMatch(/^IF public\._mcp_secret_ok\(p_secret\) IS NOT TRUE THEN/);
    }
  });

  it('the readers are created as mcp_reader, STABLE SECURITY DEFINER with an empty search_path, and write nothing', () => {
    const i = RAW.indexOf('SET ROLE mcp_reader;');
    const k = RAW.indexOf('RESET ROLE;');
    for (const r of READERS) {
      const j = RAW.indexOf(`CREATE OR REPLACE FUNCTION public.${r}(`);
      expect(i < j && j < k).toBe(true);
      expect(fn(r).all).toMatch(/\)\nRETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS \$fn\$/);
      expect(code(fn(r).body)).not.toMatch(/\b(INSERT|UPDATE|DELETE|EXECUTE|PERFORM)\b/i);
    }
    expect(RAW.indexOf('REVOKE CREATE ON SCHEMA public FROM mcp_reader;')).toBeGreaterThan(k);
  });

  it('the tools: secret, gate, message permission, arguments, read-only block, outcome, then the read log, then finish', () => {
    for (const t of TOOLS) {
      const b = fn(t).body;
      const pos = [
        b.indexOf('_mcp_secret_ok(p_secret)'),
        b.indexOf(`_mcp_enter(p_at_digest, p_resource, '${t.slice(4)}')`),
        b.indexOf('_mcp_conn_reads_messages(g.connection_id) IS NOT TRUE'),
        b.indexOf('/*ARG:'),
        b.indexOf("set_config('transaction_read_only', 'on', true)"),
        b.indexOf("RAISE EXCEPTION USING ERRCODE = 'MC000'"),
        b.indexOf("octet_length(v_res::text) > 90000 THEN 'too_large'"),
        b.indexOf('INSERT INTO public.mcp_message_reads'),
        b.lastIndexOf('PERFORM public._mcp_finish(g.call_id, v_out'),
      ];
      expect(`${t} ${pos.join(',')}`).toBe(`${t} ${[...pos].sort((x, y) => x - y).join(',')}`);
      expect(pos.every((p) => p > -1)).toBe(true);
      // refused connection: not_found to the AI app, 'refused' in the call log
      expect(b).toContain("PERFORM public._mcp_finish(g.call_id, 'refused', 0, v_t0);\n    RETURN public._mcp_refuse('not_found');");
    }
  });

  it('the read log insert is in the outermost block (no exception handler can swallow it), only for an answer that is ok', () => {
    for (const t of TOOLS) {
      const b = fn(t).body;
      const ins = b.indexOf('INSERT INTO public.mcp_message_reads');
      expect(b.split('INSERT INTO public.mcp_message_reads')).toHaveLength(2);
      expect(depth(b, ins)).toBe(1);
      const guard = b.lastIndexOf("IF v_out = 'ok' THEN", ins);
      expect(guard).toBeGreaterThan(b.indexOf("ELSE 'ok' END;"));
      expect(code(b.slice(guard, ins))).not.toMatch(/\bEND IF\b|\bEXCEPTION\b/);
      // the only handlers are the cursor parse and the read-only block, both before the insert
      const handlers = [...code(b).matchAll(/\bEXCEPTION\b(?!\s+USING)/g)].map((m) => m.index ?? -1);
      expect(handlers.every((h) => h < ins)).toBe(true);
    }
  });

  it('mcp_message_access answers exactly {ok, messages} through the same permission function; mcp_write_access is untouched', () => {
    const b = fn('mcp_message_access').body;
    expect(b).toContain("RETURN jsonb_build_object('ok', true, 'messages',\n    public._mcp_conn_reads_messages(v_conn) IS TRUE");
    expect([...b.matchAll(/jsonb_build_object\(/g)]).toHaveLength(1);
    expect(fn('mcp_message_access').all).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    expect(RAW).not.toContain('FUNCTION public.mcp_write_access');
    expect(fn('_mcp_conn_reads_messages').body).toContain('c.notice_version >= 2');
  });

  it('both readers: the Cloud state (entitled, messages_upload), live messages in linked or needs_review, confirmed live deals, and the non-active computer filter (lookup by id included)', () => {
    for (const r of READERS) {
      const b = fn(r).body;
      for (const t of ["(v_st -> 'entitled') IS DISTINCT FROM to_jsonb(true)", "(v_st -> 'switches' -> 'messages_upload') IS DISTINCT FROM to_jsonb(true)",
        "(v_st -> 'switches' -> 'one_computer') = to_jsonb(true) AND jsonb_typeof(v_st -> 'active_install_id') = 'string'",
        "x.link_state IN ('linked', 'needs_review')", 'x.removed_at IS NULL', 'd.is_confirmed', 'd.removed_at IS NULL',
        'y.removed_at IS NULL', 'y.cloud_message_id = m.id AND y.cloud_deal_id = m.cloud_deal_id']) {
        expect(`${r}: ${t} ${b.includes(t)}`).toBe(`${r}: ${t} true`);
      }
    }
    expect(fn('_mcp_r_list_deal_messages').body).toContain('v_hidden := v_hide AND v_inst IS DISTINCT FROM v_active;');
    expect(fn('_mcp_r_list_deal_messages').body).toContain('AND v_hidden IS NOT TRUE /*HIDE:lm_rows*/');
    expect(fn('_mcp_r_get_message').body).toContain('AND (v_hide IS NOT TRUE OR d.source_install_id IS NOT DISTINCT FROM v_active) /*HIDE:inactive:get*/');
  });

  it('caps every shown value, pages the list by bytes and cuts the body by its encoded size', () => {
    const l = fn('_mcp_r_list_deal_messages').body;
    const g = fn('_mcp_r_get_message').body;
    const p = fn('_mcp_msg_people').body;
    for (const b of [l, g]) {
      expect(b).toContain("'subject', public._mcp_clean(left(m.subject, 2000), 300),");
      expect(b).toContain("'filename', public._mcp_clean(left(f.filename, 2000), 200),");
      expect(b).toContain("'mime_type', public._mcp_txt(left(f.mime_type, 2000), 100),");
      expect(b).toContain('FILTER (WHERE f.n <= 20)');
      expect(b).toContain('greatest(count(*) - 20, 0)');
    }
    expect(p.match(/s\.n <= 20\)/g)).toHaveLength(3);
    expect(p).toContain("public._mcp_txt(left(s.x #>> '{}', 2000), 320)");
    expect(p).toContain("'more', greatest((SELECT count(*) FROM s) - 20, 0)");
    expect(l).toContain("'thread_key', public._mcp_txt(left(m.thread_key, 2000), 200),");
    expect(l).toContain('s.rk <= p_limit /*BOUND:rows*/ AND (s.cum <= 80000 OR s.rk = 1) /*BOUND:bytes*/');
    expect(g).toContain('v_budget := least(60000, 86000 - octet_length(v_frame::text));');
    expect(g).toContain('v_w := octet_length(to_jsonb(v_b)::text) - 2;');
    expect(g).toContain("regexp_matches(m.body_text, '.{1,250}', 'g')");
    expect(g).toContain("IF array_to_string(v_blocks, '') IS DISTINCT FROM m.body_text THEN");
    expect(g).not.toMatch(/_mcp_(clean|txt|strip|mask)\(m\.body_text/);
  });

  it('the read log table: ids and times only, no foreign key but to auth.users, RLS on, no client privilege', () => {
    const t = SQL.slice(SQL.indexOf('CREATE TABLE IF NOT EXISTS public.mcp_message_reads'), SQL.indexOf(');', SQL.indexOf('CREATE TABLE IF NOT EXISTS public.mcp_message_reads')));
    expect([...t.matchAll(/REFERENCES (\S+)/g)].map((m) => m[1])).toEqual(['auth.users']);
    for (const c of ['provider text NOT NULL', 'client_name text NOT NULL', 'connection_id uuid NULL', 'cloud_deal_id uuid NOT NULL',
      'cloud_message_id uuid NOT NULL', 'channel text NOT NULL', 'sent_at timestamptz NULL', 'part integer NULL', 'read_at timestamptz NOT NULL']) {
      expect(`${c} ${t.includes(c)}`).toBe(`${c} true`);
    }
    expect(t).not.toMatch(/subject|body|participants|address|filename/);
    expect(SQL).toContain('ALTER TABLE public.mcp_message_reads ENABLE ROW LEVEL SECURITY;');
    expect(SQL).toContain('REVOKE ALL ON TABLE public.mcp_message_reads FROM PUBLIC, anon, authenticated, service_role;');
    expect(SQL).toContain('REVOKE TRUNCATE ON TABLE public.mcp_message_reads FROM anon, authenticated;');
  });

  it('the read log view: own rows only, support sessions refused, live subject and sender only while the message is live', () => {
    const b = fn('mcp_list_my_message_reads').body;
    expect(b.indexOf('_mcp_impersonating(v_uid) IS NOT FALSE')).toBeLessThan(b.indexOf('FROM public.mcp_message_reads'));
    expect(b).toContain('WHERE x.user_id = v_uid /*OWN:log*/');
    expect(b).toContain('d.owner_user_id = v_uid /*OWN:log_deal*/');
    expect(b).toContain('mm.owner_user_id = v_uid /*OWN:log_msg*/');
    expect(b).toContain("'subject', CASE WHEN o.m_live THEN");
    expect(b).toContain("'from', CASE WHEN o.m_live THEN");
  });

  it('retention: the prune deletes rows older than one year, daily, and no API role can call it', () => {
    expect(fn('_mcp_prune_message_reads').body).toContain("x.read_at < now() - interval '1 year'");
    expect(SQL).toContain("PERFORM cron.schedule('mcp-message-reads-prune', '41 3 * * *', 'SELECT public._mcp_prune_message_reads()');");
    expect(SQL).not.toMatch(/GRANT EXECUTE ON FUNCTION public\._mcp_prune_message_reads/);
  });

  it('the tool CHECK swap is the last statement, after a 3 s lock timeout, and keeps every earlier tool', () => {
    const swap = SQL.indexOf("SET LOCAL lock_timeout = '3s';");
    expect(swap).toBeGreaterThan(SQL.lastIndexOf('$fn$;'));
    expect(swap).toBeGreaterThan(SQL.indexOf('$cron4263t$;'));
    expect(SQL.trim().endsWith(
      "CHECK (tool IS NULL OR tool IN ('get_status', 'list_deals', 'get_deal', 'get_deal_checklists', 'list_all_deals', 'update_todo', 'add_todo', 'remove_todo', 'restore_todo', 'find_people', 'list_todos', 'list_deal_messages', 'get_message'));"
    )).toBe(true);
    expect(SQL).not.toContain('mcp_call_log_outcome_check DROP');
  });
});

describe('BACKLOG-4263 P9 apply file', () => {
  const head = APPLY.slice(0, APPLY.indexOf(RAW));
  it('holds the migration text byte for byte, exactly once', () => {
    expect(APPLY.split(RAW)).toHaveLength(2);
  });
  it('has only comment lines before the migration text, naming the migration and its md5', () => {
    const lines = head.replace(/\n\n$/, '').split('\n');
    expect(head.endsWith('\n\n')).toBe(true);
    for (const l of lines) expect(l.startsWith('-- ')).toBe(true);
    expect(lines[0]).toMatch(/^-- apply-20261123140000\.sql \(generated by /);
    expect(head).toContain(`-- Migration: supabase/migrations/${NAME}.sql  file md5 ${md5(RAW)}\n`);
  });
  it('ends with exactly the ledger row for this version and name', () => {
    expect(APPLY.slice(APPLY.indexOf(RAW) + RAW.length)).toBe(
      "\nINSERT INTO supabase_migrations.schema_migrations (version, name, statements)\nVALUES ('20261123140000', 'backlog_4263_mcp_message_tools', ARRAY[]::text[]);\n",
    );
  });
});

describe('BACKLOG-4263 P9 rollback and harness', () => {
  it('the rollback refuses unless every function is at this file\'s body, drops all nine and the table, and puts back the 11-name CHECK', () => {
    for (const [name, sig] of Object.entries(SIG)) {
      expect(ROLLBACK).toContain(`DROP FUNCTION IF EXISTS ${sig};`);
      expect(ROLLBACK).toContain(`'${md5(fn(name).body)}'`);
    }
    expect(ROLLBACK).toContain('DROP TABLE IF EXISTS public.mcp_message_reads;');
    expect(ROLLBACK).toContain("cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'mcp-message-reads-prune'");
    expect(statements(ROLLBACK)).toContain(
      "CHECK (tool IS NULL OR tool IN ('get_status', 'list_deals', 'get_deal', 'get_deal_checklists', 'list_all_deals', 'update_todo', 'add_todo', 'remove_todo', 'restore_todo', 'find_people', 'list_todos'));"
    );
    expect(ROLLBACK).toContain("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261123140000';");
  });

  it('the harness starts with the guard that refuses production, checks the migration is applied, embeds the rollback, and ends in RAISE', () => {
    const c = code(HARNESS).trimStart();
    expect(c.startsWith('DO $guard4263t$')).toBe(true);
    expect(HARNESS.split('\n')[1]).toContain('must never be run on production');
    expect(HARNESS).toContain("RAISE EXCEPTION 'harness-t.sql refuses to run: TEST DATABASE ONLY (production tracker rows present)'");
    expect(HARNESS).toMatch(/IF NOT EXISTS \(SELECT 1 FROM auth\.users u WHERE md5\(u\.id::text\) = '[0-9a-f]{32}'\) THEN\n\s+RAISE EXCEPTION/);
    for (const name of Object.keys(SIG)) expect(HARNESS).toContain(`'${md5(fn(name).body)}'`);
    expect(HARNESS).toContain(`$rbq$\n${ROLLBACK}\n$rbq$`);
    expect(HARNESS.trimEnd().endsWith("RAISE EXCEPTION 'T4263_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.t_out);\nEND\n$end4263t$;")).toBe(true);
    expect(HARNESS).toContain("SET LOCAL lock_timeout = '3s';");
    const controlsOnly = read(join(DIR, 'harness-t-controls.sql'));
    expect(code(controlsOnly).trimStart().startsWith('DO $guard4263t$')).toBe(true);
    expect(controlsOnly).not.toContain("pg_temp.rec('mutant:");
    expect(controlsOnly).toContain(`$rbq$\n${ROLLBACK}\n$rbq$`);
    // fixture ids are made at run time; the only literal id is the all-zero instance id of auth.users rows
    expect([...new Set(HARNESS.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [])]).toEqual(['00000000-0000-0000-0000-000000000000']);
  });
});
