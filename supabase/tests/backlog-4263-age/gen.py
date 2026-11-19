#!/usr/bin/env python3
"""BACKLOG-4263 mcp_authorize_view returns the request's age: writes, from the migration:

  supabase/tests/backlog-4263-age/apply-20261118170000.sql     migration verbatim + ledger row + full-snapshot post-check
  supabase/tests/backlog-4263-age/rollback-20261118170000.sql  rollback (the statement of 20261118130000) + its post-check
  supabase/tests/backlog-4263-age/harness-age.sql              ONE call: fixtures, controls on the live body, apply,
                                                               re-run, controls, old-vs-new comparison, mutations,
                                                               rollback rehearsal; ends in RAISE
  supabase/tests/backlog-4263-age/catalog-facts.json           md5 of the bodies and of the generated files

The migration's function statement must equal the statement of 20261118130000 with ONE line added after the nonce
line (checked here, and again by broker-portal/__tests__/migrations/mcp-authorize-view-age-4263.test.ts).
Mutations are exact-string replacements: each must match once (else this script stops), and the harness proves in
the database that the mutated body is the one installed (md5) before its control runs.
`python3 gen.py check` regenerates in memory and fails if any written file differs.
`python3 gen.py report <kt-sql output>` prints the result of a harness run."""
import hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
VERSION, NAME = '20261118170000', 'backlog_4263_mcp_authorize_view_age'
MIG_PATH = f'supabase/migrations/{VERSION}_{NAME}.sql'
PREV_PATH = 'supabase/migrations/20261118130000_backlog_4263_mcp_todo_write_tools.sql'
rd = lambda p: open(os.path.join(REPO, p)).read()
md5 = lambda s: hashlib.md5(s.encode()).hexdigest()
mig = rd(MIG_PATH)
prev = rd(PREV_PATH)
lib = lambda n: rd(f'supabase/tests/backlog-4263-age/lib/{n}')

FN = 'mcp_authorize_view'
SIG = 'public.mcp_authorize_view(text,bytea)'
NONCE_LINE = "           'nonce', v_nonce,\n"
EXPR = 'greatest(0, floor(extract(epoch FROM now() - v_req.created_at)))::int'
AGE_LINE = f"           'age_seconds', {EXPR},\n"
ACL = '{postgres=X/postgres,authenticated=X/postgres}'


def stmt(text, name, tag='fn'):
    m = [x.group(1) for x in re.finditer(r'(CREATE OR REPLACE FUNCTION public\.' + re.escape(name) + r'\(.*?AS \$' + tag + r'\$.*?\$' + tag + r'\$;\n(?:(?:REVOKE|GRANT)[^\n]*\n)*)', text, re.S)]
    assert len(m) == 1, (name, len(m))
    return m[0]


def body(s, tag='fn'):
    return re.search(r'AS \$' + tag + r'\$(.*?)\$' + tag + r'\$;', s, re.S).group(1)


def create_only(s, tag='fn'):
    return re.search(r'(CREATE OR REPLACE FUNCTION .*?\$' + tag + r'\$;)', s, re.S).group(1)


OLD_STMT = stmt(prev, FN)
NEW_STMT = stmt(mig, FN)
assert OLD_STMT.count(NONCE_LINE) == 1 and NEW_STMT == OLD_STMT.replace(NONCE_LINE, NONCE_LINE + AGE_LINE), \
    'the migration differs from 20261118130000 by more than the age line'
assert 'clock_timestamp' not in mig
assert mig.count('CREATE OR REPLACE FUNCTION') == 1 and not re.search(r'DROP |ALTER |CREATE TABLE|CREATE POLICY|INSERT |UPDATE |DELETE ', mig.replace(NEW_STMT, ''))
assert NEW_STMT.endswith(f'REVOKE ALL ON FUNCTION public.mcp_authorize_view(text, bytea) FROM PUBLIC, anon, authenticated, service_role;\n'
                         f'GRANT EXECUTE ON FUNCTION public.mcp_authorize_view(text, bytea) TO authenticated;\n')
OLD_MD5, NEW_MD5 = md5(body(OLD_STMT)), md5(body(NEW_STMT))
assert OLD_MD5 == 'a9b5a3de003671600e0033d7d952d804', OLD_MD5  # matched on the test catalogue 2026-11-18
assert OLD_MD5 in mig and NEW_MD5 in mig, 'the md5s written in the migration are stale'
ANON_ALL = json.loads(rd('supabase/tests/backlog-4263-pr8/catalog-facts.json'))['anon_callable_mcp_after']
assert len(ANON_ALL) == 17 and not any(x.startswith('mcp_authorize_view(') for x in ANON_ALL)
arr = lambda xs: ', '.join("'" + x.replace("'", "''") + "'" for x in xs)

