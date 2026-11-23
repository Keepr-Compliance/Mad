#!/usr/bin/env python3
"""BACKLOG-4263 sync 2.49, P9 (migration T-S 20261123140000): test-project files, generated from the migration text.

  apply-20261123140000.sql     the migration text unchanged + its ledger row, in one transaction
  rollback-20261123140000.sql  drops what T-S created, puts back the call-log tool CHECK, removes the ledger row; one
                               transaction; RAISEs unless its post-check holds
  harness-t.sql                TEST DATABASE ONLY, run AFTER T-S is applied. One call that ends in RAISE (nothing is
                               kept): guard, applied check, helpers and fixtures (lib/), the controls (lib/controls.sql),
                               each control's mutants (proven applied first), the rollback file, then RAISE with every
                               result.

`python3 gen.py`          writes these files
`python3 gen.py check`    fails when a written file differs from what the migration gives now, or a mutant fragment
                          does not match exactly once (MUTATION NOT APPLIED); prints MUTATION APPLIED for each mutant
`python3 gen.py report <kt-sql output>`  reads the harness result and prints PASS / FAIL per control and mutant
`python3 gen.py selftest`  report() on canned outputs in both transport shapes and on a real captured kt-sql output;
                          `selftest --control-green-ok` is its control (must fail)
"""
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
REL = 'supabase/tests/backlog-4263-sync2-t'
T_NAME = '20261123140000_backlog_4263_mcp_message_tools.sql'
T_PATH = f'supabase/migrations/{T_NAME}'
T_VERSION, T_LEDGER = T_NAME[:14], T_NAME[15:-4]
md5 = lambda s: hashlib.md5(s.encode('utf-8')).hexdigest()
rd = lambda p: open(os.path.join(REPO, p), encoding='utf-8').read()
T = rd(T_PATH)
LIB = {n: rd(f'{REL}/lib/{n}.sql') for n in ('helpers', 'fixtures', 'controls')}
GUARD_B = "md5(u.id::text) = '53a385187695375e2e8695625a20a77a'"  # the reserved test account (same marker as backlog-4263-prod)
READERS = ('_mcp_r_list_deal_messages', '_mcp_r_get_message')
OLD_TOOLS = ['get_status', 'list_deals', 'get_deal', 'get_deal_checklists', 'list_all_deals', 'update_todo', 'add_todo',
             'remove_todo', 'restore_todo', 'find_people', 'list_todos']
NEW_TOOLS = ['list_deal_messages', 'get_message']


def unit(name):
    """(CREATE statement, body, signature) of one function of T."""
    start = f'CREATE OR REPLACE FUNCTION public.{name}('
    assert T.count(start) == 1, name
    i = T.index(start)
    b0 = T.index('AS $fn$', i) + len('AS $fn$')
    b1 = T.index('$fn$;', b0)
    sig = re.search(r'REVOKE ALL ON FUNCTION (public\.' + re.escape(name) + r'\([^)]*\))', T[b1:]).group(1)
    return T[i:b1 + 5], T[b0:b1], sig


FUNCS = [m.group(1) for m in re.finditer(r'^CREATE OR REPLACE FUNCTION public\.(\w+)\(', T, re.M)]
assert len(FUNCS) == 9, FUNCS
SIGS = {f: unit(f)[2] for f in FUNCS}
BODY_MD5 = {f: md5(unit(f)[1]) for f in FUNCS}
for t in LIB.values():
    assert '$mu' not in t


def _args(text, i):
    """Top-level argument count of the call whose '(' is at text[i] (quotes and dollar quotes respected)."""
    d, j, n, empty = 0, i, 0, True
    while True:
        c = text[j]
        if c == "'":
            j = text.index("'", j + 1)
            while text[j + 1:j + 2] == "'":
                j = text.index("'", j + 2)
        elif c == '$' and re.match(r'\$[A-Za-z_]*\$', text[j:]):
            tag = re.match(r'\$[A-Za-z_]*\$', text[j:]).group(0)
            j = text.index(tag, j + len(tag)) + len(tag) - 1
        elif c in '([':
            d += 1
        elif c in ')]':
            d -= 1
            if d == 0:
                return 0 if empty else n + 1
        elif c == ',' and d == 1:
            n += 1
        if d >= 1 and j > i and not c.isspace():
            empty = False
        j += 1


def arity_problems(text):
    """Every pg_temp.<name>( call whose argument count differs from its definition (VARIADIC: at least)."""
    defs = {}
    for m in re.finditer(r'CREATE FUNCTION pg_temp\.(\w+)\(', text):
        k = _args(text, m.end() - 1)
        var = 'VARIADIC' in text[m.end():text.index(')', m.end())]
        assert m.group(1) not in defs, m.group(1)
        defs[m.group(1)] = (k, var)
    bad = []
    for m in re.finditer(r'(?<!FUNCTION )pg_temp\.(\w+)\(', text):
        name = m.group(1)
        if name not in defs:
            bad.append(f'{name}: not defined')
            continue
        k, var = defs[name]
        got = _args(text, m.end() - 1)
        if (var and got < k) or (not var and got != k):
            bad.append(f'{name}: {got} arguments, defined with {k}')
    return bad


def dq(s, tag):
    assert tag not in s, tag
    return tag + '\n' + s + '\n' + tag


