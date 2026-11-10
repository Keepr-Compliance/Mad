#!/usr/bin/env python3
"""BACKLOG-4145 M2: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> [--applied]
Order: [--applied: record the current digest of the 13 target tables' policies] -> rollback file (so the
call always starts from the production text) -> prelude (fixtures + P0 baseline read BEFORE M2) ->
migration TWICE (the second apply proves it re-runs cleanly) -> controls.
--applied adds K0: the state keepr-test held before this call equals what the migration file produces.
Every call ends in RAISE, so the whole call rolls back. The migration is read from the working tree, so
a mutation applied to the file by mutate.py is what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261108160000_backlog_4145_shared_table_rls.sql')
out = sys.argv[1]
args = sys.argv[2:]
pre = open(os.path.join(here, 'prelude.sql')).read()
body = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback-4145-m2.sql')).read()
m = open(mig).read()
for tag in ('$rb$', '$mg$', '$drv$'):
    assert tag not in rb and tag not in m, tag
assert body.count('__ROLLBACK__') == 1 and body.count('__MIGRATION__') == 1
body = body.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m)
applied = ("CREATE TEMP TABLE p4145m2_applied AS SELECT count(*) || '/' || md5(string_agg(tablename || policyname "
           "|| permissive || cmd || roles::text || coalesce(qual, '') || coalesce(with_check, ''), ',' ORDER BY tablename, "
           "policyname)) AS d FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (ARRAY['users','organizations',"
           "'organization_members','devices','user_preferences','audit_logs','licenses','support_tickets',"
           "'support_ticket_messages','support_ticket_events','support_ticket_participants','support_ticket_attachments',"
           "'support_ticket_backlog_links']);\n")
text = (applied if '--applied' in args else '') + rb + '\n' + pre + '\n' + m + '\n' + m + '\n' + body
open(out, 'w').write(text)
print(out, len(text))
