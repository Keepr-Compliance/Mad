#!/usr/bin/env python3
"""BACKLOG-4265 (revokes all privileges of role service_role on 18 tables and 1 sequence): writes, from the migration
supabase/migrations/20261123160000_backlog_4265_api_role_table_privileges.sql:

  apply-20261123160000.sql       the migration text unchanged, then its ledger row (one call)
  rollback-20261123160000.sql    lock_timeout first, pre-check, the prior service_role privileges on every relation,
                                 ledger row removed, post-check (sorted ACL items per relation)
  harness-4265.sql               FULL call: guard, state check, lock probe, helpers and fixtures, the controls run once
                                 before the apply (each must FAIL), apply, controls, mutants (each proven installed,
                                 fingerprint restored after each), negative control, the rollback file, checks after it,
                                 RAISE 'H4265_RESULT <json>'
  harness-4265-fixtures.sql      fixtures-only call: everything before the controls, then RAISE 'H4265_FIXTURES <json>'
  harness-4265-structure.sql     structure call: the full call's statements with one plain control (c01), the negative
                                 control and one mutant
  catalog-facts.json             the pinned prior privileges, md5s of every generated file

Fixtures: the helpers and fixtures of supabase/tests/backlog-4263-sync2-t/lib/ (read at generation time; `check` goes
red when they change), then lib/helpers.sql of this folder.
Mutations are exact-string replacements that must match once (else this script stops); the harness proves in the
database that each mutation is installed before its controls run.

  python3 gen.py              write the files and print every mutation (MUTATION APPLIED <id> ...)
  python3 gen.py check        regenerate in memory; exit 1 if any written file differs
  python3 gen.py selftest     the reporters against synthetic outputs (no database)
  python3 gen.py selftest --control-green-ok   the selftest's own control: expects a missed mutant to read OK, so
                              the selftest must FAIL (exit 1)
  python3 gen.py report <out> [full|structure|fixtures]   read one call's kt-sql/nas-sql output
"""
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
REL = 'supabase/tests/backlog-4265'
VERSION, NAME = '20261123160000', 'backlog_4265_api_role_table_privileges'
MIG_PATH = f'supabase/migrations/{VERSION}_{NAME}.sql'
FX_REL = 'supabase/tests/backlog-4263-sync2-t/lib'
rd = lambda p: open(os.path.join(REPO, p), encoding='utf-8').read()
md5 = lambda s: hashlib.md5(s.encode('utf-8')).hexdigest()
MIG = rd(MIG_PATH)
LIB = {n: rd(f'{REL}/lib/{n}.sql') for n in ('helpers', 'controls')}
FX = {n: rd(f'{FX_REL}/{n}.sql') for n in ('helpers', 'fixtures')}
GUARD_B = "md5(u.id::text) = '53a385187695375e2e8695625a20a77a'"  # the reserved test account (same marker as backlog-4263-sync2-t)

BLOCKS = {
    'A': ['cloud_deal_messages', 'cloud_deal_files', 'cloud_blobs'],
    'B': ['mcp_settings', 'mcp_redirect_allowlist', 'mcp_oauth_clients', 'mcp_authorization_requests', 'mcp_connections',
          'mcp_authorization_codes', 'mcp_tokens', 'mcp_rate_counters', 'mcp_call_log'],
    'C': ['cloud_deals', 'cloud_deal_parties', 'cloud_deal_checklists', 'cloud_deal_checklist_items', 'cloud_autosave_settings',
          'member_addons'],
}
SEQ = 'mcp_call_log_id_seq'
TABLES = [t for b in 'ABC' for t in BLOCKS[b]]
RELS = TABLES + [SEQ]
assert len(TABLES) == 18
# The prior privileges, measured on the test database (2026-11-24, read-only catalogue call): every table
# DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE; the sequence SELECT, UPDATE, USAGE; grantor
# postgres, no grant option. As pg_temp.sr_acl65 prints them (privilege order COLLATE "C").
TABLE_PRIVS = ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']
SEQ_PRIVS = ['SELECT', 'UPDATE', 'USAGE']
TABLE_ACL = ','.join(f'postgres:{p}:false' for p in TABLE_PRIVS)
SEQ_ACL = ','.join(f'postgres:{p}:false' for p in SEQ_PRIVS)
assert sorted(TABLE_PRIVS, key=lambda x: x.encode()) == TABLE_PRIVS and sorted(SEQ_PRIVS, key=lambda x: x.encode()) == SEQ_PRIVS


def dq(s, tag):
    assert tag not in s, tag
    return tag + s + tag


def one(text, old, new, what):
    n = text.count(old)
    if n != 1:
        raise SystemExit(f'MUTATION NOT APPLIED {what}: fragment matched {n} times: {old[:120]!r}')
    return text.replace(old, new)


def qlist(ts):
    return ', '.join('public.' + t for t in ts)


# ------------------------------------------------------------------------------------------------ the migration
assert re.search(r"\A(?:--[^\n]*\n|\n)*SET LOCAL lock_timeout = '3s';\n", MIG), 'lock_timeout is not the first statement'
_rev = re.findall(r'^REVOKE ALL ON (TABLE|SEQUENCE) ([^;]+?) FROM service_role;$', ' '.join(MIG.split('\n  ')).replace('\n', '\n'), re.M)
REVOKED = [o.strip()[len('public.'):] for _, objs in _rev for o in objs.split(',')]
assert sorted(REVOKED) == sorted(RELS), ('the migration does not revoke exactly the 19 relations', REVOKED)
assert len(_rev) == 4 and [k for k, _ in _rev].count('SEQUENCE') == 1
assert not re.search(r'\bGRANT\s|CREATE |DROP |ALTER |POLICY|DEFAULT PRIVILEGES|INSERT |UPDATE |DELETE |TRUNCATE ', re.sub(r'(?m)^--.*$', '', MIG).replace(
    "'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'", '').replace("'USAGE', 'SELECT', 'UPDATE'", '').replace('SELECT, INSERT, UPDATE, REFERENCES', '')), \
    'the migration does more than revoke privileges'
PRECHECK = re.search(r'(DO \$pre4265\$.*?\$pre4265\$;)', MIG, re.S).group(1)
REVOKES = ''.join(m.group(0) + '\n' for m in re.finditer(r'^REVOKE ALL ON (?:TABLE|SEQUENCE) [^;]+;', MIG, re.M | re.S))
assert REVOKES.count('REVOKE ALL') == 4
PRE_ROLE = "IF current_user IS DISTINCT FROM 'postgres' THEN"
assert PRECHECK.count(PRE_ROLE) == 1

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

