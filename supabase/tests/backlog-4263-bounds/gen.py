#!/usr/bin/env python3
"""BACKLOG-4263 PR-10.4 (registration and refresh bounds, cleanup of unused app registrations): writes, from the migration:

  supabase/tests/backlog-4263-bounds/apply-20261118190000.sql     migration verbatim + ledger row + post-check
  supabase/tests/backlog-4263-bounds/rollback-20261118190000.sql  rollback (job unscheduled, cleanup dropped, the two bodies
                                                                  put back, the two new counter buckets deleted) + post-check
  supabase/tests/backlog-4263-bounds/harness-bounds.sql           ONE call: fixtures, apply, re-run, controls, old-vs-new
                                                                  comparison, mutations, rollback rehearsal; ends in RAISE
  supabase/tests/backlog-4263-bounds/catalog-facts.json           md5 of the bodies and of the generated files

Each replaced statement must equal the previous definition with exactly the edits listed below (checked here, and again by
broker-portal/__tests__/migrations/mcp-register-refresh-bounds-4263.test.ts).
Mutations are exact-string replacements: each must match once (else this script stops), and the harness proves in
the database that the mutated body is the one installed (md5) before its control runs.
`python3 gen.py check` regenerates in memory and fails if any written file differs.
`python3 gen.py report <kt-sql output file>` prints the harness result.
"""
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
VERSION, NAME = '20261118190000', 'backlog_4263_mcp_register_refresh_bounds'
MIG_PATH = f'supabase/migrations/{VERSION}_{NAME}.sql'
OAUTH_PATH = 'supabase/migrations/20261112170000_backlog_4238_mcp_oauth_server.sql'
P5_PATH = 'supabase/migrations/20261118130000_backlog_4263_mcp_todo_write_tools.sql'
rd = lambda p: open(os.path.join(REPO, p)).read()
md5 = lambda s: hashlib.md5(s.encode()).hexdigest()
mig = rd(MIG_PATH)
lib = lambda n: rd(f'supabase/tests/backlog-4263-bounds/lib/{n}')

REG = 'public.mcp_register_client(text,text,text,text[],bytea)'
REF = 'public.mcp_refresh(text,bytea,text,text,bytea,bytea)'
PRUNE = 'public._mcp_prune_unused_clients()'
JOB, SCHEDULE, COMMAND = 'mcp-unused-client-prune', '53 3 * * *', 'SELECT public._mcp_prune_unused_clients()'


def stmt(text, name, tag='fn'):
    m = [x.group(1) for x in re.finditer(r'(CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS \$' + tag + r'\$.*?\$' + tag + r'\$;\n(?:(?:REVOKE|GRANT)[^\n]*\n)*)', text, re.S)]
    assert len(m) == 1, (name, len(m))
    return m[0]


def body(s, tag='fn'):
    return re.search(r'AS \$' + tag + r'\$(.*?)\$' + tag + r'\$;', s, re.S).group(1)


def create_only(s, tag='fn'):
    return re.search(r'(CREATE OR REPLACE FUNCTION .*?\$' + tag + r'\$;)', s, re.S).group(1)


def edit(s, pairs):
    for o, n in pairs:
        assert s.count(o) == 1, (o[:80], s.count(o))
        s = s.replace(o, n)
    return s


# ------------------------------------------------------------------------------------------------ the intended edits
R_MARK = ("BEGIN\n  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN\n    RETURN public._mcp_refuse('invalid_client_metadata');",
          "BEGIN\n  /*BODY:4263-10.4-register*/\n  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN\n    RETURN public._mcp_refuse('invalid_client_metadata');")
R_IP = "  v_b := public._mcp_bump('reg_ip:' || encode(p_ip_sha256, 'hex'), interval '1 hour', 60);\n"
R_DAY = ("  IF v_b IS NOT DISTINCT FROM 'ok' THEN\n"
         "    v_b := public._mcp_bump('reg_ip_day:' || encode(p_ip_sha256, 'hex'), interval '1 day', 200);   /*BOUND:reg_ip_day*/\n"
         "  END IF;\n")
R_ALL = ("v_b := public._mcp_bump('reg_all', interval '1 day', 500);",
         "v_b := public._mcp_bump('reg_all', interval '1 day', 5000);   /*BOUND:reg_all*/")
F_MARK = ('/*BODY:4263-5*/', '/*BODY:4263-10.4-refresh*/')
F_AFTER = "    RETURN public._mcp_token_fail(p_client_id, 'invalid_grant');\n  END IF;\n\n"
F_BEFORE = "  BEGIN\n    INSERT INTO public.mcp_tokens"
F_BOUND = ("  -- 4263 PR-10.4: at most 60 refreshes per connection per hour. Over the bound this block is rolled back: no token\n"
           "  -- is issued and the presented refresh token stays unused.\n"
           "  IF public._mcp_bump('refresh_conn:' || v_conn::text, interval '1 hour', 60) IS DISTINCT FROM 'ok' THEN   /*BOUND:refresh_conn*/\n"
           "    RAISE EXCEPTION USING ERRCODE = 'MC003', MESSAGE = 'mcp refresh bound reached';\n"
           "  END IF;\n\n")
F_HANDLER = ("  EXCEPTION WHEN SQLSTATE 'MC001' THEN\n    RETURN public._mcp_token_fail(p_client_id, 'invalid_request');\n  END;\nEND\n",
             "  EXCEPTION WHEN SQLSTATE 'MC001' THEN\n    RETURN public._mcp_token_fail(p_client_id, 'invalid_request');\n"
             "  WHEN SQLSTATE 'MC003' THEN\n    RETURN public._mcp_refuse('rate_limited');   /*REFUSE:refresh_conn*/\n  END;\nEND\n")

OLD_REG = stmt(rd(OAUTH_PATH), 'mcp_register_client')
OLD_REF = stmt(rd(P5_PATH), 'mcp_refresh')
NEW_REG = stmt(mig, 'mcp_register_client')
NEW_REF = stmt(mig, 'mcp_refresh')
PRUNE_STMT = stmt(mig, '_mcp_prune_unused_clients')
assert NEW_REG == edit(OLD_REG, [R_MARK, (R_IP, R_IP + R_DAY), R_ALL]), 'register differs from 20261112170000 by more than the intended edits'
assert NEW_REF == edit(OLD_REF, [F_MARK, (F_AFTER + F_BEFORE, F_AFTER + F_BOUND + F_BEFORE), F_HANDLER]), \
    'refresh differs from 20261118130000 by more than the intended edits'
