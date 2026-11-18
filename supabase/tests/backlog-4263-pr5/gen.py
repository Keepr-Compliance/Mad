#!/usr/bin/env python3
"""BACKLOG-4263 PR-5: writes, from the migration and the bodies it replaces:

  supabase/tests/backlog-4263-pr5/apply-20261118130000.sql     migration verbatim + ledger row + post-check
  supabase/tests/backlog-4263-pr5/rollback-20261118130000.sql  rollback + its post-check
  supabase/tests/backlog-4263-pr5/harness-5.sql                ONE call: fixtures, apply, re-run, controls, mutations,
                                                               rollback rehearsal; ends in RAISE (nothing persists)
  supabase/tests/backlog-4263-pr5/catalog-facts.json           md5 of every body written, old and new

Mutations are exact-string replacements: each must match once (else this script stops), and the harness proves in
the database that the mutated body is the one installed (md5) before its control runs.
`python3 gen.py check` regenerates in memory and fails if any written file differs."""
import hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
VERSION, NAME = '20261118130000', 'backlog_4263_mcp_todo_write_tools'
MIG_PATH = f'supabase/migrations/{VERSION}_{NAME}.sql'
rd = lambda p: open(os.path.join(REPO, p)).read()
md5 = lambda s: hashlib.md5(s.encode()).hexdigest()
mig = rd(MIG_PATH)
o4238 = rd('supabase/migrations/20261112170000_backlog_4238_mcp_oauth_server.sql')
core = rd('supabase/migrations/20261118110000_backlog_4263_todo_server_core.sql')
lib = lambda n: rd(f'supabase/tests/backlog-4263-pr5/lib/{n}')

SIG = {
    'mcp_authorize_begin': 'public.mcp_authorize_begin(text,text,text,text,text,text,text,text,bytea,bytea)',
    'mcp_authorize_view': 'public.mcp_authorize_view(text,bytea)',
    'mcp_authorize_approve': 'public.mcp_authorize_approve(text,bytea,text,bytea)',
    'mcp_exchange_code': 'public.mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)',
    'mcp_refresh': 'public.mcp_refresh(text,bytea,text,text,bytea,bytea)',
    '_mcp_r_deal_checklists': 'public._mcp_r_deal_checklists(uuid,boolean,uuid)',
    '_mcp_writes_on': 'public._mcp_writes_on()',
    '_mcp_granted_scope': 'public._mcp_granted_scope(text)',
    '_mcp_conn_can_write': 'public._mcp_conn_can_write(uuid)',
    '_mcp_todo_item_out': 'public._mcp_todo_item_out(uuid,uuid)',
    '_mcp_todo_call': 'public._mcp_todo_call(text,bytea,text,text,jsonb)',
    'mcp_write_access': 'public.mcp_write_access(text,bytea,text)',
    'mcp_update_todo': 'public.mcp_update_todo(text,bytea,text,text,jsonb,text)',
    'mcp_add_todo': 'public.mcp_add_todo(text,bytea,text,text,text,text,text,text)',
    'mcp_remove_todo': 'public.mcp_remove_todo(text,bytea,text,text,text)',
    'mcp_restore_todo': 'public.mcp_restore_todo(text,bytea,text,text,text)',
    '_cloud_todo_apply_op': 'public._cloud_todo_apply_op(uuid,jsonb,text,uuid,jsonb,timestamp with time zone)',
}
REPLACED = ['mcp_authorize_begin', 'mcp_authorize_view', 'mcp_authorize_approve', 'mcp_exchange_code', 'mcp_refresh', '_mcp_r_deal_checklists']
NEW = ['_mcp_writes_on', '_mcp_granted_scope', '_mcp_conn_can_write', '_mcp_todo_item_out', '_mcp_todo_call',
       'mcp_write_access', 'mcp_update_todo', 'mcp_add_todo', 'mcp_remove_todo', 'mcp_restore_todo']