REL_VALUES = ', '.join(f"('{t}', '{'S' if t == SEQ else 'r'}')" for t in RELS)
OTHER_FP = """(SELECT md5(coalesce(string_agg(z.s, '|' ORDER BY z.s COLLATE "C"), '')) FROM (
      SELECT c.relname::text || '::' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':'
             || pg_catalog.pg_get_userbyid(a.grantor)::text || ':' || a.privilege_type || ':' || a.is_grantable::text AS s
        FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (@@NAMES@@) AND a.grantee IS DISTINCT FROM 'service_role'::regrole
      UNION ALL
      SELECT c.relname::text || ':' || t.attname::text || ':' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ':'
             || pg_catalog.pg_get_userbyid(a.grantor)::text || ':' || a.privilege_type || ':' || a.is_grantable::text
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute t ON t.attrelid = c.oid AND t.attnum > 0 AND NOT t.attisdropped
        CROSS JOIN LATERAL aclexplode(t.attacl) a
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (@@NAMES@@) AND a.grantee IS DISTINCT FROM 'service_role'::regrole) z)""".replace(
    '@@NAMES@@', 'ARRAY[' + ', '.join(f"'{t}'" for t in RELS) + ']')
GRANTS = (f"-- tables: {', '.join(BLOCKS['A'])}\nGRANT {', '.join(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'])} "
          f"ON TABLE {qlist(BLOCKS['A'])} TO service_role;\n"
          f"-- tables: {', '.join(BLOCKS['B'])}\nGRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE {qlist(BLOCKS['B'])} TO service_role;\n"
          f"-- sequence: {SEQ}\nGRANT USAGE, SELECT, UPDATE ON SEQUENCE public.{SEQ} TO service_role;\n"
          f"-- tables: {', '.join(BLOCKS['C'])}\nGRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE {qlist(BLOCKS['C'])} TO service_role;\n")
ROLLBACK = f"""-- rollback-{VERSION}.sql (generated by {REL}/gen.py; do not hand-edit)
-- Undoes {MIG_PATH}: gives role service_role back the privileges it held on the 18 tables and
-- 1 sequence before that migration (measured on the test database, 2026-11-24): on each table SELECT, INSERT, UPDATE,
-- DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN; on {SEQ} USAGE, SELECT and UPDATE; grantor postgres, no
-- grant option. The restored set is the one recorded for the test database; the pre-check refuses on a server below
-- PostgreSQL 17. Removes the ledger row. One transaction; RAISEs (nothing changed) unless the pre-check and the
-- post-check hold. Privileges of every other role are unchanged (the post-check compares a fingerprint the pre-check
-- takes).
-- lock_timeout 3s is set before the first statement.
SET LOCAL lock_timeout = '3s';
DO $pre4265r$
DECLARE v text;
BEGIN
  IF current_user IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'ROLLBACK {VERSION}: current_user is %, not postgres', current_user;
  END IF;
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION 'ROLLBACK {VERSION}: server version % has no MAINTAIN privilege', current_setting('server_version');
  END IF;
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}') <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK {VERSION}: the ledger row is absent';
  END IF;
  SELECT string_agg(x.name, ',' ORDER BY x.name) INTO v
    FROM (VALUES {REL_VALUES}) x(name, kind)
    LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass('public.' || x.name)
   WHERE c.oid IS NULL OR c.relkind::text <> x.kind OR pg_catalog.pg_get_userbyid(c.relowner) <> 'postgres'
      OR EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 'service_role'::regrole);
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK {VERSION}: not in the state the migration leaves: %', v;
  END IF;
  PERFORM set_config('keepr.r4265_other_acl', {OTHER_FP}, true);
END
$pre4265r$;

{GRANTS}
DELETE FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}';

DO $post4265r$
DECLARE v text;
BEGIN
  SELECT string_agg(x.name, ',' ORDER BY x.name) INTO v
    FROM (VALUES {REL_VALUES}) x(name, kind)
   WHERE (SELECT coalesce(string_agg(pg_catalog.pg_get_userbyid(a.grantor)::text || ':' || a.privilege_type || ':' || a.is_grantable::text, ','
                                     ORDER BY a.privilege_type COLLATE "C", pg_catalog.pg_get_userbyid(a.grantor)::text COLLATE "C"), '')
            FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
           WHERE c.oid = pg_catalog.to_regclass('public.' || x.name) AND a.grantee = 'service_role'::regrole)
         IS DISTINCT FROM CASE x.kind WHEN 'S' THEN '{SEQ_ACL}' ELSE '{TABLE_ACL}' END;
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK {VERSION} FAILED, nothing changed: service_role items differ on %', v;
  END IF;
  IF {OTHER_FP} IS DISTINCT FROM current_setting('keepr.r4265_other_acl', true) THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK {VERSION} FAILED, nothing changed: items of other roles changed';
  END IF;
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}') <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK {VERSION} FAILED, nothing changed: ledger row kept';
  END IF;
END
$post4265r$;
"""
_rb_granted = re.findall(r'^GRANT ([A-Z, ]+) ON (TABLE|SEQUENCE) ([^;]+) TO service_role;$', ROLLBACK, re.M)
assert sorted(o.strip()[len('public.'):] for _, _, objs in _rb_granted for o in objs.split(',')) == sorted(RELS)
for privs, kind, _ in _rb_granted:
    assert sorted(p.strip() for p in privs.split(',')) == sorted(SEQ_PRIVS if kind == 'SEQUENCE' else TABLE_PRIVS), privs

# ------------------------------------------------------------------------------------------------ controls and mutants
CONTROLS = ['c01_privileges', 'c02_statements_a_c', 'c03_rerun', 'c04_erase_as_service_role', 'c05_tools_as_anon',
            'c06_upload_as_authenticated', 'c07_function_execute', 'c08_default_privileges', 'c10_rollback', 'c13_other_roles',
            'c14_statements_b', 'c15_sequence', 'c18_precheck_role']
NEG_BEFORE = ['c01_privileges', 'c02_statements_a_c', 'c14_statements_b', 'c15_sequence']  # each must FAIL before the apply
CONTROLS_SQL = LIB['controls'].replace('@@SEQ_ACL@@', SEQ_ACL).replace('@@TABLE_ACL@@', TABLE_ACL)
assert '@@' not in CONTROLS_SQL
for _c in CONTROLS:
    assert CONTROLS_SQL.count(f'CREATE FUNCTION pg_temp.{_c}()') == 1, _c
assert len(re.findall(r'^CREATE FUNCTION pg_temp\.c\d\d_', CONTROLS_SQL, re.M)) == len(CONTROLS)


def ex(sql, i):
    return f"    EXECUTE {dq(sql, f'$mu{i}$')};\n"


def has_sr(t, priv='SELECT'):
    return f"has_table_privilege('service_role', 'public.{t}'::regclass, '{priv}')"


