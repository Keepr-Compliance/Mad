#!/usr/bin/env python3
"""BACKLOG-4087: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> [--with-migration]
--with-migration puts the migration in front TWICE (the second apply proves it is idempotent).
The controls end in RAISE, so the whole call rolls back (migration included when composed in).
The migration and rollback files are embedded so K16/K17 can run them inside a subtransaction.
The migration is read from the working tree, so a mutation applied to the file by mutate.py is
what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261104200000_backlog_4087_report_view_shares.sql')
out = sys.argv[1]
ctl = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback-4087.sql')).read()
m = open(mig).read()
assert ctl.count('__ROLLBACK__') == 1 and ctl.count('__MIGRATION__') == 1
for tag in ('$rb$', '$mg$', '$b$', '$f$', '$drv$'):
    assert tag not in rb and tag not in m, tag
ctl = ctl.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m)
text = (m + '\n' + m + '\n' if '--with-migration' in sys.argv[2:] else '') + ctl
open(out, 'w').write(text)
print(out, len(text))
