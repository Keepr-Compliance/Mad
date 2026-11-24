#!/usr/bin/env python3
"""BACKLOG-4266 (the AI-app connect notice is written with the exchange, or the exchange fails): writes, from the
migration supabase/migrations/20261123170000_backlog_4266_connect_notice_with_exchange.sql:

  apply-20261123170000.sql       the migration text unchanged, then its ledger row (one call)
  rollback-20261123170000.sql    lock_timeout first, pre-check, the 20261118180000 exchange statement byte-for-byte,
                                 ledger row removed, post-check
  harness-4266.sql               FULL call: guard, applied-state check, helpers and fixtures, apply, controls, mutants
                                 (each proven installed, fingerprint restored after each), negative control, the
                                 rollback file, checks after it, RAISE 'H4266_RESULT <json>'
  harness-4266-fixtures.sql      fixtures-only call: everything before the first control, then RAISE
  harness-4266-structure.sql     structure call: the full call's statements with one plain control, the negative
                                 control and one mutant
  catalog-facts.json             md5s of the bodies and of every generated file

The new exchange statement must equal the 20261118180000 statement with exactly the edits listed in EDITS (checked
here, and again by broker-portal/__tests__/migrations/connect-notice-with-exchange-4266.test.ts).
Mutations are exact-string replacements that must match once (else this script stops); the harness proves in the
database that each mutation is installed (md5 of the body, or a catalogue probe) before its controls run.

  python3 gen.py              write the files and print every mutation (MUTATION APPLIED <id> ...)
  python3 gen.py check        regenerate in memory; exit 1 if any written file differs
  python3 gen.py selftest     the reporters against synthetic outputs (no database)
  python3 gen.py report <out> [full|structure|fixtures]   read one call's kt-sql/nas-sql output
"""
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
REL = 'supabase/tests/backlog-4266'
VERSION, NAME = '20261123170000', 'backlog_4266_connect_notice_with_exchange'
MIG_PATH = f'supabase/migrations/{VERSION}_{NAME}.sql'
OLD_VERSION = '20261118180000'
OLD_PATH = f'supabase/migrations/{OLD_VERSION}_backlog_4263_ai_app_connect_notice.sql'
OLD_APPLY_PATH = f'supabase/tests/backlog-4263-notice/apply-{OLD_VERSION}.sql'
rd = lambda p: open(os.path.join(REPO, p), encoding='utf-8').read()
md5 = lambda s: hashlib.md5(s.encode('utf-8')).hexdigest()
MIG, OLD_MIG, OLD_APPLY = rd(MIG_PATH), rd(OLD_PATH), rd(OLD_APPLY_PATH)
LIB = {n: rd(f'{REL}/lib/{n}.sql') for n in ('helpers', 'fixtures', 'controls')}
SIG = 'public.mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)'
GUARD_B = "md5(u.id::text) = '53a385187695375e2e8695625a20a77a'"  # the reserved test account (same marker as backlog-4263-sync2-t)


def dq(s, tag):
    assert tag not in s, tag
    return tag + s + tag


def one(text, old, new, what):
    n = text.count(old)
    if n != 1:
        raise SystemExit(f'MUTATION NOT APPLIED {what}: fragment matched {n} times: {old[:120]!r}')
    return text.replace(old, new)


def body(s):
    return re.search(r'AS \$fn\$(.*?)\$fn\$;', s, re.S).group(1)


def create_only(s):
    return re.search(r'(CREATE OR REPLACE FUNCTION .*?\$fn\$;)', s, re.S).group(1)


# ------------------------------------------------------------------------------------------------ the two bodies
_m = [x.group(1) for x in re.finditer(r'(CREATE OR REPLACE FUNCTION public\.mcp_exchange_code\(.*?AS \$fn\$.*?\$fn\$;\n(?:(?:REVOKE|GRANT)[^\n]*\n)*)', OLD_MIG, re.S)]
assert len(_m) == 1
OLD_STMT = _m[0]
assert OLD_STMT.endswith('TO anon;\n'), OLD_STMT[-80:]
OLD_MD5 = md5(body(OLD_STMT))
assert OLD_MD5 == '9a33bff2db31288bd77a57489558a65b', OLD_MD5
OLD_BLOCK = ("  -- 4263 PR-10.7: one notice for the connection that just turned active, read later by the email job. In its own\n"
             "  -- block: any error here discards the notice only; the exchange and its answer are unchanged.\n"
             "  BEGIN\n"
             "    INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced)\n"
             "    SELECT c.user_id, c.provider, v_n > 0 FROM public.mcp_connections c WHERE c.id = v_code.connection_id;   /*NOTICE:exchange*/\n"
             "  EXCEPTION WHEN OTHERS THEN\n"
             "    NULL;\n"
             "  END;\n")
INSERT = ("  INSERT INTO public.ai_app_connect_notices (user_id, provider, replaced)\n"
          "  SELECT c.user_id, c.provider, v_n > 0 FROM public.mcp_connections c WHERE c.id = v_code.connection_id;   /*NOTICE:exchange*/\n")
COUNT = ("  GET DIAGNOSTICS v_k = ROW_COUNT;\n"
         "  IF v_k IS DISTINCT FROM 1 THEN   /*NOTICE:count*/\n"
         "    RAISE EXCEPTION USING ERRCODE = 'MC004', MESSAGE = 'mcp connect notice not written';\n"
         "  END IF;\n")
NEW_BLOCK = ("  -- 4266: one notice for the connection that just turned active, read later by the email job. Written in the same\n"
             "  -- transaction as the tokens; exactly one row or the exchange raises MC004 and nothing of it is kept.\n"
             + INSERT + COUNT)
