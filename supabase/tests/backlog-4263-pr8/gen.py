#!/usr/bin/env python3
"""BACKLOG-4263 PR-8: writes, from the migration:

  supabase/tests/backlog-4263-pr8/apply-20261118150000.sql     migration verbatim + ledger row + post-check
  supabase/tests/backlog-4263-pr8/rollback-20261118150000.sql  rollback + its post-check
  supabase/tests/backlog-4263-pr8/harness-8.sql                ONE call: fixtures, apply, re-run, controls, mutations,
                                                               rollback rehearsal; ends in RAISE (nothing persists)
  supabase/tests/backlog-4263-pr8/catalog-facts.json           md5 of every body written and of the generated files

Mutations are exact-string replacements: each must match once (else this script stops), and the harness proves in
the database that the mutated body is the one installed (md5) before its control runs. A mutation marked 'green'
is expected to leave its control passing (one isolation layer removed while the other holds).
`python3 gen.py check` regenerates in memory and fails if any written file differs.
`python3 gen.py fixtures <kt-sql output>` writes the portal fixture file from a harness run."""
import hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
VERSION, NAME = '20261118150000', 'backlog_4263_mcp_read_tools'
MIG_PATH = f'supabase/migrations/{VERSION}_{NAME}.sql'
rd = lambda p: open(os.path.join(REPO, p)).read()
md5 = lambda s: hashlib.md5(s.encode()).hexdigest()
mig = rd(MIG_PATH)
m4244 = rd('supabase/migrations/20261114110000_backlog_4244_mcp_data_tools.sql')
lib = lambda n: rd(f'supabase/tests/backlog-4263-pr8/lib/{n}')

SIG = {
    '_mcp_r_find_people': 'public._mcp_r_find_people(text,text,uuid,text,text,uuid)',
    '_mcp_r_list_todos': 'public._mcp_r_list_todos(text,text,date,date,boolean,boolean,date,uuid)',
    'mcp_find_people': 'public.mcp_find_people(text,bytea,text,text,text,text,text,text,text)',
    'mcp_list_todos': 'public.mcp_list_todos(text,bytea,text,text,text,text,text,boolean,boolean,text)',
}
NEW = ['_mcp_r_find_people', '_mcp_r_list_todos', 'mcp_find_people', 'mcp_list_todos']
READERS = ['_mcp_r_find_people', '_mcp_r_list_todos']
ANON_NEW = ['mcp_find_people', 'mcp_list_todos']
# the 15 of supabase/tests/backlog-4263-pr5/catalog-facts.json (anon_callable_mcp_after)
ANON_OLD = json.loads(rd('supabase/tests/backlog-4263-pr5/catalog-facts.json'))['anon_callable_mcp_after']
assert len(ANON_OLD) == 15
ANON_ALL = sorted(ANON_OLD + [SIG[n][len('public.'):] for n in ANON_NEW])
assert len(ANON_ALL) == 17
TOOLS_BEFORE = ['get_status', 'list_deals', 'get_deal', 'get_deal_checklists', 'list_all_deals', 'update_todo', 'add_todo', 'remove_todo', 'restore_todo']


def stmt(text, name, tag='fn'):
    m = re.search(r'(CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS \$' + tag + r'\$.*?\$' + tag + r'\$;\n(?:(?:REVOKE|GRANT)[^\n]*\n)*)', text, re.S)
    assert m, name
    return m.group(1)


def body(s, tag='fn'):
    return re.search(r'AS \$' + tag + r'\$(.*?)\$' + tag + r'\$;', s, re.S).group(1)


def create_only(s, tag='fn'):
    return re.search(r'(CREATE OR REPLACE FUNCTION .*?\$' + tag + r'\$;)', s, re.S).group(1)


NEWS = {n: stmt(mig, n) for n in NEW}
NEW_MD5 = {n: md5(body(s)) for n, s in NEWS.items()}
assert mig.count('CREATE OR REPLACE FUNCTION') == 4 and 'DROP FUNCTION' not in mig

# ------------------------------------------------------------------------------------------------ mutations
OWN_FP = [('x.owner_user_id = v_uid /*OWN:fp_deal_arg*/', 'true /*OWN:fp_deal_arg*/'), ('x.owner_user_id = v_uid /*OWN:fp_inst*/', 'true /*OWN:fp_inst*/'),
          ('d.owner_user_id = v_uid /*OWN:fp_deals*/', 'true /*OWN:fp_deals*/'), ('p.owner_user_id = v_uid /*OWN:fp_people*/', 'true /*OWN:fp_people*/')]
OWN_TD = [('x.owner_user_id = v_uid /*OWN:td_inst*/', 'true /*OWN:td_inst*/'), ('x.owner_user_id = v_uid /*OWN:cl_deal*/', 'true /*OWN:cl_deal*/'),
          ('x.owner_user_id = v_uid /*OWN:cl_lists*/', 'true /*OWN:cl_lists*/'), ('t.owner_user_id = v_uid /*OWN:cl_items*/', 'true /*OWN:cl_items*/')]
ENT = ("  IF (v_st -> 'schema_version') IS DISTINCT FROM to_jsonb(1)\n     OR (v_st -> 'licensed') IS DISTINCT FROM to_jsonb(true)\n"
       "     OR (v_st -> 'settings' -> 'enabled') IS DISTINCT FROM to_jsonb(true) THEN", '  IF false THEN')