# ------------------------------------------------------------------------------------------------ mutations
NEW_CREATE = create_only(NEW_STMT)
REFUSE = "  IF v_req.id IS NULL THEN\n    RETURN public._mcp_refuse('request_invalid');"
MUTS = [  # (id, [(old, new)], control, want)
    ('M01_age_constant_0', [(EXPR, '0')], 'c_age', 'red'),
    ('M02_clock_timestamp', [('now() - v_req.created_at', 'clock_timestamp() - v_req.created_at')], 'c_age', 'red'),
    ('M03_key_renamed', [("'age_seconds',", "'started_seconds',")], 'c_age', 'red'),
    ('M04_value_text', [(EXPR, EXPR + '::text')], 'c_age', 'red'),
    ('M05_value_numeric_unfloored', [(EXPR, 'greatest(0, extract(epoch FROM now() - v_req.created_at))')], 'c_age', 'red'),
    ('M06_floor_removed_int_rounds', [(EXPR, 'greatest(0, extract(epoch FROM now() - v_req.created_at))::int')], 'c_age', 'red'),
    ('M07_int_cast_removed', [(EXPR, 'greatest(0, floor(extract(epoch FROM now() - v_req.created_at)))')], 'c_age', 'either'),
    ('M08_greatest_removed', [(EXPR, 'floor(extract(epoch FROM now() - v_req.created_at))::int')], 'c_future', 'red'),
    ('M09_age_on_refusal', [(REFUSE, REFUSE[:-1] + " || jsonb_build_object('age_seconds', 0);")], 'c_refusals', 'red'),
    ('M10_expiry_loosened', [('AND r.expires_at > now()', "AND r.expires_at > now() - interval '1 minute'")], 'c_refusals', 'red'),
    ('M11_replaces_flipped', [("'replaces_existing', EXISTS", "'replaces_existing', NOT EXISTS")], 'c_equal', 'red'),
    ('M12_scope_fixed', [("'scope', v_req.scope,", "'scope', 'mcp:read',")], 'c_equal', 'red'),
]
DDL_MUTS = [  # (id, ddl, proof that it applied, control)
    ('D01_view_anon_granted', 'GRANT EXECUTE ON FUNCTION public.mcp_authorize_view(text, bytea) TO anon',
     f"has_function_privilege('anon', '{SIG}'::regprocedure, 'EXECUTE')", 'c_grants'),
    ('D02_view_anon_granted', 'GRANT EXECUTE ON FUNCTION public.mcp_authorize_view(text, bytea) TO anon',
     f"has_function_privilege('anon', '{SIG}'::regprocedure, 'EXECUTE')", 'c_catalog'),
    ('D03_view_stable', 'ALTER FUNCTION public.mcp_authorize_view(text, bytea) STABLE',
     f"(SELECT provolatile = 's' FROM pg_proc WHERE oid = '{SIG}'::regprocedure)", 'c_catalog'),
    ('D04_other_function_cost', 'ALTER FUNCTION public._mcp_refuse(text) COST 7',
     "(SELECT procost = 7 FROM pg_proc WHERE oid = 'public._mcp_refuse(text)'::regprocedure)", 'c_catalog'),
    ('D05_function_added', "CREATE FUNCTION public._mcp_zz_added_4263age() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
     "to_regprocedure('public._mcp_zz_added_4263age()') IS NOT NULL", 'c_catalog'),
    ('D06_other_mcp_anon_granted', 'GRANT EXECUTE ON FUNCTION public._mcp_b64url(bytea) TO anon',
     "has_function_privilege('anon', 'public._mcp_b64url(bytea)'::regprocedure, 'EXECUTE')", 'c_catalog'),
]
CONTROLS = ['c_age', 'c_future', 'c_refusals', 'c_grants', 'c_equal', 'c_catalog']
BASE_WANT = {'c_age': 'red', 'c_future': 'red', 'c_refusals': 'green', 'c_grants': 'green'}  # on the live body before the apply


def q(s, tag='$mutq$'):
    assert tag not in s
    return tag + s + tag