# ------------------------------------------------------------------------------------------------ apply file
APPLY = f"""-- apply-{T_VERSION}.sql (generated by {REL}/gen.py; do not hand-edit)
-- Migration: {T_PATH}  file md5 {md5(T)}
-- One transaction: the migration text unchanged, then its ledger row. Send this file as one call. If the apply tool
-- writes the ledger row itself, remove the INSERT below.
-- Re-run: the migration text is re-runnable; the INSERT is not. When the ledger row already exists the INSERT fails
-- (duplicate version) and the whole call rolls back, so nothing changes (inferred from the ledger's version key; not run).
-- Then run supabase/tests/backlog-4263-prod/postcheck-{T_VERSION}.sql (read-only; it requires this ledger row).

{T}
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('{T_VERSION}', '{T_LEDGER}', ARRAY[]::text[]);
"""

# ------------------------------------------------------------------------------------------------ rollback file
SIG_LIST = ', '.join("'" + SIGS[f] + "'" for f in FUNCS)
ROLLBACK = f"""-- rollback-{T_VERSION}.sql (generated by {REL}/gen.py; do not hand-edit)
-- Undoes {T_PATH}. One transaction; RAISEs (nothing changed) unless its post-check holds.
-- Refuses while public.mcp_message_reads holds any row (the read log of AI apps; keep a copy first).
-- Deleted: the call log rows of list_deal_messages and get_message (counted in the NOTICE; their audit record is lost).
-- Then the job 'mcp-message-reads-prune' is unscheduled, the nine functions and the table are dropped, the 11-name tool
-- CHECK is put back (found by the tool column; the outcome CHECK is not touched) and the ledger row is removed.
-- Locks: DROP TABLE takes ACCESS EXCLUSIVE on mcp_message_reads and, through its foreign key, a lock on auth.users;
-- the CHECK swap takes ACCESS EXCLUSIVE on mcp_call_log; both until commit, lock_timeout 3s.
-- Deploy order: the portal without the message tools first, then this file.
-- lock_timeout 3s is set before the first statement.
SET LOCAL lock_timeout = '3s';
DO $pre4263tr$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES {', '.join(f"('{SIGS[f]}', '{BODY_MD5[f]}')" for f in FUNCS)}) x(sig, md5) LOOP
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'ROLLBACK {T_VERSION}: % is not at the body {T_VERSION} wrote (md5 %)', r.sig, coalesce(v_md5, 'missing');
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.mcp_message_reads) THEN
    RAISE EXCEPTION 'ROLLBACK {T_VERSION}: public.mcp_message_reads holds rows; keep a copy, then delete them first';
  END IF;
END
$pre4263tr$;
CREATE TEMP TABLE p4263tr_fn_before ON COMMIT DROP AS
  SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS src_md5, p.proacl::text AS acl, p.proconfig AS config, p.prosecdef AS secdef,
         p.proowner AS owner, p.provolatile AS vol
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.oid NOT IN (SELECT to_regprocedure(s) FROM unnest(ARRAY[{SIG_LIST}]) s);
CREATE TEMP TABLE p4263tr_counts ON COMMIT DROP AS
  SELECT (SELECT count(*) FROM public.mcp_call_log WHERE tool IN ('list_deal_messages', 'get_message')) AS log_rows;
DELETE FROM public.mcp_call_log WHERE tool IN ('list_deal_messages', 'get_message');
DO $cron4263tr$
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'mcp-message-reads-prune';
END
$cron4263tr$;
""" + ''.join(f"DROP FUNCTION IF EXISTS {SIGS[f]};\n" for f in reversed(FUNCS)) + f"""DROP TABLE IF EXISTS public.mcp_message_reads;
DO $chk4263tr$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.contype = 'c'
       AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public.mcp_call_log'::regclass AND a.attname = 'tool')]
  LOOP
    EXECUTE format('ALTER TABLE public.mcp_call_log DROP CONSTRAINT %I', v_name);
  END LOOP;
END
$chk4263tr$;
ALTER TABLE public.mcp_call_log ADD CONSTRAINT mcp_call_log_tool_check
  CHECK (tool IS NULL OR tool IN ({', '.join("'" + t + "'" for t in OLD_TOOLS)}));
DELETE FROM supabase_migrations.schema_migrations WHERE version = '{T_VERSION}';

DO $post4263tr$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'functions_left', (SELECT count(*) FROM unnest(ARRAY[{SIG_LIST}]) s WHERE to_regprocedure(s) IS NOT NULL),
    'table_left', to_regclass('public.mcp_message_reads') IS NOT NULL,
    'job_left', EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mcp-message-reads-prune'),
    'other_functions_changed', (SELECT count(*) FROM pg_temp.p4263tr_fn_before b
         WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text = b.sig
                             AND md5(p.prosrc) = b.src_md5 AND p.proacl::text IS NOT DISTINCT FROM b.acl AND p.proconfig IS NOT DISTINCT FROM b.config
                             AND p.prosecdef = b.secdef AND p.proowner = b.owner AND p.provolatile = b.vol)),
    'tool_check', (SELECT array_agg(m[1] ORDER BY m[1] COLLATE "C") FROM pg_catalog.pg_constraint c, regexp_matches(pg_catalog.pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') m
        WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.conname = 'mcp_call_log_tool_check')
        = (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(ARRAY[{', '.join("'" + t + "'" for t in OLD_TOOLS)}]::text[]) x),
    'log_rows_deleted', (SELECT log_rows FROM pg_temp.p4263tr_counts),
    'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{T_VERSION}')) INTO v;
  IF (v ->> 'functions_left')::int <> 0 OR (v ->> 'table_left')::boolean OR (v ->> 'job_left')::boolean
     OR (v ->> 'other_functions_changed')::int <> 0 OR (v ->> 'tool_check')::boolean IS NOT TRUE OR (v ->> 'ledger')::int <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK {T_VERSION} FAILED, nothing changed: %', v;
  END IF;
  RAISE NOTICE 'ROLLBACK POST-CHECK {T_VERSION} OK: %', v;
END
$post4263tr$;
"""