ROLLBACK_GRANT_A = f"ON TABLE {qlist(BLOCKS['A'])} TO service_role;"
ROLLBACK_GRANT_C = f"GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE {qlist(BLOCKS['C'])} TO service_role;"
MIG_PRE_END = "  IF v_bad <> '' THEN\n    RAISE EXCEPTION '4265 pre-check: %', v_bad;"
assert MIG.count(MIG_PRE_END) == 1
REFUSE = ("  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.cloud_blobs'::regclass\n"
          "                  AND a.grantee = 'service_role'::regrole) THEN\n    RAISE EXCEPTION 'h65 nothing left';\n  END IF;\n")


def txt_mut(key, old, new, i, mid):
    """an exact replacement in a stored text (pg_temp.t65_txt); proof: the stored text contains the new fragment"""
    base = {'migration': MIG, 'rollback': ROLLBACK, 'precheck': PRECHECK}[key]
    one(base, old, new, mid)
    sql = f"UPDATE pg_temp.t65_txt SET v = replace(v, {dq(old, '$o' + str(i) + '$')}, {dq(new, '$n' + str(i) + '$')}) WHERE k = '{key}'"
    proof = f"(SELECT position({dq(new, '$p' + str(i) + '$')} IN v) > 0 FROM pg_temp.t65_txt WHERE k = '{key}')"
    return sql, proof


# (id, plpgsql lines, proof, {primary control: expected FAIL detail or None (any FAIL)})
MUTS = []
SHOW = []


def add(mid, lines, proof, prim):
    MUTS.append((mid, lines, proof, prim))
    SHOW.append(f'MUTATION APPLIED {mid}: {lines.strip()[:200]}')


i = 0
for t in ('mcp_settings', 'mcp_connections', 'mcp_tokens'):  # one relation of block B omitted, each singly
    add(f'M01_{t}_left', ex(f'GRANT ALL ON TABLE public.{t} TO service_role', i), has_sr(t), {'c01_privileges': t, 'c14_statements_b': None}); i += 1
for b, extra in (('A', []), ('B', [SEQ]), ('C', [])):  # one whole block omitted
    sql = f'GRANT ALL ON TABLE {qlist(BLOCKS[b])} TO service_role'
    lines = ex(sql, i) + (ex(f'GRANT ALL ON SEQUENCE public.{SEQ} TO service_role', i + 100) if extra else '')
    prim = {'c01_privileges': ','.join(sorted(BLOCKS[b] + extra, key=lambda x: x.encode())),
            ('c14_statements_b' if b == 'B' else 'c02_statements_a_c'): None}
    if b == 'B':
        prim['c15_sequence'] = None
    add(f'M02_block_{b}_left', lines, ' AND '.join(has_sr(t) for t in BLOCKS[b]), prim); i += 1
add('M03_types_left', ex('GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.cloud_deal_messages TO service_role', i),
    has_sr('cloud_deal_messages', 'TRUNCATE'), {'c01_privileges': 'cloud_deal_messages'}); i += 1
add('M04_column_left', ex('GRANT SELECT (id) ON TABLE public.cloud_deals TO service_role', i),
    "has_any_column_privilege('service_role', 'public.cloud_deals'::regclass, 'SELECT')", {'c01_privileges': 'cloud_deals', 'c02_statements_a_c': None}); i += 1
add('M05_public_select', ex('GRANT SELECT ON TABLE public.cloud_blobs TO PUBLIC', i), has_sr('cloud_blobs'),
    {'c01_privileges': 'cloud_blobs', 'c02_statements_a_c': None, 'c13_other_roles': None}); i += 1
add('M06_select_left', ex('GRANT SELECT ON TABLE public.cloud_deal_files TO service_role', i), has_sr('cloud_deal_files'),
    {'c02_statements_a_c': None}); i += 1
add('M07_insert_left', ex('GRANT INSERT ON TABLE public.mcp_tokens TO service_role', i), has_sr('mcp_tokens', 'INSERT'),
    {'c14_statements_b': None}); i += 1
add('M08_sequence_left', ex(f'GRANT USAGE ON SEQUENCE public.{SEQ} TO service_role', i),
    f"has_sequence_privilege('service_role', 'public.{SEQ}'::regclass, 'USAGE')", {'c15_sequence': None, 'c01_privileges': SEQ}); i += 1
add('M09_scrub_invoker', ex('ALTER FUNCTION public.cloud_blob_erase_scrub(uuid, uuid, boolean, integer) SECURITY INVOKER', i),
    "(SELECT NOT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = 'public.cloud_blob_erase_scrub(uuid,uuid,boolean,integer)'::regprocedure)",
    {'c04_erase_as_service_role': None, 'c07_function_execute': None}); i += 1
add('M10_reader_table_revoked', ex('REVOKE SELECT ON TABLE public.cloud_deal_messages FROM authenticated', i),
    "NOT has_table_privilege('authenticated', 'public.cloud_deal_messages'::regclass, 'SELECT')",
    {'c05_tools_as_anon': None, 'c13_other_roles': None}); i += 1
add('M11_upload_invoker', ex('ALTER FUNCTION public.cloud_upsert_messages(uuid, uuid, uuid, jsonb) SECURITY INVOKER', i),
    "(SELECT NOT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = 'public.cloud_upsert_messages(uuid,uuid,uuid,jsonb)'::regprocedure)",
    {'c06_upload_as_authenticated': None, 'c07_function_execute': None}); i += 1
add('M12_reader_executable',
    '    SET LOCAL ROLE mcp_reader;\n    GRANT EXECUTE ON FUNCTION public._mcp_r_get_message(uuid, integer) TO service_role;\n    RESET ROLE;\n',
    "has_function_privilege('service_role', 'public._mcp_r_get_message(uuid,integer)'::regprocedure, 'EXECUTE')", {'c07_function_execute': None})
add('M13_tool_executable', ex('GRANT EXECUTE ON FUNCTION public.mcp_get_message(text, bytea, text, text, integer) TO service_role', i),
    "has_function_privilege('service_role', 'public.mcp_get_message(text,bytea,text,text,integer)'::regprocedure, 'EXECUTE')",
    {'c07_function_execute': None}); i += 1
add('M14_default_privileges', ex('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM service_role', i),
    "pg_temp.default_acl65() IS DISTINCT FROM (SELECT v #>> '{}' FROM pg_temp.t_out WHERE k = 'default_acl_before')",
    {'c08_default_privileges': None}); i += 1
for mid, old, new in (('M15_rollback_grant_option', ROLLBACK_GRANT_A, ROLLBACK_GRANT_A.replace('TO service_role;', 'TO service_role WITH GRANT OPTION;')),
                      ('M16_rollback_grants_anon', ROLLBACK_GRANT_C, ROLLBACK_GRANT_C + '\nGRANT SELECT ON TABLE public.cloud_deals TO anon;'),
                      ('M17_rollback_without_truncate', ROLLBACK_GRANT_C, ROLLBACK_GRANT_C.replace('DELETE, TRUNCATE, ', 'DELETE, '))):
    sql, proof = txt_mut('rollback', old, new, i, mid)
    add(mid, ex(sql, i), proof, {'c10_rollback': None}); i += 1
