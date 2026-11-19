#!/usr/bin/env python3
"""BACKLOG-4263 PR-10.7 (a notice when an AI app connects): writes, from the migration:

  supabase/tests/backlog-4263-notice/apply-20261118180000.sql     migration verbatim + ledger row + post-check
  supabase/tests/backlog-4263-notice/rollback-20261118180000.sql  rollback (the exchange body of 20261118130000, the two
                                                                  functions and the table dropped) + its post-check
  supabase/tests/backlog-4263-notice/harness-notice.sql           ONE call: fixtures, apply, re-run, controls, old-vs-new
                                                                  comparison, mutations, rollback rehearsal; ends in RAISE
  supabase/tests/backlog-4263-notice/catalog-facts.json           md5 of the bodies and of the generated files

The migration's exchange statement must equal the statement of 20261118130000 with the body marker renamed and ONE
block inserted before the final RETURN (checked here, and again by
broker-portal/__tests__/migrations/ai-app-connect-notice-4263.test.ts).
Mutations are exact-string replacements: each must match once (else this script stops), and the harness proves in
the database that the mutated body is the one installed (md5) before its control runs.
`python3 gen.py check` regenerates in memory and fails if any written file differs.
`python3 gen.py report <kt-sql output>` prints the result of a harness run."""
import hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
VERSION, NAME = '20261118180000', 'backlog_4263_ai_app_connect_notice'
MIG_PATH = f'supabase/migrations/{VERSION}_{NAME}.sql'
P5_PATH = 'supabase/migrations/20261118130000_backlog_4263_mcp_todo_write_tools.sql'
rd = lambda p: open(os.path.join(REPO, p)).read()
md5 = lambda s: hashlib.md5(s.encode()).hexdigest()
mig = rd(MIG_PATH)
p5 = rd(P5_PATH)
lib = lambda n: rd(f'supabase/tests/backlog-4263-notice/lib/{n}')

EX = 'public.mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)'
CLAIM = 'public.ai_app_notice_claim(integer)'
DONE = 'public.ai_app_notice_done(uuid,integer,text,text)'
TABLE = 'public.ai_app_connect_notices'
RELS = ['ai_app_connect_notices', 'ai_app_connect_notices_due_idx', 'ai_app_connect_notices_pkey', 'ai_app_connect_notices_user_idx']
COLS = ['id', 'user_id', 'provider', 'replaced', 'connected_at', 'status', 'attempts', 'lease_until', 'sent_at', 'last_error']


def stmt(text, name, tag='fn'):
    m = [x.group(1) for x in re.finditer(r'(CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS \$' + tag + r'\$.*?\$' + tag + r'\$;\n(?:(?:REVOKE|GRANT)[^\n]*\n)*)', text, re.S)]
    assert len(m) == 1, (name, len(m))
    return m[0]


def body(s, tag='fn'):
    return re.search(r'AS \$' + tag + r'\$(.*?)\$' + tag + r'\$;', s, re.S).group(1)


def create_only(s, tag='fn'):
    return re.search(r'(CREATE OR REPLACE FUNCTION .*?\$' + tag + r'\$;)', s, re.S).group(1)


ANCHOR = "  RETURN jsonb_build_object('ok', true, 'token_type', 'Bearer', 'expires_in', 3600, 'scope', v_scope);   /*SCOPE:exchange*/\n"
BLOCK = ("  -- 4263 PR-10.7: one notice for the connection that just turned active, read later by the email job. In its own\n"
         "  -- block: any error here discards the notice only; the exchange and its answer are unchanged.\n"
         "  BEGIN\n"
         "    INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced)\n"
         "    SELECT c.user_id, c.provider, v_n > 0 FROM public.mcp_connections c WHERE c.id = v_code.connection_id;   /*NOTICE:exchange*/\n"
         "  EXCEPTION WHEN OTHERS THEN\n"
         "    NULL;\n"
         "  END;\n")
OLD_EX = stmt(p5, 'mcp_exchange_code')
NEW_EX = stmt(mig, 'mcp_exchange_code')
assert OLD_EX.count(ANCHOR) == 1 and OLD_EX.count('/*BODY:4263-5*/') == 1
assert NEW_EX == OLD_EX.replace('/*BODY:4263-5*/', '/*BODY:4263-10.7*/').replace(ANCHOR, BLOCK + ANCHOR), \
    'the exchange differs from 20261118130000 by more than the marker and the notice block'
