#!/usr/bin/env python3
"""BACKLOG-3513 PR-2: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql>
Order: pg_stat_statements tracking off for the call; the migration TWICE (the second apply proves the
pin's post branch and that the file can run twice); prelude.sql; controls.sql. The controls end in
RAISE, so the whole call rolls back (migration included). The migration and rollback texts are also
embedded in controls.sql for K2/K4, which run them in a subtransaction. The migration is read from the
working tree, so a mutation applied to the file by mutate.py is what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261112200000_backlog_3513_broker_report_definitions.sql')
out = sys.argv[1]
ctl = open(os.path.join(here, 'controls.sql')).read()
pre = open(os.path.join(here, 'prelude.sql')).read()
rb = open(os.path.join(here, 'rollback.sql')).read()
m = open(mig).read()
assert ctl.count('__ROLLBACK__') == 1 and ctl.count('__MIGRATION__') == 1
for tag in ('$rb$', '$mg$', '$b$', '$q$', '$drv$'):
    assert tag not in rb and tag not in m, tag
ctl = ctl.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m)
text = "set local pg_stat_statements.track = 'none';\n" + m + '\n' + m + '\n' + pre + '\n' + ctl
open(out, 'w').write(text)
print(out, len(text))