RLS_FP = ['cloud_deals', 'cloud_deal_parties']
RLS_TD = ['cloud_deals', 'cloud_deal_checklists', 'cloud_deal_checklist_items']
MC000 = ("      RAISE EXCEPTION USING ERRCODE = 'MC000', MESSAGE = 'mcp read block done';\n", '      NULL;\n')

# (id, function, [(old, new)], control, want, ddl-before or None)
MUTS = [
    ('M01_fp_match_raw_company', '_mcp_r_find_people', [("strpos(lower(s.s_company), lower(p_name)) > 0",
        "strpos(lower((SELECT x.company FROM public.cloud_deal_parties x WHERE x.id = s.id)), lower(p_name)) > 0")], 'c_fp_clean', 'red', None),
    ('M02_fp_pattern_from_input', '_mcp_r_find_people', [("strpos(lower(s.s_name), lower(p_name)) > 0", "s.s_name ILIKE '%' || p_name || '%'")], 'c_fp_clean', 'red', None),
    ('M03_fp_email_in_stored_text', '_mcp_r_find_people', [("EXISTS (SELECT 1 FROM jsonb_array_elements(s.s_emails) e WHERE lower(btrim(e ->> 'email')) = p_email)",
        "(SELECT x.emails::text FROM public.cloud_deal_parties x WHERE x.id = s.id) ILIKE '%' || p_email || '%'")], 'c_fp_email', 'red', None),
    ('M04_fp_email_beyond_ten', '_mcp_r_find_people', [("WHERE o <= 10 AND jsonb_typeof(el) = 'object'), '[]'::jsonb) END AS s_emails",
        "WHERE jsonb_typeof(el) = 'object'), '[]'::jsonb) END AS s_emails")], 'c_fp_email', 'red', None),
    ('M05_fp_phone_last_ten_digits', '_mcp_r_find_people', [("CASE WHEN z.plus THEN z.sd WHEN char_length(z.sd) = 10 THEN '1' || z.sd ELSE z.sd END = p_phone", "right(z.sd, 10) = right(p_phone, 10)")], 'c_fp_phone', 'red', None),
    ('M05b_fp_phone_stored_ten_digits', '_mcp_r_find_people', [("CASE WHEN z.plus THEN z.sd WHEN char_length(z.sd) = 10 THEN '1' || z.sd ELSE z.sd END = p_phone", "z.sd = p_phone")], 'c_fp_phone', 'red', None),
    # the rule before the + fix, on both sides at once (reader and tool)
    ('M05c_fp_phone_plus_ignored_both', '_mcp_r_find_people', [("CASE WHEN z.plus THEN z.sd WHEN char_length(z.sd) = 10", "CASE WHEN char_length(z.sd) = 10")], 'c_fp_phone_table', 'red', None,
     ('mcp_find_people', [("CASE WHEN left(p_phone, 1) = '+' THEN v_phone WHEN char_length(v_phone) = 10", "CASE WHEN char_length(v_phone) = 10")])),
    ('M05d_fp_phone_plus_ignored_stored', '_mcp_r_find_people', [("CASE WHEN z.plus THEN z.sd WHEN char_length(z.sd) = 10", "CASE WHEN char_length(z.sd) = 10")], 'c_fp_phone_table', 'red', None),
    ('M05e_fp_phone_plus_ignored_input', 'mcp_find_people', [("CASE WHEN left(p_phone, 1) = '+' THEN v_phone WHEN char_length(v_phone) = 10", "CASE WHEN char_length(v_phone) = 10")], 'c_fp_phone_table', 'red', None),
    ('M06_fp_role_part', '_mcp_r_find_people', [("lower(btrim(s.s_role_category)) = p_role", "strpos(lower(s.s_role_category), p_role) > 0")], 'c_fp_role', 'red', None),
    ('M07_fp_ref_over_filtered_rows', '_mcp_r_find_people', [("        FROM live l),\n    shown AS (",
        "        FROM live l WHERE (p_deal_id IS NULL OR l.cloud_deal_id = p_deal_id)),\n    shown AS (")], 'c_fp_ref', 'red', None),
    ('M08_fp_ref_null_contact_grouped', '_mcp_r_find_people', [("                  WHEN l.local_contact_id IS NULL OR l.d_inst IS NULL THEN l.id /*REF:own*/\n", "")], 'c_fp_ref', 'red', None),
    ('M09_fp_ref_across_computers', '_mcp_r_find_people', [("PARTITION BY l.w, l.d_inst, l.local_contact_id", "PARTITION BY l.w, l.local_contact_id")], 'c_fp_ref', 'red', None),
    ('M10_fp_ref_for_withheld', '_mcp_r_find_people', [("CASE WHEN l.w THEN NULL /*REF:withheld*/\n                  WHEN l.local", "CASE WHEN l.local")], 'c_fp_withheld', 'red', None),
    ('M11_fp_unconfirmed_deals', '_mcp_r_find_people', [("d.is_confirmed /*CONF:fp_deals*/ AND ", "")], 'c_fp_scope', 'red', None),
    ('M11b_fp_unconfirmed_ref', '_mcp_r_find_people', [("d.is_confirmed /*CONF:fp_deals*/ AND ", "")], 'c_fp_ref', 'red', None),
    ('M12_fp_removed_deals', '_mcp_r_find_people', [(" AND d.removed_at IS NULL /*LIVE:fp_deals*/", "")], 'c_fp_scope', 'red', None),
    ('M13_fp_removed_people', '_mcp_r_find_people', [(" AND p.removed_at IS NULL /*LIVE:fp_people*/", "")], 'c_fp_scope', 'red', None),
    ('M14_fp_cursor_inclusive', '_mcp_r_find_people', [("AND (p_after_id IS NULL OR l.id > p_after_id) /*KEY:after*/", "AND (p_after_id IS NULL OR l.id >= p_after_id) /*KEY:after*/")], 'c_fp_page', 'red', None),
    ('M15_fp_bytes_unbounded', '_mcp_r_find_people', [("s.cum <= 60000 /*BOUND:bytes*/", "s.cum <= 6000000 /*BOUND:bytes*/")], 'c_fp_rowmax', 'red', None),
    ('M16_fp_rows_101', '_mcp_r_find_people', [("s.rk <= 100 /*BOUND:rows*/", "s.rk <= 101 /*BOUND:rows*/")], 'c_fp_page', 'red', None),
    ('M17_fp_deal_arg_any_state', '_mcp_r_find_people', [("x.owner_user_id = v_uid /*OWN:fp_deal_arg*/ AND x.is_confirmed /*CONF:fp_deal_arg*/ AND x.removed_at IS NULL /*LIVE:fp_deal_arg*/",
        "x.owner_user_id = v_uid /*OWN:fp_deal_arg*/")], 'c_fp_not_found', 'red', None),
    ('M18_fp_no_entitlement', '_mcp_r_find_people', [ENT], 'c_fp_entitled', 'red', None),
    ('M19_fp_owner_term_only', '_mcp_r_find_people', OWN_FP, 'c_fp_isolation', 'green', None),
    ('M20_fp_rls_only', None, [], 'c_fp_isolation', 'green', RLS_FP),
    ('M21_fp_owner_term_and_rls', '_mcp_r_find_people', OWN_FP, 'c_fp_isolation', 'red', RLS_FP),
    ('M30_td_unconfirmed_deals', '_mcp_r_list_todos', [("x.is_confirmed /*CONF:cl*/ AND ", "")], 'c_td_parity', 'red', None),
    ('M31_td_removed_deals', '_mcp_r_list_todos', [(" AND x.removed_at IS NULL /*LIVE:cl_deal*/", "")], 'c_td_parity', 'red', None),
    ('M32_td_removed_lists', '_mcp_r_list_todos', [(" AND x.removed_at IS NULL /*LIVE:cl_lists*/", "")], 'c_td_parity', 'red', None),
    ('M33_td_removed_todos', '_mcp_r_list_todos', [(" AND t.removed_at IS NULL /*LIVE:cl_items*/", "")], 'c_td_parity', 'red', None),
    ('M34_td_open_is_false', '_mcp_r_list_todos', [("(p_state = 'open' AND t.is_checked IS NOT TRUE)", "(p_state = 'open' AND t.is_checked IS FALSE)")], 'c_td_parity', 'red', None),
    ('M35_td_first_30_lists', '_mcp_r_list_todos', [("AND x.removed_at IS NULL /*LIVE:cl_lists*/)", "AND x.removed_at IS NULL /*LIVE:cl_lists*/ AND x.sort_order < 30)")], 'c_td_parity', 'red', None),
    ('M36_td_due_only_with_switch', '_mcp_r_list_todos', [("          to_char(i.due_date, 'YYYY-MM-DD'),\n",
        "          CASE WHEN public._mcp_writes_on() THEN to_char(i.due_date, 'YYYY-MM-DD') END,\n")], 'c_td_columns', 'red', None),
    ('M37_td_keyset_without_nulls_last', '_mcp_r_list_todos', [("(coalesce(t.due_date, DATE '9999-12-31'), t.id) > (p_after_key, p_after_id)", "(t.due_date, t.id) > (p_after_key, p_after_id)")], 'c_td_page', 'red', None),
    ('M38_td_keyset_on_id', '_mcp_r_list_todos', [("(coalesce(t.due_date, DATE '9999-12-31'), t.id) > (p_after_key, p_after_id)", "t.id > p_after_id")], 'c_td_page', 'red', None),
    ('M39_td_due_to_exclusive', '_mcp_r_list_todos', [("(p_due_to IS NULL OR t.due_date <= p_due_to)", "(p_due_to IS NULL OR t.due_date < p_due_to)")], 'c_td_filters', 'red', None),
    ('M40_td_bytes_unbounded', '_mcp_r_list_todos', [("s.cum <= 85000 /*BOUND:bytes*/", "s.cum <= 8500000 /*BOUND:bytes*/")], 'c_td_page', 'red', None),
    ('M42_td_without_due_false_filters', '_mcp_r_list_todos', [("(p_without_due IS NOT TRUE OR t.due_date IS NULL)", "(p_without_due IS NULL OR (t.due_date IS NULL) = p_without_due)")], 'c_td_filters', 'red', None),
    ('M43_td_no_entitlement', '_mcp_r_list_todos', [ENT], 'c_fp_entitled', 'red', None),
    ('M44_td_owner_term_only', '_mcp_r_list_todos', OWN_TD, 'c_td_isolation', 'green', None),
    ('M45_td_rls_only', None, [], 'c_td_isolation', 'green', RLS_TD),
    ('M46_td_owner_term_and_rls', '_mcp_r_list_todos', OWN_TD, 'c_td_isolation', 'red', RLS_TD),
    ('M50_fp_no_day_cap', 'mcp_find_people', [("v_b := public._mcp_bump('find_people_user:' || g.user_id::text, interval '1 day', 1000);", "v_b := 'ok';")], 'c_fp_day', 'red', None),
    ('M51_fp_day_cap_high', 'mcp_find_people', [("interval '1 day', 1000);", "interval '1 day', 1000000);")], 'c_fp_day', 'red', None),
    ('M52_fp_day_cap_minute_text', 'mcp_find_people', [("RETURN public._mcp_refuse(CASE WHEN v_b = 'rate_limited' THEN 'day_limit' ELSE 'busy' END);", "RETURN public._mcp_refuse(v_b);")], 'c_fp_day', 'red', None),
    ('M53_fp_day_counts_invalid', 'mcp_find_people', [("  v_name := btrim(public._mcp_strip(p_name), E' \\t\\r\\n');",
        "  PERFORM public._mcp_bump('find_people_user:' || g.user_id::text, interval '1 day', 1000);\n  v_name := btrim(public._mcp_strip(p_name), E' \\t\\r\\n');")], 'c_fp_input', 'red', None),
    ('M54_fp_name_one_char', 'mcp_find_people', [("char_length(v_name) BETWEEN 2 AND 100", "char_length(v_name) BETWEEN 1 AND 100")], 'c_fp_input', 'red', None),
    ('M55_fp_no_criterion', 'mcp_find_people', [("     OR (p_name IS NULL AND p_role IS NULL AND p_deal_id IS NULL AND p_email IS NULL AND p_phone IS NULL) /*ARG:one*/", "     OR false /*ARG:one*/")], 'c_fp_input', 'red', None),
    ('M56_fp_phone_seven_digits', 'mcp_find_people', [("char_length(v_phone) BETWEEN 10 AND 15", "char_length(v_phone) BETWEEN 7 AND 15")], 'c_fp_input', 'red', None),
    ('M57_fp_name_untrimmed', 'mcp_find_people', [("v_name := btrim(public._mcp_strip(p_name), E' \\t\\r\\n');", "v_name := p_name;")], 'c_fp_input', 'red', None),
    ('M58_fp_claims_kept', 'mcp_find_people', [MC000], 'c_claims', 'red', None),
    ('M59_td_claims_kept', 'mcp_list_todos', [MC000], 'c_claims', 'red', None),
    ('M60_fp_secret_after_enter', 'mcp_find_people', [("  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN\n    RETURN public._mcp_refuse('not_connected');\n  END IF;\n  g := public._mcp_enter(p_at_digest, p_resource, 'find_people');",
        "  g := public._mcp_enter(p_at_digest, p_resource, 'find_people');\n  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN\n    RETURN public._mcp_refuse('not_connected');\n  END IF;")], 'c_secret', 'red', None),
    ('M61_fp_too_large_branch', 'mcp_find_people', [("OR octet_length(v_res::text) > 90000 THEN 'too_large'", "OR octet_length(v_res::text) > 1000 THEN 'too_large'")], 'c_fp_basic', 'red', None),
    ('M62_td_cursor_any_date', 'mcp_list_todos', [("\n     OR (p_cursor IS NOT NULL AND split_part(p_cursor, '|', 1) <> 'none' AND v_key NOT BETWEEN DATE '2000-01-01' AND DATE '2100-12-31') /*ARG:cursor_bounds*/ THEN", " THEN")], 'c_td_filters', 'red', None),
    ('M63_td_without_with_range', 'mcp_list_todos', [("\n     OR (p_without_due_date IS TRUE AND (p_due_from IS NOT NULL OR p_due_to IS NOT NULL)) /*ARG:without_and_range*/ THEN", " THEN")], 'c_td_filters', 'red', None),
    ('M64_td_default_all', 'mcp_list_todos', [("coalesce(p_state, 'open')", "coalesce(p_state, 'all')")], 'c_td_filters', 'red', None),
]