OLD_MD5, NEW_MD5 = md5(body(OLD_EX)), md5(body(NEW_EX))
assert OLD_MD5 == 'ab6a9345c55ab69c77347d9b37e92e9d', 'not the body the PR-5 rollback pins'
assert OLD_MD5 in mig and NEW_MD5 in mig, 'the md5s written in the migration are stale'
CLAIM_STMT, DONE_STMT = stmt(mig, 'ai_app_notice_claim'), stmt(mig, 'ai_app_notice_done')
assert [x.group(1) for x in re.finditer(r'CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(', mig)] == ['mcp_exchange_code', 'ai_app_notice_claim', 'ai_app_notice_done']
assert not re.search(r'DROP |CREATE POLICY|GRANT SELECT|GRANT INSERT|GRANT UPDATE|GRANT DELETE|GRANT ALL|TO PUBLIC|TO authenticated|pg_cron|cron\.|net\.|pg_net', mig)
ANON_ALL = json.loads(rd('supabase/tests/backlog-4263-pr8/catalog-facts.json'))['anon_callable_mcp_after']
assert len(ANON_ALL) == 17 and EX.replace('public.', '') in ANON_ALL
arr = lambda xs: ', '.join("'" + x.replace("'", "''") + "'" for x in xs)
SIGTXT = lambda s: f"'{s}'::regprocedure::text"


def q(s, tag='$mutq$'):
    assert tag not in s
    return tag + s + tag