add('M18_authenticated_revoked', ex('REVOKE SELECT ON TABLE public.cloud_deals FROM authenticated', i),
    "NOT has_table_privilege('authenticated', 'public.cloud_deals'::regclass, 'SELECT')", {'c13_other_roles': None}); i += 1
sql, proof = txt_mut('precheck', PRE_ROLE, 'IF false THEN', i, 'M19')
add('M19_precheck_role_dropped', ex(sql, i), proof, {'c18_precheck_role': None}); i += 1
sql, proof = txt_mut('migration', MIG_PRE_END, REFUSE + MIG_PRE_END, i, 'M20')
add('M20_rerun_refused', ex(sql, i), proof, {'c03_rerun': None}); i += 1
NEG = ('N01_noop_probe', ex('SELECT 1', 900), has_sr('cloud_deal_messages'), {})
NOT_APPLIED_ERROR = 'MUTATION NOT APPLIED IN DB'
assert len({m[0] for m in MUTS}) == len(MUTS)
for m in MUTS:
    assert m[3] and all(c in CONTROLS for c in m[3]), m[0]
STRUCTURE_MUTANT = 'M01_mcp_settings_left'


def run_controls(names, var):
    return ''.join(f"""    BEGIN
      res := pg_temp.{c}();
      RAISE EXCEPTION 'undo-case';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'undo-case' THEN res := 'ERROR ' || SQLSTATE; END IF;
    END;
    {var} := {var} || jsonb_build_object('{c}', res);
""" for c in names)


def mut_block(mid, lines, proof, prim, neg=False):
    want = 'not_applied' if neg else 'red'
    return f"""  -- {mid}
  BEGIN
    o := '{{}}';
    applied := NULL;
{lines}    applied := {proof};
    IF applied IS NOT TRUE THEN RAISE EXCEPTION '{NOT_APPLIED_ERROR}'; END IF;
{run_controls(list(prim), 'o')}    RAISE EXCEPTION 'undo-mutant';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'undo-mutant' THEN
      o := o || jsonb_build_object('error', CASE WHEN SQLERRM = '{NOT_APPLIED_ERROR}' THEN '{NOT_APPLIED_ERROR}' ELSE 'SQLSTATE ' || SQLSTATE END);
    END IF;
  END;
  PERFORM pg_temp.rec('mutant:{mid}', o || jsonb_build_object('applied', applied, 'want', '{want}'));
  IF pg_temp.fingerprint65() IS DISTINCT FROM (SELECT v #>> '{{}}' FROM pg_temp.t_out WHERE k = 'baseline_fp') THEN
    RAISE EXCEPTION 'MUTANT NOT RESTORED {mid}';
  END IF;
"""


FINGERPRINT = """-- what the mutants change: service_role items on the 19 relations, every other role's items, default privileges,
-- EXECUTE grants and SECURITY DEFINER of the functions naming the relations, the stored texts
CREATE FUNCTION pg_temp.fingerprint65() RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT md5(concat_ws('|',
    (SELECT string_agg(x.name || '=' || pg_temp.sr_acl65(x.name), ',' ORDER BY x.name COLLATE "C") FROM pg_temp.t65_rel x),
    pg_temp.other_acl65(), pg_temp.default_acl65(), pg_temp.fn_exec65(),
    (SELECT string_agg(t.k || '=' || md5(t.v), ',' ORDER BY t.k) FROM pg_temp.t65_txt t)))
$h$;
"""
STATE_REL = ', '.join(f"('{t}')" for t in RELS)
HEAD = f"""-- harness-4265.sql (generated by {REL}/gen.py; do not hand-edit)
-- TEST DATABASE ONLY. This file ends in a rollback and must never be run on production.
-- BACKLOG-4265: run on a database where 20261123140000 is applied and {VERSION} is NOT (service_role still holds its
-- prior privileges on the 19 relations). 20261123150000 and 20261123170000 may be applied or not: nothing here depends
-- on them. ONE call that ends in RAISE, so nothing persists. Order: guard (refuses any database that is not the test
-- database) -> state check -> lock probe (a subtransaction that is undone) -> helpers (backlog-4263-sync2-t/lib, then
-- lib/helpers.sql) and fixtures (backlog-4263-sync2-t/lib/fixtures.sql) -> the controls once before the apply -> the
-- apply file -> {len(CONTROLS)} controls, each in a subtransaction that is undone -> {len(MUTS)} mutants and 1 negative
-- control, each proven installed before its primary controls run under it, the fingerprint compared after each -> the
-- rollback file and checks after it -> RAISE 'H4265_RESULT <json>'.
-- Afterwards: select extensions.pg_stat_statements_reset(). Records statuses, counts, fixture keys and md5s only.
-- Locks (all released by the final RAISE; lock_timeout 3s throughout): the lock probe's locks only inside its own
--   subtransaction; the row check (pg_temp.row_hashes65) reads every row of 16 of the 18 tables and of auth.users and
--   so holds ACCESS SHARE on each until the call ends (it blocks only ALTER / DROP / TRUNCATE / VACUUM FULL from another
--   session); the fixtures' row locks: the one mcp_settings row and the one cloud_release_switches row (a portal-secret
--   change or a switch change waits) and the rows of the invented users; the privilege changes of the apply on the 19
--   relations until the call ends (their lock mode is what the lock probe records).
-- Do not run in minutes 15 to 30 of the hour or at minute 23 (the erase job). statement_timeout 240s.
DO $guard4265$
DECLARE n bigint := 0;
BEGIN
  IF pg_catalog.to_regclass('public.pm_backlog_items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.pm_backlog_items' INTO n;
  END IF;
  IF n > 100 OR coalesce((SELECT s.n_live_tup FROM pg_catalog.pg_stat_user_tables s WHERE s.relid = pg_catalog.to_regclass('public.pm_backlog_items')), 0) > 100 THEN
    RAISE EXCEPTION 'harness-4265 refuses to run: TEST DATABASE ONLY (production tracker rows present)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE {GUARD_B}) THEN
    RAISE EXCEPTION 'harness-4265 refuses to run: TEST DATABASE ONLY (test database marker absent)';
  END IF;
END
$guard4265$;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '240s';
DO $state4265$
DECLARE v text;
BEGIN
  SELECT string_agg(x.name, ',' ORDER BY x.name) INTO v FROM (VALUES {STATE_REL}) x(name)
   WHERE coalesce((SELECT string_agg(pg_catalog.pg_get_userbyid(a.grantor)::text || ':' || a.privilege_type || ':' || a.is_grantable::text, ','
                                     ORDER BY a.privilege_type COLLATE "C", pg_catalog.pg_get_userbyid(a.grantor)::text COLLATE "C")
                     FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
                    WHERE c.oid = pg_catalog.to_regclass('public.' || x.name) AND a.grantee = 'service_role'::regrole), '')
         IS DISTINCT FROM CASE WHEN x.name = '{SEQ}' THEN '{SEQ_ACL}' ELSE '{TABLE_ACL}' END;
  IF v IS NOT NULL
     OR current_user IS DISTINCT FROM 'postgres'
     OR current_setting('server_version_num')::int < 170000
     OR (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}') <> 0
     OR NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261123140000')
     OR NOT pg_has_role(current_user, 'service_role', 'SET') OR NOT pg_has_role(current_user, 'anon', 'SET')
     OR NOT pg_has_role(current_user, 'authenticated', 'SET') OR NOT pg_has_role(current_user, 'mcp_reader', 'SET') THEN
    RAISE EXCEPTION 'harness-4265: the database is not at the state this harness needs (service_role items differ on %, ledger {VERSION} %)',
      coalesce(v, 'none'), (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}');
  END IF;
END
$state4265$;
"""
LOCKS = ("(SELECT coalesce(jsonb_agg(jsonb_build_object('rel', l.relation::regclass::text, 'mode', l.mode) "
         "ORDER BY l.relation::regclass::text, l.mode), '[]') FROM pg_catalog.pg_locks l "
         "WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND l.relation = ANY (ARRAY["
         + ', '.join(f"pg_catalog.to_regclass('public.{t}')" for t in RELS) + "]::oid[]))")
