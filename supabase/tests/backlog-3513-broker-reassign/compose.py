#!/usr/bin/env python3
"""BACKLOG-3513 PR-3f (migration 20261112220000): build one SQL text for a single kt-sql call on keepr-test.

keepr-test has 20261112200000 and 20261112210000 COMMITTED; this composes on top of them:
tracking off; 20261112220000 twice (the second apply proves the pin's second-run branch); the PR-2
prelude (fixtures); controls.sql here. The controls end in RAISE, so the whole call rolls back.
Usage: compose.py <out.sql>
The migration is read from the working tree, so a mutation applied by mutate.py is what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
p2 = os.path.join(here, '..', 'backlog-3513-broker')
m220 = open(os.path.join(here, '..', '..', 'migrations', '20261112220000_backlog_3513_broker_report_reassign.sql')).read()
pre = open(os.path.join(p2, 'prelude.sql')).read()
ctl = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback.sql')).read()
assert ctl.count('__ROLLBACK__') == 1 and ctl.count('__MIGRATION__') == 1
for tag in ('$rb$', '$mg$', '$b$', '$q$', '$drv$'):
    assert tag not in rb and tag not in m220, tag
ctl = ctl.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m220)
text = "set local pg_stat_statements.track = 'none';\n" + m220 + '\n' + m220 + '\n' + pre + '\n' + ctl
open(sys.argv[1], 'w').write(text)
print(sys.argv[1], len(text))