# ------------------------------------------------------------------------------------------------ mutants
CONTROLS = ['c_c9a_permission', 'c_c9a_access', 'c_c9b_parts_big', 'c_c9b_list_big', 'c_c9b_sweep', 'c_c9c_log_rows', 'c_c9d_filters',
            'c_c9e_entitlement', 'c_c9f_log_fails', 'c_c9g_no_read_no_row', 'c_c9h_inactive', 'c_p9a_log_survives', 'c_log_view',
            'c_marks_args', 'c_keyset_null', 'c_prune', 'c_catalogue', 'c_strip', 'c_people', 'c_prune_loop']
for c in CONTROLS:
    assert LIB['controls'].count(f'CREATE FUNCTION pg_temp.{c}()') == 1, c
assert len(re.findall(r'^CREATE FUNCTION pg_temp\.c_', LIB['controls'], re.M)) == len(CONTROLS)

LOG_COMMENT = '  -- read log: after the read-only block, outside any exception handler, only for an answer that is returned\n'


def log_block(name, marker):
    u = unit(name)[0]
    i = u.index(LOG_COMMENT)
    j = u.index(marker, i) + len(marker)
    j = u.index('  END IF;\n', j) + len('  END IF;\n')
    return u[i:j]


def insert_stmt(name, marker):
    b = log_block(name, marker)
    i = b.index('    INSERT INTO public.mcp_message_reads')
    j = b.index(marker) + len(marker)
    return b[i:j]


CLIENT = "coalesce((SELECT c.client_name FROM public.mcp_connections c WHERE c.id = g.connection_id), '')"
MC000 = "      RAISE EXCEPTION USING ERRCODE = 'MC000', MESSAGE = 'mcp read block done';\n"