EDITS = [('/*BODY:4263-10.7*/', '/*BODY:4266*/'), ('  v_scope  text;\n', '  v_scope  text;\n  v_k      integer;\n'), (OLD_BLOCK, NEW_BLOCK)]
NEW_STMT = OLD_STMT
for o_, n_ in EDITS:
    NEW_STMT = one(NEW_STMT, o_, n_, 'EDITS')
NEW_MD5 = md5(body(NEW_STMT))
assert MIG.count(NEW_STMT) == 1, 'the migration does not contain the derived exchange statement'
assert OLD_MD5 in MIG and NEW_MD5 in MIG, 'the md5s written in the migration are stale'
assert [m.group(1) for m in re.finditer(r'CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(', MIG)] == ['mcp_exchange_code']
assert MIG.split('\n-- ====')[0] and re.search(r"\A(?:--[^\n]*\n|\n)*SET LOCAL lock_timeout = '3s';\n", MIG), 'lock_timeout is not the first statement'
assert not re.search(r'DROP |CREATE TABLE|ALTER TABLE|CREATE POLICY|GRANT SELECT|GRANT INSERT|GRANT UPDATE|GRANT DELETE|GRANT ALL|TO PUBLIC|TO authenticated|TO service_role|cron\.|net\.|vault\.', MIG)
assert 'EXCEPTION WHEN OTHERS' not in body(NEW_STMT)
MIG_POST = re.search(r'(DO \$post4266\$.*?\$post4266\$;)', MIG, re.S).group(1)
NEW_CREATE, OLD_CREATE = create_only(NEW_STMT), create_only(OLD_STMT)

# ------------------------------------------------------------------------------------------------ apply and rollback
APPLY = f"""-- apply-{VERSION}.sql (generated by {REL}/gen.py; do not hand-edit)
-- Migration: {MIG_PATH}  file md5 {md5(MIG)}
-- One transaction: the migration text unchanged, then its ledger row. Send this file as one call. If the apply tool
-- writes the ledger row itself, remove the INSERT below.
-- Re-run: the migration text is re-runnable; the INSERT is not. When the ledger row already exists the INSERT fails
-- (duplicate version) and the whole call rolls back, so nothing changes.
-- Then run supabase/tests/backlog-4263-prod/postcheck-{VERSION}.sql (read-only; it requires this ledger row).

{MIG}
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('{VERSION}', '{NAME}', ARRAY[]::text[]);
"""

EX_FACTS = f"""(SELECT md5(p.prosrc) = '{{md5}}' AND p.prosecdef AND p.provolatile = 'v'
                        AND array_to_string(p.proconfig, ',') = 'search_path=""' AND p.proowner = 'postgres'::regrole::oid
                        AND (SELECT array_agg(DISTINCT a.grantee::regrole::text ORDER BY a.grantee::regrole::text) FROM aclexplode(p.proacl) a
                              WHERE a.privilege_type = 'EXECUTE') = ARRAY['anon', 'postgres']
                        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
                   FROM pg_catalog.pg_proc p WHERE p.oid = '{SIG}'::regprocedure)"""
ROLLBACK = f"""-- rollback-{VERSION}.sql (generated by {REL}/gen.py; do not hand-edit)
-- Undoes {MIG_PATH}: puts back the mcp_exchange_code statement of {OLD_PATH}
-- byte-for-byte (body md5 {OLD_MD5}; its REVOKE and GRANT as written there) and removes the ledger row. One
-- transaction; RAISEs (nothing changed) unless the pre-check and the post-check hold.
-- Order: run this BEFORE rollback-{OLD_VERSION}.sql (backlog-4263-notice), whose pre-check requires the exchange at md5
-- {OLD_MD5}.
-- Locks: CREATE OR REPLACE FUNCTION locks the function's pg_proc row; the DELETE locks one ledger row; both until commit.
-- lock_timeout 3s is set before the first statement.
SET LOCAL lock_timeout = '3s';
DO $pre4266r$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('{SIG}');
  IF v_md5 IS DISTINCT FROM '{NEW_MD5}' THEN
    RAISE EXCEPTION 'ROLLBACK {VERSION}: mcp_exchange_code is not at the body {VERSION} wrote (md5 %)', coalesce(v_md5, 'missing');
  END IF;
END
$pre4266r$;

{OLD_STMT}DELETE FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}';

DO $post4266r$
DECLARE v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'exchange', {EX_FACTS.format(md5=OLD_MD5)},
    'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')) INTO v;
  IF (v ->> 'exchange')::boolean IS NOT TRUE OR (v ->> 'ledger')::int IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK {VERSION} FAILED, nothing changed: %', v;
  END IF;
END
$post4266r$;
"""
assert ROLLBACK.count(OLD_STMT) == 1 and md5(body(OLD_STMT)) == OLD_MD5

# ------------------------------------------------------------------------------------------------ controls and mutants
CONTROLS = ['c_notice', 'c_none', 'c_fail_check', 'c_fail_deadlock', 'c_fail_lock', 'c_zero_row', 'c_catalogue', 'c_reruns', 'c_postcheck']
FAILS = ['c_fail_check', 'c_fail_deadlock', 'c_fail_lock', 'c_zero_row']


def wrap(handler):
    return NEW_BLOCK.replace(INSERT + COUNT, '  BEGIN\n' + ''.join('  ' + l + '\n' for l in (INSERT + COUNT).splitlines())
                             + '  EXCEPTION WHEN ' + handler + '\n  END;\n')