R_OLD, R_NEW = md5(body(OLD_REG)), md5(body(NEW_REG))
F_OLD, F_NEW = md5(body(OLD_REF)), md5(body(NEW_REF))
P_NEW = md5(body(PRUNE_STMT))
assert R_OLD == '27326378a7ca849f4a116f6b46e1767e' and F_OLD == 'a7797a967b1952dec493c48c62328530', 'not the bodies measured on the test project'
for x in (R_OLD, R_NEW, F_OLD, F_NEW, P_NEW):
    assert x in mig, ('stale md5 in the migration', x)
assert [x.group(1) for x in re.finditer(r'CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(', mig)] == ['mcp_register_client', 'mcp_refresh', '_mcp_prune_unused_clients']
assert not re.search(r'DROP |CREATE TABLE|ALTER TABLE|CREATE POLICY|GRANT SELECT|GRANT INSERT|GRANT UPDATE|GRANT DELETE|GRANT ALL|TO PUBLIC|TO authenticated|TO service_role|net\.|pg_net', mig)
assert mig.count('cron.schedule(') == 1 and f"cron.schedule('{JOB}', '{SCHEDULE}', '{COMMAND}')" in mig
assert 'GRANT' not in PRUNE_STMT
ANON_ALL = json.loads(rd('supabase/tests/backlog-4263-notice/catalog-facts.json'))['anon_callable_mcp']
assert len(ANON_ALL) == 17
arr = lambda xs: ', '.join("'" + x.replace("'", "''") + "'" for x in xs)
SIGTXT = lambda s: f"'{s}'::regprocedure::text"


def q(s, tag='$mutq$'):
    assert tag not in s
    return tag + s + tag


# ------------------------------------------------------------------------------------------------ mutations
REG_C, REF_C, PRUNE_C = create_only(NEW_REG), create_only(NEW_REF), create_only(PRUNE_STMT)
COUNTERS = R_IP + R_DAY + ("  IF v_b IS NOT DISTINCT FROM 'ok' THEN\n    v_b := public._mcp_bump('reg_all', interval '1 day', 5000);   /*BOUND:reg_all*/\n  END IF;\n"
                           "  IF v_b IS DISTINCT FROM 'ok' THEN\n    RETURN public._mcp_refuse(coalesce(v_b, 'busy'));\n  END IF;\n")
MARK_R = '  /*BODY:4263-10.4-register*/\n'
BOUND_IF = ("  IF public._mcp_bump('refresh_conn:' || v_conn::text, interval '1 hour', 60) IS DISTINCT FROM 'ok' THEN   /*BOUND:refresh_conn*/\n"
            "    RAISE EXCEPTION USING ERRCODE = 'MC003', MESSAGE = 'mcp refresh bound reached';\n  END IF;\n")
RAISE_LINE = "    RAISE EXCEPTION USING ERRCODE = 'MC003', MESSAGE = 'mcp refresh bound reached';\n"
TOK_BLOCK = '  -- token insert failure: everything in this block is rolled back (the presented token stays unused)\n'
EARLY_BUMP = ("  IF public._mcp_bump('refresh_conn:' || coalesce((SELECT t.connection_id::text FROM public.mcp_tokens t WHERE t.token_sha256 = sha256(p_rt_digest)), ''),\n"
              "                      interval '1 hour', 60) IS DISTINCT FROM 'ok' THEN\n    RETURN public._mcp_refuse('rate_limited');\n  END IF;\n")
AGE_S = "     WHERE k.created_at < now() - interval '30 days'   /*AGE:select*/\n"
AGE_R = "       AND k.created_at < now() - interval '30 days'   /*AGE:recheck*/\n"
SEL_C = "       AND NOT EXISTS (SELECT 1 FROM public.mcp_connections c WHERE c.client_id = k.client_id)   /*SELECT:connections*/\n"
SEL_R = "       AND NOT EXISTS (SELECT 1 FROM public.mcp_authorization_requests r WHERE r.client_id = k.client_id)   /*SELECT:requests*/\n"
RCK_C = "       AND NOT EXISTS (SELECT 1 FROM public.mcp_connections c WHERE c.client_id = k.client_id)   /*RECHECK:connections*/\n"
RCK_R = "       AND NOT EXISTS (SELECT 1 FROM public.mcp_authorization_requests r WHERE r.client_id = k.client_id);   /*RECHECK:requests*/\n"
LOCK = ("    v_lock := NULL;\n    SELECT k.client_id INTO v_lock FROM public.mcp_oauth_clients k\n     WHERE k.client_id = v_id\n"
        "       FOR UPDATE SKIP LOCKED;   /*LOCK:client*/\n    CONTINUE WHEN v_lock IS NULL;\n")
