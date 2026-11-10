#!/usr/bin/env python3
"""BACKLOG-4145 M1: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> controls [--with-migration]
--with-migration puts rollback-4145-m1.sql in front (so the call starts from the pre-migration state
whatever keepr-test holds), snapshots every public policy, then applies the migration TWICE (the
second apply proves it re-runs cleanly). Without it, the controls run against the applied state.
Every call ends in RAISE, so the whole call rolls back (migration included when composed in).
controls embeds the migration and rollback files so K-checks can run them inside a subtransaction.
The migration is read from the working tree, so a mutation applied to the file by mutate.py is
what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261108150000_backlog_4145_shared_table_access_helpers.sql')
out, which = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
assert which == 'controls'
pre = open(os.path.join(here, 'prelude.sql')).read()
body = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback-4145-m1.sql')).read()
m = open(mig).read()
for tag in ('$rb$', '$mg$', '$drv$'):
    assert tag not in rb and tag not in m, tag
assert body.count('__ROLLBACK__') == 1 and body.count('__MIGRATION__') == 1
body = body.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m)
snap = ("CREATE TEMP TABLE p4145_policy_snapshot AS SELECT count(*) AS n, "
        "md5(string_agg(tablename || policyname || cmd || coalesce(qual, '') || coalesce(with_check, ''), ',' "
        "ORDER BY tablename, policyname)) AS digest FROM pg_policies WHERE schemaname = 'public';\n")
text = ''
if '--with-migration' in args:
    text += rb + '\n' + snap + m + '\n' + m + '\n'
else:
    text += snap
text += pre + '\n' + body
open(out, 'w').write(text)
print(out, len(text))