FN_MUTANTS = [  # (id, [(old, new)] on the new CREATE statement, primary controls) -- each primary must FAIL under it
    ('M01_swallow_restored', None, FAILS),
    ('M02_warning_then_continue', [(NEW_BLOCK, wrap("OTHERS THEN\n    RAISE WARNING 'connect notice not written: %', SQLSTATE;"))],
     ['c_fail_check', 'c_fail_deadlock', 'c_zero_row']),
    ('M03_reraised_as_mc001', [(NEW_BLOCK, wrap("OTHERS THEN\n    RAISE EXCEPTION USING ERRCODE = 'MC001', MESSAGE = 'mcp token insert failed';"))],
     ['c_fail_check', 'c_fail_deadlock', 'c_zero_row']),
    ('M04_no_row_count_check', [(COUNT, '')], ['c_zero_row']),
    ('M05_token_fail_answer', [(NEW_BLOCK, wrap("OTHERS THEN\n    RETURN public._mcp_token_fail(p_client_id, 'invalid_request');"))],
     ['c_fail_check', 'c_fail_deadlock', 'c_zero_row']),
    ('M06_handler_narrowed', [(NEW_BLOCK, wrap('integrity_constraint_violation THEN\n    NULL;'))], ['c_fail_check']),
    ('M07_count_only_above_one', [('  IF v_k IS DISTINCT FROM 1 THEN   /*NOTICE:count*/\n', '  IF v_k > 1 THEN   /*NOTICE:count*/\n')], ['c_zero_row']),
    ('M08_insert_twice', [(INSERT + COUNT, INSERT + COUNT + INSERT + COUNT)], ['c_notice']),
    ('M09_no_insert', [(INSERT + COUNT, '')], ['c_notice']),
    ('M10_replaced_always_false', [('SELECT c.user_id, c.provider, v_n > 0 FROM', 'SELECT c.user_id, c.provider, false FROM')], ['c_notice']),
]
EXQ = 'public.mcp_exchange_code(text, bytea, text, text, text, text, bytea, bytea)'
DDL_MUTANTS = [  # (id, sql, proof, primary controls)
    ('D01_granted_authenticated', f'GRANT EXECUTE ON FUNCTION {EXQ} TO authenticated',
     f"has_function_privilege('authenticated', '{SIG}'::regprocedure, 'EXECUTE')", ['c_catalogue']),
    ('D02_granted_public', f'GRANT EXECUTE ON FUNCTION {EXQ} TO PUBLIC',
     f"EXISTS (SELECT 1 FROM aclexplode((SELECT p.proacl FROM pg_catalog.pg_proc p WHERE p.oid = '{SIG}'::regprocedure)) a WHERE a.grantee = 0)", ['c_catalogue']),
    ('D03_anon_revoked', f'REVOKE EXECUTE ON FUNCTION {EXQ} FROM anon',
     f"NOT has_function_privilege('anon', '{SIG}'::regprocedure, 'EXECUTE')", ['c_catalogue']),
    ('D04_security_invoker', f'ALTER FUNCTION {EXQ} SECURITY INVOKER',
     f"(SELECT NOT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = '{SIG}'::regprocedure)", ['c_catalogue']),
    ('D05_search_path_public', f'ALTER FUNCTION {EXQ} SET search_path = public',
     f"(SELECT array_to_string(p.proconfig, ',')::text FROM pg_catalog.pg_proc p WHERE p.oid = '{SIG}'::regprocedure) = 'search_path=public'", ['c_catalogue']),
    ('D06_notices_force_rls', 'ALTER TABLE public.ai_app_connect_notices FORCE ROW LEVEL SECURITY',
     "(SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c WHERE c.oid = 'public.ai_app_connect_notices'::regclass)", ['c_catalogue']),
    ('D07_notices_trigger', 'CREATE TRIGGER h66_noop BEFORE INSERT ON public.ai_app_connect_notices FOR EACH ROW EXECUTE FUNCTION pg_temp.h66_noop()',
     "EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.ai_app_connect_notices'::regclass AND t.tgname::text = 'h66_noop')", ['c_catalogue']),
    ('D08_old_precheck_widened', "UPDATE pg_temp.t66_txt SET v = replace(v, $w$NOT IN ('ab6a9345c55ab69c77347d9b37e92e9d', '9a33bff2db31288bd77a57489558a65b')$w$, "
     f"$w$NOT IN ('ab6a9345c55ab69c77347d9b37e92e9d', '9a33bff2db31288bd77a57489558a65b', '{NEW_MD5}')$w$) WHERE k IN ('m{OLD_VERSION}', 'a{OLD_VERSION}')",
     f"(SELECT bool_and(position('{NEW_MD5}' IN v) > 0) FROM pg_temp.t66_txt WHERE k IN ('m{OLD_VERSION}', 'a{OLD_VERSION}'))", ['c_reruns']),
    ('D09_connections_provider_widened',
     "ALTER TABLE public.mcp_connections DROP CONSTRAINT mcp_connections_provider_check, "
     "ADD CONSTRAINT mcp_connections_provider_check CHECK (provider IN ('anthropic', 'openai', 'h66_other')) NOT VALID",
     "(SELECT pg_catalog.pg_get_constraintdef(k.oid)::text FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.mcp_connections'::regclass "
     "AND k.conname::text = 'mcp_connections_provider_check') LIKE '%h66_other%'", ['c_catalogue', 'c_postcheck']),
]
assert OLD_MIG.count("NOT IN ('ab6a9345c55ab69c77347d9b37e92e9d', '9a33bff2db31288bd77a57489558a65b')") == 1
assert OLD_APPLY.count("NOT IN ('ab6a9345c55ab69c77347d9b37e92e9d', '9a33bff2db31288bd77a57489558a65b')") == 1
NEG_MUTANTS = [('N01_noop_probe', 'SELECT 1', DDL_MUTANTS[0][2])]
NOT_APPLIED_ERROR = 'MUTATION NOT APPLIED IN DB'
WANT, PRIMARY, SHOW = {}, {}, []