# ------------------------------------------------------------------------------------------------ mutations
NEW_EX_C, CLAIM_C, DONE_C = create_only(NEW_EX), create_only(CLAIM_STMT), create_only(DONE_STMT)
REJ = '  -- a rejected redemption uses up the code and removes its pending connection\n'
EARLY = BLOCK.replace('v_n > 0 FROM', 'coalesce(v_n, 0) > 0 FROM')
CHECK_CLAIM = "  IF auth.role() IS DISTINCT FROM 'service_role' THEN   /*CALLER:claim*/\n    RAISE EXCEPTION 'Unauthorized';\n  END IF;\n"
CHECK_DONE = CHECK_CLAIM.replace('CALLER:claim', 'CALLER:done')
UPD_STALE = re.search(r"(  UPDATE public\.ai_app_connect_notices n\n     SET status = 'skipped'.*?SKIP LOCKED\);\n)", CLAIM_C, re.S).group(1)
UPD_FAIL = re.search(r"(  UPDATE public\.ai_app_connect_notices n\n     SET status = 'failed'.*?SKIP LOCKED\);\n)", CLAIM_C, re.S).group(1)
DEL_OLD = re.search(r"(  DELETE FROM public\.ai_app_connect_notices n\n.*?SKIP LOCKED\);\n)", CLAIM_C, re.S).group(1)
assert UPD_STALE.count('UPDATE public') == 1 and UPD_FAIL.count('UPDATE public') == 1 and DEL_OLD.count('DELETE') == 1 and DEL_OLD.count('UPDATE public') == 0
VOCAB = re.search(r"(  IF \(p_status IN .*?END IF;\n)", DONE_C, re.S).group(1)
FN_MUTS = [  # (id, target, [(old, new)], control, ddl before, extra proof)
    ('M01_no_insert', 'ex', [(BLOCK, '')], 'c_notice', None, None),
    ('M02_replaced_always_false', 'ex', [('SELECT c.user_id, c.provider, v_n > 0 FROM', 'SELECT c.user_id, c.provider, false FROM')], 'c_notice', None, None),
    ('M03_replaced_after_replacement', 'ex', [('v_n > 0 FROM public.mcp_connections c WHERE',
      "EXISTS (SELECT 1 FROM public.mcp_connections o WHERE o.user_id = c.user_id AND o.redirect_uri = c.redirect_uri AND o.id <> c.id AND o.status = 'active') FROM public.mcp_connections c WHERE")],
     'c_notice', None, None),
    ('M04_insert_twice', 'ex', [(BLOCK, BLOCK + BLOCK)], 'c_notice', None, None),
    ('M05_insert_before_code_check', 'ex', [(BLOCK, ''), (REJ, EARLY + REJ)], 'c_none', None, None),
    ('M06_no_exception_block', 'ex', [('  EXCEPTION WHEN OTHERS THEN\n    NULL;\n  END;\n', '  END;\n')], 'c_insert_fail', None, None),
    ('M07_answer_changed', 'ex', [("'scope', v_scope);   /*SCOPE:exchange*/", "'scope', v_scope, 'notice', true);   /*SCOPE:exchange*/")], 'c_equal', None, None),
    ('M08_fk_to_connection_cascade', 'ex', [('(user_id, provider, replaced)\n    SELECT c.user_id, c.provider, v_n > 0 FROM',
                                             '(user_id, provider, replaced, connection_id)\n    SELECT c.user_id, c.provider, v_n > 0, c.id FROM')], 'c_survive',
     'ALTER TABLE public.ai_app_connect_notices ADD COLUMN connection_id uuid NULL REFERENCES public.mcp_connections (id) ON DELETE CASCADE',
     "EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.ai_app_connect_notices'::regclass AND a.attname = 'connection_id' AND NOT a.attisdropped)"),
    ('M09_handler_narrowed', 'ex', [('  EXCEPTION WHEN OTHERS THEN\n    NULL;\n  END;\n', '  EXCEPTION WHEN integrity_constraint_violation THEN\n    NULL;\n  END;\n')],
     'c_insert_fail', None, None),
    ('M10_claim_no_inside_check', 'claim', [(CHECK_CLAIM, '')], 'c_caller', None, None),
    ('M11_claim_no_lease', 'claim', [('       AND (x.lease_until IS NULL OR x.lease_until <= now())   /*LEASE:free*/\n', '')], 'c_claim', None, None),
    ('M12_claim_no_attempts_cap', 'claim', [('       AND x.attempts < 5   /*CAP:attempts*/\n', ''), (UPD_FAIL, '')], 'c_claim', None, None),
    ('M13_claim_no_failed_mark', 'claim', [(UPD_FAIL, '')], 'c_claim', None, None),
    ('M14_claim_no_stale_skip', 'claim', [(UPD_STALE, ''), ("       AND x.connected_at >= now() - interval '2 days'   /*STALE:claim*/\n", '')], 'c_claim', None, None),
    ('M15_claim_no_stale_mark', 'claim', [(UPD_STALE, '')], 'c_claim', None, None),
    ('M16_claim_no_prune', 'claim', [(DEL_OLD, '')], 'c_claim', None, None),
    ('M17_claim_no_limit_cap', 'claim', [('LIMIT least(greatest(coalesce(p_limit, 0), 0), 50)', 'LIMIT greatest(coalesce(p_limit, 0), 0)')], 'c_cap', None, None),
    ('M18_claim_returns_email', 'claim', [("'connected_at', u.connected_at, 'attempts', u.attempts)",
                                           "'connected_at', u.connected_at, 'attempts', u.attempts, 'email', (SELECT au.email FROM auth.users au WHERE au.id = u.user_id))")], 'c_claim', None, None),
    ('M19_claim_no_increment', 'claim', [('SET attempts = n.attempts + 1, lease_until', 'SET attempts = n.attempts, lease_until')], 'c_claim', None, None),
    ('M20_done_no_inside_check', 'done', [(CHECK_DONE, '')], 'c_caller', None, None),
    ('M21_done_no_attempts_guard', 'done', [('     AND n.attempts = p_attempts   /*GUARD:attempts*/\n', '')], 'c_done', None, None),
    ('M22_done_overwrites_finished', 'done', [("\n     AND n.status = 'due';", ';')], 'c_done', None, None),
    ('M23_done_error_not_cut', 'done', [('left(p_error, 40)', 'p_error')], 'c_done', None, None),
    ('M24_done_any_status', 'done', [(VOCAB, '')], 'c_done', None, None),
    ('M25_stale_skip_ignores_lease', 'claim', [('                     AND (x.lease_until IS NULL OR x.lease_until <= now())   /*LEASE:stale*/\n', '')], 'c_claim', None, None),
]
TARGET = {'ex': (NEW_EX_C, EX), 'claim': (CLAIM_C, CLAIM), 'done': (DONE_C, DONE)}
DDL_MUTS = [  # (id, ddl, proof, control)
    ('M30_claim_granted_authenticated', 'GRANT EXECUTE ON FUNCTION public.ai_app_notice_claim(integer) TO authenticated',
     f"has_function_privilege('authenticated', '{CLAIM}'::regprocedure, 'EXECUTE')", 'c_grants'),
    ('M31_table_select_service_role', 'GRANT SELECT ON public.ai_app_connect_notices TO service_role',
     "has_table_privilege('service_role', 'public.ai_app_connect_notices'::regclass, 'SELECT')", 'c_grants'),
    ('M32_cat_done_granted_anon', 'GRANT EXECUTE ON FUNCTION public.ai_app_notice_done(uuid, integer, text, text) TO anon',
     f"has_function_privilege('anon', '{DONE}'::regprocedure, 'EXECUTE')", 'c_catalog'),
    ('M33_cat_other_function_cost', 'ALTER FUNCTION public._mcp_refuse(text) COST 7',
     "(SELECT procost = 7 FROM pg_proc WHERE oid = 'public._mcp_refuse(text)'::regprocedure)", 'c_catalog'),
    ('M34_cat_function_added', "CREATE FUNCTION public._mcp_zz_added_4263() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
     "to_regprocedure('public._mcp_zz_added_4263()') IS NOT NULL", 'c_catalog'),
    ('M35_cat_anon_list_grows', 'GRANT EXECUTE ON FUNCTION public._mcp_refuse(text) TO anon',
     "has_function_privilege('anon', 'public._mcp_refuse(text)'::regprocedure, 'EXECUTE')", 'c_catalog'),
    ('M36_cat_policy_added', 'CREATE POLICY x4263_p ON public.ai_app_connect_notices FOR SELECT TO authenticated USING (true)',
     "EXISTS (SELECT 1 FROM pg_policy y WHERE y.polrelid = 'public.ai_app_connect_notices'::regclass)", 'c_catalog'),
    ('M37_cat_other_table_granted', 'GRANT SELECT ON public.mcp_redirect_allowlist TO authenticated',
     "has_table_privilege('authenticated', 'public.mcp_redirect_allowlist'::regclass, 'SELECT')", 'c_catalog'),
    ('M38_cat_exchange_attribute', 'ALTER FUNCTION public.mcp_exchange_code(text, bytea, text, text, text, text, bytea, bytea) COST 99',
     f"(SELECT procost = 99 FROM pg_proc WHERE oid = '{EX}'::regprocedure)", 'c_catalog'),
    ('M39_cat_text_column_added', 'ALTER TABLE public.ai_app_connect_notices ADD COLUMN client_name text NULL',
     "EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.ai_app_connect_notices'::regclass AND a.attname = 'client_name')", 'c_catalog'),
    ('M40_cat_unique_index', 'CREATE UNIQUE INDEX x4263_u ON public.ai_app_connect_notices (user_id, provider, connected_at)',
     "to_regclass('public.x4263_u') IS NOT NULL", 'c_catalog'),
]
DDL_MUTS += [
    ('M41_cat_allowlist_key_widened', 'ALTER TABLE public.mcp_redirect_allowlist DROP CONSTRAINT mcp_redirect_allowlist_pkey, ADD PRIMARY KEY (redirect_uri, provider)',
     "(SELECT array_length(k.conkey, 1) = 2 FROM pg_constraint k WHERE k.conrelid = 'public.mcp_redirect_allowlist'::regclass AND k.contype = 'p')", 'c_catalog'),
    ('M42_mig_anon_name_swapped', 'REVOKE EXECUTE ON FUNCTION public.mcp_get_status(text, bytea, text) FROM anon; GRANT EXECUTE ON FUNCTION public._mcp_refuse(text) TO anon',
     "has_function_privilege('anon', 'public._mcp_refuse(text)'::regprocedure, 'EXECUTE') AND NOT has_function_privilege('anon', 'public.mcp_get_status(text,bytea,text)'::regprocedure, 'EXECUTE')", 'c_mig_post'),
]
CONTROLS = ['c_notice', 'c_none', 'c_insert_fail', 'c_survive', 'c_two_users', 'c_grants', 'c_caller', 'c_claim', 'c_cap', 'c_done', 'c_catalog', 'c_mig_post']