# (id, function, [(old, new)], primary controls, want)
FN_MUTANTS = [
    ('perm_version_ignored', '_mcp_conn_reads_messages', [("AND c.notice_version >= 2)   /*PERM:version*/", "AND true)")], ['c_c9a_permission', 'c_c9a_access'], 'red'),
    ('perm_gate_list_dropped', 'mcp_list_deal_messages', [("IF public._mcp_conn_reads_messages(g.connection_id) IS NOT TRUE THEN                        /*PERM:list*/", "IF false THEN")], ['c_c9a_permission'], 'red'),
    ('perm_gate_get_dropped', 'mcp_get_message', [("IF public._mcp_conn_reads_messages(g.connection_id) IS NOT TRUE THEN                        /*PERM:get*/", "IF false THEN")], ['c_c9a_permission'], 'red'),
    ('access_permission_ignored', 'mcp_message_access', [("public._mcp_conn_reads_messages(v_conn) IS TRUE                                            /*ACCESS:permission*/", "true")], ['c_c9a_access'], 'red'),
    ('access_switch_ignored', 'mcp_message_access', [("AND coalesce((SELECT w.messages_upload FROM public.cloud_release_switches w WHERE w.id), false));   /*ACCESS:switch*/", ");")], ['c_c9a_access'], 'red'),
    ('part_cut_by_characters', '_mcp_r_get_message', [("v_w := octet_length(to_jsonb(v_b)::text) - 2;", "v_w := char_length(v_b);")], ['c_c9b_sweep', 'c_c9b_parts_big'], 'red'),
    ('part_budget_ignores_header', '_mcp_r_get_message', [("v_budget := least(60000, 86000 - octet_length(v_frame::text));", "v_budget := 88000;")], ['c_c9b_parts_big'], 'red'),
    ('cap_people_to_uncapped', '_mcp_msg_people', [("WHERE s.n <= 20 /*CAP:people*/ AND", "WHERE")], ['c_c9b_parts_big', 'c_c9b_list_big'], 'red'),
    ('people_extra_from_not_counted', '_mcp_msg_people', [("'more', (SELECT count(*) FROM s) - (SELECT count(*) FROM v))", "'more', (SELECT count(*) FROM s WHERE s.r <> 'from_more') - (SELECT count(*) FROM v))")], ['c_people'], 'red'),
    ('people_cc_not_counted_in_list', '_mcp_msg_people', [("'more', (SELECT count(*) FROM s) - (SELECT count(*) FROM v))", "'more', (SELECT count(*) FROM s WHERE s.r <> 'cc' OR p_with_cc IS TRUE) - (SELECT count(*) FROM v))")], ['c_people', 'c_c9b_list_big'], 'red'),
    ('body_not_stripped', '_mcp_r_get_message', [("v_text := public._mcp_strip(m.body_text);", "v_text := m.body_text;")], ['c_strip', 'c_c9b_parts_big'], 'red'),
    ('hide_needs_active_list', '_mcp_r_list_deal_messages', [("v_hide := (v_st -> 'switches' -> 'one_computer') = to_jsonb(true);", "v_hide := (v_st -> 'switches' -> 'one_computer') = to_jsonb(true) AND jsonb_typeof(v_st -> 'active_install_id') = 'string';")], ['c_c9h_inactive'], 'red'),
    ('hide_needs_active_get', '_mcp_r_get_message', [("v_hide := (v_st -> 'switches' -> 'one_computer') = to_jsonb(true);", "v_hide := (v_st -> 'switches' -> 'one_computer') = to_jsonb(true) AND jsonb_typeof(v_st -> 'active_install_id') = 'string';")], ['c_c9h_inactive'], 'red'),
    ('prune_single_batch', '_mcp_prune_message_reads', [("EXIT WHEN v_b < 100000 OR", "EXIT WHEN true OR")], ['c_prune_loop'], 'red'),
    ('cap_files_list_uncapped', '_mcp_r_list_deal_messages', [("ORDER BY f.n) FILTER (WHERE f.n <= 20), '[]'::jsonb) AS files,", "ORDER BY f.n), '[]'::jsonb) AS files,")], ['c_c9b_list_big'], 'red'),
    ('cap_files_get_uncapped', '_mcp_r_get_message', [("ORDER BY f.n) FILTER (WHERE f.n <= 20), '[]'::jsonb),   /*CAP:files:get*/", "ORDER BY f.n), '[]'::jsonb),")], ['c_c9b_parts_big'], 'red'),
    ('cap_subject_list_uncapped', '_mcp_r_list_deal_messages', [("'subject', public._mcp_clean(left(m.subject, 2000), 300),", "'subject', m.subject,")], ['c_c9b_list_big'], 'red'),
    ('cap_subject_get_uncapped', '_mcp_r_get_message', [("'subject', public._mcp_clean(left(m.subject, 2000), 300),", "'subject', m.subject,")], ['c_c9b_parts_big'], 'red'),
    ('list_byte_bound_dropped', '_mcp_r_list_deal_messages', [(" AND (s.cum <= 80000 OR s.rk = 1) /*BOUND:bytes*/", "")], ['c_c9b_list_big'], 'red'),
    # the first-row arm is reached only by a row over 80000 bytes, which the caps rule out: expected equivalent
    ('list_first_row_arm_dropped', '_mcp_r_list_deal_messages', [("(s.cum <= 80000 OR s.rk = 1) /*BOUND:bytes*/", "s.cum <= 80000")], ['c_c9b_list_big'], 'green'),
    ('keyset_on_sent_at_only', '_mcp_r_list_deal_messages', [("(coalesce(x.sent_at, x.received_at, x.created_at), x.id) < (p_after_key, p_after_id)) /*KEY:after*/", "(x.sent_at, x.id) < (p_after_key, p_after_id))")], ['c_keyset_null'], 'red'),
    ('log_inside_read_block_list', 'mcp_list_deal_messages',
     [(log_block('mcp_list_deal_messages', '/*LOG:list*/'), ''),
      (MC000, insert_stmt('mcp_list_deal_messages', '/*LOG:list*/').replace('v_client', CLIENT).replace('\n    ', '\n      ').replace('    INSERT', '      INSERT', 1) + '\n' + MC000)],
     ['c_c9c_log_rows'], 'red'),
    ('log_dropped_get', 'mcp_get_message', [(log_block('mcp_get_message', '/*LOG:get*/'), '')], ['c_c9c_log_rows'], 'red'),
    ('log_swallowed_get', 'mcp_get_message', [(insert_stmt('mcp_get_message', '/*LOG:get*/'),
                                               '    BEGIN\n' + insert_stmt('mcp_get_message', '/*LOG:get*/') + '\n    EXCEPTION WHEN OTHERS THEN NULL;\n    END;')], ['c_c9f_log_fails'], 'red'),
    ('log_swallowed_list', 'mcp_list_deal_messages', [(insert_stmt('mcp_list_deal_messages', '/*LOG:list*/'),
                                                       '    BEGIN\n' + insert_stmt('mcp_list_deal_messages', '/*LOG:list*/') + '\n    EXCEPTION WHEN OTHERS THEN NULL;\n    END;')], ['c_c9f_log_fails'], 'red'),
    ('log_before_outcome_get', 'mcp_get_message', [(LOG_COMMENT + "  IF v_out = 'ok' THEN", LOG_COMMENT + "  IF v_res IS NOT NULL THEN")], ['c_c9g_no_read_no_row'], 'red'),
    ('log_before_outcome_list', 'mcp_list_deal_messages', [(LOG_COMMENT + "  IF v_out = 'ok' THEN", LOG_COMMENT + "  IF v_res IS NOT NULL THEN")], ['c_c9g_no_read_no_row'], 'red'),
    ('removed_messages_listed', '_mcp_r_list_deal_messages', [("\n         AND x.removed_at IS NULL /*LIVE:lm_msgs*/", "")], ['c_c9d_filters'], 'red'),
    ('removed_message_by_id', '_mcp_r_get_message', [("\n     AND x.removed_at IS NULL /*LIVE:gm_msg*/", "")], ['c_c9d_filters'], 'red'),
    ('suggested_listed', '_mcp_r_list_deal_messages', [("\n         AND x.link_state IN ('linked', 'needs_review') /*STATE:lm*/", "")], ['c_c9d_filters'], 'red'),
    ('suggested_by_id', '_mcp_r_get_message', [("\n     AND x.link_state IN ('linked', 'needs_review') /*STATE:gm*/", "")], ['c_c9d_filters'], 'red'),
    ('unconfirmed_deal_list', '_mcp_r_list_deal_messages', [(" AND d.is_confirmed /*CONF:lm_deal*/", "")], ['c_c9d_filters'], 'red'),
    ('unconfirmed_deal_by_id', '_mcp_r_get_message', [(" AND d.is_confirmed /*CONF:gm_deal*/", "")], ['c_c9d_filters'], 'red'),
    ('removed_deal_list', '_mcp_r_list_deal_messages', [(" AND d.removed_at IS NULL /*LIVE:lm_deal*/", "")], ['c_c9d_filters'], 'red'),
    ('removed_deal_by_id', '_mcp_r_get_message', [(" AND d.removed_at IS NULL /*LIVE:gm_deal*/", "")], ['c_c9d_filters'], 'red'),
    ('removed_files_list', '_mcp_r_list_deal_messages', [(" AND y.removed_at IS NULL /*LIVE:lm_files*/", "")], ['c_c9d_filters'], 'red'),
    ('removed_files_get', '_mcp_r_get_message', [(" AND y.removed_at IS NULL /*LIVE:gm_files*/", "")], ['c_c9d_filters'], 'red'),
    ('files_not_through_message', '_mcp_r_list_deal_messages', [("WHERE y.cloud_message_id = m.id AND y.cloud_deal_id = m.cloud_deal_id /*FILE:via_message:list*/", "WHERE y.cloud_deal_id = m.cloud_deal_id")], ['c_c9d_filters'], 'red'),
    ('notice_ignored_list', '_mcp_r_list_deal_messages', [("\n     OR (v_st -> 'entitled') IS DISTINCT FROM to_jsonb(true)                                   /*ENT:notice:list*/", "")], ['c_c9e_entitlement'], 'red'),
    ('notice_ignored_get', '_mcp_r_get_message', [("\n     OR (v_st -> 'entitled') IS DISTINCT FROM to_jsonb(true)                                   /*ENT:notice:get*/", "")], ['c_c9e_entitlement'], 'red'),
    ('switch_ignored_list', '_mcp_r_list_deal_messages', [("\n     OR (v_st -> 'switches' -> 'messages_upload') IS DISTINCT FROM to_jsonb(true) THEN         /*ENT:switch:list*/", " THEN")], ['c_c9e_entitlement'], 'red'),
    ('switch_ignored_get', '_mcp_r_get_message', [("\n     OR (v_st -> 'switches' -> 'messages_upload') IS DISTINCT FROM to_jsonb(true) THEN         /*ENT:switch:get*/", " THEN")], ['c_c9e_entitlement'], 'red'),
    ('inactive_shown_list', '_mcp_r_list_deal_messages', [("v_hidden := v_hide AND v_inst IS DISTINCT FROM v_active;", "v_hidden := false;")], ['c_c9h_inactive'], 'red'),
    ('inactive_rows_list', '_mcp_r_list_deal_messages', [("\n         AND v_hidden IS NOT TRUE /*HIDE:lm_rows*/", "")], ['c_c9h_inactive'], 'red'),
    ('inactive_by_id', '_mcp_r_get_message', [("\n     AND (v_hide IS NOT TRUE OR d.source_install_id IS NOT DISTINCT FROM v_active) /*HIDE:inactive:get*/", "")], ['c_c9h_inactive'], 'red'),
    ('log_view_support_allowed', 'mcp_list_my_message_reads', [("IF public._mcp_impersonating(v_uid) IS NOT FALSE THEN                                        /*LOGVIEW:support*/", "IF false THEN")], ['c_log_view'], 'red'),
    ('log_view_any_owner', 'mcp_list_my_message_reads', [("WHERE x.user_id = v_uid /*OWN:log*/", "WHERE true")], ['c_log_view'], 'red'),
    ('mark_review_constant', '_mcp_r_list_deal_messages', [("'review_state', m.link_state,", "'review_state', 'linked',")], ['c_marks_args'], 'red'),
    ('mark_hidden_constant', '_mcp_r_list_deal_messages', [("'hidden_from_export', m.hidden_from_export,", "'hidden_from_export', false,")], ['c_marks_args'], 'red'),
    ('review_filter_ignored', '_mcp_r_list_deal_messages', [("\n         AND (p_linked_only IS NOT TRUE OR x.link_state = 'linked') /*ARG:review*/", "")], ['c_marks_args'], 'red'),
    ('channel_filter_ignored', '_mcp_r_list_deal_messages', [("\n         AND (p_channel IS NULL OR x.channel_kind = p_channel) /*ARG:channel*/", "")], ['c_marks_args'], 'red'),
    ('prune_one_day', '_mcp_prune_message_reads', [("WHERE x.read_at < now() - interval '1 year'", "WHERE x.read_at < now() - interval '1 day'")], ['c_prune'], 'red'),
]
# (id, statement, proof that it applied, primary controls, want, as the reader owner)
DDL_MUTANTS = [
    ('log_cascades_with_connection',
     'ALTER TABLE public.mcp_message_reads ADD CONSTRAINT t4263_m_conn_fk FOREIGN KEY (connection_id) REFERENCES public.mcp_connections (id) ON DELETE CASCADE NOT VALID',
     "EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 't4263_m_conn_fk')", ['c_p9a_log_survives'], 'red', False),
    ('prune_granted_service_role', 'GRANT EXECUTE ON FUNCTION public._mcp_prune_message_reads() TO service_role',
     "has_function_privilege('service_role', 'public._mcp_prune_message_reads()', 'EXECUTE')", ['c_catalogue'], 'red', False),
    ('log_table_select_authenticated', 'GRANT SELECT ON TABLE public.mcp_message_reads TO authenticated',
     "has_table_privilege('authenticated', 'public.mcp_message_reads', 'SELECT')", ['c_catalogue'], 'red', False),
    ('reader_granted_anon', 'GRANT EXECUTE ON FUNCTION public._mcp_r_get_message(uuid, integer) TO anon',
     "has_function_privilege('anon', 'public._mcp_r_get_message(uuid,integer)', 'EXECUTE')", ['c_catalogue'], 'red', False),
    ('reader_volatile', 'ALTER FUNCTION public._mcp_r_get_message(uuid, integer) VOLATILE',
     "(SELECT provolatile FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public._mcp_r_get_message(uuid,integer)')) = 'v'", ['c_catalogue'], 'red', True),
]
WANT = {}
PRIMARY = {}