def fn_mutant(i, mid, reps, prim):
    if reps is None:
        mu = OLD_CREATE
        SHOW.append(f'MUTATION APPLIED {mid} (the {OLD_VERSION} body, md5 {md5(body(mu))})')
    else:
        mu = NEW_CREATE
        for o_, n_ in reps:
            mu = one(mu, o_, n_, mid)
        removed = sum(1 for l in NEW_CREATE.splitlines() if l not in mu.splitlines())
        added = sum(1 for l in mu.splitlines() if l not in NEW_CREATE.splitlines())
        SHOW.append(f'MUTATION APPLIED {mid} (numstat +{added} -{removed}; mutated body md5 {md5(body(mu))})')
    assert mu != NEW_CREATE and md5(body(mu)) != NEW_MD5
    WANT[mid], PRIMARY[mid] = 'red', prim
    return mid, f"    EXECUTE {dq(mu, f'$mu{i}$')};\n", f"(SELECT md5(prosrc)::text FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('{SIG}')) = '{md5(body(mu))}'", prim


def ddl_mutant(i, mid, sql, proof, prim):
    SHOW.append(f'MUTATION APPLIED {mid} (ddl): {sql[:160]}')
    WANT[mid], PRIMARY[mid] = 'red', prim
    return mid, f"    EXECUTE {dq(sql, f'$mu{i}$')};\n", proof, prim


MUTS = [fn_mutant(i, *m) for i, m in enumerate(FN_MUTANTS)]
MUTS += [ddl_mutant(len(MUTS) + i, *m) for i, m in enumerate(DDL_MUTANTS)]
for k, (mid, sql, proof) in enumerate(NEG_MUTANTS):
    WANT[mid], PRIMARY[mid] = 'not_applied', []
    MUTS.append((mid, f"    EXECUTE {dq(sql, f'$neg{k}$')};\n", proof, []))
    SHOW.append(f'NEGATIVE CONTROL {mid}: applies {sql!r}; must record applied=false, error {NOT_APPLIED_ERROR!r}')
assert len({m[0] for m in MUTS}) == len(MUTS)
for m in MUTS:
    assert all(c in CONTROLS for c in m[3])


def run_controls(names, var):
    return ''.join(f"""    BEGIN
      res := pg_temp.{c}();
      RAISE EXCEPTION 'undo-case';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'undo-case' THEN res := 'ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 400); END IF;
    END;
    {var} := {var} || jsonb_build_object('{c}', res);
""" for c in names)


def mut_block(mid, apply_, proof, prim):
    return f"""  -- {mid}
  BEGIN
    o := '{{}}';
    applied := NULL;
{apply_}    applied := {proof};
    IF applied IS NOT TRUE THEN RAISE EXCEPTION '{NOT_APPLIED_ERROR}'; END IF;
{run_controls(prim, 'o')}    RAISE EXCEPTION 'undo-mutant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'undo-mutant' THEN o := o || jsonb_build_object('error', SQLERRM); END IF;
  END;
  PERFORM pg_temp.rec('mutant:{mid}', o || jsonb_build_object('applied', applied, 'want', '{WANT[mid]}'));
  IF pg_temp.fingerprint() IS DISTINCT FROM (SELECT v #>> '{{}}' FROM pg_temp.t66_out WHERE k = 'baseline_fp') THEN
    RAISE EXCEPTION 'MUTANT NOT RESTORED {mid}';
  END IF;
"""


FINGERPRINT = f"""-- catalogue fingerprint of what the mutants change: the exchange (body md5, ACL, volatility, security definer, owner,
-- settings), the notice table (owner, ACL, RLS, FORCE RLS), its constraint names, the non-internal triggers on it and on
-- mcp_connections, and the stored migration texts. Every operand is cast to text explicitly; ACL items are sorted; a
-- NULL ACL reads 'acl:default'.
CREATE FUNCTION pg_temp.fingerprint() RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT md5(concat_ws('|',
    (SELECT concat_ws(':', p.oid::regprocedure::text, md5(p.prosrc)::text,
                      CASE WHEN p.proacl IS NULL THEN 'acl:default' ELSE (SELECT string_agg(x.item::text, ',' ORDER BY x.item::text) FROM unnest(p.proacl) AS x(item)) END,
                      p.provolatile::text, p.prosecdef::text, pg_catalog.pg_get_userbyid(p.proowner)::text, coalesce(array_to_string(p.proconfig, ','), '')::text)
       FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('{SIG}')),
    (SELECT concat_ws(':', pg_catalog.pg_get_userbyid(c.relowner)::text,
                      CASE WHEN c.relacl IS NULL THEN 'acl:default' ELSE (SELECT string_agg(x.item::text, ',' ORDER BY x.item::text) FROM unnest(c.relacl) AS x(item)) END,
                      c.relrowsecurity::text, c.relforcerowsecurity::text)
       FROM pg_catalog.pg_class c WHERE c.oid = 'public.ai_app_connect_notices'::regclass),
    (SELECT string_agg(k.conname::text, ',' ORDER BY k.conname::text) FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.ai_app_connect_notices'::regclass),
    (SELECT coalesce(string_agg(t.tgrelid::regclass::text || '.' || t.tgname::text, ',' ORDER BY t.tgrelid::regclass::text, t.tgname::text), '')
       FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN ('public.ai_app_connect_notices'::regclass, 'public.mcp_connections'::regclass) AND NOT t.tgisinternal),
    (SELECT string_agg(x.k || '=' || md5(x.v), ',' ORDER BY x.k) FROM pg_temp.t66_txt x)))
$h$;
"""

FN_SNAP = """  SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc)::text AS src_md5, p.proacl::text AS acl, coalesce(array_to_string(p.proconfig, ','), '')::text AS config,
         p.prosecdef AS secdef, pg_catalog.pg_get_userbyid(p.proowner)::text AS owner, p.provolatile::text AS vol
    FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace"""