def mut_block(mid, install, proof, ctl, want):
    return f"""DO $m_{mid}$
DECLARE v text; ok boolean;
BEGIN
  BEGIN
    EXECUTE {q(install)};
    ok := {proof};
    v := pg_temp.iso('{ctl}');
    RAISE EXCEPTION USING ERRCODE = 'MX002';
  EXCEPTION WHEN SQLSTATE 'MX002' THEN NULL;
    WHEN OTHERS THEN v := 'MUTANT ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 300); ok := false;
  END;
  PERFORM pg_temp.rec('MUT_{mid}', jsonb_build_object('applied', ok, 'control', '{ctl}', 'want', '{want}', 'red', left(v, 4) <> 'PASS', 'result', left(v, 500)));
END
$m_{mid}$;
"""


mut_sql, mut_report, WANT = [], [], {}
for mid, reps, ctl, want in MUTS:
    WANT[mid] = want
    mc = NEW_CREATE
    for o_, n_ in reps:
        assert mc.count(o_) == 1, (mid, o_, mc.count(o_))
        mc = mc.replace(o_, n_)
    assert mc != NEW_CREATE, mid
    line = ' / '.join(l.strip() for l in mc.splitlines() if l not in NEW_CREATE.splitlines())
    mut_report.append(f'MUTATION APPLIED {mid}: {line.strip()[:160]}')
    mut_sql.append(mut_block(mid, mc, f"(SELECT md5(p.prosrc) = '{md5(body(mc))}' FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG}'))", ctl, want))
for mid, ddl, proof, ctl in DDL_MUTS:
    WANT[mid] = 'red'
    mut_report.append(f'MUTATION APPLIED {mid} (ddl): {ddl[:160]}')
    mut_sql.append(mut_block(mid, ddl, proof, ctl, 'red'))

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
VIEW_SAME = """EXISTS (SELECT 1 FROM pg_temp.{t} b JOIN pg_proc p ON """ + SAME + """ WHERE b.sig = '""" + SIG + """'::regprocedure::text)"""
ANON_Q = """(SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C"), '{}') FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE'))
        = (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(ARRAY[""" + arr(ANON_ALL) + """]::text[]) x)"""
SHAPE = f"""(SELECT p.proowner = 'postgres'::regrole::oid AND p.provolatile = 'v' AND p.prosecdef AND array_to_string(p.proconfig, ',') = 'search_path=""'
          AND p.proacl::text = '{ACL}'
          AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = '{SIG}'::regprocedure)"""


def postcheck(tag, t, want_md5, ledger, label):
    return f"""DO ${tag}$
DECLARE v jsonb; v_want jsonb;
BEGIN
  SELECT jsonb_build_object(
    'view_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = '{SIG}'::regprocedure),
    'view_md5_before', (SELECT src_md5 FROM pg_temp.{t} WHERE sig = '{SIG}'::regprocedure::text),
    'changed', {CHANGED.format(t=t)},
    'view_attributes_unchanged', {VIEW_SAME.format(t=t)},
    'view_owner_volatile_definer_path_grants', {SHAPE},
    'added', {ADDED.format(t=t)},
    'anon_mcp_17', {ANON_Q},
    'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')) INTO v;
  v_want := CASE WHEN v ->> 'view_md5_before' = '{want_md5}' THEN '[]'::jsonb ELSE to_jsonb(ARRAY['{SIG}'::regprocedure::text]) END;
  IF v ->> 'view_md5' IS DISTINCT FROM '{want_md5}'
     OR v -> 'changed' IS DISTINCT FROM v_want
     OR (v ->> 'view_attributes_unchanged')::boolean IS NOT TRUE OR (v ->> 'view_owner_volatile_definer_path_grants')::boolean IS NOT TRUE
     OR v -> 'added' <> '[]'::jsonb OR (v ->> 'anon_mcp_17')::boolean IS NOT TRUE OR (v ->> 'ledger')::int <> {ledger} THEN
    RAISE EXCEPTION '{label} POST-CHECK {VERSION} FAILED, nothing applied: %', v;
  END IF;
  RAISE NOTICE '{label} POST-CHECK {VERSION} OK: %', v;
END
${tag}$;
"""