mut_sql, mut_report, WANT = [], [], {}
for mid, tgt, reps, ctl, pre, extra in FN_MUTS:
    WANT[mid] = ctl
    src, sig = TARGET[tgt]
    mc = src
    for o_, n_ in reps:
        assert mc.count(o_) == 1, (mid, o_[:60], mc.count(o_))
        mc = mc.replace(o_, n_)
    assert mc != src, mid
    mut_report.append(f'MUTATION APPLIED {mid}: md5 {md5(body(mc))} ({len(reps)} replacement(s))')
    run = "pg_temp.with_old('c_equal')" if ctl == 'c_equal' else f"pg_temp.iso('{ctl}')"
    proof = f"(SELECT md5(p.prosrc) = '{md5(body(mc))}' FROM pg_proc p WHERE p.oid = to_regprocedure('{sig}'))" + (f' AND {extra}' if extra else '')
    mut_sql.append(f"""DO $m_{mid}$
DECLARE v text; ok boolean;
BEGIN
  BEGIN
    {'EXECUTE ' + q(pre) + ';' if pre else ''}
    EXECUTE {q(mc)};
    ok := {proof};
    v := {run};
    RAISE EXCEPTION USING ERRCODE = 'MX002';
  EXCEPTION WHEN SQLSTATE 'MX002' THEN NULL;
    WHEN OTHERS THEN v := 'MUTANT ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 300); ok := false;
  END;
  PERFORM pg_temp.rec('MUT_{mid}', jsonb_build_object('applied', ok, 'control', '{ctl}', 'red', left(v, 4) IS DISTINCT FROM 'PASS', 'result', left(v, 400)));
END
$m_{mid}$;
""")
for mid, ddl, proof, ctl in DDL_MUTS:
    WANT[mid] = ctl
    mut_report.append(f'MUTATION APPLIED {mid} (ddl): {ddl[:150]}')
    mut_sql.append(f"""DO $m_{mid}$
DECLARE v text; ok boolean;
BEGIN
  BEGIN
    EXECUTE {q(ddl)};
    ok := {proof};
    v := pg_temp.iso('{ctl}');
    RAISE EXCEPTION USING ERRCODE = 'MX002';
  EXCEPTION WHEN SQLSTATE 'MX002' THEN NULL;
    WHEN OTHERS THEN v := 'MUTANT ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 300); ok := false;
  END;
  PERFORM pg_temp.rec('MUT_{mid}', jsonb_build_object('applied', ok, 'control', '{ctl}', 'red', left(v, 4) IS DISTINCT FROM 'PASS', 'result', left(v, 400)));
END
$m_{mid}$;
""")

