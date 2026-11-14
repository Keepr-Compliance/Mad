#!/usr/bin/env python3
"""BACKLOG-4212 PR1: build ONE SQL text for ONE kt-sql call on keepr-test.

Usage: compose.py <out.sql>

The call is one transaction that ends in RAISE, so nothing persists. In order:
  P   record the validator keepr-test has now (4175): definition md5, ACL, attributes, and which
      corpus rows it answers differently from the corpus (expected: the userSuppressMinAnswers
      rows 0, 2 and 20, which 4175 refuses)
  A   apply migration 20261116100000 TWICE (idempotent), then: corpus (supabase/tests/backlog-4175/
      corpus.json) all agree; every SQL reason equals admin-portal/__tests__/sender-rules-4186/
      corpus-sql-reasons.json; ACL unchanged and closed to anon/authenticated; IMMUTABLE, SECURITY
      INVOKER, search_path ''; the CHECK still calls the validator; every stored row still passes;
      a row with the key inserts, a row with the key out of range is refused by the CHECK
  M   three mutations of the migration, each an exact-string replace on the clean file text
      (required to match once, else this script exits), applied with CREATE OR REPLACE, proven
      applied by reading pg_get_functiondef, then the corpus reds are recorded
  R   run rollback-4212.sql: the definition md5 and ACL equal P again
Output: RAISE 'P4212_RESULT {...}'.
"""
import difflib, json, os, sys

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.abspath(os.path.join(here, '..', '..', '..'))
MIG = os.path.join(root, 'supabase/migrations/20261116100000_backlog_4212_user_suppress_threshold.sql')
RB = os.path.join(here, 'rollback-4212.sql')
CORPUS = os.path.join(root, 'supabase/tests/backlog-4175/corpus.json')
REASONS = os.path.join(root, 'admin-portal/__tests__/sender-rules-4186/corpus-sql-reasons.json')

THREE = "ARRAY['minCensusLinkedEmails', 'reportSendIntervalHours', 'reportMaxRows'])"
FOUR_LINE = ("\n          OR public._sender_rule_set_keys_exact(p->'thresholds', ARRAY['minCensusLinkedEmails', "
             "'reportSendIntervalHours', 'reportMaxRows', 'userSuppressMinAnswers'])) THEN")
MUTATIONS = {
    # M9: the server refuses the key the app accepts
    'M9_sql_refuses_key': (FOUR_LINE, ") THEN"),
    # range: no upper bound on the server
    'MR_sql_no_upper_bound': ("{thresholds,userSuppressMinAnswers}', 0, 20)",
                              "{thresholds,userSuppressMinAnswers}', 0, 9007199254740991)"),
    # required: only the four-key object is allowed
    'MQ_sql_key_required': ("IF NOT (public._sender_rule_set_keys_exact(p->'thresholds', " + THREE + "\n          OR ",
                            "IF NOT ("),
}

out = sys.argv[1]
mig = open(MIG).read()
rb = open(RB).read()
corpus = open(CORPUS).read().strip()
reasons = json.dumps(json.load(open(REASONS)))
json.loads(corpus)
for tag in ('$cp$', '$rs$', '$q$'):
    for name, body in (('migration', mig), ('rollback', rb), ('corpus', corpus), ('reasons', reasons)):
        assert tag not in body, (tag, name)

def q(s):
    return '$q$' + s + '$q$'