POST_APPLY = postcheck('postage', 'ag_fn_before', NEW_MD5, 1, 'APPLY')
apply = f"""-- apply-{VERSION}.sql (generated by supabase/tests/backlog-4263-age/gen.py; do not hand-edit)
-- Migration: {MIG_PATH}  file md5 {md5(mig)}
-- One transaction. If the apply tool writes the ledger row itself, remove the INSERT below.
-- The post-check RAISEs (rolling everything back) unless: mcp_authorize_view is at md5 {NEW_MD5}; it is the only
-- function in schema public that changed (body md5, grants, settings, security definer, owner, volatility, strict,
-- leakproof, parallel, cost, rows), and only its body changed; it is owned by postgres, VOLATILE, SECURITY DEFINER
-- with an empty search_path and ACL {ACL}; no function was added or dropped; the
-- anon-callable mcp functions are exactly the 17 named; the ledger row.
CREATE TEMP TABLE ag_fn_before ON COMMIT DROP AS
{SNAP};

{mig}
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('{VERSION}', '{NAME}', ARRAY[]::text[]);

{POST_APPLY}"""

rollback = f"""-- rollback-{VERSION}.sql (generated by supabase/tests/backlog-4263-age/gen.py; do not hand-edit)
-- Undoes {MIG_PATH}: puts back the statement of mcp_authorize_view written by {PREV_PATH}
-- (body md5 {OLD_MD5}, grants as that file states them) and removes the ledger row. One transaction; RAISEs (nothing
-- changed) unless the post-check holds. Order: the database first, then the portal (a portal with or without the
-- age line accepts the answer without age_seconds).
DO $preager$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('{SIG}');
  IF v_md5 IS DISTINCT FROM '{NEW_MD5}' THEN
    RAISE EXCEPTION 'ROLLBACK {VERSION}: mcp_authorize_view is not at the body {VERSION} wrote (md5 %)', coalesce(v_md5, 'missing');
  END IF;
END
$preager$;
CREATE TEMP TABLE ag_rb_before ON COMMIT DROP AS
{SNAP};

{OLD_STMT}
DELETE FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}';

{postcheck('postager', 'ag_rb_before', OLD_MD5, 0, 'ROLLBACK')}"""

# ------------------------------------------------------------------------------------------------ harness
strip = lambda s: s.replace(' ON COMMIT DROP', '')
OLD_COPY = create_only(OLD_STMT).replace('CREATE OR REPLACE FUNCTION public.mcp_authorize_view(', 'CREATE FUNCTION public.mcp_authorize_view_x4263age_old(', 1)
assert body(OLD_COPY) == body(OLD_STMT)
controls_sql = (lib('controls.sql').replace('@@POSTCHECK@@', q(strip(POST_APPLY), '$pcq$'))
                .replace('@@OLDCOPY@@', q(OLD_COPY, '$ocq$')).replace('@@OLD_MD5@@', OLD_MD5))