# ------------------------------------------------------------------------------------------------ catalogue checks
SNAP = """  SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS src_md5, p.proacl::text AS acl, p.proconfig AS config, p.prosecdef AS secdef,
         p.proowner AS owner, p.provolatile AS vol, p.proisstrict AS strict, p.proleakproof AS leakproof, p.proparallel AS parallel,
         p.procost AS cost, p.prorows AS nrows
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace"""
REL_SNAP = """  SELECT c.relname::text AS rel, c.relkind::text AS kind, c.relacl::text AS acl, c.relrowsecurity AS rls, c.relforcerowsecurity AS frls,
         c.relowner AS owner, (SELECT count(*) FROM pg_policy y WHERE y.polrelid = c.oid) AS npol
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace"""
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
EX_SAME = """EXISTS (SELECT 1 FROM pg_temp.{t} b JOIN pg_proc p ON """ + SAME + f""" WHERE b.sig = {SIGTXT(EX)})"""
REL_SAME = """c.relnamespace = 'public'::regnamespace AND c.relname::text = b.rel AND c.relkind::text = b.kind AND c.relacl::text IS NOT DISTINCT FROM b.acl
                   AND c.relrowsecurity = b.rls AND c.relforcerowsecurity = b.frls AND c.relowner = b.owner
                   AND (SELECT count(*) FROM pg_policy y WHERE y.polrelid = c.oid) = b.npol"""
REL_EXISTS = "EXISTS (SELECT 1 FROM pg_class c2 WHERE c2.relnamespace = 'public'::regnamespace AND c2.relname::text = b.rel)"
REL_CHANGED = """(SELECT coalesce(array_agg(b.rel ORDER BY b.rel COLLATE "C"), '{{}}') FROM pg_temp.{t} b
         WHERE """ + REL_EXISTS + """ AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE """ + REL_SAME + "))"
REL_GONE = """(SELECT coalesce(array_agg(b.rel ORDER BY b.rel COLLATE "C"), '{{}}') FROM pg_temp.{t} b WHERE NOT """ + REL_EXISTS + ")"
REL_ADDED = """(SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname::text COLLATE "C"), '{{}}') FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND NOT EXISTS (SELECT 1 FROM pg_temp.{t} b WHERE b.rel = c.relname::text))"""
ANON_Q = """(SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C"), '{}') FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE'))
        = (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(ARRAY[""" + arr(ANON_ALL) + """]::text[]) x)"""
ANON_AI = """(SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^ai_app_'
        AND has_function_privilege('anon', p.oid, 'EXECUTE'))"""
JOBS = f"""(SELECT count(*) = 2 AND bool_and(p.proowner = 'postgres'::regrole::oid AND p.prosecdef AND p.provolatile = 'v'
          AND p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'plpgsql') AND array_to_string(p.proconfig, ',') = 'search_path=""'
          AND (SELECT array_agg(DISTINCT a.grantee::regrole::text ORDER BY a.grantee::regrole::text) FROM aclexplode(p.proacl) a
                WHERE a.privilege_type = 'EXECUTE') = ARRAY['postgres', 'service_role'])
        FROM pg_proc p WHERE p.oid IN (to_regprocedure('{CLAIM}'), to_regprocedure('{DONE}')))"""
TABLE_SHAPE = f"""(SELECT c.relrowsecurity AND c.relowner = 'postgres'::regrole::oid
          AND NOT EXISTS (SELECT 1 FROM pg_policy y WHERE y.polrelid = c.oid)
          AND NOT EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee <> c.relowner)
          AND (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid AND i.indisunique) = 1
          AND (SELECT array_agg(k.confrelid::regclass::text) FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f') = ARRAY['auth.users']
          AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)
              = ARRAY[{arr(COLS)}]
        FROM pg_class c WHERE c.oid = to_regclass('{TABLE}'))"""
LEDGER = f"(SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')"