# catalogue mutations: (id, ddl, proof that it applied, control)
TXT = create_only(stmt(m4244, '_mcp_txt'))
TXT_MUT = TXT.replace("p_max - 1) || '…' ELSE s.x END", "p_max - 1) || '…' ELSE s.x END ")
assert TXT_MUT != TXT
DDL_MUTS = [
    ('M70_cat_existing_function_changed', TXT_MUT, "md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._mcp_txt(text,integer)'::regprocedure)) = '%s'" % md5(body(TXT_MUT)), 'c_catalog'),
    ('M71_cat_outcome_check_dropped', 'ALTER TABLE public.mcp_call_log DROP CONSTRAINT mcp_call_log_outcome_check',
     "NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.mcp_call_log'::regclass AND conname = 'mcp_call_log_outcome_check')", 'c_catalog'),
    ('M72_cat_reader_granted', 'SET ROLE mcp_reader; GRANT EXECUTE ON FUNCTION public._mcp_r_find_people(text, text, uuid, text, text, uuid) TO authenticated; RESET ROLE',
     "has_function_privilege('authenticated', 'public._mcp_r_find_people(text,text,uuid,text,text,uuid)'::regprocedure, 'EXECUTE')", 'c_catalog'),
    ('M73_cat_tool_granted_authenticated', 'GRANT EXECUTE ON FUNCTION public.mcp_list_todos(text, bytea, text, text, text, text, text, boolean, boolean, text) TO authenticated',
     "has_function_privilege('authenticated', 'public.mcp_list_todos(text,bytea,text,text,text,text,text,boolean,boolean,text)'::regprocedure, 'EXECUTE')", 'c_catalog'),
    ('M74_cat_tool_check_without_list_todos', "ALTER TABLE public.mcp_call_log DROP CONSTRAINT mcp_call_log_tool_check; ALTER TABLE public.mcp_call_log ADD CONSTRAINT mcp_call_log_tool_check CHECK (tool IS NULL OR tool IN ("
     + ', '.join(repr(t) for t in TOOLS_BEFORE + ['find_people']) + ")) NOT VALID",
     "pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.mcp_call_log'::regclass AND conname = 'mcp_call_log_tool_check')) !~ 'list_todos'", 'c_catalog'),
]

