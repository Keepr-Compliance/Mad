#!/usr/bin/env python3
"""BACKLOG-4219 PR1: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> [--with-migration]
--with-migration puts the migration in front TWICE (the second apply proves it is idempotent).
The controls end in RAISE, so the whole call rolls back (migration included when composed in).
The rollback script is embedded so S20 can run it. Files are read from the working tree, so a
mutation applied by mutate.py is what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261112130000_backlog_4219_learn_pilot_report.sql')
out = sys.argv[1]
ctl = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback-4219.sql')).read()
m = open(mig).read()
assert ctl.count('__ROLLBACK__') == 1
for tag in ('$rb$', '$b$', '$f$', '$drv$'):
    assert tag not in rb and tag not in m, tag
ctl = ctl.replace('__ROLLBACK__', rb)
text = (m + '\n' + m + '\n' if '--with-migration' in sys.argv[2:] else '') + ctl
open(out, 'w').write(text)
print(out, len(text))