def postcheck_apply(tag, t, tr, label):
    return f"""DO ${tag}$
DECLARE v jsonb; w_changed jsonb; w_added jsonb; w_rel jsonb;
BEGIN
  SELECT jsonb_build_object(
    'exchange_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = '{EX}'::regprocedure),
    'exchange_md5_before', (SELECT b.src_md5 FROM pg_temp.{t} b WHERE b.sig = {SIGTXT(EX)}),
    'exchange_attributes_unchanged', {EX_SAME.format(t=t)},
    'changed', {CHANGED.format(t=t)},
    'gone', {GONE.format(t=t)},
    'added', {ADDED.format(t=t)},
    'jobs_owner_definer_path_grants', {JOBS},
    'table_closed_columns_keys', {TABLE_SHAPE},
    'rel_changed', {REL_CHANGED.format(t=tr)},
    'rel_gone', {REL_GONE.format(t=tr)},
    'rel_added', {REL_ADDED.format(t=tr)},
    'anon_mcp_17', {ANON_Q},
    'anon_ai_app', {ANON_AI},
    'allowlist_key', (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
                       WHERE k.conrelid = 'public.mcp_redirect_allowlist'::regclass AND k.contype = 'p') = ARRAY['redirect_uri'],
    'ledger', {LEDGER}) INTO v;
  w_changed := CASE WHEN v ->> 'exchange_md5_before' = '{NEW_MD5}' THEN '[]'::jsonb ELSE jsonb_build_array({SIGTXT(EX)}) END;
  SELECT coalesce(jsonb_agg(x ORDER BY x COLLATE "C"), '[]') INTO w_added
    FROM unnest(ARRAY[{SIGTXT(CLAIM)}, {SIGTXT(DONE)}]) x WHERE NOT EXISTS (SELECT 1 FROM pg_temp.{t} b WHERE b.sig = x);
  SELECT coalesce(jsonb_agg(x ORDER BY x COLLATE "C"), '[]') INTO w_rel
    FROM unnest(ARRAY[{arr(RELS)}]) x WHERE NOT EXISTS (SELECT 1 FROM pg_temp.{tr} b WHERE b.rel = x);
  IF v ->> 'exchange_md5' IS DISTINCT FROM '{NEW_MD5}'
     OR v -> 'changed' IS DISTINCT FROM w_changed OR v -> 'added' IS DISTINCT FROM w_added OR v -> 'gone' IS DISTINCT FROM '[]'::jsonb
     OR (v ->> 'exchange_attributes_unchanged')::boolean IS NOT TRUE OR (v ->> 'jobs_owner_definer_path_grants')::boolean IS NOT TRUE
     OR (v ->> 'table_closed_columns_keys')::boolean IS NOT TRUE
     OR v -> 'rel_changed' IS DISTINCT FROM '[]'::jsonb OR v -> 'rel_gone' IS DISTINCT FROM '[]'::jsonb OR v -> 'rel_added' IS DISTINCT FROM w_rel
     OR (v ->> 'anon_mcp_17')::boolean IS NOT TRUE OR (v ->> 'anon_ai_app')::int IS DISTINCT FROM 0 OR (v ->> 'ledger')::int IS DISTINCT FROM 1
     OR (v ->> 'allowlist_key')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION '{label} POST-CHECK {VERSION} FAILED, nothing applied: %', v;
  END IF;
  RAISE NOTICE '{label} POST-CHECK {VERSION} OK: %', v;
END
${tag}$;
"""


def postcheck_rollback(tag, t, tr):
    gone = sorted([CLAIM.replace('public.', ''), DONE.replace('public.', '')])
    return f"""DO ${tag}$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'exchange_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = '{EX}'::regprocedure),
    'exchange_attributes_unchanged', {EX_SAME.format(t=t)},
    'changed', {CHANGED.format(t=t)},
    'gone', {GONE.format(t=t)},
    'added', {ADDED.format(t=t)},
    'table_gone', to_regclass('{TABLE}') IS NULL,
    'rel_changed', {REL_CHANGED.format(t=tr)},
    'rel_gone', {REL_GONE.format(t=tr)},
    'rel_added', {REL_ADDED.format(t=tr)},
    'anon_mcp_17', {ANON_Q},
    'ledger', {LEDGER}) INTO v;
  IF v ->> 'exchange_md5' IS DISTINCT FROM '{OLD_MD5}'
     OR v -> 'changed' IS DISTINCT FROM jsonb_build_array({SIGTXT(EX)}) OR v -> 'added' IS DISTINCT FROM '[]'::jsonb
     OR v -> 'gone' IS DISTINCT FROM '{json.dumps(gone)}'::jsonb
     OR (v ->> 'exchange_attributes_unchanged')::boolean IS NOT TRUE OR (v ->> 'table_gone')::boolean IS NOT TRUE
     OR v -> 'rel_changed' IS DISTINCT FROM '[]'::jsonb OR v -> 'rel_gone' IS DISTINCT FROM '{json.dumps(sorted(RELS))}'::jsonb
     OR v -> 'rel_added' IS DISTINCT FROM '[]'::jsonb
     OR (v ->> 'anon_mcp_17')::boolean IS NOT TRUE OR (v ->> 'ledger')::int IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK {VERSION} FAILED, nothing changed: %', v;
  END IF;
  RAISE NOTICE 'ROLLBACK POST-CHECK {VERSION} OK: %', v;
END
${tag}$;
"""


POST_APPLY = postcheck_apply('postnotice', 'pn_fn_before', 'pn_rel_before', 'APPLY')
apply = f"""-- apply-{VERSION}.sql (generated by supabase/tests/backlog-4263-notice/gen.py; do not hand-edit)
-- Migration: {MIG_PATH}  file md5 {md5(mig)}
-- One transaction. If the apply tool writes the ledger row itself, remove the INSERT below.
-- The post-check RAISEs (rolling everything back) unless: mcp_exchange_code is at md5 {NEW_MD5} and is the only
-- function in schema public that changed (body md5, grants, settings, security definer, owner, volatility, strict,
-- leakproof, parallel, cost, rows), and only its body changed; exactly ai_app_notice_claim and ai_app_notice_done were
-- added, owned by postgres, plpgsql VOLATILE SECURITY DEFINER with an empty search_path, EXECUTE for postgres and
-- service_role only; no function was dropped; exactly the table ai_app_connect_notices and its three indexes were
-- added (RLS on, no policy, no privilege for any role but its owner, one unique index (the key), one foreign key (to
-- auth.users), the ten named columns); no other relation in public changed its grants, RLS or policy count; the
-- anon-callable mcp functions are exactly the 17 named and no ai_app_ function is anon-callable; the ledger row.
CREATE TEMP TABLE pn_fn_before ON COMMIT DROP AS
{SNAP};
CREATE TEMP TABLE pn_rel_before ON COMMIT DROP AS
{REL_SNAP};

{mig}
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('{VERSION}', '{NAME}', ARRAY[]::text[]);

{POST_APPLY}"""