assert '@@' not in controls_sql
harness = f"""-- harness-age.sql (generated by supabase/tests/backlog-4263-age/gen.py; do not hand-edit)
-- BACKLOG-4263 mcp_authorize_view age: ONE call on the test project (~/.claude/bin/kt-sql harness-age.sql) that ends in
-- RAISE, so nothing persists. Order: helpers and fixtures -> a 1.2 s sleep (clock_timestamp() leaves now()) -> controls
-- on the live body (baseline) -> the apply file (migration + ledger + post-check) -> the migration again (re-run) ->
-- {len(CONTROLS)} controls (c_equal runs the old body under a temporary name) -> {len(MUTS) + len(DDL_MUTS)} mutations, each proven
-- installed before its control runs -> the rollback file and its post-check -> RAISE with every result.
-- Afterwards: ~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()". Only statuses, counts and
-- fixture results are recorded.
{lib('fixtures.sql')}
{controls_sql}
DO $t0$
BEGIN
  PERFORM pg_temp.rec('t_start', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('view_md5_before_apply', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{SIG}'::regprocedure)));
  PERFORM pg_temp.rec('view_md5_expected_before', to_jsonb('{OLD_MD5}'::text));
  PERFORM pg_temp.rec('migration_md5', to_jsonb('{md5(mig)}'::text));
  PERFORM pg_temp.rec('ledger_before', to_jsonb((SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')));
END $t0$;
-- ================================================================ baseline: the controls on the live body
DO $base0$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY[{arr(BASE_WANT)}] LOOP
    PERFORM pg_temp.rec('BASE_' || c, jsonb_build_object('result', left(pg_temp.iso(c), 500)));
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
  PERFORM pg_temp.rec('old_copy_gone', to_jsonb(to_regprocedure('public.mcp_authorize_view_x4263age_old(text,bytea)') IS NULL));
  PERFORM pg_temp.rec('t_after_controls', to_jsonb(clock_timestamp()));
END
$ctl$;
-- ================================================================ mutations
{''.join(mut_sql)}
DO $t3$ BEGIN PERFORM pg_temp.rec('t_after_mutations', to_jsonb(clock_timestamp())); END $t3$;
-- ================================================================ rollback rehearsal
{strip(rollback)}
DO $after$
BEGIN
  PERFORM pg_temp.rec('rb_view_md5', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{SIG}'::regprocedure)));
  PERFORM pg_temp.rec('rb_md5_equals_before_apply', to_jsonb((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{SIG}'::regprocedure)
                                                             = (SELECT v #>> '{{}}' FROM pg_temp.ag_out WHERE k = 'view_md5_before_apply')));
  PERFORM pg_temp.rec('rb_acl', to_jsonb((SELECT proacl::text FROM pg_proc WHERE oid = '{SIG}'::regprocedure)));
  PERFORM pg_temp.rec('rb_ledger', to_jsonb((SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')));
  PERFORM pg_temp.rec('rb_c_age', jsonb_build_object('result', left(pg_temp.iso('c_age'), 300)));
  PERFORM pg_temp.rec('rb_c_refusals', jsonb_build_object('result', left(pg_temp.iso('c_refusals'), 300)));
  PERFORM pg_temp.rec('now_unchanged_since_fixtures', to_jsonb(now() = (SELECT (v #>> '{{}}')::timestamptz FROM pg_temp.ag_out WHERE k = 'fx_now')));
  PERFORM pg_temp.rec('t_end', to_jsonb(clock_timestamp()));
  RAISE EXCEPTION 'AGE_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.ag_out);
END
$after$;
"""

facts = {'migration': MIG_PATH, 'migration_md5': md5(mig),
         'function': SIG, 'view_md5_before': OLD_MD5, 'view_md5_after': NEW_MD5,
         'line_added': AGE_LINE.strip(), 'acl': ACL,
         'anon_callable_mcp': ANON_ALL,
         'controls': CONTROLS, 'baseline_on_live_body': BASE_WANT, 'mutations': WANT,
         'apply_md5': md5(apply), 'rollback_md5': md5(rollback)}
outs = {f'apply-{VERSION}.sql': apply, f'rollback-{VERSION}.sql': rollback, 'harness-age.sql': harness,
        'catalog-facts.json': json.dumps(facts, indent=2, ensure_ascii=False) + '\n'}

if len(sys.argv) > 2 and sys.argv[1] == 'report':
    first = open(sys.argv[2]).read()
    raw = json.loads(first.splitlines()[0])['message'] if first.lstrip().startswith('{') else first
    res = json.loads(raw[raw.index('AGE_RESULT ') + 11:raw.index('\nCONTEXT')])
    for k, v in sorted(res.items()):
        if k.startswith('MUT_'):
            ok = v.get('applied') is True and (v.get('red') is True or v.get('want') == 'either')
            print(('OK  ' if ok else 'BAD ') + k, json.dumps(v, ensure_ascii=False)[:700])
        elif k.startswith('CTL_'):
            print(('OK  ' if str(v).startswith('PASS') else 'BAD ') + k, json.dumps(v, ensure_ascii=False)[:1500])
        elif k.startswith('BASE_'):
            red = not v['result'].startswith('PASS')
            print(('OK  ' if red == (BASE_WANT[k[5:]] == 'red') else 'BAD ') + k, json.dumps(v, ensure_ascii=False)[:500])
        else:
            print('    ' + k, json.dumps(v, ensure_ascii=False)[:1500])
    sys.exit(0)
if len(sys.argv) > 1 and sys.argv[1] == 'check':
    bad = [k for k, v in outs.items() if open(os.path.join(HERE, k)).read() != v]
    print('differs: ' + ', '.join(bad) if bad else 'all generated files match')
    sys.exit(1 if bad else 0)
for k, v in outs.items():
    open(os.path.join(HERE, k), 'w').write(v)
print('\n'.join(mut_report))
print(json.dumps({k: md5(v) for k, v in outs.items()}, indent=1))
print('old', OLD_MD5, 'new', NEW_MD5, 'controls', len(CONTROLS), 'mutations', len(MUTS) + len(DDL_MUTS))