parts = []
parts.append("""DO $pre$ BEGIN
  IF to_regprocedure('public._sender_rule_set_invalid(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'P4212_RESULT {"error": "the 4175 validator is not on this database"}';
  END IF;
END $pre$;
CREATE TEMP TABLE p4212 (k TEXT PRIMARY KEY, v TEXT);
CREATE TEMP TABLE p4212_corpus AS SELECT t.i, t.e FROM jsonb_array_elements($cp$""" + corpus + """$cp$::jsonb) WITH ORDINALITY AS t(e, i);
CREATE TEMP TABLE p4212_reasons AS SELECT t.i, t.e FROM jsonb_array_elements($rs$""" + reasons + """$rs$::jsonb) WITH ORDINALITY AS t(e, i);
CREATE FUNCTION pg_temp.wrong() RETURNS TEXT LANGUAGE sql AS $b$
  SELECT coalesce(string_agg(e->>'name', '; ' ORDER BY i), '') FROM pg_temp.p4212_corpus
  WHERE (public._sender_rule_set_invalid(e->'content') IS NULL) IS DISTINCT FROM (e->>'sql')::boolean
$b$;
CREATE FUNCTION pg_temp.nwrong() RETURNS BIGINT LANGUAGE sql AS $b$
  SELECT count(*) FROM pg_temp.p4212_corpus
  WHERE (public._sender_rule_set_invalid(e->'content') IS NULL) IS DISTINCT FROM (e->>'sql')::boolean
$b$;
CREATE FUNCTION pg_temp.def() RETURNS TEXT LANGUAGE sql AS $b$
  SELECT pg_get_functiondef('public._sender_rule_set_invalid(jsonb)'::regprocedure)
$b$;
CREATE FUNCTION pg_temp.acl() RETURNS TEXT LANGUAGE sql AS $b$
  SELECT coalesce(proacl::text, '<null>') FROM pg_proc WHERE oid = 'public._sender_rule_set_invalid(jsonb)'::regprocedure
$b$;
CREATE FUNCTION pg_temp.attrs() RETURNS TEXT LANGUAGE sql AS $b$
  SELECT provolatile || '|' || prosecdef || '|' || coalesce(proconfig::text, '<null>') || '|' || l.lanname
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public._sender_rule_set_invalid(jsonb)'::regprocedure
$b$;
INSERT INTO pg_temp.p4212 VALUES
  ('P_md5', md5(pg_temp.def())), ('P_acl', pg_temp.acl()), ('P_attrs', pg_temp.attrs()), ('P_wrong', pg_temp.wrong()),
  ('P_corpus_n', (SELECT count(*) FROM pg_temp.p4212_corpus)::text);
""")
parts.append(mig)
parts.append(mig)
parts.append("""DO $a$
DECLARE v_s TEXT; v_n BIGINT; v_cnt BIGINT; v_ver BIGINT; v_c JSONB;
BEGIN
  INSERT INTO pg_temp.p4212 VALUES ('A_md5_changed', CASE WHEN md5(pg_temp.def()) <> (SELECT x.v FROM pg_temp.p4212 x WHERE x.k = 'P_md5') THEN 'PASS' ELSE 'FAIL same definition' END);
  v_s := pg_temp.wrong();
  v_n := (SELECT count(*) FROM pg_temp.p4212_corpus);
  INSERT INTO pg_temp.p4212 VALUES ('A_corpus_sql_side', CASE WHEN v_s = '' AND v_n = 296 THEN 'PASS' ELSE 'FAIL n=' || v_n || ' wrong: ' || v_s END);
  SELECT coalesce(string_agg(coalesce(cc.e->>'name', rr.e->>'name'), '; ' ORDER BY coalesce(cc.i, rr.i)), '') INTO v_s
  FROM pg_temp.p4212_corpus cc FULL JOIN pg_temp.p4212_reasons rr ON rr.i = cc.i
  WHERE cc.e IS NULL OR rr.e IS NULL OR cc.e->>'name' IS DISTINCT FROM rr.e->>'name'
     OR public._sender_rule_set_invalid(cc.e->'content') IS DISTINCT FROM rr.e->>'reason';
  INSERT INTO pg_temp.p4212 VALUES ('A_reasons_match_admin_json', CASE WHEN v_s = '' THEN 'PASS' ELSE 'FAIL ' || v_s END);
  INSERT INTO pg_temp.p4212 VALUES ('A_acl_unchanged', CASE WHEN pg_temp.acl() = (SELECT x.v FROM pg_temp.p4212 x WHERE x.k = 'P_acl') THEN 'PASS ' || pg_temp.acl() ELSE 'FAIL ' || pg_temp.acl() END);
  INSERT INTO pg_temp.p4212 VALUES ('A_no_client_execute', CASE WHEN NOT has_function_privilege('anon', 'public._sender_rule_set_invalid(jsonb)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._sender_rule_set_invalid(jsonb)', 'EXECUTE') THEN 'PASS' ELSE 'FAIL ' || pg_temp.acl() END);
  INSERT INTO pg_temp.p4212 VALUES ('A_attrs', CASE WHEN pg_temp.attrs() = (SELECT x.v FROM pg_temp.p4212 x WHERE x.k = 'P_attrs') AND pg_temp.attrs() LIKE 'i|false|%search_path%|plpgsql' THEN 'PASS ' || pg_temp.attrs() ELSE 'FAIL ' || pg_temp.attrs() END);
  SELECT pg_get_constraintdef(pc.oid) INTO v_s FROM pg_constraint pc WHERE pc.conname = 'sender_rule_sets_content_valid' AND pc.conrelid = 'public.sender_rule_sets'::regclass;
  INSERT INTO pg_temp.p4212 VALUES ('A_check_calls_validator', CASE WHEN v_s LIKE '%_sender_rule_set_invalid(content) IS NULL%' THEN 'PASS' ELSE 'FAIL ' || coalesce(v_s, '<no constraint>') END);
  SELECT count(*) FILTER (WHERE public._sender_rule_set_invalid(rs.content) IS NOT NULL), count(*) INTO v_n, v_cnt FROM public.sender_rule_sets rs;
  INSERT INTO pg_temp.p4212 VALUES ('A_stored_rows_valid', CASE WHEN v_n = 0 AND v_cnt > 0 THEN 'PASS rows=' || v_cnt ELSE 'FAIL invalid=' || v_n || ' of ' || v_cnt END);
  v_ver := (SELECT max(rs.version) FROM public.sender_rule_sets rs) + 1000;
  v_c := (SELECT cc.e->'content' FROM pg_temp.p4212_corpus cc WHERE cc.e->>'name' = 'userSuppressMinAnswers: 2');
  BEGIN
    INSERT INTO public.sender_rule_sets (version, content, released, bundled, canary_org, published_by)
    VALUES (v_ver, jsonb_set(v_c, '{version}', to_jsonb(v_ver)), false, false, gen_random_uuid(), NULL);
    v_s := 'inserted';
  EXCEPTION WHEN OTHERS THEN v_s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
  INSERT INTO pg_temp.p4212 VALUES ('A_insert_with_key', CASE WHEN v_s = 'inserted' THEN 'PASS' ELSE 'FAIL ' || v_s END);
  BEGIN
    INSERT INTO public.sender_rule_sets (version, content, released, bundled, canary_org, published_by)
    VALUES (v_ver + 1, jsonb_set(jsonb_set(v_c, '{version}', to_jsonb(v_ver + 1)), '{thresholds,userSuppressMinAnswers}', '21'), false, false, gen_random_uuid(), NULL);
    v_s := 'inserted';
  EXCEPTION WHEN OTHERS THEN v_s := SQLSTATE || ' ' || left(SQLERRM, 120);
  END;
  INSERT INTO pg_temp.p4212 VALUES ('A_check_refuses_21', CASE WHEN v_s LIKE '23514 %sender_rule_sets_content_valid%' THEN 'PASS' ELSE 'FAIL ' || v_s END);
END $a$;
""")