def fn_mutant(i, mid, fn, reps, prim, want, show):
    stmt, body, sig = unit(fn)
    mu = stmt
    for old, new in reps:
        n = mu.count(old)
        if n != 1:
            raise SystemExit(f'MUTATION NOT APPLIED {mid}: fragment matched {n} times in {fn}: {old[:120]!r}')
        mu = mu.replace(old, new)
    assert mu != stmt
    mbody = mu[mu.index('AS $fn$') + len('AS $fn$'):mu.rindex('$fn$;')]
    if show:
        removed = sum(1 for l in stmt.splitlines() if l not in mu.splitlines())
        added = sum(1 for l in mu.splitlines() if l not in stmt.splitlines())
        print(f'MUTATION APPLIED {mid} ({fn}; numstat +{added} -{removed}; mutated body md5 {md5(mbody)})')
        for old, new in reps:
            for l in old.splitlines()[:3]:
                print('  - ' + l.strip()[:150])
            for l in new.splitlines()[:3]:
                print('  + ' + l.strip()[:150])
    WANT[mid], PRIMARY[mid] = want, prim
    q = dq(mu, f'$mu{i}$')
    apply_ = (f"    PERFORM pg_temp.as_reader({q});\n" if fn in READERS else f"    EXECUTE {q};\n")
    proof = f"(SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('{sig}')) = '{md5(mbody)}'"
    return mid, apply_, proof, prim