CONTROLS = ['c_fp_basic', 'c_fp_parity', 'c_fp_isolation', 'c_fp_not_found', 'c_fp_scope', 'c_fp_clean', 'c_fp_withheld', 'c_fp_email', 'c_fp_phone',
            'c_fp_role', 'c_fp_phone_table', 'c_fp_ref', 'c_fp_input', 'c_fp_day', 'c_fp_page', 'c_fp_rowmax', 'c_fp_entitled', 'c_secret',
            'c_td_parity', 'c_td_columns', 'c_td_filters', 'c_td_page', 'c_td_rowmax', 'c_td_isolation', 'c_claims', 'c_catalog']
assert {m[3] for m in MUTS} <= set(CONTROLS) and {m[3] for m in DDL_MUTS} <= set(CONTROLS)
assert len({m[0] for m in MUTS} | {m[0] for m in DDL_MUTS}) == len(MUTS) + len(DDL_MUTS)


def q(s, tag='$mutq$'):
    assert tag not in s
    return tag + s + tag


def rls_sql(tables, on):
    return ''.join("    EXECUTE 'ALTER TABLE public.%s %s ROW LEVEL SECURITY';\n" % (t, 'ENABLE' if on else 'DISABLE') for t in tables)


def rls_proof(tables):
    return ' AND '.join("(SELECT NOT relrowsecurity FROM pg_class WHERE oid = 'public.%s'::regclass)" % t for t in tables)