GUARD = re.search(r"(  IF EXISTS \(SELECT 1 FROM pg_catalog\.pg_constraint k\n.*?/\*GUARD:children\*/\n    RETURN 0;\n  END IF;\n)", PRUNE_C, re.S).group(1)
FN_MUTS = [  # (id, target, [(old, new)], control, expect red)
    ('M01_reg_day_removed', 'reg', [(R_DAY, '')], 'c_reg_day', True),
    ('M02_reg_day_one_global_key', 'reg', [("'reg_ip_day:' || encode(p_ip_sha256, 'hex')", "'reg_ip_day'")], 'c_reg_day', True),
    ('M03_reg_day_hour_window', 'reg', [("interval '1 day', 200)", "interval '1 hour', 200)")], 'c_reg_day', True),
    ('M04_reg_all_left_at_500', 'reg', [("interval '1 day', 5000)", "interval '1 day', 500)")], 'c_reg_global', True),
    ('M05_counters_before_secret', 'reg', [(COUNTERS, ''), (MARK_R, MARK_R + COUNTERS)], 'c_reg_secret', True),
    ('M06_reg_ip_hour_changed', 'reg', [("interval '1 hour', 60);\n  IF v_b", "interval '1 hour', 120);\n  IF v_b")], 'c_reg_hour', True),
    ('M10_rf_bound_removed', 'ref', [(BOUND_IF, '')], 'c_refresh', True),
    ('M11_rf_keyed_per_user', 'ref', [("'refresh_conn:' || v_conn::text", "'refresh_conn:' || v_user::text")], 'c_refresh', True),
    ('M12_rf_keyed_per_token', 'ref', [("'refresh_conn:' || v_conn::text", "'refresh_conn:' || encode(p_rt_digest, 'hex')")], 'c_refresh', True),
    ('M13_rf_over_bound_uses_token', 'ref', [(RAISE_LINE, "    RETURN public._mcp_refuse('rate_limited');\n")], 'c_refresh', True),
    ('M14_rf_refused_attempts_counted', 'ref', [(BOUND_IF, ''), (TOK_BLOCK, EARLY_BUMP + TOK_BLOCK)], 'c_refresh', True),
    ('M15_rf_bound_61', 'ref', [("interval '1 hour', 60) IS DISTINCT FROM 'ok' THEN   /*BOUND:refresh_conn*/", "interval '1 hour', 61) IS DISTINCT FROM 'ok' THEN   /*BOUND:refresh_conn*/")], 'c_refresh', True),
    ('M16_rf_refusal_changed', 'ref', [("RETURN public._mcp_refuse('rate_limited');   /*REFUSE:refresh_conn*/", "RETURN public._mcp_refuse('invalid_grant');   /*REFUSE:refresh_conn*/")], 'c_refresh', True),
    ('M17_rf_answer_changed', 'ref', [("'scope', v_scope);   /*SCOPE:refresh*/", "'scope', v_scope, 'bounded', true);   /*SCOPE:refresh*/")], 'c_equal', True),
    ('M18_reg_answer_changed', 'reg', [("'redirect_uris', to_jsonb(p_redirect_uris));", "'redirect_uris', to_jsonb(p_redirect_uris), 'bounded', true);")], 'c_equal', True),
    ('M20_age_28_days', 'prune', [(AGE_S, AGE_S.replace("'30 days'", "'28 days'")), (AGE_R, AGE_R.replace("'30 days'", "'28 days'"))], 'c_prune_rule', True),
    ('M21_connections_active_only', 'prune', [(SEL_C, SEL_C.replace('k.client_id)', "k.client_id AND c.status = 'active')")),
                                              (RCK_C, RCK_C.replace('k.client_id)', "k.client_id AND c.status = 'active')"))], 'c_prune_rule', True),
    ('M22_requests_unchecked', 'prune', [(SEL_R, ''), (RCK_C + RCK_R, RCK_C.replace('   /*RECHECK:connections*/', ';   /*RECHECK:connections*/'))], 'c_prune_rule', True),
    ('M23_no_recheck_after_lock', 'prune', [(AGE_R + RCK_C + RCK_R, AGE_R.replace('   /*AGE:recheck*/', ';   /*AGE:recheck*/'))], 'c_prune_recheck', True),
    ('M24_no_skip_locked', 'prune', [('FOR UPDATE SKIP LOCKED;   /*LOCK:client*/', 'FOR UPDATE;   /*LOCK:client*/')], 'c_prune_rule', False),
    ('M25_no_lock', 'prune', [(LOCK, ''), ('WHERE k.client_id = v_lock', 'WHERE k.client_id = v_id')], 'c_prune_recheck', False),
    ('M26_no_children_guard', 'prune', [(GUARD, '')], 'c_prune_other_child', True),
    ('M27_cap_1000', 'prune', [('LIMIT 500   /*CAP:run*/', 'LIMIT 1000   /*CAP:run*/')], 'c_prune_cap', True),
    ('M28_returns_zero', 'prune', [('  RETURN v_n;\n', '  RETURN 0;\n')], 'c_prune_rule', True),
]
TARGET = {'reg': (REG_C, REG), 'ref': (REF_C, REF), 'prune': (PRUNE_C, PRUNE)}
DDL_MUTS = [  # (id, ddl, proof, control)
    ('M30_prune_granted_service_role', 'GRANT EXECUTE ON FUNCTION public._mcp_prune_unused_clients() TO service_role',
     f"has_function_privilege('service_role', '{PRUNE}'::regprocedure, 'EXECUTE')", 'c_prune_grants'),
    ('M31_prune_granted_anon', 'GRANT EXECUTE ON FUNCTION public._mcp_prune_unused_clients() TO anon',
     f"has_function_privilege('anon', '{PRUNE}'::regprocedure, 'EXECUTE')", 'c_catalog'),
    ('M32_cron_schedule_changed', f"SELECT cron.schedule('{JOB}', '0 * * * *', '{COMMAND}')",
     f"EXISTS (SELECT 1 FROM cron.job WHERE jobname = '{JOB}' AND schedule = '0 * * * *')", 'c_cron'),
    ('M33_cron_unscheduled', f"SELECT cron.unschedule('{JOB}')", f"NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = '{JOB}')", 'c_cron'),
    ('M34_cron_second_job', f"SELECT cron.schedule('x4263-prune-copy', '{SCHEDULE}', '{COMMAND}')",
     "EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'x4263-prune-copy')", 'c_cron'),
    ('M35_cat_other_function_cost', 'ALTER FUNCTION public._mcp_refuse(text) COST 7',
     "(SELECT procost = 7 FROM pg_proc WHERE oid = 'public._mcp_refuse(text)'::regprocedure)", 'c_catalog'),
    ('M36_cat_function_added', "CREATE FUNCTION public._mcp_zz_added_4263() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
     "to_regprocedure('public._mcp_zz_added_4263()') IS NOT NULL", 'c_catalog'),
    ('M37_cat_register_attribute', 'ALTER FUNCTION public.mcp_register_client(text, text, text, text[], bytea) COST 99',
     f"(SELECT procost = 99 FROM pg_proc WHERE oid = '{REG}'::regprocedure)", 'c_catalog'),
    ('M38_cat_refresh_granted_authenticated', 'GRANT EXECUTE ON FUNCTION public.mcp_refresh(text, bytea, text, text, bytea, bytea) TO authenticated',
     f"has_function_privilege('authenticated', '{REF}'::regprocedure, 'EXECUTE')", 'c_catalog'),
    ('M39_cat_counter_table_granted', 'GRANT SELECT ON public.mcp_rate_counters TO anon',
     "has_table_privilege('anon', 'public.mcp_rate_counters'::regclass, 'SELECT')", 'c_catalog'),
    ('M40_cat_cleanup_not_definer', 'ALTER FUNCTION public._mcp_prune_unused_clients() SECURITY INVOKER',
     f"(SELECT NOT prosecdef FROM pg_proc WHERE oid = '{PRUNE}'::regprocedure)", 'c_catalog'),
    ('M41_mig_anon_name_swapped', 'REVOKE EXECUTE ON FUNCTION public.mcp_get_status(text, bytea, text) FROM anon; GRANT EXECUTE ON FUNCTION public._mcp_refuse(text) TO anon',
     "has_function_privilege('anon', 'public._mcp_refuse(text)'::regprocedure, 'EXECUTE') AND NOT has_function_privilege('anon', 'public.mcp_get_status(text,bytea,text)'::regprocedure, 'EXECUTE')", 'c_mig_post'),
    ('M42_mig_cron_command_changed', f"SELECT cron.schedule('{JOB}', '{SCHEDULE}', 'SELECT 1')",
     f"EXISTS (SELECT 1 FROM cron.job WHERE jobname = '{JOB}' AND command = 'SELECT 1')", 'c_mig_post'),
]
CONTROLS = ['c_reg_day', 'c_reg_hour', 'c_reg_global', 'c_reg_secret', 'c_refresh', 'c_prune_rule', 'c_prune_cap', 'c_prune_recheck',
            'c_prune_other_child', 'c_prune_grants', 'c_children', 'c_cron', 'c_catalog', 'c_mig_post']