LEDGER = f"(SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')"
POSTCHECK_PATH = f'supabase/tests/backlog-4263-prod/postcheck-{VERSION}.sql'
POSTCHECK = rd(POSTCHECK_PATH)
assert "provider CHECK of ai_app_connect_notices = mcp_connections" in POSTCHECK, 'the prod post-check does not pin the provider CHECK parity'
_pc_sql = re.sub(r'(?m)^--[^\n]*\n', '', POSTCHECK).strip().rstrip(';')
CONTROLS_SQL = (LIB['controls'].replace('@@MIGPOST@@', dq(MIG_POST, '$mpq$')).replace('@@NEW_MD5@@', NEW_MD5)
                .replace('@@POSTCHECK@@', dq(_pc_sql, '$pcq$')))
assert '@@' not in CONTROLS_SQL
TXT = f"""CREATE TEMP TABLE t66_txt (k text PRIMARY KEY, v text NOT NULL);
INSERT INTO pg_temp.t66_txt VALUES ('m{VERSION}', {dq(MIG, '$t1$')}), ('m{OLD_VERSION}', {dq(OLD_MIG, '$t2$')}), ('a{OLD_VERSION}', {dq(OLD_APPLY, '$t3$')});
"""
HEAD = f"""-- harness-4266.sql (generated by {REL}/gen.py; do not hand-edit)
-- TEST DATABASE ONLY. This file ends in a rollback and must never be run on production.
-- BACKLOG-4266: run on a database where 20261123140000 is applied and {VERSION} is NOT (mcp_exchange_code at md5
-- {OLD_MD5}). ONE call that ends in RAISE, so nothing persists. Order: guard (refuses any database that is not the
-- test database) -> state check -> helpers and fixtures -> the apply file (migration + ledger row) and a catalogue
-- diff -> {len(CONTROLS)} controls, each in a subtransaction that is undone -> {len(MUTS) - len(NEG_MUTANTS)} mutants and
-- {len(NEG_MUTANTS)} negative control, each proven installed before its primary controls run under it, the
-- fingerprint compared after each -> the rollback file and checks after it -> RAISE 'H4266_RESULT <json>'.
-- Afterwards: select extensions.pg_stat_statements_reset(). Records statuses, counts, fixture keys and md5s only.
-- Locks (all released by the final RAISE; lock_timeout 3s throughout): row locks on the fixture rows it writes
--   (three invented auth.users rows and their mcp_* rows, one mcp_oauth_clients row) and on the ONE mcp_settings row
--   until the call ends (a portal-secret change waits); the pg_proc row of mcp_exchange_code (CREATE OR REPLACE) until
--   the call ends; inside each control or mutant only, ACCESS EXCLUSIVE / SHARE ROW EXCLUSIVE on
--   ai_app_connect_notices (ADD CONSTRAINT, CREATE TRIGGER), released when that subtransaction is undone.
-- statement_timeout 240s.
DO $guard4266$
DECLARE n bigint := 0;
BEGIN
  IF pg_catalog.to_regclass('public.pm_backlog_items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.pm_backlog_items' INTO n;
  END IF;
  IF n > 100 OR coalesce((SELECT s.n_live_tup FROM pg_catalog.pg_stat_user_tables s WHERE s.relid = pg_catalog.to_regclass('public.pm_backlog_items')), 0) > 100 THEN
    RAISE EXCEPTION 'harness-4266 refuses to run: TEST DATABASE ONLY (production tracker rows present)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE {GUARD_B}) THEN
    RAISE EXCEPTION 'harness-4266 refuses to run: TEST DATABASE ONLY (test database marker absent)';
  END IF;
END
$guard4266$;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '240s';
DO $state4266$
BEGIN
  IF (SELECT md5(prosrc)::text FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('{SIG}')) IS DISTINCT FROM '{OLD_MD5}'
     OR {LEDGER} <> 0
     OR NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261123140000') THEN
    RAISE EXCEPTION 'harness-4266: the database is not at the state this harness needs (exchange md5 %, ledger {VERSION} %)',
      (SELECT md5(prosrc)::text FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('{SIG}')), {LEDGER};
  END IF;
END
$state4266$;
DO $t0_4266$ BEGIN CREATE TEMP TABLE t66_t0 AS SELECT clock_timestamp() AS t; END $t0_4266$;
{LIB['helpers']}
DO $t1_4266$ BEGIN PERFORM pg_temp.rec('t_fixture_start', to_jsonb((SELECT t FROM pg_temp.t66_t0))); END $t1_4266$;
{LIB['fixtures']}
{TXT}"""
FIXTURE_END = """DO $fxend4266$
BEGIN
  PERFORM pg_temp.rec('t_fixture_end', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('fx_exchange_md5', to_jsonb((SELECT md5(prosrc)::text FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('""" + SIG + """'))));
  PERFORM pg_temp.rec('fx_texts', to_jsonb((SELECT count(*) FROM pg_temp.t66_txt)));
END
$fxend4266$;
"""
APPLY_STEP = f"""-- ================================================================ apply (the apply file, verbatim)
CREATE TEMP TABLE t66_fn_before AS
{FN_SNAP};
{APPLY}DO $applied4266$
BEGIN
  PERFORM pg_temp.rec('t_applied', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('apply', jsonb_build_object(
    'exchange_md5', (SELECT md5(prosrc)::text FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('{SIG}')),
    'changed', (SELECT coalesce(jsonb_agg(b.sig ORDER BY b.sig), '[]') FROM pg_temp.t66_fn_before b
                 WHERE NOT EXISTS (SELECT 1 FROM ({FN_SNAP}) a WHERE a.sig = b.sig AND a.src_md5 = b.src_md5 AND a.acl IS NOT DISTINCT FROM b.acl
                                     AND a.config = b.config AND a.secdef = b.secdef AND a.owner = b.owner AND a.vol = b.vol)),
    'added', (SELECT coalesce(jsonb_agg(a.sig ORDER BY a.sig), '[]') FROM ({FN_SNAP}) a WHERE NOT EXISTS (SELECT 1 FROM pg_temp.t66_fn_before b WHERE b.sig = a.sig)),
    'attrs_except_body_same', (SELECT a.acl IS NOT DISTINCT FROM b.acl AND a.config = b.config AND a.secdef = b.secdef AND a.owner = b.owner AND a.vol = b.vol
                                 FROM ({FN_SNAP}) a JOIN pg_temp.t66_fn_before b ON b.sig = a.sig WHERE a.sig = '{SIG}'::regprocedure::text),
    'ledger', {LEDGER}));
END
$applied4266$;
"""
CONTROLS_BLOCK = f"""DO $controls4266$
DECLARE res text; base jsonb := '{{}}'; o jsonb; applied boolean;
BEGIN
  PERFORM pg_temp.rec('t_start', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('baseline_fp', to_jsonb(pg_temp.fingerprint()));
  PERFORM pg_temp.rec('mode', to_jsonb('@@MODE@@'::text));
@@PLAIN@@  PERFORM pg_temp.rec('t_controls_end', to_jsonb(clock_timestamp()));
@@MUTANTS@@  PERFORM pg_temp.rec('fp_end', to_jsonb(pg_temp.fingerprint()));
  PERFORM pg_temp.rec('t_mutants_end', to_jsonb(clock_timestamp()));
END
$controls4266$;
"""
AFTER = f"""-- ================================================================ the rollback file, verbatim, then checks after it
DO $rb4266$
BEGIN
  BEGIN
    EXECUTE {dq(ROLLBACK, '$rbq$')};
    PERFORM pg_temp.rec('rollback', to_jsonb('ok'::text));
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.rec('rollback', to_jsonb('ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 900)));
  END;
END
$rb4266$;
DO $after4266$
DECLARE x_c jsonb; x_e jsonb; x_f jsonb;
BEGIN
  PERFORM pg_temp.rec('rb_state', jsonb_build_object(
    'exchange_md5', (SELECT md5(prosrc)::text FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('{SIG}')),
    'same_as_before_apply', (SELECT a.src_md5 = b.src_md5 AND a.acl IS NOT DISTINCT FROM b.acl AND a.config = b.config AND a.secdef = b.secdef
                                    AND a.owner = b.owner AND a.vol = b.vol
                               FROM ({FN_SNAP}) a JOIN pg_temp.t66_fn_before b ON b.sig = a.sig WHERE a.sig = '{SIG}'::regprocedure::text),
    'ledger', {LEDGER}));
  x_c := pg_temp.consent('n-rb', pg_temp.id('C'), 'anthropic');
  x_e := pg_temp.w(pg_temp.q_ex('n-rb', 'anthropic', 301));
  x_f := pg_temp.effects(pg_temp.id('C'));
  PERFORM pg_temp.rec('rb_exchange', jsonb_build_object('consent', pg_temp.consented(x_c), 'answer_ok', x_e = pg_temp.ok_answer(),
                                                        'notices', x_f -> 'notices'));
  PERFORM pg_temp.rec('t_end', to_jsonb(clock_timestamp()));
  RAISE EXCEPTION 'H4266_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.t66_out);
END
$after4266$;
"""