def ddl_mutant(i, mid, sql, proof, prim, want, as_reader, show):
    if show:
        print(f'MUTATION APPLIED {mid} (ddl)\n  + {sql}')
    WANT[mid], PRIMARY[mid] = want, prim
    q = dq(sql, f'$mu{i}$')
    return mid, (f"    PERFORM pg_temp.as_reader({q});\n" if as_reader else f"    EXECUTE {q};\n"), proof, prim


def mutants(show=False):
    out = [fn_mutant(i, *m, show) for i, m in enumerate(FN_MUTANTS)]
    out += [ddl_mutant(len(FN_MUTANTS) + i, *m, show) for i, m in enumerate(DDL_MUTANTS)]
    ids = [m[0] for m in out]
    assert len(ids) == len(set(ids))
    for m in out:
        for c in m[3]:
            assert c in CONTROLS, c
    return out


def run_controls(names, var):
    return ''.join(f"""    BEGIN
      res := pg_temp.{c}();
      RAISE EXCEPTION 'undo-case';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'undo-case' THEN res := 'ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 400); END IF;
    END;
    {var} := {var} || jsonb_build_object('{c}', res);
""" for c in names)


MUTS = mutants()
mut_blocks = ''.join(f"""  -- {mid}
  BEGIN
    o := '{{}}';
    applied := NULL;
{apply_}    applied := {proof};
    IF applied IS NOT TRUE THEN RAISE EXCEPTION 'MUTATION NOT APPLIED IN DB'; END IF;
{run_controls(prim, 'o')}    RAISE EXCEPTION 'undo-mutant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'undo-mutant' THEN o := o || jsonb_build_object('error', SQLERRM); END IF;
  END;
  PERFORM pg_temp.rec('mutant:{mid}', o || jsonb_build_object('applied', applied, 'want', '{WANT[mid]}'));
""" for mid, apply_, proof, prim in MUTS)

APPLIED_CHECK = ' OR '.join(f"(SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('{SIGS[f]}')) IS DISTINCT FROM '{BODY_MD5[f]}'"
                            for f in FUNCS)