PROBE = f"""-- ================================================================ lock probe (first; undone)
-- the locks this session holds on the 19 relations: before, after the migration's REVOKE statements, and after an
-- explicit ACCESS SHARE lock on cloud_deal_messages (the probe's own positive control: that row must appear)
DO $probe4265$
DECLARE b jsonb; a1 jsonb; a2 jsonb; err text;
BEGIN
  b := {LOCKS};
  BEGIN
    EXECUTE {dq(REVOKES, '$rv$')};
    a1 := {LOCKS};
    LOCK TABLE public.cloud_deal_messages IN ACCESS SHARE MODE;
    a2 := {LOCKS};
    RAISE EXCEPTION 'undo-probe';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'undo-probe' THEN err := SQLSTATE; END IF;
  END;
  PERFORM set_config('keepr.h4265_probe', jsonb_build_object('before', b, 'after_revoke', a1, 'after_lock', a2, 'error', err,
    'control_seen', coalesce(a2 @> '[{{"rel": "cloud_deal_messages", "mode": "AccessShareLock"}}]'::jsonb, false),
    'after_unwind', {LOCKS})::text, true);
END
$probe4265$;
"""
TXT = f"""INSERT INTO pg_temp.t65_txt VALUES ('migration', {dq(MIG, '$t1$')}), ('rollback', {dq(ROLLBACK, '$t2$')}),
  ('precheck', {dq(PRECHECK, '$t3$')});
"""
FIXTURE_END = """DO $fxend4265$
BEGIN
  PERFORM pg_temp.rec('lock_probe', current_setting('keepr.h4265_probe', true)::jsonb);
  PERFORM pg_temp.rec('t_fixture_end', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('fx_users', to_jsonb((SELECT count(*) FROM auth.users WHERE id IN (pg_temp.f('A'), pg_temp.f('B')))));
  PERFORM pg_temp.rec('fx_m_inact', to_jsonb((SELECT count(*) FROM public.cloud_deal_messages WHERE id = pg_temp.f('m_inact') AND removed_at IS NULL)));
  PERFORM pg_temp.rec('fx_k2', to_jsonb((SELECT count(*) FROM public.mcp_connections WHERE id = pg_temp.f('K2') AND notice_version = 2)));
  PERFORM pg_temp.rec('fx_texts', to_jsonb((SELECT count(*) FROM pg_temp.t65_txt)));
END
$fxend4265$;
"""
HEAD_ALL = HEAD + PROBE + FX['helpers'] + '\n' + LIB['helpers'] + '\n' + "DO $t0_4265$ BEGIN PERFORM pg_temp.rec('t_fixture_start', to_jsonb(clock_timestamp())); END $t0_4265$;\n" + FX['fixtures'] + '\n' + TXT
BEFORE = f"""-- ================================================================ baselines and the controls once before the apply
DO $before4265$
DECLARE res text; base jsonb := '{{}}';
BEGIN
  PERFORM pg_temp.rec('other_acl_before', to_jsonb(pg_temp.other_acl65()));
  PERFORM pg_temp.rec('fn_exec_before', to_jsonb(pg_temp.fn_exec65()));
  PERFORM pg_temp.rec('default_acl_before', to_jsonb(pg_temp.default_acl65()));
  PERFORM pg_temp.rec('fn_service_role', pg_temp.fn_sr65());
{run_controls(NEG_BEFORE, 'base')}  PERFORM pg_temp.rec('neg_before', base);
END
$before4265$;
"""
APPLY_STEP = f"""-- ================================================================ apply (the apply file, verbatim)
{APPLY}DO $applied4265$
BEGIN
  PERFORM pg_temp.rec('t_applied', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('apply', jsonb_build_object('ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}'),
    'service_role_items', (SELECT coalesce(string_agg(x.name, ',' ORDER BY x.name), '') FROM pg_temp.t65_rel x WHERE pg_temp.sr_acl65(x.name) <> '')));
END
$applied4265$;
"""
CONTROLS_BLOCK = """DO $controls4265$
DECLARE res text; base jsonb := '{}'; o jsonb; applied boolean;
BEGIN
  PERFORM pg_temp.rec('t_start', to_jsonb(clock_timestamp()));
  PERFORM pg_temp.rec('baseline_fp', to_jsonb(pg_temp.fingerprint65()));
  PERFORM pg_temp.rec('mode', to_jsonb('@@MODE@@'::text));
@@PLAIN@@  PERFORM pg_temp.rec('t_controls_end', to_jsonb(clock_timestamp()));
@@MUTANTS@@  PERFORM pg_temp.rec('fp_end', to_jsonb(pg_temp.fingerprint65()));
  PERFORM pg_temp.rec('t_mutants_end', to_jsonb(clock_timestamp()));
END
$controls4265$;
"""
AFTER = f"""-- ================================================================ the rollback file, verbatim, then checks after it
DO $rb4265$
BEGIN
  BEGIN
    EXECUTE {dq(ROLLBACK, '$rbq$')};
    PERFORM pg_temp.rec('rollback', to_jsonb('ok'::text));
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.rec('rollback', to_jsonb('ERROR ' || SQLSTATE || CASE WHEN SQLERRM LIKE 'ROLLBACK%' THEN ' (its own check)' ELSE '' END));
  END;
END
$rb4265$;
DO $after4265$
BEGIN
  PERFORM pg_temp.rec('rb_state', jsonb_build_object(
    'service_role_items_differ', (SELECT coalesce(string_agg(x.name, ',' ORDER BY x.name), '') FROM pg_temp.t65_rel x
                                   WHERE pg_temp.sr_acl65(x.name) IS DISTINCT FROM CASE x.kind WHEN 'S' THEN '{SEQ_ACL}' ELSE '{TABLE_ACL}' END),
    'other_roles_same', pg_temp.other_acl65() = (SELECT v #>> '{{}}' FROM pg_temp.t_out WHERE k = 'other_acl_before'),
    'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '{VERSION}')));
  PERFORM pg_temp.rec('report_cascade', pg_temp.r16_cascade());
  PERFORM pg_temp.rec('foreign_rows', pg_temp.foreign_rows65());
  PERFORM pg_temp.rec('t_end', to_jsonb(clock_timestamp()));
  RAISE EXCEPTION 'H4265_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.t_out);
END
$after4265$;
"""