def harness(mode):
    plain = run_controls(CONTROLS if mode == 'full' else ['c_notice'], 'base') + "  PERFORM pg_temp.rec('controls', base);\n"
    muts = MUTS if mode == 'full' else [m for m in MUTS if m[0] in ('M01_swallow_restored', 'N01_noop_probe')]
    cb = CONTROLS_BLOCK.replace('@@MODE@@', mode).replace('@@PLAIN@@', plain).replace('@@MUTANTS@@', ''.join(mut_block(*m) for m in muts))
    if mode == 'structure':
        cb = cb.replace("  PERFORM pg_temp.rec('fp_end',", "  PERFORM pg_temp.rec('fingerprints', jsonb_build_object('first', (SELECT v #>> '{}' FROM pg_temp.t66_out WHERE k = 'baseline_fp'), 'second', pg_temp.fingerprint()));\n  PERFORM pg_temp.rec('fp_end',")
    name = {'full': 'harness-4266.sql', 'structure': 'harness-4266-structure.sql'}[mode]
    return (HEAD.replace('harness-4266.sql (generated', f'{name} (generated') + FIXTURE_END + APPLY_STEP + CONTROLS_SQL + FINGERPRINT + cb + AFTER)


HARNESS = harness('full')
HARNESS_STRUCTURE = harness('structure')
HARNESS_FIXTURES = (HEAD.replace('harness-4266.sql (generated', 'harness-4266-fixtures.sql (generated') + FIXTURE_END
                    + """DO $fxraise4266$
BEGIN
  RAISE EXCEPTION 'H4266_FIXTURES %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.t66_out);
END
$fxraise4266$;
""")
for h in (HARNESS, HARNESS_STRUCTURE):
    assert h.count(APPLY) == 1 and h.count("rec('baseline_fp', to_jsonb(pg_temp.fingerprint()))") == 1
    assert h.count('MUTANT NOT RESTORED') == h.count("pg_temp.rec('mutant:")
assert HARNESS.count("pg_temp.rec('mutant:") == len(MUTS)
for _h in (HARNESS, HARNESS_STRUCTURE, HARNESS_FIXTURES):
    assert _h.count(GUARD_B) == 1

FACTS = {'migration': MIG_PATH, 'migration_md5': md5(MIG), 'exchange': SIG, 'exchange_md5_before': OLD_MD5, 'exchange_md5_after': NEW_MD5,
         'controls': CONTROLS, 'mutants': {m[0]: {'want': WANT[m[0]], 'primary': PRIMARY[m[0]]} for m in MUTS},
         'apply_md5': md5(APPLY), 'rollback_md5': md5(ROLLBACK)}