mut_sql, mut_report, WANT = [], [], {}
for mid, fn, reps, ctl, want, rls, *more in MUTS:
    WANT[mid] = want
    proof, pre, post = [], '', ''
    if rls:
        pre += rls_sql(rls, False)
        proof.append(rls_proof(rls))
        mut_report.append(f'MUTATION APPLIED {mid} (ddl): row level security off on {", ".join(rls)}')
    if fn:
        mc = c = create_only(NEWS[fn])
        for o_, n_ in reps:
            assert mc.count(o_) == 1, (mid, o_, mc.count(o_))
            mc = mc.replace(o_, n_)
        assert mc != c, mid
        first_new = next((n_ for _, n_ in reps if n_.strip()), None)
        line = next((l for l in mc.splitlines() if first_new and first_new.strip().splitlines()[0] in l), '(lines removed)')
        mut_report.append(f'MUTATION APPLIED {mid} ({fn}): {line.strip()[:150]}')
        reader = fn in READERS
        if reader:
            pre += "    EXECUTE 'GRANT CREATE ON SCHEMA public TO mcp_reader';\n    EXECUTE 'SET ROLE mcp_reader';\n"
        pre += f"    EXECUTE {q(mc)};\n"
        if reader:
            pre += "    EXECUTE 'RESET ROLE';\n"
        proof.append(f"(SELECT md5(p.prosrc) = '{md5(body(mc))}' FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG[fn]}'))")
    for fn2, reps2 in more:
        mc2 = c2 = create_only(NEWS[fn2])
        for o_, n_ in reps2:
            assert mc2.count(o_) == 1, (mid, o_, mc2.count(o_))
            mc2 = mc2.replace(o_, n_)
        assert mc2 != c2 and fn2 not in READERS, mid
        mut_report.append(f'MUTATION APPLIED {mid} ({fn2}): {reps2[0][1][:150]}')
        pre += f"    EXECUTE {q(mc2)};\n"
        proof.append(f"(SELECT md5(p.prosrc) = '{md5(body(mc2))}' FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG[fn2]}'))")
    mut_sql.append(f"""DO $m_{mid}$
DECLARE v text; ok boolean;
BEGIN
  BEGIN
{pre}    ok := {' AND '.join(proof)};
    v := pg_temp.iso('{ctl}');
    RAISE EXCEPTION USING ERRCODE = 'MX002';
  EXCEPTION WHEN SQLSTATE 'MX002' THEN NULL;
  END;
  PERFORM pg_temp.rec('MUT_{mid}', jsonb_build_object('applied', ok, 'control', '{ctl}', 'want', '{want}', 'red', v <> 'PASS', 'result', left(v, 400)));
END
$m_{mid}$;
""")
for mid, ddl, proof, ctl in DDL_MUTS:
    WANT[mid] = 'red'
    mut_report.append(f'MUTATION APPLIED {mid} (ddl): {ddl.strip().splitlines()[0][:150]}')
    mut_sql.append(f"""DO $m_{mid}$
DECLARE v text; ok boolean;
BEGIN
  BEGIN
    EXECUTE {q(ddl)};
    ok := {proof};
    v := pg_temp.iso('{ctl}');
    RAISE EXCEPTION USING ERRCODE = 'MX002';
  EXCEPTION WHEN SQLSTATE 'MX002' THEN NULL;
  END;
  PERFORM pg_temp.rec('MUT_{mid}', jsonb_build_object('applied', ok, 'control', '{ctl}', 'want', 'red', 'red', v <> 'PASS', 'result', left(v, 400)));
END
$m_{mid}$;
""")

