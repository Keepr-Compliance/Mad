#!/usr/bin/env python3
"""BACKLOG-4263 list_deals address match: writes, from the migration:

  supabase/tests/backlog-4263-addr/apply-20261118160000.sql     migration verbatim + ledger row + post-check
  supabase/tests/backlog-4263-addr/rollback-20261118160000.sql  rollback (the body of 20261118110000) + its post-check
  supabase/tests/backlog-4263-addr/harness-addr.sql             ONE call: fixtures, controls on the live body, apply,
                                                                re-run, controls, old-vs-new comparison, timing,
                                                                mutations, rollback rehearsal; ends in RAISE
  supabase/tests/backlog-4263-addr/catalog-facts.json           md5 of the bodies and of the generated files

The migration's function statement must equal the statement of 20261118110000 with ONE predicate replaced (checked
here, and again by broker-portal/__tests__/migrations/mcp-list-deals-match-4263.test.ts).
Mutations are exact-string replacements: each must match once (else this script stops), and the harness proves in
the database that the mutated body is the one installed (md5) before its control runs.
`python3 gen.py check` regenerates in memory and fails if any written file differs.
`python3 gen.py report <kt-sql output>` prints the result of a harness run."""
import hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
VERSION, NAME = '20261118160000', 'backlog_4263_mcp_list_deals_match'
MIG_PATH = f'supabase/migrations/{VERSION}_{NAME}.sql'
CORE_PATH = 'supabase/migrations/20261118110000_backlog_4263_todo_server_core.sql'
rd = lambda p: open(os.path.join(REPO, p)).read()
md5 = lambda s: hashlib.md5(s.encode()).hexdigest()
mig = rd(MIG_PATH)
core = rd(CORE_PATH)
m4244 = rd('supabase/migrations/20261114110000_backlog_4244_mcp_data_tools.sql')
lib = lambda n: rd(f'supabase/tests/backlog-4263-addr/lib/{n}')

FN = '_mcp_r_list_deals'
SIG = 'public._mcp_r_list_deals(text,text,integer,timestamptz,uuid)'
OLD_PRED = "AND (p_q IS NULL OR dl.property_address ILIKE '%' ||"
NEW_PRED = "AND (p_q IS NULL OR public._mcp_clean(dl.property_address, 300) ILIKE '%' ||"
SHOWN = "'address', public._mcp_clean(pr.property_address, 300),"


def stmt(text, name, tag='fn'):
    m = [x.group(1) for x in re.finditer(r'(CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS \$' + tag + r'\$.*?\$' + tag + r'\$;\n(?:(?:REVOKE|GRANT)[^\n]*\n)*)', text, re.S)]
    assert len(m) == 1, (name, len(m))
    return m[0]


def body(s, tag='fn'):
    return re.search(r'AS \$' + tag + r'\$(.*?)\$' + tag + r'\$;', s, re.S).group(1)


def create_only(s, tag='fn'):
    return re.search(r'(CREATE OR REPLACE FUNCTION .*?\$' + tag + r'\$;)', s, re.S).group(1)


OLD_STMT = stmt(core, FN)
NEW_STMT = stmt(mig, FN)
assert OLD_STMT.count(OLD_PRED) == 1 and NEW_STMT == OLD_STMT.replace(OLD_PRED, NEW_PRED), 'the migration differs from 20261118110000 by more than the predicate'
assert body(NEW_STMT).count(SHOWN) == 1
assert mig.count('CREATE OR REPLACE FUNCTION') == 1 and not re.search(r'DROP |ALTER |CREATE TABLE|CREATE POLICY', mig)
OLD_MD5, NEW_MD5 = md5(body(OLD_STMT)), md5(body(NEW_STMT))
assert OLD_MD5 in mig and NEW_MD5 in mig, 'the md5s written in the migration are stale'
ANON_ALL = json.loads(rd('supabase/tests/backlog-4263-pr8/catalog-facts.json'))['anon_callable_mcp_after']
assert len(ANON_ALL) == 17
arr = lambda xs: ', '.join("'" + x.replace("'", "''") + "'" for x in xs)

