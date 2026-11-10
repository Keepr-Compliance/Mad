#!/usr/bin/env python3
"""BACKLOG-3514: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> controls [--with-migration]
--with-migration puts rollback-3514.sql in front (start from the pre-migration state whatever
keepr-test holds), then applies the migration TWICE (the second apply proves it re-runs cleanly).
Without it, the controls run against the migration as applied on keepr-test.
Every call ends in RAISE, so the whole call rolls back (migration, scratch table and fixtures).
controls embeds the migration and rollback files so K1 can run them inside a subtransaction.
Files are read from the working tree, so a mutation applied by mutate.py is what runs.
Refuses to compose if any embedded file carries transaction control (BEGIN; / COMMIT;).
"""
import os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261108220000_backlog_3514_broker_saved_views.sql')
out, which = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
assert which == 'controls'
pre = open(os.path.join(here, 'prelude.sql')).read()
body = open(os.path.join(here, which + '.sql')).read()
rb = open(os.path.join(here, 'rollback-3514.sql')).read()
m = open(mig).read()
for name, t in (('rollback', rb), ('migration', m), ('prelude', pre)):
    if re.search(r'^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;', t, re.I | re.M):
        sys.exit('%s carries transaction control; refusing' % name)
for tag in ('$rb$', '$mg$', '$drv$'):
    assert tag not in rb and tag not in m, tag
assert body.count('__ROLLBACK__') == 1 and body.count('__MIGRATION__') == 1
body = body.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m)
text = (rb + '\n' + m + '\n' + m + '\n') if '--with-migration' in args else ''
text += pre + '\n' + body
open(out, 'w').write(text)
print(out, len(text))