report = []
for name, (old, new) in MUTATIONS.items():
    n = mig.count(old)
    if n != 1:
        sys.exit('%s: MUTATION NOT APPLIED, fragment matched %d times' % (name, n))
    mutated = mig.replace(old, new)
    diff = [l for l in difflib.unified_diff(mig.splitlines(), mutated.splitlines(), lineterm='', n=0)
            if l[:1] in '+-' and not l.startswith(('+++', '---'))]
    added = sum(1 for l in diff if l[0] == '+'); removed = sum(1 for l in diff if l[0] == '-')
    report.append('== %s\nMUTATION APPLIED (text) numstat=%d/%d\n%s' % (
        name, added, removed, '\n'.join('  %s %s' % (l[0], l[1:].strip()[:160]) for l in diff)))
    parts.append(mutated)
    present = new.strip()
    parts.append("""DO $m$
DECLARE d TEXT := pg_temp.def();
BEGIN
  INSERT INTO pg_temp.p4212 VALUES (%s,
    CASE WHEN position(%s IN d) = 0 AND position(%s IN d) > 0
         THEN 'applied n=' || pg_temp.nwrong() || ' reds=[' || left(pg_temp.wrong(), 400) || ']'
         ELSE 'NOT APPLIED (definition unchanged)' END);
END $m$;
""" % (q(name), q(old), q(present)))

parts.append(rb)
parts.append("""DO $r$ BEGIN
  INSERT INTO pg_temp.p4212 VALUES ('R_rollback_restores_4175', CASE
    WHEN md5(pg_temp.def()) = (SELECT v FROM pg_temp.p4212 WHERE k = 'P_md5')
     AND pg_temp.acl() = (SELECT v FROM pg_temp.p4212 WHERE k = 'P_acl')
     AND pg_temp.wrong() = (SELECT v FROM pg_temp.p4212 WHERE k = 'P_wrong')
    THEN 'PASS' ELSE 'FAIL md5/acl/wrong differ: ' || pg_temp.wrong() END);
END $r$;
DO $z$ BEGIN
  RAISE EXCEPTION 'P4212_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p4212);
END $z$;
""")

text = '\n'.join(parts)
open(out, 'w').write(text)
print('\n'.join(report))
print('composed', out, len(text), 'bytes')