rollback = f"""-- rollback-{VERSION}.sql (generated by supabase/tests/backlog-4263-notice/gen.py; do not hand-edit)
-- Undoes {MIG_PATH}: puts back the body of mcp_exchange_code written by {P5_PATH}
-- (md5 {OLD_MD5}), drops ai_app_notice_claim, ai_app_notice_done and the table ai_app_connect_notices (its rows go with
-- it; the count is in the NOTICE), and removes the ledger row. One transaction; RAISEs (nothing changed) unless the
-- post-check holds. Order: run this BEFORE any rollback of 20261118130000 (whose pre-check requires the exchange at
-- md5 {OLD_MD5}). It does not depend on the rollbacks of 20261118140000, 20261118150000 or 20261118160000.
DO $prenoticer$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('{EX}');
  IF v_md5 IS DISTINCT FROM '{NEW_MD5}' THEN
    RAISE EXCEPTION 'ROLLBACK {VERSION}: mcp_exchange_code is not at the body {VERSION} wrote (md5 %)', coalesce(v_md5, 'missing');
  END IF;
  IF to_regprocedure('{CLAIM}') IS NULL OR to_regprocedure('{DONE}') IS NULL OR to_regclass('{TABLE}') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK {VERSION}: an object {VERSION} created is missing';
  END IF;
  RAISE NOTICE 'ROLLBACK {VERSION}: dropping % notice rows', (SELECT count(*) FROM public.ai_app_connect_notices);
END
$prenoticer$;
CREATE TEMP TABLE pn_rb_fn ON COMMIT DROP AS
{SNAP};
CREATE TEMP TABLE pn_rb_rel ON COMMIT DROP AS
{REL_SNAP};

{OLD_EX}
SET LOCAL lock_timeout = '3s';
DROP FUNCTION public.ai_app_notice_claim(integer);
DROP FUNCTION public.ai_app_notice_done(uuid, integer, text, text);
DROP TABLE public.ai_app_connect_notices;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}';

{postcheck_rollback('postnoticer', 'pn_rb_fn', 'pn_rb_rel')}"""

# ------------------------------------------------------------------------------------------------ harness
MIG_POST = re.search(r'(DO \$post4263notice\$.*?\$post4263notice\$;)', mig, re.S).group(1)
assert "SET LOCAL lock_timeout = '3s';\n\n-- ============================================================================ table" in mig
strip = lambda s: s.replace(' ON COMMIT DROP', '')
OLD_COPY = create_only(OLD_EX).replace('CREATE OR REPLACE FUNCTION public.mcp_exchange_code(', 'CREATE FUNCTION public.mcp_exchange_code_x4263old(', 1)
assert body(OLD_COPY) == body(OLD_EX)
controls_sql = (lib('controls.sql').replace('@@POSTCHECK@@', q(strip(POST_APPLY), '$pcq$')).replace('@@OLDCOPY@@', q(OLD_COPY, '$ocq$'))
                .replace('@@OLD_MD5@@', OLD_MD5).replace('@@MIGPOST@@', q(MIG_POST, '$mpq$')))