# ------------------------------------------------------------------------------------------------ terms
EDGES = [298, 299, 300, 301, 302, 303, 338, 339, 340, 341, 342, 343]
TAGS = ['kq' + chr(97 + L % 26) + chr(97 + L // 26 % 26) for L in EDGES]
assert len(set(TAGS)) == len(TAGS)
TERMS = ['4111', '1111 1111', '4111-1111-1', '4111-1112', '987-65', '65-4321', '987-65-4', '41', '11', 'lot 4', 'invented rd', 'unit',
         'lot [', 'number hidden by keepr', 'hidden', '[number', 'by keepr] invented', 'zerowidth', 'zero', 'width lane', '50%', '0%', 'a_b',
         'axb', '_b', 'h\\s', '\\s', 'mixed case', 'MIXED CASE', 'fixture', 'xb', '%%', '__', 'midmarker', 'tailmarker', 'end end', 'y…',
         'yyy kq', 'edge'] + TAGS
assert all(2 <= len(t) <= 100 for t in TERMS)
A_LIVE = 11 + len(EDGES)

# ------------------------------------------------------------------------------------------------ mutations
NEW_CREATE = create_only(NEW_STMT)
TXT = create_only(stmt(m4244, '_mcp_txt'))
TXT_MUT = TXT.replace("p_max - 1) || '…' ELSE s.x END", "p_max - 1) || '…' ELSE s.x END ")
assert TXT_MUT != TXT
ESC = "replace(replace(replace(p_q, '\\', '\\\\'), '%', '\\%'), '_', '\\_')"
assert NEW_CREATE.count(ESC) == 1
MUTS = [  # (id, [(old, new)], control)
    ('M01_match_raw', [(NEW_PRED, OLD_PRED)], 'c_mask'),
    ('M01b_match_raw', [(NEW_PRED, OLD_PRED)], 'c_shown'),
    ('M02_match_uncut', [("public._mcp_clean(dl.property_address, 300) ILIKE", "public._mcp_clean(dl.property_address, 1000) ILIKE")], 'c_cut'),
    ('M02b_match_uncut', [("public._mcp_clean(dl.property_address, 300) ILIKE", "public._mcp_clean(dl.property_address, 1000) ILIKE")], 'c_shown'),
    ('M03_match_mask_only', [("public._mcp_clean(dl.property_address, 300) ILIKE", "public._mcp_mask(dl.property_address) ILIKE")], 'c_shown'),
    ('M03b_match_mask_only', [("public._mcp_clean(dl.property_address, 300) ILIKE", "public._mcp_mask(dl.property_address) ILIKE")], 'c_terms'),
    ('M04_no_escape', [(ESC, 'p_q')], 'c_terms'),
    ('M05_case_sensitive', [("300) ILIKE '%'", "300) LIKE '%'")], 'c_terms'),
    ('M06_page_short', [("       LIMIT p_limit + 1),", "       LIMIT p_limit),")], 'c_equal'),
    ('M07_order_id_asc', [("ORDER BY dl.last_synced_at DESC, dl.id DESC /*ORDER:list*/", "ORDER BY dl.last_synced_at DESC, dl.id ASC /*ORDER:list*/")], 'c_equal'),
    ('M08_cursor_inclusive', [("(dl.last_synced_at, dl.id) < (p_after_ts, p_after_id)", "(dl.last_synced_at, dl.id) <= (p_after_ts, p_after_id)")], 'c_filters'),
    ('M09_status_ignored', [("AND (p_status IS NULL OR dl.status = p_status)", "")], 'c_filters'),
]
DDL_MUTS = [  # (id, ddl, proof that it applied)
    ('M10_cat_other_function_changed', TXT_MUT, "md5((SELECT prosrc FROM pg_proc WHERE oid = 'public._mcp_txt(text,integer)'::regprocedure)) = '%s'" % md5(body(TXT_MUT))),
    ('M11_cat_function_added', "CREATE FUNCTION public._mcp_zz_added_4263() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
     "to_regprocedure('public._mcp_zz_added_4263()') IS NOT NULL"),
    ('M12_cat_reader_granted', 'SET ROLE mcp_reader; GRANT EXECUTE ON FUNCTION public._mcp_r_list_deals(text, text, integer, timestamptz, uuid) TO authenticated; RESET ROLE',
     f"has_function_privilege('authenticated', '{SIG}'::regprocedure, 'EXECUTE')"),
    ('M13_cat_reader_volatile', 'SET ROLE mcp_reader; ALTER FUNCTION public._mcp_r_list_deals(text, text, integer, timestamptz, uuid) VOLATILE; RESET ROLE',
     f"(SELECT provolatile = 'v' FROM pg_proc WHERE oid = '{SIG}'::regprocedure)"),
    ('M14_cat_anon_granted', 'GRANT EXECUTE ON FUNCTION public._mcp_clean(text, integer) TO anon',
     "has_function_privilege('anon', 'public._mcp_clean(text,integer)'::regprocedure, 'EXECUTE')"),
    ('M15_cat_other_function_cost', 'ALTER FUNCTION public._mcp_txt(text, integer) COST 7',
     "(SELECT procost = 7 FROM pg_proc WHERE oid = 'public._mcp_txt(text,integer)'::regprocedure)"),
]
CONTROLS = ['c_mask', 'c_shown', 'c_cut', 'c_terms', 'c_filters', 'c_catalog']
BASE_WANT = {'c_mask': 'red', 'c_shown': 'red', 'c_cut': 'red', 'c_terms': 'red', 'c_filters': 'green'}  # on the live body before the apply


def q(s, tag='$mutq$'):
    assert tag not in s
    return tag + s + tag


mut_sql, mut_report, WANT = [], [], {}
for mid, reps, ctl in MUTS:
    WANT[mid] = 'red'
    mc = NEW_CREATE
    for o_, n_ in reps:
        assert mc.count(o_) == 1, (mid, o_, mc.count(o_))
        mc = mc.replace(o_, n_)
    assert mc != NEW_CREATE, mid
    line = next((l for l in mc.splitlines() if reps[0][1] and reps[0][1].strip().splitlines()[0] in l), '(line removed)')
    mut_report.append(f'MUTATION APPLIED {mid}: {line.strip()[:150]}')
    run = "pg_temp.with_old('c_equal')" if ctl == 'c_equal' else f"pg_temp.iso('{ctl}')"
    mut_sql.append(f"""DO $m_{mid}$
DECLARE v text; ok boolean;
BEGIN
  BEGIN
    EXECUTE 'GRANT CREATE ON SCHEMA public TO mcp_reader';
    EXECUTE 'SET ROLE mcp_reader';
    EXECUTE {q(mc)};
    EXECUTE 'RESET ROLE';
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM mcp_reader';
    ok := (SELECT md5(p.prosrc) = '{md5(body(mc))}' FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG}'));
    v := {run};
    RAISE EXCEPTION USING ERRCODE = 'MX002';
  EXCEPTION WHEN SQLSTATE 'MX002' THEN NULL;
    WHEN OTHERS THEN v := 'MUTANT ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 300); ok := false;
  END;
  PERFORM pg_temp.rec('MUT_{mid}', jsonb_build_object('applied', ok, 'control', '{ctl}', 'want', 'red', 'red', left(v, 4) <> 'PASS', 'result', left(v, 400)));
END
$m_{mid}$;
""")
for mid, ddl, proof in DDL_MUTS:
    WANT[mid] = 'red'
    mut_report.append(f'MUTATION APPLIED {mid} (ddl): {ddl.strip().splitlines()[0][:150]}')
    mut_sql.append(f"""DO $m_{mid}$
DECLARE v text; ok boolean;
BEGIN
  BEGIN
    EXECUTE {q(ddl)};
    ok := {proof};
    v := pg_temp.iso('c_catalog');
    RAISE EXCEPTION USING ERRCODE = 'MX002';
  EXCEPTION WHEN SQLSTATE 'MX002' THEN NULL;
    WHEN OTHERS THEN v := 'MUTANT ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 300); ok := false;
  END;
  PERFORM pg_temp.rec('MUT_{mid}', jsonb_build_object('applied', ok, 'control', 'c_catalog', 'want', 'red', 'red', left(v, 4) <> 'PASS', 'result', left(v, 400)));
END
$m_{mid}$;
""")

# ------------------------------------------------------------------------------------------------ catalogue checks
SNAP = """  SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS src_md5, p.proacl::text AS acl, p.proconfig AS config, p.prosecdef AS secdef,
         p.proowner AS owner, p.provolatile AS vol, p.proisstrict AS strict, p.proleakproof AS leakproof, p.proparallel AS parallel,
         p.procost AS cost, p.prorows AS nrows
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace"""
SAME = """p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text = b.sig
                             AND p.proacl::text IS NOT DISTINCT FROM b.acl AND p.proconfig IS NOT DISTINCT FROM b.config
                             AND p.prosecdef = b.secdef AND p.proowner = b.owner AND p.provolatile = b.vol AND p.proisstrict = b.strict
                             AND p.proleakproof = b.leakproof AND p.proparallel = b.parallel AND p.procost = b.cost AND p.prorows = b.nrows"""
CHANGED = """(SELECT coalesce(array_agg(b.sig ORDER BY b.sig COLLATE "C"), '{{}}') FROM pg_temp.{t} b
         WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE """ + SAME + """ AND md5(p.prosrc) = b.src_md5))"""
ADDED = """(SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C"), '{{}}') FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND NOT EXISTS (SELECT 1 FROM pg_temp.{t} b WHERE b.sig = p.oid::regprocedure::text))"""
READER_SAME = """EXISTS (SELECT 1 FROM pg_temp.{t} b JOIN pg_proc p ON """ + SAME + """ WHERE b.sig = '""" + SIG + """'::regprocedure::text)"""
ANON_Q = """(SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C"), '{}') FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE'))
        = (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(ARRAY[""" + arr(ANON_ALL) + """]::text[]) x)"""
SHAPE = f"""(SELECT p.proowner = 'mcp_reader'::regrole::oid AND p.provolatile = 's' AND p.prosecdef AND array_to_string(p.proconfig, ',') = 'search_path=""'
          AND has_function_privilege('postgres', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = '{SIG}'::regprocedure)"""


def postcheck(tag, t, want_md5, ledger, label):
    return f"""DO ${tag}$
DECLARE v jsonb; v_want jsonb;
BEGIN
  SELECT jsonb_build_object(
    'reader_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = '{SIG}'::regprocedure),
    'reader_md5_before', (SELECT src_md5 FROM pg_temp.{t} WHERE sig = '{SIG}'::regprocedure::text),
    'changed', {CHANGED.format(t=t)},
    'reader_attributes_unchanged', {READER_SAME.format(t=t)},
    'reader_owner_stable_definer_path_grants', {SHAPE},
    'added', {ADDED.format(t=t)},
    'anon_mcp_17', {ANON_Q},
    'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')) INTO v;
  v_want := CASE WHEN v ->> 'reader_md5_before' = '{want_md5}' THEN '[]'::jsonb ELSE to_jsonb(ARRAY['{SIG}'::regprocedure::text]) END;
  IF v ->> 'reader_md5' IS DISTINCT FROM '{want_md5}'
     OR v -> 'changed' IS DISTINCT FROM v_want
     OR (v ->> 'reader_attributes_unchanged')::boolean IS NOT TRUE OR (v ->> 'reader_owner_stable_definer_path_grants')::boolean IS NOT TRUE
     OR v -> 'added' <> '[]'::jsonb OR (v ->> 'anon_mcp_17')::boolean IS NOT TRUE OR (v ->> 'ledger')::int <> {ledger} THEN
    RAISE EXCEPTION '{label} POST-CHECK {VERSION} FAILED, nothing applied: %', v;
  END IF;
  RAISE NOTICE '{label} POST-CHECK {VERSION} OK: %', v;
END
${tag}$;
"""


POST_APPLY = postcheck('postaddr', 'pa_fn_before', NEW_MD5, 1, 'APPLY')
apply = f"""-- apply-{VERSION}.sql (generated by supabase/tests/backlog-4263-addr/gen.py; do not hand-edit)
-- Migration: {MIG_PATH}  file md5 {md5(mig)}
-- One transaction. If the apply tool writes the ledger row itself, remove the INSERT below.
-- The post-check RAISEs (rolling everything back) unless: _mcp_r_list_deals is at md5 {NEW_MD5}; it is the only
-- function in schema public that changed (body md5, grants, settings, security definer, owner, volatility, strict,
-- leakproof, parallel, cost, rows), and only its body changed; it is owned by mcp_reader, STABLE, SECURITY DEFINER
-- with an empty search_path and EXECUTE for postgres and for no API role; no function was added or dropped; the
-- anon-callable mcp functions are exactly the 17 named; the ledger row.
CREATE TEMP TABLE pa_fn_before ON COMMIT DROP AS
{SNAP};

{mig}
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('{VERSION}', '{NAME}', ARRAY[]::text[]);

{POST_APPLY}"""

rollback = f"""-- rollback-{VERSION}.sql (generated by supabase/tests/backlog-4263-addr/gen.py; do not hand-edit)
-- Undoes {MIG_PATH}: puts back the body of _mcp_r_list_deals written by {CORE_PATH}
-- (md5 {OLD_MD5}) and removes the ledger row. One transaction; RAISEs (nothing changed) unless the post-check holds.
-- Order: run this BEFORE any rollback of 20261118110000 (supabase/tests/backlog-4263-pr2/rollback-4263.sql replaces
-- this function without checking its body).
DO $preaddrr$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG}');
  IF v_md5 IS DISTINCT FROM '{NEW_MD5}' THEN
    RAISE EXCEPTION 'ROLLBACK {VERSION}: _mcp_r_list_deals is not at the body {VERSION} wrote (md5 %)', coalesce(v_md5, 'missing');
  END IF;
END
$preaddrr$;
CREATE TEMP TABLE pa_rb_before ON COMMIT DROP AS
{SNAP};
GRANT CREATE ON SCHEMA public TO mcp_reader;
SET ROLE mcp_reader;

{OLD_STMT}
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM mcp_reader;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}';

{postcheck('postaddrr', 'pa_rb_before', OLD_MD5, 0, 'ROLLBACK')}"""

# ------------------------------------------------------------------------------------------------ harness
strip = lambda s: s.replace(' ON COMMIT DROP', '')
OLD_COPY = create_only(OLD_STMT).replace('CREATE OR REPLACE FUNCTION public._mcp_r_list_deals(', 'CREATE FUNCTION public._mcp_r_list_deals_x4263old(', 1)
assert body(OLD_COPY) == body(OLD_STMT)
controls_sql = (lib('controls.sql').replace('@@TERMS@@', arr(TERMS)).replace('@@A_LIVE@@', str(A_LIVE))
                .replace('@@POSTCHECK@@', q(strip(POST_APPLY), '$pcq$')).replace('@@OLDCOPY@@', q(OLD_COPY, '$ocq$')).replace('@@OLD_MD5@@', OLD_MD5))
assert '@@' not in controls_sql
harness = f"""-- harness-addr.sql (generated by supabase/tests/backlog-4263-addr/gen.py; do not hand-edit)
-- BACKLOG-4263 list_deals address match: ONE call on the test project (~/.claude/bin/kt-sql harness-addr.sql) that
-- ends in RAISE, so nothing persists. Order: helpers and fixtures -> controls on the live body (baseline) -> the
-- apply file (migration + ledger + post-check) -> the migration again (re-run) -> {len(CONTROLS)} controls -> the old body
-- under a temporary name: old-vs-new comparison, A's differences, timing at 1,000 deals -> {len(MUTS) + len(DDL_MUTS)} mutations, each proven
-- installed before its control runs -> the rollback file and its post-check -> RAISE with every result.
-- Afterwards: ~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()". Only statuses, counts, fixture
-- keys and timings are recorded.
{rd('supabase/tests/backlog-4263-pr5/lib/helpers-base.sql')}
{lib('fixtures.sql')}
{controls_sql}
DO $t0$
BEGIN
  PERFORM pg_temp.rec('t_start', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('reader_md5_before_apply', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{SIG}'::regprocedure)));
  PERFORM pg_temp.rec('reader_md5_expected_before', to_jsonb('{OLD_MD5}'::text));
  PERFORM pg_temp.rec('migration_md5', to_jsonb('{md5(mig)}'::text));
END $t0$;
-- ================================================================ baseline: the controls on the live body
DO $base0$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY[{arr(BASE_WANT)}] LOOP
    PERFORM pg_temp.rec('BASE_' || c, jsonb_build_object('result', left(pg_temp.iso(c), 400)));
  END LOOP;
END
$base0$;
-- ================================================================ apply
{strip(apply)}
DO $t1$ BEGIN PERFORM pg_temp.rec('t_after_apply', to_jsonb(clock_timestamp())); END $t1$;
-- ================================================================ re-run of the migration
{mig}
-- ================================================================ controls
DO $ctl$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY[{arr(CONTROLS)}] LOOP
    PERFORM pg_temp.rec('CTL_' || c, to_jsonb(pg_temp.iso(c)));
  END LOOP;
  PERFORM pg_temp.rec('t_after_controls', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('CTL_c_equal', to_jsonb(pg_temp.with_old('c_equal')));
  PERFORM pg_temp.rec('t_after_equal', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('REPORT_diff_a', pg_temp.j(pg_temp.with_old('diff_a')));
  PERFORM pg_temp.rec('REPORT_timing', pg_temp.j(pg_temp.with_old('timing')));
  PERFORM pg_temp.rec('t_after_timing', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('old_copy_gone', to_jsonb(to_regprocedure('public._mcp_r_list_deals_x4263old(text,text,integer,timestamptz,uuid)') IS NULL));
END
$ctl$;
-- ================================================================ mutations
{''.join(mut_sql)}
DO $t3$ BEGIN PERFORM pg_temp.rec('t_after_mutations', to_jsonb(clock_timestamp())); END $t3$;
-- ================================================================ rollback rehearsal
{strip(rollback)}
DO $after$
BEGIN
  PERFORM pg_temp.rec('rb_reader_md5', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{SIG}'::regprocedure)));
  PERFORM pg_temp.rec('rb_md5_equals_before_apply', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{SIG}'::regprocedure)
                                                             = (SELECT v #>> '{{}}' FROM pg_temp.pa_out WHERE k = 'reader_md5_before_apply')));
  PERFORM pg_temp.rec('rb_c_mask', jsonb_build_object('result', left(pg_temp.iso('c_mask'), 300)));
  PERFORM pg_temp.rec('t_end', to_jsonb(clock_timestamp()));
  RAISE EXCEPTION 'ADDR_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.pa_out);
END
$after$;
"""

facts = {'migration': MIG_PATH, 'migration_md5': md5(mig),
         'reader': SIG, 'reader_md5_before': OLD_MD5, 'reader_md5_after': NEW_MD5,
         'predicate_before': OLD_PRED, 'predicate_after': NEW_PRED,
         'anon_callable_mcp': ANON_ALL,
         'controls': CONTROLS + ['c_equal'], 'baseline_on_live_body': BASE_WANT, 'mutations': WANT,
         'apply_md5': md5(apply), 'rollback_md5': md5(rollback)}
outs = {f'apply-{VERSION}.sql': apply, f'rollback-{VERSION}.sql': rollback, 'harness-addr.sql': harness,
        'catalog-facts.json': json.dumps(facts, indent=2, ensure_ascii=False) + '\n'}

if len(sys.argv) > 2 and sys.argv[1] == 'report':
    first = open(sys.argv[2]).read()
    raw = json.loads(first.splitlines()[0])['message'] if first.lstrip().startswith('{') else first
    res = json.loads(raw[raw.index('ADDR_RESULT ') + 12:raw.index('\nCONTEXT')])
    for k, v in sorted(res.items()):
        if k.startswith('MUT_'):
            ok = v.get('applied') is True and v.get('red') is True
            print(('OK  ' if ok else 'BAD ') + k, json.dumps(v, ensure_ascii=False)[:600])
        elif k.startswith('CTL_'):
            print(('OK  ' if str(v).startswith('PASS') else 'BAD ') + k, json.dumps(v, ensure_ascii=False)[:1500])
        elif k.startswith('BASE_'):
            red = not v['result'].startswith('PASS')
            print(('OK  ' if red == (BASE_WANT[k[5:]] == 'red') else 'BAD ') + k, json.dumps(v, ensure_ascii=False)[:500])
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
print('old', OLD_MD5, 'new', NEW_MD5, 'controls', len(CONTROLS) + 1, 'mutations', len(MUTS) + len(DDL_MUTS))