ANON_NEW = ['mcp_write_access', 'mcp_update_todo', 'mcp_add_todo', 'mcp_remove_todo', 'mcp_restore_todo']
ANON_OLD = ['mcp_authorize_begin(text,text,text,text,text,text,text,text,bytea,bytea)', 'mcp_check_access(text,bytea,text)',
            'mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)', 'mcp_get_deal(text,bytea,text,text)',
            'mcp_get_deal_checklists(text,bytea,text,text,boolean,text)', 'mcp_get_status(text,bytea,text)',
            'mcp_list_all_deals(text,bytea,text,text,text,text,text)', 'mcp_list_deals(text,bytea,text,text,text,integer,text)',
            'mcp_refresh(text,bytea,text,text,bytea,bytea)', 'mcp_register_client(text,text,text,text[],bytea)']
ANON_ALL = sorted(ANON_OLD + [SIG[n][len('public.'):] for n in ANON_NEW])


def stmt(text, name, tag):
    m = re.search(r'(CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS \$' + tag + r'\$.*?\$' + tag + r'\$;\n(?:(?:REVOKE|GRANT)[^\n]*\n)*)', text, re.S)
    assert m, name
    return m.group(1)


def body(s, tag):
    return re.search(r'AS \$' + tag + r'\$(.*?)\$' + tag + r'\$;', s, re.S).group(1)


def create_only(s, tag):
    return re.search(r'(CREATE OR REPLACE FUNCTION .*?\$' + tag + r'\$;)', s, re.S).group(1)


TRACED = {'mcp_authorize_begin': 'bf7192517604c2db532312a7e071a751', 'mcp_authorize_view': '879b6c01072494b931e782a6f07b463d',
          'mcp_authorize_approve': '90eac2594c015edc44b3fecc9ec0209b', 'mcp_exchange_code': 'cfb0787d8601435bbe47a575155866b8',
          'mcp_refresh': 'b6ccefaa100e0b69df3e16e0a407d740', '_mcp_r_deal_checklists': 'f6a9f0336a1a070adcf66778afecbce7'}
OLD = {n: stmt(core if n == '_mcp_r_deal_checklists' else o4238, n, 'fn') for n in REPLACED}
for n, s in OLD.items():
    assert md5(body(s, 'fn')) == TRACED[n], (n, md5(body(s, 'fn')))   # the files' bodies are the live ones (pre-check md5s)
NEWS = {n: stmt(mig, n, 'fn') for n in REPLACED + NEW}
NEW_MD5 = {n: md5(body(s, 'fn')) for n, s in NEWS.items()}
CORE_OP = stmt(core, '_cloud_todo_apply_op', 'f')
assert md5(body(CORE_OP, 'f')) == '5b0df6658b9681c281bc64fd8fbc7846'