HARNESS = f"""-- harness-t.sql (generated by {REL}/gen.py; do not hand-edit)
-- TEST DATABASE ONLY. This file ends in a rollback and must never be run on production.
-- BACKLOG-4263 sync 2.49, P9: run AFTER {T_PATH} is applied (file md5 {md5(T)}), which needs 20261123100000 and
-- 20261123130000 applied first.
-- ONE call (~/.claude/bin/kt-sql harness-t.sql) that ends in RAISE, so nothing persists. Order: guard (refuses any
-- database that is not the test database) -> applied check -> helpers and fixtures -> {len(CONTROLS)} controls, each in a
-- subtransaction that is undone -> {len(MUTS)} mutants, each proven installed (md5 of the function body, or a catalogue
-- probe) before its primary controls run under it -> the rollback file and its post-check -> RAISE 'T4263_RESULT <json>'.
-- Afterwards: ~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()". Prints counts, ids of its own
-- invented rows and verdicts only.
-- Locks (every one is released by the final RAISE; lock_timeout 3s throughout):
--   row locks on the rows it inserts or changes: the fixture users (auth.users, public.users, organizations,
--     organization_members, organization_plans, member_addons, cloud_* and mcp_* rows of those users), the ONE row of
--     cloud_release_switches and the ONE row of mcp_settings until this call ends. Waiting on them: a switch flip, a
--     portal-secret change, and the erase job's scrub (cloud_blob_erase_scrub takes the switch row FOR SHARE; the job
--     runs at minute 23 of every hour, so do not start this call between minute 15 and minute 30). Plain reads are not
--     blocked;
--   a mutant or control that changes a function or a constraint holds that lock only inside its own subtransaction,
--     which is undone (and its locks released) at its end: pg_proc rows (CREATE OR REPLACE), mcp_message_reads
--     (ADD CONSTRAINT, ACCESS EXCLUSIVE), and for one mutant SHARE ROW EXCLUSIVE on mcp_connections (a NOT VALID foreign
--     key; milliseconds);
--   last step only, right before the RAISE, the rollback file: ACCESS EXCLUSIVE on mcp_message_reads and mcp_call_log,
--     and, NOT MEASURED, very likely a lock on auth.users (dropping the table removes its foreign-key triggers there).
-- Duration: NOT MEASURED. The 1,000,000-character body is read in every part (about 90 calls).
DO $guard4263t$
DECLARE n bigint := 0;
BEGIN
  IF pg_catalog.to_regclass('public.pm_backlog_items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.pm_backlog_items' INTO n;
  END IF;
  IF n > 100 OR coalesce((SELECT s.n_live_tup FROM pg_catalog.pg_stat_user_tables s WHERE s.relid = pg_catalog.to_regclass('public.pm_backlog_items')), 0) > 100 THEN
    RAISE EXCEPTION 'harness-t.sql refuses to run: TEST DATABASE ONLY (production tracker rows present)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE {GUARD_B}) THEN
    RAISE EXCEPTION 'harness-t.sql refuses to run: TEST DATABASE ONLY (test database marker absent)';
  END IF;
END
$guard4263t$;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '900s';
DO $applied4263t$
BEGIN
  IF {APPLIED_CHECK} THEN
    RAISE EXCEPTION 'harness-t.sql: migration {T_VERSION} is not applied at this file''s text';
  END IF;
END
$applied4263t$;
{LIB['helpers']}
{LIB['fixtures']}
{LIB['controls']}
DO $controls4263t$
DECLARE res text; base jsonb := '{{}}'; o jsonb; applied boolean;
BEGIN
  PERFORM pg_temp.rec('t_start', to_jsonb(clock_timestamp()));
{run_controls(CONTROLS, 'base')}  PERFORM pg_temp.rec('controls', base);
  PERFORM pg_temp.rec('t_controls_end', to_jsonb(clock_timestamp()));
{mut_blocks}  PERFORM pg_temp.rec('t_mutants_end', to_jsonb(clock_timestamp()));
END
$controls4263t$;
-- ================================================================ the rollback file, verbatim
DO $rb4263t$
BEGIN
  IF to_regclass('pg_temp.t_out') IS NULL THEN
    RAISE EXCEPTION 'harness-t.sql must run as one transaction (pg_temp.t_out is gone); the rollback step did not run';
  END IF;
  BEGIN
    EXECUTE {dq(ROLLBACK, '$rbq$')};
    PERFORM pg_temp.rec('rollback', to_jsonb('ok'::text));
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.rec('rollback', to_jsonb('ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 900)));
  END;
END
$rb4263t$;
DO $end4263t$
BEGIN
  PERFORM pg_temp.rec('t_end', to_jsonb(clock_timestamp()));
  RAISE EXCEPTION 'T4263_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.t_out);
END
$end4263t$;
"""

# the same call without the mutants: a cheaper first run (controls, rollback, RAISE)
HARNESS_CONTROLS = (HARNESS.replace(mut_blocks, '')
                    .replace(f'-> {len(MUTS)} mutants, each proven installed (md5 of the function body, or a catalogue\n-- probe) before its primary controls run under it ', '(no mutants: harness-t.sql runs them) ')
                    .replace('harness-t.sql', 'harness-t-controls.sql'))
assert HARNESS_CONTROLS.count('(no mutants: harness-t-controls.sql runs them)') == 1
HARNESS_CONTROLS = HARNESS_CONTROLS.replace('(no mutants: harness-t-controls.sql runs them)', '(no mutants: harness-t.sql runs them)')
assert 'mutant:' not in HARNESS_CONTROLS
OUTS = {os.path.join(HERE, f'apply-{T_VERSION}.sql'): APPLY,
        os.path.join(HERE, 'harness-t-controls.sql'): HARNESS_CONTROLS,
        os.path.join(HERE, f'rollback-{T_VERSION}.sql'): ROLLBACK,
        os.path.join(HERE, 'harness-t.sql'): HARNESS}


def unwrap(raw):
    """The harness's RAISE text from kt-sql's output: drop its 'kt-sql: ...' status lines; when what is left is the
    Management API's JSON body {"message": "..."}, take the message; otherwise (plain psql-style text) keep it."""
    text = '\n'.join(l for l in raw.replace('\r\n', '\n').split('\n') if not l.startswith('kt-sql: ')).strip()
    try:
        body = json.loads(text)
    except ValueError:
        return text
    if isinstance(body, dict) and isinstance(body.get('message'), str):
        return body['message']
    return text