mut_sql, mut_report, WANT = [], [], {}


def mut_block(mid, setup, proof, run, ctl, red):
    return f"""DO $m_{mid}$
DECLARE v text; ok boolean;
BEGIN
  BEGIN
    {setup}
    ok := {proof};
    v := {run};
    RAISE EXCEPTION USING ERRCODE = 'MX002';
  EXCEPTION WHEN SQLSTATE 'MX002' THEN NULL;
    WHEN OTHERS THEN v := 'MUTANT ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 300); ok := false;
  END;
  PERFORM pg_temp.rec('MUT_{mid}', jsonb_build_object('applied', ok, 'control', '{ctl}', 'expect_red', {str(red).lower()}, 'red', left(v, 4) IS DISTINCT FROM 'PASS', 'result', left(v, 400)));
END
$m_{mid}$;
"""


for mid, tgt, reps, ctl, red in FN_MUTS:
    WANT[mid] = {'control': ctl, 'expect_red': red}
    src, sig = TARGET[tgt]
    mc = edit(src, reps)
    assert mc != src, mid
    mut_report.append(f'MUTATION APPLIED {mid}: md5 {md5(body(mc))} ({len(reps)} replacement(s))')
    run = "pg_temp.with_old('c_equal')" if ctl == 'c_equal' else f"pg_temp.iso('{ctl}')"
    proof = f"(SELECT md5(p.prosrc) = '{md5(body(mc))}' FROM pg_proc p WHERE p.oid = to_regprocedure('{sig}'))"
    mut_sql.append(mut_block(mid, f'EXECUTE {q(mc)};', proof, run, ctl, red))
for mid, ddl, proof, ctl in DDL_MUTS:
    WANT[mid] = {'control': ctl, 'expect_red': True}
    mut_report.append(f'MUTATION APPLIED {mid} (ddl): {ddl[:150]}')
    mut_sql.append(mut_block(mid, f'EXECUTE {q(ddl)};', proof, f"pg_temp.iso('{ctl}')", ctl, True))

# ------------------------------------------------------------------------------------------------ catalogue checks
SNAP = """  SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS src_md5, p.proacl::text AS acl, p.proconfig AS config, p.prosecdef AS secdef,
         p.proowner AS owner, p.provolatile AS vol, p.proisstrict AS strict, p.proleakproof AS leakproof, p.proparallel AS parallel,
         p.procost AS cost, p.prorows AS nrows
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace"""
REL_SNAP = """  SELECT c.relname::text AS rel, c.relkind::text AS kind, c.relacl::text AS acl, c.relrowsecurity AS rls, c.relforcerowsecurity AS frls,
         c.relowner AS owner, (SELECT count(*) FROM pg_policy y WHERE y.polrelid = c.oid) AS npol
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace"""
CRON_SNAP = "  SELECT j.jobid, j.jobname, j.schedule, j.command, j.username, j.active, j.database FROM cron.job j"
SAME = """p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text = b.sig
                             AND p.proacl::text IS NOT DISTINCT FROM b.acl AND p.proconfig IS NOT DISTINCT FROM b.config
                             AND p.prosecdef = b.secdef AND p.proowner = b.owner AND p.provolatile = b.vol AND p.proisstrict = b.strict
                             AND p.proleakproof = b.leakproof AND p.proparallel = b.parallel AND p.procost = b.cost AND p.prorows = b.nrows"""
EXISTS_SIG = "EXISTS (SELECT 1 FROM pg_proc p2 WHERE p2.pronamespace = 'public'::regnamespace AND p2.oid::regprocedure::text = b.sig)"
CHANGED = """(SELECT coalesce(array_agg(b.sig ORDER BY b.sig COLLATE "C"), '{{}}') FROM pg_temp.{t} b
         WHERE """ + EXISTS_SIG + """ AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE """ + SAME + """ AND md5(p.prosrc) = b.src_md5))"""