OUTS = {f'apply-{VERSION}.sql': APPLY, f'rollback-{VERSION}.sql': ROLLBACK, 'harness-4266.sql': HARNESS,
        'harness-4266-structure.sql': HARNESS_STRUCTURE, 'harness-4266-fixtures.sql': HARNESS_FIXTURES}
FACTS['files'] = {k: md5(v) for k, v in OUTS.items()}
OUTS['catalog-facts.json'] = json.dumps(FACTS, indent=2) + '\n'


# ------------------------------------------------------------------------------------------------ reporters
def unwrap(raw, marker):
    """the JSON object after `marker` in a kt-sql/nas-sql error envelope; None when the shape is not one RAISE"""
    lines = [l for l in raw.splitlines() if l.strip()]
    if not lines or lines[-1].strip() != 'kt-sql: HTTP 400' or sum(1 for l in lines if l.startswith('kt-sql: HTTP')) != 1:
        return None, 'transport: the call did not end in exactly one kt-sql: HTTP 400 line'
    env = next((l for l in lines if l.lstrip().startswith('{')), None)
    try:
        msg = json.loads(env)['message']
    except Exception:
        return None, 'transport: no JSON error envelope'
    i = msg.find(marker + ' ')
    if i < 0 or 'P0001' not in msg[:i]:
        return None, f'transport: {marker} not found (first 300 chars: {msg[:300]!r})'
    j = msg.find('\nCONTEXT', i)
    try:
        return json.loads(msg[i + len(marker) + 1:j if j > 0 else len(msg)].strip()), None
    except Exception as e:
        return None, f'transport: result not JSON ({e})'


def ms(res, a, b):
    from datetime import datetime
    try:
        # PostgreSQL drops trailing zeros of the fraction; pad it to 6 digits for fromisoformat
        f = lambda k: datetime.fromisoformat(re.sub(r'\.(\d{1,6})', lambda m: '.' + m.group(1).ljust(6, '0'), str(res[k]).replace('Z', '+00:00'), count=1))
        return int((f(b) - f(a)).total_seconds() * 1000)
    except Exception:
        return None


def report(raw, mode='full'):
    res, err = unwrap(raw, 'H4266_RESULT')
    if err:
        return [err, 'NOT OK'], 1
    out, bad = [], 0
    ap = res.get('apply') or {}
    ap_ok = ap == {'exchange_md5': NEW_MD5, 'changed': ['mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)'], 'added': [],
                   'attrs_except_body_same': True, 'ledger': 1}
    out.append(f"{'OK  ' if ap_ok else 'BAD '} apply {json.dumps(ap)[:400]}")
    bad += 0 if ap_ok else 1
    if res.get('mode') != mode:
        out.append(f'BAD  mode {res.get("mode")!r}, expected {mode!r}')
        bad += 1
    ctl = res.get('controls') or {}
    names = CONTROLS if mode == 'full' else ['c_notice']
    for c in names:
        v = ctl.get(c)
        ok = v == 'PASS'
        bad += 0 if ok else 1
        out.append(f"{'PASS' if ok else 'BAD '} control {c}: {str(v)[:900]}")
    muts = MUTS if mode == 'full' else [m for m in MUTS if m[0] in ('M01_swallow_restored', 'N01_noop_probe')]
    n_mut = n_neg = 0
    for mid, _a, _p, prim in muts:
        o = res.get(f'mutant:{mid}')
        if WANT[mid] == 'not_applied':
            n_neg += 1
            good = isinstance(o, dict) and o.get('applied') is False and o.get('error') == NOT_APPLIED_ERROR
            out.append(f"{'NEG_OK' if good else 'NEG_FAILED'} {mid} -> {json.dumps(o)[:300]}")
            bad += 0 if good else 1
            continue
        n_mut += 1
        if not isinstance(o, dict) or o.get('applied') is not True or 'error' in o:
            tag = 'NOT_APPLIED' if not isinstance(o, dict) or o.get('applied') is not True else 'CRASH'
            out.append(f'{tag} {mid} -> {json.dumps(o)[:400]}')
            bad += 1
            continue
        states = {c: str(o.get(c)) for c in prim}
        errs = [c for c, v in states.items() if v.startswith('ERROR')]
        fails = [c for c, v in states.items() if v.startswith('FAIL')]
        if errs or len(fails) != len(prim):
            out.append(f"NOT_CAUGHT {mid}: every primary must FAIL (not ERROR, not PASS): {json.dumps(states)[:600]}")
            bad += 1
        else:
            out.append(f"CAUGHT {mid} by FAIL in {', '.join(prim)}")
    if res.get('fp_end') != res.get('baseline_fp'):
        out.append('BAD  fingerprint at the end differs from the baseline')
        bad += 1
    if mode == 'structure':
        fp = res.get('fingerprints') or {}
        if not fp.get('first') or fp.get('first') != fp.get('second'):
            out.append(f'BAD  fingerprints {fp}')
            bad += 1
    rb = res.get('rollback')
    st = res.get('rb_state') or {}
    ex = res.get('rb_exchange') or {}
    rb_ok = rb == 'ok' and st == {'exchange_md5': OLD_MD5, 'same_as_before_apply': True, 'ledger': 0} \
        and ex == {'consent': True, 'answer_ok': True, 'notices': ['anthropic false due']}
    out.append(f"{'OK  ' if rb_ok else 'BAD '} rollback {rb!r} state {json.dumps(st)} exchange after it {json.dumps(ex)}")
    bad += 0 if rb_ok else 1
    out.append(f"durations ms: fixtures {ms(res, 't_fixture_start', 't_fixture_end')}, apply {ms(res, 't_fixture_end', 't_applied')}, "
               f"controls {ms(res, 't_start', 't_controls_end')}, mutants {ms(res, 't_controls_end', 't_mutants_end')}, total {ms(res, 't_fixture_start', 't_end')}")
    out.append(f'controls={len(names)} mutant_entries={n_mut + n_neg} (real={n_mut} + negative_control_required_not_applied={n_neg}) problems={bad}')
    if mode == 'structure':
        out.append('structure: OK' if bad == 0 else 'structure: NOT OK')
    return out, 1 if bad else 0