def harness(mode):
    plain = run_controls(CONTROLS if mode == 'full' else ['c01_privileges'], 'base') + "  PERFORM pg_temp.rec('controls', base);\n"
    muts = MUTS if mode == 'full' else [m for m in MUTS if m[0] == STRUCTURE_MUTANT]
    body = ''.join(mut_block(*m) for m in muts) + mut_block(*NEG, neg=True)
    cb = CONTROLS_BLOCK.replace('@@MODE@@', mode).replace('@@PLAIN@@', plain).replace('@@MUTANTS@@', body)
    if mode == 'structure':
        cb = cb.replace("  PERFORM pg_temp.rec('fp_end',", "  PERFORM pg_temp.rec('fingerprints', jsonb_build_object('first', (SELECT v #>> '{}' FROM pg_temp.t_out WHERE k = 'baseline_fp'), 'second', pg_temp.fingerprint65()));\n  PERFORM pg_temp.rec('fp_end',")
    name = {'full': 'harness-4265.sql', 'structure': 'harness-4265-structure.sql'}[mode]
    return (HEAD_ALL.replace('harness-4265.sql (generated', f'{name} (generated') + FIXTURE_END + CONTROLS_SQL + BEFORE + APPLY_STEP
            + FINGERPRINT + cb + AFTER)


HARNESS = harness('full')
HARNESS_STRUCTURE = harness('structure')
HARNESS_FIXTURES = (HEAD_ALL.replace('harness-4265.sql (generated', 'harness-4265-fixtures.sql (generated') + FIXTURE_END
                    + """DO $fxraise4265$
BEGIN
  PERFORM pg_temp.rec('foreign_rows', pg_temp.foreign_rows65());
  RAISE EXCEPTION 'H4265_FIXTURES %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.t_out);
END
$fxraise4265$;
""")
for h in (HARNESS, HARNESS_STRUCTURE):
    assert h.count(APPLY) == 1 and h.count('MUTANT NOT RESTORED') == h.count("pg_temp.rec('mutant:")
    assert h.index(PROBE) < h.index(FX['helpers']), 'the lock probe must come before the helpers (they take locks)'
assert HARNESS.count("pg_temp.rec('mutant:") == len(MUTS) + 1
for _h in (HARNESS, HARNESS_STRUCTURE, HARNESS_FIXTURES):
    assert _h.count(GUARD_B) == 1

FACTS = {'migration': MIG_PATH, 'migration_md5': md5(MIG), 'relations': {b: BLOCKS[b] for b in 'ABC'}, 'sequence': SEQ,
         'prior_service_role_items': {'table': TABLE_ACL, 'sequence': SEQ_ACL, 'measured': 'test database, 2026-11-24, read-only catalogue call'},
         'fixtures_from': {f'{FX_REL}/{n}.sql': md5(v) for n, v in FX.items()},
         'controls': CONTROLS, 'controls_before_apply_must_fail': NEG_BEFORE,
         'mutants': {m[0]: {'primary': m[3]} for m in MUTS}, 'negative_control': NEG[0],
         'apply_md5': md5(APPLY), 'rollback_md5': md5(ROLLBACK)}
OUTS = {f'apply-{VERSION}.sql': APPLY, f'rollback-{VERSION}.sql': ROLLBACK, 'harness-4265.sql': HARNESS,
        'harness-4265-structure.sql': HARNESS_STRUCTURE, 'harness-4265-fixtures.sql': HARNESS_FIXTURES}
FACTS['files'] = {k: md5(v) for k, v in OUTS.items()}
OUTS['catalog-facts.json'] = json.dumps(FACTS, indent=2) + '\n'
CLASSES = {'harness-4265.sql': 'rolled_back', 'harness-4265-fixtures.sql': 'rolled_back', 'harness-4265-structure.sql': 'rolled_back',
           f'apply-{VERSION}.sql': 'commits', f'rollback-{VERSION}.sql': 'commits', 'dryrun-foreign-rows.sql': 'fragment'}


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


FOREIGN_TABLES = ['cloud_deal_messages', 'cloud_deal_files', 'cloud_blobs', 'mcp_redirect_allowlist', 'mcp_oauth_clients',
                  'mcp_authorization_requests', 'mcp_connections', 'mcp_authorization_codes', 'mcp_tokens', 'mcp_call_log',
                  'cloud_deals', 'cloud_deal_parties', 'cloud_deal_checklists', 'cloud_deal_checklist_items',
                  'cloud_autosave_settings', 'member_addons', 'auth.users']


def foreign_ok(res):
    fr = res.get('foreign_rows')
    is_int = lambda x: type(x) is int
    ok = isinstance(fr, dict) and sorted(fr) == sorted(FOREIGN_TABLES)
    if ok:
        for t in FOREIGN_TABLES:
            v = fr[t]
            if not (isinstance(v, dict) and sorted(v) == ['gone_or_changed'] and is_int(v['gone_or_changed']) and v['gone_or_changed'] == 0):
                ok = False
    shown = {t: (f"{v.get('gone_or_changed')} gone or changed" if isinstance(v, dict) else repr(v))
             for t, v in fr.items()} if isinstance(fr, dict) else repr(fr)
    return ok, f"{'OK  ' if ok else 'BAD '} rows that existed before the fixtures: {json.dumps(shown)}"