# ------------------------------------------------------------------------------------------------ mutations
# (id, function, tag, old, new, control): the most likely wrong implementations, each must turn its control red
MUTS = [
    ('M01_gate_no_scope', '_mcp_conn_can_write', 'fn', " AND c.scope = 'mcp:todos')", ')', 'c_old_grant'),
    ('M02_gate_no_switch', '_mcp_conn_can_write', 'fn', "  SELECT public._mcp_writes_on()                                                                   /*WRITE:switch*/\n     AND EXISTS",
     '  SELECT EXISTS', 'c_switch_default'),
    ('M03_call_no_gate', '_mcp_todo_call', 'fn', "IF public._mcp_conn_can_write(g.connection_id) IS NOT TRUE THEN", 'IF false THEN', 'c_old_grant'),
    ('M04_begin_always_todos', 'mcp_authorize_begin', 'fn', "public._mcp_granted_scope(p_scope), p_state,", "'mcp:todos', p_state,", 'c_consent'),
    ('M04b_begin_todos_when_on', 'mcp_authorize_begin', 'fn', "public._mcp_granted_scope(p_scope), p_state,", "CASE WHEN public._mcp_writes_on() THEN 'mcp:todos' ELSE 'mcp:read' END, p_state,", 'c_consent'),
    ('M05_approve_copies_request', 'mcp_authorize_approve', 'fn', "public._mcp_granted_scope(v_req.scope) /*SCOPE:approve*/", 'v_req.scope', 'c_consent'),
    ('M06_grant_ignores_switch', '_mcp_granted_scope', 'fn', "p_requested = 'mcp:todos' AND public._mcp_writes_on()", "p_requested = 'mcp:todos'", 'c_consent'),
    ('M07_claims_not_restored', '_mcp_todo_call', 'fn',
     "    PERFORM set_config('request.jwt.claims', coalesce(v_c0, ''), true);                            /*CLAIMS:restore*/\n    PERFORM set_config('request.jwt.claim.sub', coalesce(v_s0, ''), true);\n    PERFORM set_config('request.jwt.claim.role', coalesce(v_r0, ''), true);\n",
     '', 'c_claims'),
    ('M08_claims_emptied', '_mcp_todo_call', 'fn',
     "    PERFORM set_config('request.jwt.claims', coalesce(v_c0, ''), true);                            /*CLAIMS:restore*/",
     "    PERFORM set_config('request.jwt.claims', '', true);", 'c_claims'),
    ('M08b_lock_timeout_left', '_mcp_todo_call', 'fn', "    PERFORM set_config('lock_timeout', v_lt0, true);                                               /*LOCK:restore*/\n", '', 'c_claims'),
    ('M09_partial_write_kept', '_mcp_todo_call', 'fn', "        RAISE EXCEPTION USING ERRCODE = 'MC002', MESSAGE = 'mcp write refused';                    /*WRITE:all_or_nothing*/",
     '        EXIT;', 'c_all_or_nothing'),
    ('M10_op_id_random', '_mcp_todo_call', 'fn', "                      ELSE md5(concat_ws('|', 'mcp-todo', g.connection_id::text, p_tool, v_key, a::text))::uuid END,",
     '                      ELSE gen_random_uuid() END,', 'c_replay'),
    ('M10b_add_op_id_random', '_mcp_todo_call', 'fn', "                    ELSE md5(concat_ws('|', 'mcp-todo', g.connection_id::text, p_tool, a::text))::uuid END,",
     '                    ELSE gen_random_uuid() END,', 'c_replay_add'),
    ('M11_note_check_off', '_mcp_todo_call', 'fn', "IF jsonb_typeof(v_old) = 'string' AND public._mcp_clean", "IF false AND public._mcp_clean", 'c_note'),
    ('M12_no_order', '_mcp_todo_call', 'fn', "      v_ops := jsonb_build_array((v_ops -> 0) || jsonb_build_object('sort_order', v_order));\n", '', 'c_order'),
    ('M13_label_from_client_name', '_mcp_todo_call', 'fn',
     "'label', CASE g.provider WHEN 'anthropic' THEN 'Claude' WHEN 'openai' THEN 'ChatGPT' END),",
     "'label', (SELECT c.client_name FROM public.mcp_connections c WHERE c.id = g.connection_id)),", 'c_write_ok'),
    ('M14_item_out_no_owner', '_mcp_todo_item_out', 'fn', ["WHERE t.id = p_item AND t.owner_user_id = p_owner /*OWN:item_out*/", " AND c.owner_user_id = p_owner", " AND d.owner_user_id = p_owner"], ['WHERE t.id = p_item', '', ''], 'c_cross_owner'),
    ('M15_core_template_rename', '_cloud_todo_apply_op', 'f', "(v_part = 'order' OR (v_part = 'title' AND NOT v_my))", "(v_part = 'order')", 'c_template'),
    ('M16_core_no_ai_lock', '_cloud_todo_apply_op', 'f', "  IF v_ai AND public._cloud_todo_deal_locked(p_owner, d.id) THEN                                  /*LOCK:ai*/",
     '  IF false THEN', 'c_lock'),
    ('M17_core_ai_on_removed', '_cloud_todo_apply_op', 'f', "    IF v_on_removed AND NOT v_desk THEN", '    IF false THEN', 'c_removed'),
    ('M18_frame_v2_always', '_mcp_r_deal_checklists', 'fn', "v_v2  boolean := public._mcp_writes_on() IS TRUE;", 'v_v2  boolean := true;', 'c_frame'),
    ('M19_write_access_always', 'mcp_write_access', 'fn', "'write', public._mcp_conn_can_write(v_conn) IS TRUE", "'write', true", 'c_write_access'),
    ('M20_no_day_cap', '_mcp_todo_call', 'fn', "interval '1 day', 500);", "interval '1 day', 1000000);", 'c_rate'),
    ('M21_core_unconfirmed_create', '_cloud_todo_apply_op', 'f', "IF d.id IS NULL OR (v_ai AND d.is_confirmed IS NOT TRUE) THEN", 'IF d.id IS NULL THEN', 'c_cross_owner'),
    ('M22_exchange_scope_constant', 'mcp_exchange_code', 'fn', "'scope', v_scope);   /*SCOPE:exchange*/", "'scope', 'mcp:read');", 'c_consent'),
    ('M23_refresh_upgrades', 'mcp_refresh', 'fn', "'scope', v_scope);   /*SCOPE:refresh*/", "'scope', 'mcp:todos');", 'c_old_grant'),
    ('M24_view_shows_request', 'mcp_authorize_view', 'fn', "public._mcp_granted_scope(v_req.scope),", 'v_req.scope,', 'c_consent'),
    ('M25_core_no_template_remove_rule', '_cloud_todo_apply_op', 'f', "    IF (NOT v_desk AND (ent = 'checklist' OR NOT v_my))", "    IF (NOT v_desk AND (ent = 'checklist'))", 'c_template'),
    ('M26_core_ai_restore_template', '_cloud_todo_apply_op', 'f', "v_ai_restore_template boolean := false;", 'v_ai_restore_template boolean := true;', 'c_template'),
]
CONTROLS = ['c_switch_default', 'c_old_grant', 'c_consent', 'c_write_ok', 'c_template', 'c_all_or_nothing', 'c_lock', 'c_removed',
            'c_cross_owner', 'c_replay', 'c_replay_add', 'c_note', 'c_order', 'c_input', 'c_rate', 'c_access', 'c_turn_off',
            'c_claims', 'c_second_actor', 'c_write_access', 'c_frame', 'c_catalog']