def report(raw):
    """(printed lines, ok). ok only when every control is PASS; in a full run every mutant is applied and caught (FAIL:
    from a primary control, none ERROR) or, if want=green, passes; the rollback step is ok. Unreadable output is not ok."""
    msg = unwrap(raw)
    i = msg.find('T4263_RESULT ')
    if i < 0:
        return ['NOT OK: no T4263_RESULT in the output: ' + msg[:300].replace('\n', ' ')], False
    try:
        res, _ = json.JSONDecoder().raw_decode(msg[i + len('T4263_RESULT '):])
    except ValueError as e:
        return [f'NOT OK: T4263_RESULT is not complete JSON ({e})'], False
    if not isinstance(res, dict) or not isinstance(res.get('controls'), dict):
        return ['NOT OK: T4263_RESULT has no controls object'], False
    out, bad = [], 0
    ctl = res['controls']
    for c in CONTROLS:
        v = ctl.get(c, 'MISSING')
        ok = v == 'PASS'
        bad += 0 if ok else 1
        out.append(f"{'PASS' if ok else 'FAIL'} {c} {'' if ok else str(v)[:900]}")
    only_controls = not any(k.startswith('mutant:') for k in res)
    if only_controls:
        out.append('controls-only run (harness-t-controls.sql): no mutants expected')
    n_mut = 0
    for mid, *_ in ([] if only_controls else MUTS):
        o = res.get('mutant:' + mid)
        n_mut += 1
        if not isinstance(o, dict):
            out.append(f'MISSING mutant {mid}')
            bad += 1
            continue
        vals = [str(o.get(c, 'MISSING')) for c in PRIMARY[mid]]
        if o.get('applied') is not True or 'error' in o:
            tag = 'NOT_APPLIED' if o.get('applied') is not True else 'CRASH'
        elif WANT[mid] == 'green':
            tag = 'EQUIV' if all(v == 'PASS' for v in vals) else 'UNEXPECTED_RED'
        elif any(v.startswith('ERROR') or v == 'MISSING' for v in vals):
            tag = 'CRASH'
        elif any(v.startswith('FAIL') for v in vals):
            tag = 'CAUGHT'
        else:
            tag = 'MISSED'
        bad += 0 if tag in ('CAUGHT', 'EQUIV') else 1
        out.append(f'{tag:14} {mid} want={WANT[mid]} -> {json.dumps(o)[:300]}')
    out.append(f"rollback: {res.get('rollback')}")
    if res.get('rollback') != 'ok':
        bad += 1
    out.append(f'controls={len(CONTROLS)} mutants={n_mut} problems={bad}')
    if not ctl or (n_mut == 0 and not only_controls):
        out.append('NOT OK: zero tests ran')
        return out, False
    return out, bad == 0


def selftest(green_ok=False):
    """report() on canned outputs in both transport shapes. With green_ok (the selftest's own control) a missed mutant
    is asserted to be ok, which must fail."""
    def full(mutant_override=None, control_override=None, rollback='ok'):
        res = {'controls': {c: 'PASS' for c in CONTROLS}, 'rollback': rollback}
        if control_override:
            res['controls'].update(control_override)
        for mid, *_ in MUTS:
            o = {c: ('PASS' if WANT[mid] == 'green' else 'FAIL: x') for c in PRIMARY[mid]}
            o.update({'applied': True, 'want': WANT[mid]})
            res['mutant:' + mid] = o
        if mutant_override:
            res['mutant:' + mutant_override[0]] = mutant_override[1]
        return 'T4263_RESULT ' + json.dumps(res)
    wrap = lambda t: 'kt-sql: running\n' + json.dumps({'message': 'Failed to run sql query: ERROR:  P0001: ' + t + '\nCONTEXT:  PL/pgSQL function inline_code_block'})
    plain = lambda t: 'ERROR:  ' + t + '\nCONTEXT:  PL/pgSQL function inline_code_block line 3 at RAISE'
    red = [m[0] for m in MUTS if WANT[m[0]] == 'red'][0]
    missed = (red, {**{c: 'PASS' for c in PRIMARY[red]}, 'applied': True, 'want': 'red'})
    crash = (red, {**{c: 'ERROR XX000 boom' for c in PRIMARY[red]}, 'applied': True, 'want': 'red'})
    controls_only = 'T4263_RESULT ' + json.dumps({'controls': {c: 'PASS' for c in CONTROLS}, 'rollback': 'ok'})
    cases = [('full, wrapped', wrap(full()), True), ('full, plain', plain(full()), True),
             ('controls only, wrapped', wrap(controls_only), True),
             ('missed mutant', wrap(full(missed)), green_ok), ('crash is not caught', wrap(full(crash)), False),
             ('failed control', wrap(full(control_override={CONTROLS[0]: 'FAIL: x'})), False),
             ('failed rollback', wrap(full(rollback='ERROR x')), False),
             ('truncated', wrap(full())[:400], False), ('no result', wrap('something else'), False)]
    sample = '/Users/daniel/Developer/Mad/scratchpad/4263/sync2/window1/s1-run2-out.txt'
    bad = 0
    for name, raw, want in cases:
        got = report(raw)[1]
        print(f"{'ok ' if got == want else 'BAD'} {name}: report ok={got}, expected {want}")
        bad += got != want
    if os.path.exists(sample):  # a real captured transport output (another harness): unwrap must find its RAISE text
        u = unwrap(open(sample, encoding='utf-8').read())
        found = 'S1_RESULT {' in u
        print(f"{'ok ' if found else 'BAD'} real kt-sql sample unwrapped ({len(u)} characters)")
        bad += not found
    print(f'selftest: {len(cases)} cases, {bad} wrong')
    return 1 if bad else 0


if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == 'report':
        lines, ok = report(open(a[1], encoding='utf-8').read())
        print('\n'.join(lines))
        sys.exit(0 if ok else 1)
    if a and a[0] == 'selftest':
        sys.exit(selftest(green_ok=len(a) > 1 and a[1] == '--control-green-ok'))
    if a and a[0] == 'check':
        mutants(show=True)
        bad = arity_problems(HARNESS)
        for b in bad:
            print('CALL MISMATCH', b)
        print(f'pg_temp calls checked against their definitions: {len(bad)} mismatches')
        if bad:
            sys.exit(1)
        stale = [p for p, v in OUTS.items() if not os.path.exists(p) or open(p, encoding='utf-8').read() != v]
        for p in stale:
            print('differs:', os.path.relpath(p, REPO))
        print(f'{len(MUTS)} mutants, every fragment matched exactly once; {len(CONTROLS)} controls')
        sys.exit(1 if stale else 0)
    if a:
        print(__doc__)
        sys.exit(2)
    for p, v in OUTS.items():
        open(p, 'w', encoding='utf-8').write(v)
        print('written', os.path.relpath(p, REPO), md5(v))