def probe_ok(res):
    p = res.get('lock_probe')
    ok = isinstance(p, dict) and p.get('error') is None and p.get('control_seen') is True and p.get('before') == [] and p.get('after_unwind') == []
    mode = 'none' if isinstance(p, dict) and p.get('after_revoke') == [] else json.dumps(p.get('after_revoke') if isinstance(p, dict) else None)
    return ok, f"{'OK  ' if ok else 'BAD '} lock probe: relation locks taken by the REVOKE statements: {mode}; positive control seen: " \
               f"{p.get('control_seen') if isinstance(p, dict) else None}"


def report(raw, mode='full'):
    res, err = unwrap(raw, 'H4265_RESULT')
    if err:
        return [err, 'NOT OK'], 1
    out, bad = [], 0
    ap = res.get('apply') or {}
    ap_ok = ap == {'ledger': 1, 'service_role_items': ''}
    out.append(f"{'OK  ' if ap_ok else 'BAD '} apply {json.dumps(ap)[:300]}")
    bad += 0 if ap_ok else 1
    p_ok, p_line = probe_ok(res)
    out.append(p_line)
    bad += 0 if p_ok else 1
    if res.get('mode') != mode:
        out.append(f'BAD  mode {res.get("mode")!r}, expected {mode!r}')
        bad += 1
    nb = res.get('neg_before') or {}
    for c in NEG_BEFORE:
        good = str(nb.get(c, '')).startswith('FAIL')
        out.append(f"{'NEG_OK' if good else 'NEG_FAILED'} before the apply {c} must FAIL: {str(nb.get(c))[:300]}")
        bad += 0 if good else 1
    ctl = res.get('controls') or {}
    names = CONTROLS if mode == 'full' else ['c01_privileges']
    for c in names:
        v = ctl.get(c)
        ok = v == 'PASS'
        bad += 0 if ok else 1
        out.append(f"{'PASS' if ok else 'BAD '} control {c}: {str(v)[:600]}")
    muts = MUTS if mode == 'full' else [m for m in MUTS if m[0] == STRUCTURE_MUTANT]
    n_mut = 0
    for mid, _l, _p, prim in muts:
        n_mut += 1
        o = res.get(f'mutant:{mid}')
        if not isinstance(o, dict) or o.get('applied') is not True or 'error' in o:
            tag = 'NOT_APPLIED' if not isinstance(o, dict) or o.get('applied') is not True else 'CRASH'
            out.append(f'{tag} {mid} -> {json.dumps(o)[:400]}')
            bad += 1
            continue
        miss = []
        for c, detail in prim.items():
            v = str(o.get(c))
            if not v.startswith('FAIL') or (detail is not None and v != 'FAIL: ' + detail):
                miss.append(f'{c}={v[:200]}')
        if miss:
            out.append(f"NOT_CAUGHT {mid}: {'; '.join(miss)}")
            bad += 1
        else:
            out.append(f"CAUGHT {mid} by FAIL in {', '.join(prim)}")
    o = res.get(f'mutant:{NEG[0]}')
    neg_good = isinstance(o, dict) and o.get('applied') is False and o.get('error') == NOT_APPLIED_ERROR
    out.append(f"{'NEG_OK' if neg_good else 'NEG_FAILED'} {NEG[0]} -> {json.dumps(o)[:300]}")
    bad += 0 if neg_good else 1
    if res.get('fp_end') != res.get('baseline_fp'):
        out.append('BAD  fingerprint at the end differs from the baseline')
        bad += 1
    if mode == 'structure':
        fp = res.get('fingerprints') or {}
        if not fp.get('first') or fp.get('first') != fp.get('second'):
            out.append(f'BAD  fingerprints {fp}')
            bad += 1
    rb, st = res.get('rollback'), res.get('rb_state') or {}
    rb_ok = rb == 'ok' and st == {'service_role_items_differ': '', 'other_roles_same': True, 'ledger': 0}
    out.append(f"{'OK  ' if rb_ok else 'BAD '} rollback {rb!r} state {json.dumps(st)}")
    bad += 0 if rb_ok else 1
    f_ok, f_line = foreign_ok(res)
    out.append(f_line)
    bad += 0 if f_ok else 1
    out.append(f"report only: cascade {json.dumps(res.get('report_cascade'))}; "
               f"functions service_role can execute {json.dumps(res.get('fn_service_role'))[:600]}")
    out.append(f'controls={len(names)} mutant_entries={n_mut + 1} (real={n_mut} + negative_control_required_not_applied=1) problems={bad}')
    if mode == 'structure':
        out.append('structure: OK' if bad == 0 else 'structure: NOT OK')
    return out, 1 if bad else 0


def report_fixtures(raw):
    res, err = unwrap(raw, 'H4265_FIXTURES')
    if err:
        return [err, 'NOT OK'], 1
    want = {'fx_users': 2, 'fx_m_inact': 1, 'fx_k2': 1, 'fx_texts': 3}
    bad = [k for k, v in want.items() if res.get(k) != v]
    out = ['the database answered with its marker H4265_FIXTURES (one RAISE, kt-sql: HTTP 400)']
    out += [f"{'OK  ' if k not in bad else 'BAD '} {k} = {json.dumps(res.get(k))} (want {json.dumps(v)})" for k, v in want.items()]
    p_ok, p_line = probe_ok(res)
    out.append(p_line)
    if not p_ok:
        bad.append('lock_probe')
    f_ok, f_line = foreign_ok(res)
    out.append(f_line)
    if not f_ok:
        bad.append('foreign_rows')
    # the reporter's own verdict line (the database never prints this; it prints H4265_FIXTURES)
    out.append('H4265_FIXTURES_OK' if not bad else 'NOT OK')
    return out, 1 if bad else 0