# ------------------------------------------------------------------------------------------------ apply
mig_md5 = md5(mig)
arr = lambda xs: ', '.join(repr(x) for x in xs)
SNAP = """  SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS src_md5, p.proacl::text AS acl, p.proconfig AS config, p.prosecdef AS secdef,
         p.proowner AS owner, p.provolatile AS vol
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace"""
CHANGED = """(SELECT count(*) FROM pg_temp.{t} b
         WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text = b.sig
                             AND md5(p.prosrc) = b.src_md5 AND p.proacl::text IS NOT DISTINCT FROM b.acl AND p.proconfig IS NOT DISTINCT FROM b.config
                             AND p.prosecdef = b.secdef AND p.proowner = b.owner AND p.provolatile = b.vol))"""
ANON_Q = """(SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C"), '{{}}') FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE'))
        = (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(ARRAY[{names}]::text[]) x)"""
TOOL_NAMES_Q = """(SELECT array_agg(m[1] ORDER BY m[1] COLLATE "C") FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') m
        WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.conname = 'mcp_call_log_tool_check')
        = (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(ARRAY[{names}]::text[]) x)"""
OUTCOME_Q = """(SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.conname = 'mcp_call_log_outcome_check')
        IS NOT DISTINCT FROM (SELECT def FROM pg_temp.{t} WHERE name = 'mcp_call_log_outcome_check')"""
CHECKS_Q = """(SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.contype = 'c') = (SELECT count(*) FROM pg_temp.{t})"""

post = f"""
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('{VERSION}', '{NAME}', ARRAY[]::text[]);

DO $post4263p8$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'bodies', (SELECT coalesce(jsonb_object_agg(x.sig, coalesce(md5(p.prosrc), 'missing')), '{{}}') FROM (VALUES {', '.join(f"('{SIG[n]}', '{NEW_MD5[n]}')" for n in NEW)}) x(sig, want)
                LEFT JOIN pg_proc p ON p.oid = to_regprocedure(x.sig) WHERE p.oid IS NULL OR md5(p.prosrc) <> x.want),
    'readers_ok', public._mcp_reader_ok('{SIG['_mcp_r_find_people']}'::regprocedure) AND public._mcp_reader_ok('{SIG['_mcp_r_list_todos']}'::regprocedure),
    'readers_api_grants', (SELECT count(*) FROM unnest(ARRAY[{arr(SIG[n] for n in READERS)}]) s, unnest(ARRAY['anon', 'authenticated', 'service_role']) r
        WHERE has_function_privilege(r, s::regprocedure, 'EXECUTE')),
    'readers_postgres', (SELECT bool_and(has_function_privilege('postgres', s::regprocedure, 'EXECUTE')) FROM unnest(ARRAY[{arr(SIG[n] for n in READERS)}]) s),
    'tools_other_grants', (SELECT count(*) FROM unnest(ARRAY[{arr(SIG[n] for n in ANON_NEW)}]) s, unnest(ARRAY['authenticated', 'service_role']) r
        WHERE has_function_privilege(r, s::regprocedure, 'EXECUTE')),
    'anon_mcp_17', {ANON_Q.format(names=arr(ANON_ALL))},
    'existing_functions_changed', {CHANGED.format(t='p4263p8_fn_before')},
    'functions_added', (SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C"), '{{}}') FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND NOT EXISTS (SELECT 1 FROM pg_temp.p4263p8_fn_before b WHERE b.sig = p.oid::regprocedure::text))
        = (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(ARRAY[{arr(SIG[n][len('public.'):] for n in NEW)}]::text[]) x),
    'tool_check', {TOOL_NAMES_Q.format(names=arr(TOOLS_BEFORE + ['find_people', 'list_todos']))},
    'outcome_check_unchanged', {OUTCOME_Q.format(t='p4263p8_check_before')},
    'check_count_unchanged', {CHECKS_Q.format(t='p4263p8_check_before')},
    'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')) INTO v;
  IF v -> 'bodies' <> '{{}}'::jsonb OR (v ->> 'readers_ok')::boolean IS NOT TRUE OR (v ->> 'readers_api_grants')::int <> 0
     OR (v ->> 'readers_postgres')::boolean IS NOT TRUE OR (v ->> 'tools_other_grants')::int <> 0 OR (v ->> 'anon_mcp_17')::boolean IS NOT TRUE
     OR (v ->> 'existing_functions_changed')::int <> 0 OR (v ->> 'functions_added')::boolean IS NOT TRUE OR (v ->> 'tool_check')::boolean IS NOT TRUE
     OR (v ->> 'outcome_check_unchanged')::boolean IS NOT TRUE OR (v ->> 'check_count_unchanged')::boolean IS NOT TRUE OR (v ->> 'ledger')::int <> 1 THEN
    RAISE EXCEPTION 'APPLY POST-CHECK {VERSION} FAILED, nothing applied: %', v;
  END IF;
  RAISE NOTICE 'APPLY POST-CHECK {VERSION} OK: %', v;
END
$post4263p8$;
"""
apply_head = f"""-- apply-{VERSION}.sql (generated by supabase/tests/backlog-4263-pr8/gen.py; do not hand-edit)
-- Migration: {MIG_PATH}  file md5 {mig_md5}
-- One transaction. If the apply tool writes the ledger row itself, remove the INSERT below.
-- The post-check RAISEs (rolling everything back) unless: the four new functions are at their md5; the two readers
-- are owned by mcp_reader, STABLE and SECURITY DEFINER, with EXECUTE for postgres and for no API role; the two tools
-- are callable by anon only; the anon-callable mcp functions are exactly the 17 named; every function in schema
-- public that existed before is unchanged (body md5, grants, settings, security definer, owner, volatility); the
-- only functions added are the four; the call-log tool CHECK holds exactly the 11 names; the outcome CHECK and the
-- number of CHECKs on mcp_call_log are unchanged; the ledger row.
-- The tool CHECK swap (last statement of the migration) takes an ACCESS EXCLUSIVE lock on mcp_call_log until commit.
CREATE TEMP TABLE p4263p8_fn_before ON COMMIT DROP AS
{SNAP};
CREATE TEMP TABLE p4263p8_check_before ON COMMIT DROP AS
  SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.contype = 'c';

"""
apply = apply_head + mig + post