assert '@@' not in controls_sql
LOCKS = "(SELECT coalesce(jsonb_agg(DISTINCT l.mode), '[]') FROM pg_locks l WHERE l.pid = pg_backend_pid() AND l.relation = 'auth.users'::regclass)"
harness = f"""-- harness-notice.sql (generated by supabase/tests/backlog-4263-notice/gen.py; do not hand-edit)
-- BACKLOG-4263 PR-10.7: ONE call on the test project (~/.claude/bin/kt-sql harness-notice.sql) that ends in RAISE, so
-- nothing persists. Order: helpers and fixtures -> the apply file (migration + ledger + post-check) -> the migration
-- again (re-run) -> {len(CONTROLS)} controls -> the old exchange body under a temporary name: old-vs-new comparison ->
-- {len(FN_MUTS) + len(DDL_MUTS)} mutations, each proven installed before its control runs -> the rollback file and its post-check ->
-- RAISE with every result. Afterwards: ~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()".
-- Only statuses, counts, fixture keys, md5s and timings are recorded.
{rd('supabase/tests/backlog-4263-pr5/lib/helpers-base.sql')}
{lib('fixtures.sql')}
DO $t0$
BEGIN
  PERFORM pg_temp.rec('t_start', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('exchange_md5_before_apply', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{EX}'::regprocedure)));
  PERFORM pg_temp.rec('exchange_md5_expected_before', to_jsonb('{OLD_MD5}'::text));
  PERFORM pg_temp.rec('migration_md5', to_jsonb('{md5(mig)}'::text));
  PERFORM pg_temp.rec('ledger_20261118160000', to_jsonb((SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261118160000')));
  PERFORM pg_temp.rec('ledger_20261118170000', to_jsonb((SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261118170000')));
  PERFORM pg_temp.rec('authorize_view_md5', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.mcp_authorize_view(text,bytea)'::regprocedure)));
  PERFORM pg_temp.rec('locks_auth_users_before_apply', {LOCKS});
END $t0$;
-- ================================================================ apply
{strip(apply)}
DO $t1$
BEGIN
  PERFORM pg_temp.rec('t_after_apply', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('locks_auth_users_after_apply', {LOCKS});
  PERFORM pg_temp.rec('lock_timeout_after_apply', to_jsonb(current_setting('lock_timeout')));
END $t1$;
{controls_sql}
-- ================================================================ re-run of the migration
DO $rerun$
BEGIN
  EXECUTE {q(mig, '$migq$')};
  PERFORM pg_temp.rec('rerun', to_jsonb('ok'::text));
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
  PERFORM pg_temp.rec('REPORT_exchange_answers', pg_temp.j(pg_temp.iso('eq_report')));
  PERFORM pg_temp.rec('old_copy_gone', to_jsonb(to_regprocedure('public.mcp_exchange_code_x4263old(text,bytea,text,text,text,text,bytea,bytea)') IS NULL));
  PERFORM pg_temp.rec('notices_after_controls', to_jsonb((SELECT count(*) FROM public.ai_app_connect_notices)));
  PERFORM pg_temp.rec('t_after_equal', to_jsonb(clock_timestamp()));
END
$ctl$;
-- ================================================================ mutations
{''.join(mut_sql)}
DO $t3$ BEGIN PERFORM pg_temp.rec('t_after_mutations', to_jsonb(clock_timestamp())); END $t3$;
-- ================================================================ rollback rehearsal
DO $rb$
BEGIN
  EXECUTE {q(strip(rollback), '$rbq$')};
  PERFORM pg_temp.rec('rollback', to_jsonb('ok'::text));
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_temp.rec('rollback', to_jsonb('ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 900)));
END
$rb$;
DO $after$
DECLARE x_e jsonb;
BEGIN
  PERFORM pg_temp.rec('rb_exchange_md5', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{EX}'::regprocedure)));
  PERFORM pg_temp.rec('rb_md5_equals_before_apply', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{EX}'::regprocedure)
                                                             = (SELECT v #>> '{{}}' FROM pg_temp.pn_out WHERE k = 'exchange_md5_before_apply')));
  PERFORM pg_temp.rec('rb_objects_gone', to_jsonb(to_regclass('{TABLE}') IS NULL AND to_regprocedure('{CLAIM}') IS NULL AND to_regprocedure('{DONE}') IS NULL));
  PERFORM pg_temp.rec('rb_ledger', to_jsonb({LEDGER}));
  PERFORM pg_temp.rec('locks_auth_users_after_rollback', {LOCKS});
  PERFORM pg_temp.consent('n-rb1', pg_temp.id('A'), 'anthropic');
  x_e := pg_temp.w(pg_temp.q_ex('n-rb1', 'anthropic', 191));
  PERFORM pg_temp.rec('rb_exchange_still_works', to_jsonb(x_e = pg_temp.ok_answer()));
  PERFORM pg_temp.rec('t_end', to_jsonb(clock_timestamp()));
  RAISE EXCEPTION 'NOTICE_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.pn_out);
END
$after$;
"""

facts = {'migration': MIG_PATH, 'migration_md5': md5(mig),
         'exchange': EX, 'exchange_md5_before': OLD_MD5, 'exchange_md5_after': NEW_MD5,
         'claim': CLAIM, 'claim_md5': md5(body(CLAIM_STMT)), 'done': DONE, 'done_md5': md5(body(DONE_STMT)),
         'table': TABLE, 'relations_added': RELS, 'columns': COLS,
         'anon_callable_mcp': ANON_ALL,
         'controls': CONTROLS + ['c_equal'], 'mutations': WANT,
         'apply_md5': md5(apply), 'rollback_md5': md5(rollback)}
outs = {f'apply-{VERSION}.sql': apply, f'rollback-{VERSION}.sql': rollback, 'harness-notice.sql': harness,
        'catalog-facts.json': json.dumps(facts, indent=2, ensure_ascii=False) + '\n'}

if len(sys.argv) > 2 and sys.argv[1] == 'report':
    first = open(sys.argv[2]).read()
    raw = json.loads(first.splitlines()[0])['message'] if first.lstrip().startswith('{') else first
    i = raw.index('NOTICE_RESULT ') + 14
    j = raw.find('\nCONTEXT', i)
    res = json.loads(raw[i:j if j > 0 else len(raw)].strip())
    for k, v in sorted(res.items()):
        if k.startswith('MUT_'):
            ok = v.get('applied') is True and v.get('red') is True
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
print('old', OLD_MD5, 'new', NEW_MD5, 'controls', len(CONTROLS) + 1, 'mutations', len(FN_MUTS) + len(DDL_MUTS))