assert {m[5] for m in MUTS} <= set(CONTROLS)

mut_sql = []
mut_report = []
for mid, fn, tag, old, new, ctl in MUTS:
    src = NEWS[fn] if fn in NEWS else CORE_OP
    c = create_only(src, tag)
    olds, news = (old, new) if isinstance(old, list) else ([old], [new])
    mc = c
    for o_, n_ in zip(olds, news):
        assert mc.count(o_) == 1, (mid, o_, mc.count(o_))
        mc = mc.replace(o_, n_)
    new = news[0]
    line = next((l for l in mc.splitlines() if new.strip() and new.strip().splitlines()[0] in l), '(lines removed)')
    mut_report.append(f'MUTATION APPLIED {mid} ({fn}): {line.strip()[:150]}')
    want = md5(body(mc, tag))
    reader = fn == '_mcp_r_deal_checklists'
    q = '$mutq$'
    pre = "    EXECUTE 'GRANT CREATE ON SCHEMA public TO mcp_reader';\n    EXECUTE 'SET ROLE mcp_reader';\n" if reader else ''
    post = "    EXECUTE 'RESET ROLE';\n" if reader else ''
    mut_sql.append(f"""DO $m_{mid}$
DECLARE v text; ok boolean;
BEGIN
  BEGIN
{pre}    EXECUTE {q}{mc}{q};
{post}    SELECT md5(p.prosrc) = '{want}' INTO ok FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG[fn]}');
    v := pg_temp.iso('{ctl}');
    RAISE EXCEPTION USING ERRCODE = 'MX002';
  EXCEPTION WHEN SQLSTATE 'MX002' THEN NULL;
  END;
  PERFORM pg_temp.rec('MUT_{mid}', jsonb_build_object('applied', ok, 'control', '{ctl}', 'red', v <> 'PASS', 'result', left(v, 400)));
END
$m_{mid}$;
""")