# ------------------------------------------------------------------------------------------------ rollback
rollback = f"""-- rollback-{VERSION}.sql (generated by supabase/tests/backlog-4263-pr8/gen.py; do not hand-edit)
-- Undoes {MIG_PATH}. One transaction; RAISEs (nothing changed) unless the post-check holds.
-- Order: run this BEFORE any rollback of 20261118130000 (that rollback puts back a tool CHECK without these names).
-- Deleted first: the call log rows of find_people and list_todos (counted in the NOTICE; their audit record is lost)
-- and the find_people day counters. Then the four functions are dropped and the 9-name tool CHECK is put back (found
-- by the tool column; the outcome CHECK is not touched). That swap takes an ACCESS EXCLUSIVE lock on mcp_call_log
-- until commit, with lock_timeout 3s. Deploy order: the portal without the two tools first, then this file.
DO $pre4263p8r$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES {', '.join(f"('{SIG[n]}', '{NEW_MD5[n]}')" for n in NEW)}) x(sig, md5) LOOP
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'ROLLBACK {VERSION}: % is not at the body {VERSION} wrote (md5 %)', r.sig, coalesce(v_md5, 'missing'); END IF;
  END LOOP;
END
$pre4263p8r$;
CREATE TEMP TABLE p4263p8r_fn_before ON COMMIT DROP AS
{SNAP} AND p.oid::regprocedure::text NOT IN ({arr(SIG[n][len('public.'):] for n in NEW)});
CREATE TEMP TABLE p4263p8r_check_before ON COMMIT DROP AS
  SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.contype = 'c';
CREATE TEMP TABLE p4263p8r_counts ON COMMIT DROP AS SELECT
  (SELECT count(*) FROM public.mcp_call_log WHERE tool IN ('find_people', 'list_todos')) AS log_rows,
  (SELECT count(*) FROM public.mcp_rate_counters WHERE bucket LIKE 'find\\_people\\_user:%') AS counters;
DELETE FROM public.mcp_call_log WHERE tool IN ('find_people', 'list_todos');
DELETE FROM public.mcp_rate_counters WHERE bucket LIKE 'find\\_people\\_user:%';
DROP FUNCTION IF EXISTS public.mcp_find_people(text, bytea, text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.mcp_list_todos(text, bytea, text, text, text, text, text, boolean, boolean, text);
DROP FUNCTION IF EXISTS public._mcp_r_find_people(text, text, uuid, text, text, uuid);
DROP FUNCTION IF EXISTS public._mcp_r_list_todos(text, text, date, date, boolean, boolean, date, uuid);
SET LOCAL lock_timeout = '3s';
DO $chk4263p8r$
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
$chk4263p8r$;
ALTER TABLE public.mcp_call_log ADD CONSTRAINT mcp_call_log_tool_check
  CHECK (tool IS NULL OR tool IN ({arr(TOOLS_BEFORE)}));
DELETE FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}';

DO $post4263p8r$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'new_left', (SELECT count(*) FROM unnest(ARRAY[{arr(SIG[n] for n in NEW)}]) s WHERE to_regprocedure(s) IS NOT NULL),
    'anon_mcp_15', {ANON_Q.format(names=arr(ANON_OLD))},
    'other_functions_changed', {CHANGED.format(t='p4263p8r_fn_before')},
    'tool_check', {TOOL_NAMES_Q.format(names=arr(TOOLS_BEFORE))},
    'outcome_check_unchanged', {OUTCOME_Q.format(t='p4263p8r_check_before')},
    'check_count_unchanged', {CHECKS_Q.format(t='p4263p8r_check_before')},
    'log_rows_deleted', (SELECT log_rows FROM pg_temp.p4263p8r_counts),
    'day_counters_deleted', (SELECT counters FROM pg_temp.p4263p8r_counts),
    'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')) INTO v;
  IF (v ->> 'new_left')::int <> 0 OR (v ->> 'anon_mcp_15')::boolean IS NOT TRUE OR (v ->> 'other_functions_changed')::int <> 0
     OR (v ->> 'tool_check')::boolean IS NOT TRUE OR (v ->> 'outcome_check_unchanged')::boolean IS NOT TRUE
     OR (v ->> 'check_count_unchanged')::boolean IS NOT TRUE OR (v ->> 'ledger')::int <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK {VERSION} FAILED, nothing changed: %', v;
  END IF;
  RAISE NOTICE 'ROLLBACK POST-CHECK {VERSION} OK: %', v;
END
$post4263p8r$;
"""

