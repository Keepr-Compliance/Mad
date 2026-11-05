#!/usr/bin/env python3
"""BACKLOG-4144 M2: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql>
The migration and the rollback are embedded in controls.sql (the controls run the rollback first, apply
the migration twice, and run the rollback again at the end). The controls end in RAISE, so the whole
call rolls back. The migration is read from the working tree, so a mutation applied to the file by
mutate.py is what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261105110000_backlog_4144_report_rls.sql')
ctl = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback-4144-rls.sql')).read()
m = open(mig).read()
assert ctl.count('__ROLLBACK__') == 2 and ctl.count('__MIGRATION__') == 2
for tag in ('$rb$', '$mg$', '$b$', '$f$', '$drv$'):
    assert tag not in rb and tag not in m, tag
text = ctl.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m)
open(sys.argv[1], 'w').write(text)
print(sys.argv[1], len(text))