# ------------------------------------------------------------------------------------------------ apply
mig_md5 = md5(mig)
post = f"""
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('{VERSION}', '{NAME}', ARRAY[]::text[]);

DO $post4263p5$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'bodies', (SELECT coalesce(jsonb_object_agg(x.sig, coalesce(md5(p.prosrc), 'missing')), '{{}}') FROM (VALUES {', '.join(f"('{SIG[n]}', '{NEW_MD5[n]}')" for n in REPLACED + NEW)}) x(sig, want)
                LEFT JOIN pg_proc p ON p.oid = to_regprocedure(x.sig) WHERE p.oid IS NULL OR md5(p.prosrc) <> x.want),
    'reader_owner_ok', public._mcp_reader_ok('public._mcp_r_deal_checklists(uuid,boolean,uuid)'::regprocedure),
    'anon_mcp', (SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text), '{{}}') FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE'))
        = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[{', '.join(repr(x) for x in ANON_ALL)}]::text[]) x),
    'anon_other_changed', (SELECT count(*) FROM (
        (SELECT sig FROM pg_temp.p4263p5_anon_before EXCEPT SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE'))
        UNION ALL
        (SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE') AND p.proname !~ '^mcp_' EXCEPT SELECT sig FROM pg_temp.p4263p5_anon_before)) z),
    'internal_api_grants', (SELECT count(*) FROM unnest(ARRAY[{', '.join(repr(SIG[n]) for n in NEW if n not in ANON_NEW)}]) s
        WHERE has_function_privilege('anon', s::regprocedure, 'EXECUTE') OR has_function_privilege('authenticated', s::regprocedure, 'EXECUTE')
           OR has_function_privilege('service_role', s::regprocedure, 'EXECUTE')),
    'switch_off', (SELECT writes_enabled IS FALSE FROM public.mcp_write_settings WHERE id),
    'switch_table_api_privileges', (SELECT count(*) FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) pr
        WHERE has_table_privilege(r, 'public.mcp_write_settings', pr)),
    'writes_on', public._mcp_writes_on(),
    'connections_by_scope_unchanged', (SELECT coalesce(jsonb_object_agg(scope, n), '{{}}') FROM (SELECT scope, count(*) n FROM public.mcp_connections GROUP BY scope) x)
                                       = (SELECT j FROM pg_temp.p4263p5_conn_before),
    'old_grants_can_write', (SELECT count(*) FROM public.mcp_connections c WHERE public._mcp_conn_can_write(c.id)),
    'todos_connections', (SELECT count(*) FROM public.mcp_connections WHERE scope = 'mcp:todos'),
    'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')) INTO v;
  IF v -> 'bodies' <> '{{}}'::jsonb OR (v ->> 'reader_owner_ok')::boolean IS NOT TRUE OR (v ->> 'anon_mcp')::boolean IS NOT TRUE
     OR (v ->> 'anon_other_changed')::int <> 0 OR (v ->> 'internal_api_grants')::int <> 0 OR (v ->> 'switch_off')::boolean IS NOT TRUE
     OR (v ->> 'switch_table_api_privileges')::int <> 0
     OR (v ->> 'writes_on')::boolean IS NOT FALSE OR (v ->> 'connections_by_scope_unchanged')::boolean IS NOT TRUE
     OR (v ->> 'old_grants_can_write')::int <> 0 OR (v ->> 'todos_connections')::int <> 0 OR (v ->> 'ledger')::int <> 1 THEN
    RAISE EXCEPTION 'APPLY POST-CHECK {VERSION} FAILED, nothing applied: %', v;
  END IF;
  RAISE NOTICE 'APPLY POST-CHECK {VERSION} OK: %', v;
END
$post4263p5$;
"""
apply_head = f"""-- apply-{VERSION}.sql (generated by supabase/tests/backlog-4263-pr5/gen.py; do not hand-edit)
-- Migration: {MIG_PATH}  file md5 {mig_md5}
-- One transaction. If the apply tool writes the ledger row itself, remove the INSERT below.
-- The post-check RAISEs (rolling everything back) unless: every function this file writes is at its md5; the reader
-- is owned by mcp_reader, STABLE and SECURITY DEFINER; the anon-callable mcp functions are exactly the 15 named
-- (10 before + 5 new); no other anon-callable function changed; the internal functions have no API grant; the
-- switch is OFF; no connection changed scope and none can write (old-grant check); the ledger row.
CREATE TEMP TABLE p4263p5_anon_before ON COMMIT DROP AS
  SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE');
CREATE TEMP TABLE p4263p5_conn_before ON COMMIT DROP AS
  SELECT (SELECT coalesce(jsonb_object_agg(scope, n), '{{}}') FROM (SELECT scope, count(*) n FROM public.mcp_connections GROUP BY scope) x) AS j;

"""
apply = apply_head + mig + post