GONE = """(SELECT coalesce(array_agg(b.sig ORDER BY b.sig COLLATE "C"), '{{}}') FROM pg_temp.{t} b WHERE NOT """ + EXISTS_SIG + ")"
ADDED = """(SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C"), '{{}}') FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND NOT EXISTS (SELECT 1 FROM pg_temp.{t} b WHERE b.sig = p.oid::regprocedure::text))"""
ATTR_SAME = """(SELECT count(*) = 2 FROM pg_temp.{t} b JOIN pg_proc p ON """ + SAME + f""" WHERE b.sig IN ({SIGTXT(REG)}, {SIGTXT(REF)}))"""
REL_SAME = """c.relnamespace = 'public'::regnamespace AND c.relname::text = b.rel AND c.relkind::text = b.kind AND c.relacl::text IS NOT DISTINCT FROM b.acl
                   AND c.relrowsecurity = b.rls AND c.relforcerowsecurity = b.frls AND c.relowner = b.owner
                   AND (SELECT count(*) FROM pg_policy y WHERE y.polrelid = c.oid) = b.npol"""
REL_DIFF = """(SELECT count(*) FROM pg_temp.{t} b WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE """ + REL_SAME + """))
        + (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND NOT EXISTS (SELECT 1 FROM pg_temp.{t} b WHERE b.rel = c.relname::text))"""
CRON_OTHERS = """(SELECT count(*) FROM pg_temp.{t} b WHERE b.jobname IS DISTINCT FROM '""" + JOB + """' AND NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobid = b.jobid
           AND j.jobname IS NOT DISTINCT FROM b.jobname AND j.schedule = b.schedule AND j.command = b.command AND j.username = b.username
           AND j.active = b.active AND j.database = b.database))
        + (SELECT count(*) FROM cron.job j WHERE j.jobname IS DISTINCT FROM '""" + JOB + """' AND NOT EXISTS (SELECT 1 FROM pg_temp.{t} b WHERE b.jobid = j.jobid))"""
CRON_OURS = f"""(SELECT count(*) FROM cron.job j WHERE j.jobname = '{JOB}') = 1
        AND EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = '{JOB}' AND j.schedule = '{SCHEDULE}' AND j.command = '{COMMAND}'
                       AND j.username = 'postgres' AND j.active AND j.database = current_database())
        AND (SELECT count(*) FROM cron.job j WHERE j.command ~ '_mcp_prune_unused_clients') = 1"""
ANON_Q = """(SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C"), '{}') FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE'))
        = (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(ARRAY[""" + arr(ANON_ALL) + """]::text[]) x)"""
PRUNE_SHAPE = f"""(SELECT md5(p.prosrc) = '{P_NEW}' AND p.proowner = 'postgres'::regrole::oid AND p.prosecdef AND p.provolatile = 'v'
          AND NOT p.proisstrict AND p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'plpgsql')
          AND array_to_string(p.proconfig, ',') = 'search_path=""' AND p.prorettype = 'integer'::regtype
          AND (SELECT array_agg(DISTINCT a.grantee::regrole::text) FROM aclexplode(p.proacl) a) = ARRAY['postgres']
        FROM pg_proc p WHERE p.oid = to_regprocedure('{PRUNE}'))"""
CHILDREN = """(SELECT array_agg(c.relnamespace::regnamespace::text || '.' || c.relname::text || ':' || k.confdeltype::text ORDER BY c.relname::text COLLATE "C")
          FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE k.contype = 'f' AND k.confrelid = 'public.mcp_oauth_clients'::regclass)
        = ARRAY['public.mcp_authorization_requests:c', 'public.mcp_connections:c']"""
LEDGER = f"(SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')"
COUNTER_NEW = "(SELECT count(*) FROM public.mcp_rate_counters r WHERE left(r.bucket, 11) = 'reg_ip_day:' OR left(r.bucket, 13) = 'refresh_conn:')"


def postcheck_apply(tag, t, tr, tc, label):
    return f"""DO ${tag}$
DECLARE v jsonb; w_changed jsonb := '[]';
BEGIN
  SELECT jsonb_build_object(
    'register_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = '{REG}'::regprocedure),
    'refresh_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = '{REF}'::regprocedure),
    'register_md5_before', (SELECT b.src_md5 FROM pg_temp.{t} b WHERE b.sig = {SIGTXT(REG)}),
    'refresh_md5_before', (SELECT b.src_md5 FROM pg_temp.{t} b WHERE b.sig = {SIGTXT(REF)}),
    'attributes_unchanged', {ATTR_SAME.format(t=t)},
    'changed', {CHANGED.format(t=t)},
    'gone', {GONE.format(t=t)},
    'added', {ADDED.format(t=t)},
    'cleanup_shape', {PRUNE_SHAPE},
    'children', {CHILDREN},
    'relations_changed', {REL_DIFF.format(t=tr)},
    'cron_ours', {CRON_OURS},
    'cron_others_changed', {CRON_OTHERS.format(t=tc)},
    'anon_mcp_17', {ANON_Q},
    'ledger', {LEDGER}) INTO v;
  IF v ->> 'register_md5_before' IS DISTINCT FROM '{R_NEW}' THEN w_changed := w_changed || to_jsonb({SIGTXT(REG)}); END IF;
  IF v ->> 'refresh_md5_before' IS DISTINCT FROM '{F_NEW}' THEN w_changed := w_changed || to_jsonb({SIGTXT(REF)}); END IF;
  SELECT coalesce(jsonb_agg(x.s ORDER BY x.s COLLATE "C"), '[]') INTO w_changed FROM jsonb_array_elements_text(w_changed) AS x(s);
  IF v ->> 'register_md5' IS DISTINCT FROM '{R_NEW}' OR v ->> 'refresh_md5' IS DISTINCT FROM '{F_NEW}'
     OR v -> 'changed' IS DISTINCT FROM w_changed OR v -> 'gone' IS DISTINCT FROM '[]'::jsonb
     OR v -> 'added' IS DISTINCT FROM (CASE WHEN EXISTS (SELECT 1 FROM pg_temp.{t} b WHERE b.sig = {SIGTXT(PRUNE)}) THEN '[]'::jsonb ELSE jsonb_build_array({SIGTXT(PRUNE)}) END)
     OR (v ->> 'attributes_unchanged')::boolean IS NOT TRUE OR (v ->> 'cleanup_shape')::boolean IS NOT TRUE OR (v ->> 'children')::boolean IS NOT TRUE
     OR (v ->> 'relations_changed')::int IS DISTINCT FROM 0 OR (v ->> 'cron_ours')::boolean IS NOT TRUE OR (v ->> 'cron_others_changed')::int IS DISTINCT FROM 0
     OR (v ->> 'anon_mcp_17')::boolean IS NOT TRUE OR (v ->> 'ledger')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION '{label} POST-CHECK {VERSION} FAILED, nothing applied: %', v;
  END IF;
  RAISE NOTICE '{label} POST-CHECK {VERSION} OK: %', v;
END
${tag}$;
"""