def selftest(green_ok=False):
    """report() on canned outputs. With green_ok (the selftest's own control) a missed mutant is expected to read OK, so
    the selftest must then FAIL: proof that it can."""
    def env(marker, obj):
        return json.dumps({'message': f'Failed to run sql query: ERROR:  P0001: {marker} ' + json.dumps(obj) + '\nCONTEXT:  x'}) + '\nkt-sql: HTTP 400\n'
    probe = {'before': [], 'after_revoke': [], 'after_lock': [{'rel': 'cloud_deal_messages', 'mode': 'AccessShareLock'}], 'error': None,
             'control_seen': True, 'after_unwind': []}
    good = {'mode': 'full', 'apply': {'ledger': 1, 'service_role_items': ''}, 'lock_probe': probe,
            'neg_before': {c: 'FAIL: x' for c in NEG_BEFORE}, 'controls': {c: 'PASS' for c in CONTROLS}, 'baseline_fp': 'x', 'fp_end': 'x',
            'rollback': 'ok', 'rb_state': {'service_role_items_differ': '', 'other_roles_same': True, 'ledger': 0},
            'foreign_rows': {t: {'gone_or_changed': 0} for t in FOREIGN_TABLES},
            f'mutant:{NEG[0]}': {'applied': False, 'error': NOT_APPLIED_ERROR, 'want': 'not_applied'}}
    for mid, _l, _p, prim in MUTS:
        good[f'mutant:{mid}'] = dict({c: ('FAIL: ' + d if d is not None else 'FAIL: x') for c, d in prim.items()}, applied=True, want='red')
    cases = [('all good', good, 0)]
    c = lambda: json.loads(json.dumps(good))
    b = c(); b['controls']['c05_tools_as_anon'] = 'FAIL: x'; cases.append(('a control fails', b, 1))
    b = c(); b['mutant:M02_block_B_left']['c14_statements_b'] = 'PASS'; cases.append(('a mutant not caught', b, 0 if green_ok else 1))
    b = c(); b['mutant:M01_mcp_tokens_left']['c01_privileges'] = 'FAIL: mcp_settings,mcp_tokens'; cases.append(('a mutant red on the wrong relations', b, 1))
    b = c(); b['neg_before']['c01_privileges'] = 'PASS'; cases.append(('a control passes before the apply', b, 1))
    b = c(); b['lock_probe']['control_seen'] = False; cases.append(('lock probe without its positive control', b, 1))
    b = c(); b['lock_probe']['before'] = [{'rel': 'mcp_tokens', 'mode': 'AccessShareLock'}]; cases.append(('a lock held before the probe', b, 1))
    b = c(); b['foreign_rows']['cloud_deals']['gone_or_changed'] = 1; cases.append(('a foreign row changed', b, 1))
    b = c(); del b['foreign_rows']['auth.users']; cases.append(('foreign-row check without one table', b, 1))
    b = c(); b['foreign_rows']['mcp_tokens']['gone_or_changed'] = True; cases.append(('foreign-row count a boolean', b, 1))
    b = c(); b['foreign_rows']['mcp_tokens']['before'] = 3; cases.append(('a whole-table count in the result', b, 1))
    b = c(); b['mutant:M09_scrub_invoker']['c04_erase_as_service_role'] = 'ERROR XX000 boom'; cases.append(('a mutant ERROR', b, 1))
    b = c(); b[f'mutant:{NEG[0]}'] = {'applied': True, 'want': 'not_applied'}; cases.append(('negative control applied', b, 1))
    b = c(); del b[f'mutant:{NEG[0]}']; cases.append(('negative control missing', b, 1))
    b = c(); b['fp_end'] = 'y'; cases.append(('fingerprint changed', b, 1))
    b = c(); b['rollback'] = 'ERROR'; cases.append(('rollback failed', b, 1))
    b = c(); b['apply']['service_role_items'] = 'cloud_blobs'; cases.append(('apply left an item', b, 1))
    fails = 0
    for name, obj, want in cases:
        _o, rc = report(env('H4265_RESULT', obj), 'full')
        ok = rc == want
        fails += 0 if ok else 1
        print(('ok   ' if ok else 'FAIL ') + name)
    _o, rc = report(json.dumps([{'line': 'x'}]) + '\nkt-sql: HTTP 200\n', 'full')
    print(('ok   ' if rc == 1 else 'FAIL ') + 'committed call (HTTP 200) refused'); fails += 0 if rc == 1 else 1
    _o, rc = report(env('H4265_RESULT', good) + 'kt-sql: HTTP 400\n', 'full')
    print(('ok   ' if rc == 1 else 'FAIL ') + 'two status lines refused'); fails += 0 if rc == 1 else 1
    fx = {'fx_users': 2, 'fx_m_inact': 1, 'fx_k2': 1, 'fx_texts': 3, 'lock_probe': probe, 'foreign_rows': good['foreign_rows']}
    for name, obj, want in [('fixtures good', fx, 0), ('fixtures: K2 missing', dict(fx, fx_k2=0), 1),
                            ('fixtures: a foreign row changed', dict(fx, foreign_rows=dict(fx['foreign_rows'], mcp_tokens={'gone_or_changed': 1})), 1)]:
        _o, rc = report_fixtures(env('H4265_FIXTURES', obj))
        ok = rc == want
        fails += 0 if ok else 1
        print(('ok   ' if ok else 'FAIL ') + name)
    print('selftest: OK' if fails == 0 else f'selftest: {fails} FAILED')
    return 1 if fails else 0


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['check']:
        import importlib.util as _ilu
        _cs = _ilu.spec_from_file_location('call_shape4263', os.path.join(HERE, '..', 'backlog-4263-sync2-t', 'call_shape.py'))
        call_shape = _ilu.module_from_spec(_cs); _cs.loader.exec_module(call_shape)
        _classes = {'harness-4265.sql': 'rolled_back', 'harness-4265-fixtures.sql': 'rolled_back', 'harness-4265-structure.sql': 'rolled_back', 'apply-20261123160000.sql': 'commits', 'rollback-20261123160000.sql': 'commits', 'dryrun-foreign-rows.sql': 'fragment'}
        assert _classes == CLASSES
        if not call_shape.gen_check(HERE, {'harness-4265.sql': 'rolled_back', 'harness-4265-fixtures.sql': 'rolled_back', 'harness-4265-structure.sql': 'rolled_back', 'apply-20261123160000.sql': 'commits', 'rollback-20261123160000.sql': 'commits', 'dryrun-foreign-rows.sql': 'fragment'}):
            sys.exit(1)
        _ccs = _ilu.spec_from_file_location('casts4263', os.path.join(HERE, '..', 'backlog-4263-sync2-t', 'casts.py'))
        casts = _ilu.module_from_spec(_ccs); _ccs.loader.exec_module(casts)
        _cast = [(k, x) for k, v in OUTS.items() if k.endswith('.sql') for x in casts.findings(v)]
        _cast += [(f'lib/{n}.sql', x) for n, v in LIB.items() for x in casts.findings(v)] + [('migration', x) for x in casts.findings(MIG)]
        for _k, _x in _cast:
            print('CAST', _k, _x)
        print(f'cast check: {len([k for k in OUTS if k.endswith(".sql")]) + len(LIB) + 1} files, {len(_cast)} findings')
        if _cast:
            sys.exit(1)
        bad = [k for k, v in OUTS.items() if not os.path.exists(os.path.join(HERE, k)) or open(os.path.join(HERE, k), encoding='utf-8').read() != v]
        print('differs: ' + ', '.join(bad) if bad else 'all generated files match')
        print(f'{len(MUTS)} mutants, every fragment matched exactly once; 1 negative control; {len(CONTROLS)} controls')
        sys.exit(1 if bad else 0)
    if a[:1] == ['selftest']:
        sys.exit(selftest(green_ok=len(a) > 1 and a[1] == '--control-green-ok'))
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
    print('controls', len(CONTROLS), '| mutants', len(MUTS), '+ negative 1')
