#!/usr/bin/env python3
"""BACKLOG-4263: (1) catalogue facts after the migration -> catalog-facts.json; (2) rollback rehearsal: migration,
fixtures with a soft-removed deal, the rollback, then every replaced body back at its traced md5, no new object,
no added column. One rolled-back kt-sql call each."""
import json, os, re, subprocess, sys, tempfile
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
import harness as H
sigs = []
for m in re.finditer(r'^CREATE OR REPLACE FUNCTION public\.(\w+)\(', H.MIG, re.M):
    sigs.append(H.unit(H.MIG, m.group(1))[2])
def regsig(s):  # 'public.f(uuid, jsonb)' -> 'f(uuid,jsonb)' as regprocedure::text prints it, resolved in SQL instead
    return s
cat = open(os.path.join(here, 'catalog.sql')).read().replace('__SIGS__', "ARRAY(SELECT x::regprocedure::text FROM unnest(ARRAY[%s]) x)" % ','.join(H.lit(s) for s in sigs))
def call(body):
    d = tempfile.mkdtemp(); p = os.path.join(d, 'c.sql')
    open(p, 'w').write(body)
    r = subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), p], capture_output=True, text=True)
    os.remove(p); os.rmdir(d)
    subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), '-c', 'select extensions.pg_stat_statements_reset()'], capture_output=True)
    msg = json.loads(r.stdout.strip().split('\n')[0]).get('message', r.stdout)
    m = re.search(r'P4263_(\w+) (\{.*\})\s*\nCONTEXT', msg, re.S)
    if not m: raise SystemExit('NO RESULT: ' + msg[:2000])
    return json.loads(m.group(2))
pre = "SET LOCAL pg_stat_statements.track = 'none';\nSET LOCAL lock_timeout = '10s';\n"
facts = call(pre + H.MIG + "\nDO $z$ BEGIN RAISE EXCEPTION 'P4263_FACTS %', (" + cat.split('\n', 2)[2] + "); END $z$;")
assert len(facts) == len(sigs), (len(facts), len(sigs))
json.dump(facts, open(os.path.join(here, 'catalog-facts.json'), 'w'), indent=1, sort_keys=True)
print('catalogue facts:', len(facts), 'functions')
traced = re.findall(r"\('(public\.[^']+)', '([0-9a-f]{32})'\)", H.MIG)
probe = """DO $z$ BEGIN RAISE EXCEPTION 'P4263_RB %%', jsonb_build_object(
 'traced_ok', (SELECT count(*) FROM (VALUES %s) v(sig, m) JOIN pg_proc p ON p.oid = to_regprocedure(v.sig) AND md5(p.prosrc) = v.m),
 'traced_total', %d,
 'new_functions', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname ~ '^_cloud_todo_' OR proname IN
     ('cloud_todo_push','cloud_todo_pull','cloud_todo_history','cloud_todo_restore','cloud_list_removed','cloud_reclaim_install','cloud_install_status','cloud_purge_deal_now'))),
 'new_tables', (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('cloud_todo_feed_head','cloud_todo_history','cloud_todo_ops','cloud_removed_installs','cloud_todo_seq')),
 'added_columns', (SELECT count(*) FROM pg_attribute WHERE attrelid IN ('public.cloud_deals'::regclass,'public.cloud_deal_checklists'::regclass,'public.cloud_deal_checklist_items'::regclass)
     AND NOT attisdropped AND attname IN ('removed_kind','restorable_until','change_seq','purged_at','due_date','done_rev','order_rev','removed_rev','created_by_kind')
     OR (attrelid = 'public.cloud_deals'::regclass AND attname = 'removed_at' AND NOT attisdropped)),
 'cron_job', (SELECT count(*) FROM cron.job WHERE jobname = 'cloud-todo-purge'),
 'soft_removed_deal_left', (SELECT count(*) FROM public.cloud_deals WHERE id = pg_temp.id('D2')),
 'old_upsert_works', (SELECT pg_temp.up(pg_temp.id('A'), 'cloud_upsert_checklist_items', pg_temp.id('I1'), pg_temp.id('D1'), jsonb_build_array(pg_temp.rw('i9', jsonb_build_object('local_checklist_id', 'cl1', 'title', 'After rollback')))) -> 'results' -> 0 ->> 'status'),
 'anon_list_same', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE')) = (SELECT count(*) FROM pg_temp.p4263_anon_before)); END $z$;""" % (
    ','.join("(%s, %s)" % (H.lit(s), H.lit(m)) for s, m in traced), len(traced))
body = (pre + "CREATE TEMP TABLE p4263_anon_before AS SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE');\n"
        + H.MIG + '\n' + H.HL + '\n' + H.FX + '\nSELECT pg_temp.base4263();\n' + H.MIG
        + "\nSELECT pg_temp.deldeal(pg_temp.id('A'), pg_temp.id('D2'));\n" + H.RB + '\n' + probe).replace('__RUN__', os.urandom(8).hex())
print('rollback rehearsal:', json.dumps(call(body), sort_keys=True))