def postcheck_rollback(tag, t, tr, tc):
    return f"""DO ${tag}$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'register_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = '{REG}'::regprocedure),
    'refresh_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = '{REF}'::regprocedure),
    'attributes_unchanged', {ATTR_SAME.format(t=t)},
    'changed', {CHANGED.format(t=t)},
    'gone', {GONE.format(t=t)},
    'added', {ADDED.format(t=t)},
    'relations_changed', {REL_DIFF.format(t=tr)},
    'cron_ours', (SELECT count(*) FROM cron.job j WHERE j.jobname = '{JOB}' OR j.command ~ '_mcp_prune_unused_clients'),
    'cron_others_changed', {CRON_OTHERS.format(t=tc)},
    'new_counter_rows', {COUNTER_NEW},
    'anon_mcp_17', {ANON_Q},
    'ledger', {LEDGER}) INTO v;
  IF v ->> 'register_md5' IS DISTINCT FROM '{R_OLD}' OR v ->> 'refresh_md5' IS DISTINCT FROM '{F_OLD}'
     OR v -> 'changed' IS DISTINCT FROM jsonb_build_array({SIGTXT(REF)}, {SIGTXT(REG)}) OR v -> 'added' IS DISTINCT FROM '[]'::jsonb
     OR v -> 'gone' IS DISTINCT FROM (SELECT jsonb_agg(b.sig) FROM pg_temp.{t} b WHERE b.sig ~ '^(public\\.)?_mcp_prune_unused_clients\\(\\)$')
     OR (v ->> 'attributes_unchanged')::boolean IS NOT TRUE OR (v ->> 'relations_changed')::int IS DISTINCT FROM 0
     OR (v ->> 'cron_ours')::int IS DISTINCT FROM 0 OR (v ->> 'cron_others_changed')::int IS DISTINCT FROM 0
     OR (v ->> 'new_counter_rows')::int IS DISTINCT FROM 0
     OR (v ->> 'anon_mcp_17')::boolean IS NOT TRUE OR (v ->> 'ledger')::int IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK {VERSION} FAILED, nothing changed: %', v;
  END IF;
  RAISE NOTICE 'ROLLBACK POST-CHECK {VERSION} OK: %', v;
END
${tag}$;
"""


POST_APPLY = postcheck_apply('postbounds', 'pb_fn_before', 'pb_rel_before', 'pb_cron_snap', 'APPLY')
apply = f"""-- apply-{VERSION}.sql (generated by supabase/tests/backlog-4263-bounds/gen.py; do not hand-edit)
-- Migration: {MIG_PATH}  file md5 {md5(mig)}
-- One transaction. If the apply tool writes the ledger row itself, remove the INSERT below.
-- The post-check RAISEs (rolling everything back) unless: mcp_register_client is at md5 {R_NEW} and mcp_refresh at md5
-- {F_NEW}, and they are the only functions in schema public that changed (body md5, grants, settings, security definer,
-- owner, volatility, strict, leakproof, parallel, cost, rows), and only their bodies changed; exactly
-- _mcp_prune_unused_clients() was added (md5 {P_NEW}, owned by postgres, plpgsql VOLATILE SECURITY DEFINER with an empty
-- search_path, returns integer, EXECUTE for postgres only); no function was dropped; the tables with a foreign key to
-- mcp_oauth_clients are exactly mcp_authorization_requests and mcp_connections; no relation in public changed its grants,
-- RLS or policy count, and none was added or dropped; the cron job '{JOB}' exists once ('{SCHEDULE}', '{COMMAND}', active,
-- as postgres, in this database) and no other cron job changed; the anon-callable mcp functions are exactly the 17 named;
-- the ledger row.
CREATE TEMP TABLE pb_fn_before ON COMMIT DROP AS
{SNAP};
CREATE TEMP TABLE pb_rel_before ON COMMIT DROP AS
{REL_SNAP};
CREATE TEMP TABLE pb_cron_snap ON COMMIT DROP AS
{CRON_SNAP};

{mig}
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('{VERSION}', '{NAME}', ARRAY[]::text[]);

{POST_APPLY}"""

