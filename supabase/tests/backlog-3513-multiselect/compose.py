#!/usr/bin/env python3
"""BACKLOG-3513 PR-3h (migration 20261114100000): build one SQL text for a single kt-sql call on keepr-test.

keepr-test has 20261112200000 COMMITTED; this composes on top of it: tracking off; 20261114100000
twice (the second apply proves the pin's second-run branch); the PR-2 prelude (fixtures); controls.sql
here. The controls end in RAISE, so the whole call rolls back.
Usage: compose.py <out.sql>
The migration is read from the working tree, so a mutation applied by mutate.py is what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
p2 = os.path.join(here, '..', 'backlog-3513-broker')
mig = open(os.path.join(here, '..', '..', 'migrations', '20261114100000_backlog_3513_submissions_rows_multi.sql')).read()
pre = open(os.path.join(p2, 'prelude.sql')).read()
ctl = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback.sql')).read()
assert ctl.count('__ROLLBACK__') == 1 and ctl.count('__MIGRATION__') == 2
for tag in ('$rb$', '$mg$', '$b$', '$q$', '$drv$'):
    assert tag not in rb and tag not in mig, tag
ctl = ctl.replace('__ROLLBACK__', rb).replace('__MIGRATION__', mig)
text = "set local pg_stat_statements.track = 'none';\n" + mig + '\n' + mig + '\n' + pre + '\n' + ctl
open(sys.argv[1], 'w').write(text)
print(sys.argv[1], len(text))
