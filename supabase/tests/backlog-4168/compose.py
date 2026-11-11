#!/usr/bin/env python3
"""BACKLOG-4168: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> baseline|controls [--pre] [--with-migration] [--want PRE|POST]
--pre puts rollback-4168.sql in front, so the call starts from the pre-migration state whatever
keepr-test currently holds. --with-migration implies --pre, then applies the migration TWICE (the
second apply proves it re-runs cleanly), then 20261111120000 (BACKLOG-4170 PR3) in version order.
Every call ends in RAISE, so the whole call rolls back (migration included when composed in).
controls embeds the migration and rollback files so K-checks can run them inside a subtransaction.
The migration is read from the working tree, so a mutation applied to the file by mutate.py is
what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261107100000_backlog_4168_admin_role_ceiling.sql')
# BACKLOG-4170 PR3 re-keys internal_users_read_invitations; replayed after 4168 in version order
pr3 = os.path.join(here, '..', '..', 'migrations', '20261111120000_backlog_4170_shared_table_policies.sql')
out, which = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
want = args[args.index('--want') + 1] if '--want' in args else 'POST'
assert want in ('PRE', 'POST')
pre = open(os.path.join(here, 'prelude.sql')).read()
body = open(os.path.join(here, which + '.sql')).read()
rb = open(os.path.join(here, 'rollback-4168.sql')).read()
m = open(mig).read()
m3 = open(pr3).read()
for tag in ('$rb$', '$mg$', '$drv$', '$p3$'):
    assert tag not in rb and tag not in m and tag not in m3, tag
if which == 'controls':
    assert body.count('__ROLLBACK__') == 1 and body.count('__MIGRATION__') == 1 and body.count('__PR3__') == 1
    body = body.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m).replace('__PR3__', m3)
text = (rb + '\n' if ('--pre' in args or '--with-migration' in args) else '')
text += (m + '\n' + m + '\n' + m3 + '\n' if '--with-migration' in args else '')
text += "SELECT set_config('p4168.want', '%s', false);\n" % want + pre + '\n' + body
open(out, 'w').write(text)
print(out, len(text))