rollback = f"""-- rollback-{VERSION}.sql (generated by supabase/tests/backlog-4263-bounds/gen.py; do not hand-edit)
-- Undoes {MIG_PATH}, in this order: unschedules the cron job '{JOB}', drops _mcp_prune_unused_clients(), puts back the
-- body of mcp_register_client written by {OAUTH_PATH} (md5 {R_OLD}) and the body of mcp_refresh written by
-- {P5_PATH} (md5 {F_OLD}), deletes the counter rows of the two buckets this file added (reg_ip_day:*, refresh_conn:*;
-- the count is in the NOTICE) and no other counter row, and removes the ledger row. App registrations already deleted by
-- the cleanup are not restored. With the old body the global daily bound is 500 again: if today's reg_all count is above
-- 500, registrations are refused until the next UTC day.
-- One transaction; RAISEs (nothing changed) unless the post-check holds. Run this BEFORE any rollback of 20261118130000 or
-- 20261112170000 (whose pre-checks require the bodies put back here).
DO $preboundsr$
DECLARE v_r text; v_f text;
BEGIN
  SELECT md5(p.prosrc) INTO v_r FROM pg_proc p WHERE p.oid = to_regprocedure('{REG}');
  SELECT md5(p.prosrc) INTO v_f FROM pg_proc p WHERE p.oid = to_regprocedure('{REF}');
  IF v_r IS DISTINCT FROM '{R_NEW}' OR v_f IS DISTINCT FROM '{F_NEW}' THEN
    RAISE EXCEPTION 'ROLLBACK {VERSION}: the functions are not at the bodies {VERSION} wrote (md5 %, %)', coalesce(v_r, 'missing'), coalesce(v_f, 'missing');
  END IF;
  IF to_regprocedure('{PRUNE}') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK {VERSION}: _mcp_prune_unused_clients() is missing';
  END IF;
  RAISE NOTICE 'ROLLBACK {VERSION}: deleting % counter rows (reg_ip_day, refresh_conn); today''s reg_all count %', {COUNTER_NEW},
    coalesce((SELECT r.count FROM public.mcp_rate_counters r WHERE r.bucket = 'reg_all' AND r.window_start = public._mcp_window(interval '1 day')), 0);
END
$preboundsr$;
CREATE TEMP TABLE pb_rb_fn ON COMMIT DROP AS
{SNAP};
CREATE TEMP TABLE pb_rb_rel ON COMMIT DROP AS
{REL_SNAP};
CREATE TEMP TABLE pb_rb_cron ON COMMIT DROP AS
{CRON_SNAP};

SET LOCAL lock_timeout = '3s';
DO $unschedbounds$
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = '{JOB}';
END
$unschedbounds$;
DROP FUNCTION public._mcp_prune_unused_clients();
{OLD_REG}
{OLD_REF}
DELETE FROM public.mcp_rate_counters WHERE left(bucket, 11) = 'reg_ip_day:' OR left(bucket, 13) = 'refresh_conn:';
DELETE FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}';

{postcheck_rollback('postboundsr', 'pb_rb_fn', 'pb_rb_rel', 'pb_rb_cron')}"""

# ------------------------------------------------------------------------------------------------ harness
MIG_POST = re.search(r'(DO \$post4263bounds\$.*?\$post4263bounds\$;)', mig, re.S).group(1)
strip = lambda s: s.replace(' ON COMMIT DROP', '')


def old_copy(s, name):
    c = create_only(s).replace(f'CREATE OR REPLACE FUNCTION public.{name}(', f'CREATE FUNCTION public.{name}_x4263old(', 1)
    assert body(c) == body(s)
    return c


controls_sql = (lib('controls.sql').replace('@@POSTCHECK@@', q(strip(POST_APPLY), '$pcq$')).replace('@@MIGPOST@@', q(MIG_POST, '$mpq$'))
                .replace('@@OLDREG@@', q(old_copy(OLD_REG, 'mcp_register_client'), '$orq$')).replace('@@OLDREF@@', q(old_copy(OLD_REF, 'mcp_refresh'), '$ofq$'))
                .replace('@@R_OLD@@', R_OLD).replace('@@F_OLD@@', F_OLD))