# ------------------------------------------------------------------------------------------------ harness
def strip_temp_on_commit(s):
    return s.replace(' ON COMMIT DROP', '')


controls_sql = lib('controls.sql').replace('@@ANON_ALL@@', arr(ANON_ALL))
harness = f"""-- harness-8.sql (generated by supabase/tests/backlog-4263-pr8/gen.py; do not hand-edit)
-- BACKLOG-4263 PR-8: ONE call on the test project (~/.claude/bin/kt-sql harness-8.sql) that ends in RAISE, so nothing
-- persists. Order: helpers and fixtures (real producers) -> the apply file (migration + ledger + post-check) -> the
-- migration again (re-run) -> {len(CONTROLS)} controls -> {len(MUTS) + len(DDL_MUTS)} mutations, each proven installed before its
-- control runs -> real answers for the portal fixtures -> the rollback file and its post-check -> RAISE with every
-- result. Afterwards: ~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()". Only statuses, counts and
-- booleans are recorded, except the FX_ answers, which hold this file's invented fixture rows only.
{rd('supabase/tests/backlog-4263-pr5/lib/helpers-base.sql')}
{lib('fixtures.sql')}
-- ================================================================ apply
DO $t0$ BEGIN PERFORM pg_temp.rec('t_before_apply', to_jsonb(clock_timestamp())); PERFORM pg_temp.rec('migration_md5', to_jsonb('{mig_md5}'::text)); END $t0$;
{strip_temp_on_commit(apply)}
DO $t1$ BEGIN PERFORM pg_temp.rec('lock_timeout_after_apply', to_jsonb(current_setting('lock_timeout'))); PERFORM pg_temp.rec('t_after_apply', to_jsonb(clock_timestamp())); END $t1$;
-- ================================================================ re-run of the migration
{mig}
-- ================================================================ controls
{controls_sql}
DO $base$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY[{arr(CONTROLS)}] LOOP
    PERFORM pg_temp.rec('CTL_' || c, to_jsonb(pg_temp.iso(c)));
  END LOOP;
END
$base$;
DO $t2$ BEGIN PERFORM pg_temp.rec('t_after_controls', to_jsonb(clock_timestamp())); END $t2$;
-- ================================================================ mutations
{''.join(mut_sql)}
DO $t3$ BEGIN PERFORM pg_temp.rec('t_after_mutations', to_jsonb(clock_timestamp())); END $t3$;
-- ================================================================ real answers for the portal fixtures
{lib('observe.sql')}
-- ================================================================ rollback rehearsal
{strip_temp_on_commit(rollback)}
DO $after$
BEGIN
  PERFORM pg_temp.unrate();
  PERFORM pg_temp.rec('rb_get_deal_still_answers', to_jsonb(pg_temp.ws(pg_temp.w(pg_temp.q_gd(1, pg_temp.id('DA1'))))));
  PERFORM pg_temp.rec('rb_find_people_gone', to_jsonb(to_regprocedure('{SIG['mcp_find_people']}') IS NULL));
  PERFORM pg_temp.rec('t_end', to_jsonb(clock_timestamp()));
  RAISE EXCEPTION 'P8_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p8_out);
END
$after$;
"""

facts = {'migration': MIG_PATH, 'migration_md5': mig_md5,
         'new': {SIG[n]: NEW_MD5[n] for n in NEW},
         'anon_callable_mcp_after': ANON_ALL,
         'call_log_tools_after': TOOLS_BEFORE + ['find_people', 'list_todos'],
         'controls': CONTROLS, 'mutations': {**WANT},
         'apply_md5': md5(apply), 'rollback_md5': md5(rollback)}
outs = {f'apply-{VERSION}.sql': apply, f'rollback-{VERSION}.sql': rollback, 'harness-8.sql': harness,
        'catalog-facts.json': json.dumps(facts, indent=2) + '\n'}

if len(sys.argv) > 2 and sys.argv[1] in ('fixtures', 'report'):
    first = open(sys.argv[2]).read()
    raw = json.loads(first.splitlines()[0])['message'] if first.lstrip().startswith('{') else first
    res = json.loads(raw[raw.index('P8_RESULT ') + 10:raw.index('\nCONTEXT')])
    if sys.argv[1] == 'report':
        for k, v in sorted(res.items()):
            if k.startswith('FX_'):
                continue
            if k.startswith('MUT_'):
                ok = v.get('applied') is True and v.get('red') == (v.get('want') == 'red')
                print(('OK  ' if ok else 'BAD ') + k, json.dumps(v)[:600])
            elif k.startswith('CTL_'):
                print(('OK  ' if v == 'PASS' else 'BAD ') + k, json.dumps(v)[:900])
            else:
                print('    ' + k, json.dumps(v)[:400])
        sys.exit(0)
    fx = {k: v for k, v in sorted(res.items()) if k.startswith('FX_')}
    fx['_meta'] = {'migration_md5': res['migration_md5'], 'harness': 'supabase/tests/backlog-4263-pr8/harness-8.sql'}
    text = json.dumps(fx, indent=1, sort_keys=True, ensure_ascii=False)
    ids = sorted(set(re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', text)))
    for n, u in enumerate(ids, 1):
        text = text.replace(u, f'<id:{n}>')
    text = re.sub(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z', '2026-11-18T00:00:00.000000Z', text)
    out = os.path.join(REPO, 'broker-portal/__tests__/mcp/fixtures/read-tools-4263.json')
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
print('controls', len(CONTROLS), 'mutations', len(MUTS) + len(DDL_MUTS))