# ------------------------------------------------------------------------------------------------ rollback
new_marks = {n: md5(body(NEWS[n], 'fn')) for n in REPLACED}
old_parts = []
for n in REPLACED:
    s = OLD[n]
    if n == '_mcp_r_deal_checklists':
        s = 'GRANT CREATE ON SCHEMA public TO mcp_reader;\nSET ROLE mcp_reader;\n' + s + 'RESET ROLE;\nREVOKE CREATE ON SCHEMA public FROM mcp_reader;\n'
    old_parts.append(s)
rollback = f"""-- rollback-{VERSION}.sql (generated by supabase/tests/backlog-4263-pr5/gen.py; do not hand-edit)
-- Undoes {MIG_PATH}. One transaction; RAISEs (nothing changed) unless the post-check holds.
-- Write grants are taken back: every 'mcp:todos' connection and request becomes 'mcp:read' (counted in the NOTICE).
-- Call log rows of the four write tools, and rows with outcome read_only or refused, are deleted (counted), so the
-- earlier CHECKs can be put back. The todos the AI apps changed stay as they are (they are ordinary todo changes).
DO $pre4263p5r$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES {', '.join(f"('{SIG[n]}', '{new_marks[n]}')" for n in REPLACED)}) x(sig, md5) LOOP
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'ROLLBACK {VERSION}: % is not at the body {VERSION} wrote (md5 %)', r.sig, coalesce(v_md5, 'missing'); END IF;
  END LOOP;
END
$pre4263p5r$;
CREATE TEMP TABLE p4263p5r_counts ON COMMIT DROP AS SELECT
  (SELECT count(*) FROM public.mcp_connections WHERE scope = 'mcp:todos') AS todos_connections,
  (SELECT count(*) FROM public.mcp_authorization_requests WHERE scope = 'mcp:todos') AS todos_requests,
  (SELECT count(*) FROM public.mcp_call_log WHERE tool IN ('update_todo', 'add_todo', 'remove_todo', 'restore_todo') OR outcome IN ('read_only', 'refused')) AS log_rows;
UPDATE public.mcp_connections SET scope = 'mcp:read' WHERE scope = 'mcp:todos';
UPDATE public.mcp_authorization_requests SET scope = 'mcp:read' WHERE scope = 'mcp:todos';
DELETE FROM public.mcp_call_log WHERE tool IN ('update_todo', 'add_todo', 'remove_todo', 'restore_todo') OR outcome IN ('read_only', 'refused');

{''.join(p + chr(10) for p in old_parts)}
{''.join(f'DROP FUNCTION IF EXISTS {SIG[n]};{chr(10)}' for n in reversed(NEW))}
ALTER TABLE public.mcp_authorization_requests DROP CONSTRAINT IF EXISTS mcp_authorization_requests_scope_check;
ALTER TABLE public.mcp_authorization_requests ADD CONSTRAINT mcp_authorization_requests_scope_check CHECK (scope = 'mcp:read');
ALTER TABLE public.mcp_connections DROP CONSTRAINT IF EXISTS mcp_connections_scope_check;
ALTER TABLE public.mcp_connections ADD CONSTRAINT mcp_connections_scope_check CHECK (scope = 'mcp:read');
ALTER TABLE public.mcp_call_log DROP CONSTRAINT IF EXISTS mcp_call_log_tool_check;
ALTER TABLE public.mcp_call_log ADD CONSTRAINT mcp_call_log_tool_check
  CHECK (tool IS NULL OR tool IN ('get_status', 'list_deals', 'get_deal', 'get_deal_checklists', 'list_all_deals'));
ALTER TABLE public.mcp_call_log DROP CONSTRAINT IF EXISTS mcp_call_log_outcome_check;
ALTER TABLE public.mcp_call_log ADD CONSTRAINT mcp_call_log_outcome_check
  CHECK (outcome IN ('pending', 'ok', 'not_connected', 'disabled', 'rate_limited', 'busy', 'not_entitled', 'timeout', 'error',
                     'invalid_input', 'not_found', 'too_large'));
DROP TABLE IF EXISTS public.mcp_write_settings;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}';

DO $post4263p5r$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'bodies', (SELECT coalesce(jsonb_object_agg(x.sig, coalesce(md5(p.prosrc), 'missing')), '{{}}') FROM (VALUES {', '.join(f"('{SIG[n]}', '{TRACED[n]}')" for n in REPLACED)}) x(sig, want)
                LEFT JOIN pg_proc p ON p.oid = to_regprocedure(x.sig) WHERE p.oid IS NULL OR md5(p.prosrc) <> x.want),
    'new_left', (SELECT count(*) FROM unnest(ARRAY[{', '.join(repr(SIG[n]) for n in NEW)}]) s WHERE to_regprocedure(s) IS NOT NULL),
    'anon_mcp', (SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text), '{{}}') FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE'))
        = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[{', '.join(repr(x) for x in ANON_OLD)}]::text[]) x),
    'reader_owner_ok', public._mcp_reader_ok('public._mcp_r_deal_checklists(uuid,boolean,uuid)'::regprocedure),
    'column_left', (SELECT count(*) FROM pg_class WHERE oid = to_regclass('public.mcp_write_settings')),
    'todos_connections_downgraded', (SELECT todos_connections FROM pg_temp.p4263p5r_counts),
    'todos_requests_downgraded', (SELECT todos_requests FROM pg_temp.p4263p5r_counts),
    'log_rows_deleted', (SELECT log_rows FROM pg_temp.p4263p5r_counts),
    'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')) INTO v;
  IF v -> 'bodies' <> '{{}}'::jsonb OR (v ->> 'new_left')::int <> 0 OR (v ->> 'anon_mcp')::boolean IS NOT TRUE
     OR (v ->> 'reader_owner_ok')::boolean IS NOT TRUE OR (v ->> 'column_left')::int <> 0 OR (v ->> 'ledger')::int <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK {VERSION} FAILED, nothing changed: %', v;
  END IF;
  RAISE NOTICE 'ROLLBACK POST-CHECK {VERSION} OK: %', v;
END
$post4263p5r$;
"""