assert '@@' not in controls_sql
OTHER_COUNTERS = "(SELECT count(*) FROM public.mcp_rate_counters r WHERE r.bucket = 'reg_ip:' || pg_temp.iph('rb'))"
harness = f"""-- harness-bounds.sql (generated by supabase/tests/backlog-4263-bounds/gen.py; do not hand-edit)
-- BACKLOG-4263 PR-10.4: ONE call on the test project (~/.claude/bin/kt-sql harness-bounds.sql) that ends in RAISE, so
-- nothing persists (the cron job included). Order: helpers and fixtures -> the apply file (migration + ledger +
-- post-check) -> the migration again (re-run) -> {len(CONTROLS)} controls -> the old bodies under temporary names: old-vs-new
-- comparison -> {len(FN_MUTS) + len(DDL_MUTS)} mutations, each proven installed before its control runs -> the rollback file
-- and its post-check -> RAISE with every result. Afterwards: ~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()".
-- Only statuses, counts, fixture keys, md5s and timings are recorded.
SET LOCAL pg_stat_statements.track = 'none';
{rd('supabase/tests/backlog-4263-pr5/lib/helpers-base.sql')}
{lib('fixtures.sql')}
DO $t0$
BEGIN
  PERFORM pg_temp.rec('t_start', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('register_md5_before_apply', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{REG}'::regprocedure)));
  PERFORM pg_temp.rec('refresh_md5_before_apply', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{REF}'::regprocedure)));
  PERFORM pg_temp.rec('expected_before', to_jsonb(ARRAY['{R_OLD}', '{F_OLD}']));
  PERFORM pg_temp.rec('migration_md5', to_jsonb('{md5(mig)}'::text));
  PERFORM pg_temp.rec('ledger_20261118180000', to_jsonb((SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261118180000')));
  PERFORM pg_temp.rec('children_before', pg_temp.children());
END $t0$;
-- ================================================================ apply
{strip(apply)}
DO $t1$
BEGIN
  PERFORM pg_temp.rec('t_after_apply', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('lock_timeout_after_apply', to_jsonb(current_setting('lock_timeout')));
  PERFORM pg_temp.rec('cron_jobs_after_apply', to_jsonb((SELECT count(*) FROM cron.job)));
  PERFORM pg_temp.rec('job_run_now_would_delete', to_jsonb((SELECT count(*) FROM public.mcp_oauth_clients k
     WHERE k.created_at < now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM public.mcp_connections c WHERE c.client_id = k.client_id)
       AND NOT EXISTS (SELECT 1 FROM public.mcp_authorization_requests r WHERE r.client_id = k.client_id))));
END $t1$;
{controls_sql}
-- ================================================================ re-run of the migration
DO $rerun$
BEGIN
  EXECUTE {q(mig, '$migq$')};
  PERFORM pg_temp.rec('rerun', to_jsonb('ok'::text));
  PERFORM pg_temp.rec('rerun_cron_jobs', to_jsonb((SELECT count(*) FROM cron.job)));
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.rec('rerun', to_jsonb('ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 400)));
END
$rerun$;
-- ================================================================ controls
DO $ctl$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY[{arr(CONTROLS)}] LOOP
    PERFORM pg_temp.rec('CTL_' || c, to_jsonb(pg_temp.iso(c)));
  END LOOP;
  PERFORM pg_temp.rec('t_after_controls', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('CTL_c_equal', to_jsonb(pg_temp.with_old('c_equal')));
  PERFORM pg_temp.rec('REPORT_answers', pg_temp.j(pg_temp.iso('eq_report')));
  PERFORM pg_temp.rec('old_copies_gone', to_jsonb(to_regprocedure('public.mcp_register_client_x4263old(text,text,text,text[],bytea)') IS NULL
                                                   AND to_regprocedure('public.mcp_refresh_x4263old(text,bytea,text,text,bytea,bytea)') IS NULL));
  PERFORM pg_temp.rec('t_after_equal', to_jsonb(clock_timestamp()));
END
$ctl$;
-- ================================================================ mutations
{''.join(mut_sql)}
DO $t3$ BEGIN PERFORM pg_temp.rec('t_after_mutations', to_jsonb(clock_timestamp())); END $t3$;
-- ================================================================ rollback rehearsal (one counter row in each new bucket and one in reg_ip first)
DO $rb$
BEGIN
  PERFORM pg_temp.setc('reg_ip_day:' || pg_temp.iph('rb'), '1 day', 3);
  PERFORM pg_temp.setc('refresh_conn:' || md5('rb'), '1 hour', 3);
  PERFORM pg_temp.setc('reg_ip:' || pg_temp.iph('rb'), '1 hour', 3);
  EXECUTE {q(strip(rollback), '$rbq$')};
  PERFORM pg_temp.rec('rollback', to_jsonb('ok'::text));
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.rec('rollback', to_jsonb('ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 900)));
END
$rb$;
DO $after$
DECLARE x_r jsonb; x_f jsonb;
BEGIN
  PERFORM pg_temp.rec('rb_register_md5_equals_before_apply', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{REG}'::regprocedure)
                                                             = (SELECT v #>> '{{}}' FROM pg_temp.pb_out WHERE k = 'register_md5_before_apply')));
  PERFORM pg_temp.rec('rb_refresh_md5_equals_before_apply', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{REF}'::regprocedure)
                                                            = (SELECT v #>> '{{}}' FROM pg_temp.pb_out WHERE k = 'refresh_md5_before_apply')));
  PERFORM pg_temp.rec('rb_cleanup_gone', to_jsonb(to_regprocedure('{PRUNE}') IS NULL));
  PERFORM pg_temp.rec('rb_cron_jobs', to_jsonb((SELECT count(*) FROM cron.job)));
  PERFORM pg_temp.rec('rb_new_counter_rows', to_jsonb({COUNTER_NEW}));
  PERFORM pg_temp.rec('rb_other_counter_kept', to_jsonb({OTHER_COUNTERS}));
  PERFORM pg_temp.rec('rb_ledger', to_jsonb({LEDGER}));
  x_r := pg_temp.w(pg_temp.q_reg('rb1', 'rb2'));
  PERFORM pg_temp.rec('rb_register_still_works', to_jsonb(x_r = pg_temp.reg_ok('rb1')));
  PERFORM pg_temp.connect('rbc', pg_temp.id('A'), 'anthropic', 9000, 9001);
  x_f := pg_temp.w(pg_temp.q_rf(9001, 9002, 9003));
  PERFORM pg_temp.rec('rb_refresh_still_works', to_jsonb(x_f = pg_temp.ok_answer()));
  PERFORM pg_temp.rec('real_registrations_changed_at_end', to_jsonb(pg_temp.real_changed()));
  PERFORM pg_temp.rec('t_end', to_jsonb(clock_timestamp()));
  RAISE EXCEPTION 'BOUNDS_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.pb_out);
END
$after$;
"""

facts = {'migration': MIG_PATH, 'migration_md5': md5(mig),
         'register': REG, 'register_md5_before': R_OLD, 'register_md5_after': R_NEW,
         'refresh': REF, 'refresh_md5_before': F_OLD, 'refresh_md5_after': F_NEW,
         'cleanup': PRUNE, 'cleanup_md5': P_NEW,
         'cron_job': {'name': JOB, 'schedule': SCHEDULE, 'command': COMMAND, 'username': 'postgres'},
         'anon_callable_mcp': ANON_ALL,
         'controls': CONTROLS + ['c_equal'], 'mutations': WANT,
         'apply_md5': md5(apply), 'rollback_md5': md5(rollback)}
outs = {f'apply-{VERSION}.sql': apply, f'rollback-{VERSION}.sql': rollback, 'harness-bounds.sql': harness,
        'catalog-facts.json': json.dumps(facts, indent=2, ensure_ascii=False) + '\n'}

if len(sys.argv) > 2 and sys.argv[1] == 'report':
    first = open(sys.argv[2]).read()
    raw = json.loads(first.splitlines()[0])['message'] if first.lstrip().startswith('{') else first
    i = raw.index('BOUNDS_RESULT ') + 14
    j = raw.find('\nCONTEXT', i)
    res = json.loads(raw[i:j if j > 0 else len(raw)].strip())
    for k, v in sorted(res.items()):
        if k.startswith('MUT_'):
            ok = v.get('applied') is True and v.get('red') is v.get('expect_red')
            print(('OK  ' if ok else 'BAD ') + k, json.dumps(v, ensure_ascii=False)[:600])
        elif k.startswith('CTL_'):
            print(('OK  ' if str(v).startswith('PASS') else 'BAD ') + k, json.dumps(v, ensure_ascii=False)[:2000])
        else:
            print('    ' + k, json.dumps(v, ensure_ascii=False)[:2500])
    sys.exit(0)
if len(sys.argv) > 1 and sys.argv[1] == 'check':
    bad = [k for k, v in outs.items() if open(os.path.join(HERE, k)).read() != v]
    print('differs: ' + ', '.join(bad) if bad else 'all generated files match')
    sys.exit(1 if bad else 0)
for k, v in outs.items():
    open(os.path.join(HERE, k), 'w').write(v)
print('\n'.join(mut_report))
print(json.dumps({k: md5(v) for k, v in outs.items()}, indent=1))
print('register', R_OLD, '->', R_NEW, 'refresh', F_OLD, '->', F_NEW, 'cleanup', P_NEW, 'controls', len(CONTROLS) + 1, 'mutations', len(FN_MUTS) + len(DDL_MUTS))