def report_fixtures(raw):
    res, err = unwrap(raw, 'H4266_FIXTURES')
    if err:
        return [err, 'NOT OK'], 1
    want = {'fx_settings_rows': 1, 'fx_users': 3, 'fx_notices_before': 0, 'fx_allowlist': {'anthropic': True, 'openai': True},
            'fx_exchange_md5': OLD_MD5, 'fx_texts': 3}
    bad = [k for k, v in want.items() if res.get(k) != v]
    out = [f"{'OK  ' if k not in bad else 'BAD '} {k} = {json.dumps(res.get(k))} (want {json.dumps(v)})" for k, v in want.items()]
    out.append(f"fixtures ms: {ms(res, 't_fixture_start', 't_fixture_end')}")
    out.append('H4266_FIXTURES_OK' if not bad else 'NOT OK')
    return out, 1 if bad else 0


def selftest():
    def env(marker, obj):
        return json.dumps({'message': f'Failed to run sql query: ERROR:  P0001: {marker} ' + json.dumps(obj) + '\nCONTEXT:  x'}) + '\nkt-sql: HTTP 400\n'
    good = {'mode': 'full', 'apply': {'exchange_md5': NEW_MD5, 'changed': ['mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)'], 'added': [],
                                      'attrs_except_body_same': True, 'ledger': 1},
            'controls': {c: 'PASS' for c in CONTROLS}, 'baseline_fp': 'x', 'fp_end': 'x', 'rollback': 'ok',
            'rb_state': {'exchange_md5': OLD_MD5, 'same_as_before_apply': True, 'ledger': 0},
            'rb_exchange': {'consent': True, 'answer_ok': True, 'notices': ['anthropic false due']}}
    for mid, _a, _p, prim in MUTS:
        good[f'mutant:{mid}'] = ({'applied': False, 'error': NOT_APPLIED_ERROR, 'want': 'not_applied'} if WANT[mid] == 'not_applied'
                                 else dict({c: 'FAIL: x' for c in prim}, applied=True, want='red'))
    cases = [('all good', good, 0)]
    b = json.loads(json.dumps(good)); b['controls']['c_zero_row'] = 'FAIL: x'; cases.append(('a control fails', b, 1))
    b = json.loads(json.dumps(good)); b['mutant:M04_no_row_count_check']['c_zero_row'] = 'PASS'; cases.append(('a mutant not caught', b, 1))
    b = json.loads(json.dumps(good)); b['mutant:M01_swallow_restored']['c_fail_check'] = 'ERROR XX000 boom'; cases.append(('a mutant ERROR', b, 1))
    b = json.loads(json.dumps(good)); b['mutant:N01_noop_probe'] = {'applied': True, 'want': 'not_applied'}; cases.append(('negative control applied', b, 1))
    b = json.loads(json.dumps(good)); del b['mutant:N01_noop_probe']; cases.append(('negative control missing', b, 1))
    b = json.loads(json.dumps(good)); b['fp_end'] = 'y'; cases.append(('fingerprint changed', b, 1))
    b = json.loads(json.dumps(good)); b['rollback'] = 'ERROR'; cases.append(('rollback failed', b, 1))
    b = json.loads(json.dumps(good)); b['apply']['added'] = ['x()']; cases.append(('apply added a function', b, 1))
    fails = 0
    for name, obj, want in cases:
        _o, rc = report(env('H4266_RESULT', obj), 'full')
        ok = rc == want
        fails += 0 if ok else 1
        print(('ok   ' if ok else 'FAIL ') + name)
    _o, rc = report(json.dumps([{'line': 'x'}]) + '\nkt-sql: HTTP 200\n', 'full')
    print(('ok   ' if rc == 1 else 'FAIL ') + 'committed call (HTTP 200) refused'); fails += 0 if rc == 1 else 1
    _o, rc = report(env('H4266_RESULT', good) + 'kt-sql: HTTP 400\n', 'full')
    print(('ok   ' if rc == 1 else 'FAIL ') + 'two status lines refused'); fails += 0 if rc == 1 else 1
    print('selftest: OK' if fails == 0 else f'selftest: {fails} FAILED')
    return 1 if fails else 0


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['check']:
        bad = [k for k, v in OUTS.items() if not os.path.exists(os.path.join(HERE, k)) or open(os.path.join(HERE, k), encoding='utf-8').read() != v]
        print('differs: ' + ', '.join(bad) if bad else 'all generated files match')
        sys.exit(1 if bad else 0)
    if a[:1] == ['selftest']:
        sys.exit(selftest())
    if a[:1] == ['report']:
        raw = open(a[1], encoding='utf-8').read()
        mode = a[2] if len(a) > 2 else 'full'
        lines, rc = report_fixtures(raw) if mode == 'fixtures' else report(raw, mode)
        print('\n'.join(lines))
        sys.exit(rc)
    for k, v in OUTS.items():
        open(os.path.join(HERE, k), 'w', encoding='utf-8').write(v)
    print('\n'.join(SHOW))
    print(json.dumps(FACTS['files'], indent=1))
    print('exchange md5 before', OLD_MD5, 'after', NEW_MD5, '| controls', len(CONTROLS), '| mutants', len(MUTS) - len(NEG_MUTANTS), '+ negative', len(NEG_MUTANTS))