# ------------------------------------------------------------------------------------------------ harness
def strip_temp_on_commit(s):
    # the harness keeps these temp tables to the end of the call
    return s.replace(' ON COMMIT DROP', '')

harness = f"""-- harness-5.sql (generated by supabase/tests/backlog-4263-pr5/gen.py; do not hand-edit)
-- BACKLOG-4263 PR-5: ONE call on the test project (~/.claude/bin/kt-sql harness-5.sql) that ends in RAISE, so nothing
-- persists. Order: fixtures (real producers) -> the apply file (migration + ledger + post-check) -> the migration
-- again (re-run) -> {len(CONTROLS)} controls -> {len(MUTS)} mutations, each proven installed by md5 before its control runs
-- -> the rollback file and its post-check -> the old body still answers -> RAISE with every result.
-- Afterwards: ~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()". Only statuses, counts and
-- booleans are recorded.
{lib('../../backlog-4263-pr5/lib/helpers-base.sql') if False else rd('supabase/tests/backlog-4263-pr5/lib/helpers-base.sql')}
{lib('fixtures.sql')}
-- ================================================================ apply
{strip_temp_on_commit(apply)}
-- ================================================================ re-run of the migration
{mig}
DO $rerun$ BEGIN PERFORM pg_temp.rec('rerun_switch_kept_off', to_jsonb((SELECT writes_enabled FROM public.mcp_write_settings WHERE id) IS FALSE)); END $rerun$;
-- ================================================================ controls
{lib('controls.sql')}
DO $base$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY[{', '.join(repr(c) for c in CONTROLS)}] LOOP
    PERFORM pg_temp.rec('CTL_' || c, to_jsonb(pg_temp.iso(c)));
  END LOOP;
END
$base$;
-- ================================================================ mutations
{''.join(mut_sql)}
-- ================================================================ real answers for the portal fixtures
{lib('observe.sql')}
-- ================================================================ rollback rehearsal (after the controls' fixtures: todos connections exist)
DO $rbfx$ BEGIN PERFORM pg_temp.sw(true); PERFORM pg_temp.rec('rb_before', jsonb_build_object('todos_connections', (SELECT count(*) FROM public.mcp_connections WHERE scope = 'mcp:todos'))); END $rbfx$;
{strip_temp_on_commit(rollback)}
DO $after$
BEGIN
  PERFORM pg_temp.rec('rb_old_reader_v1', to_jsonb((pg_temp.reader(pg_temp.id('A'), pg_temp.id('DA1')) -> 'v')::int = 1));
  PERFORM pg_temp.rec('rb_old_check_access', pg_temp.w(format('SELECT public.mcp_check_access(%L, %L::bytea, %L)', pg_temp.secret(), pg_temp.dgl(11), pg_temp.res())));
  PERFORM pg_temp.rec('rb_scope_of_todos_conn', to_jsonb((SELECT scope FROM public.mcp_connections WHERE id = pg_temp.id('KA_todos'))));
  RAISE EXCEPTION 'P5_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p5_out);
END
$after$;
"""

facts = {'migration': MIG_PATH, 'migration_md5': mig_md5,
         'replaced': {SIG[n]: {'old': TRACED[n], 'new': NEW_MD5[n]} for n in REPLACED},
         'new': {SIG[n]: NEW_MD5[n] for n in NEW},
         'anon_callable_mcp_after': ANON_ALL,
         'apply_md5': md5(apply), 'rollback_md5': md5(rollback)}
outs = {'apply-20261118130000.sql': apply, 'rollback-20261118130000.sql': rollback, 'harness-5.sql': harness,
        'catalog-facts.json': json.dumps(facts, indent=2) + '\n'}
if len(sys.argv) > 2 and sys.argv[1] == 'fixtures':
    # python3 gen.py fixtures <kt-sql output file>: writes broker-portal/__tests__/mcp/fixtures/todo-tools-4263.json
    first = open(sys.argv[2]).read().splitlines()[0]
    raw = json.loads(first)['message']
    res = json.loads(raw[raw.index('P5_RESULT ') + 10:raw.index('\nCONTEXT')])
    fx = {k: v for k, v in sorted(res.items()) if k.startswith('FX_')}
    text = json.dumps(fx, indent=1, sort_keys=True)
    ids = sorted(set(re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', text)))
    for n, u in enumerate(ids, 1):
        text = text.replace(u, f'<id:{n}>')
    text = re.sub(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z', '2026-11-18T00:00:00.000000Z', text)
    out = os.path.join(REPO, 'broker-portal/__tests__/mcp/fixtures/todo-tools-4263.json')
    open(out, 'w').write(text + '\n')
    print('wrote', out, len(fx), 'answers', len(ids), 'ids')
    sys.exit(0)
if len(sys.argv) > 1 and sys.argv[1] == 'check':
    bad = [k for k, v in outs.items() if open(os.path.join(HERE, k)).read() != v]
    print('differs: ' + ', '.join(bad) if bad else 'all generated files match')
    sys.exit(1 if bad else 0)
for k, v in outs.items():
    open(os.path.join(HERE, k), 'w').write(v)
print('\n'.join(mut_report))
print(json.dumps({k: md5(v) for k, v in outs.items()}, indent=1))
