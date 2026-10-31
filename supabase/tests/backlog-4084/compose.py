#!/usr/bin/env python3
"""BACKLOG-4084: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> <modes> [--with-migration]
--with-migration puts the migration in front TWICE (the second apply proves it is idempotent).
The controls end in RAISE, so the whole call rolls back (migration included when composed in).
The migration and rollback files are embedded so C6 can run them inside a subtransaction.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261031180000_backlog_4084_report_default_view.sql')
out, modes = sys.argv[1], sys.argv[2]
ctl = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback-4084.sql')).read()
m = open(mig).read()
assert ctl.count('ARRAY[__MODES__]') == 1 and ctl.count('__ROLLBACK__') == 1 and ctl.count('__MIGRATION__') == 1
assert '$rb$' not in rb and '$mg$' not in m
ctl = ctl.replace('ARRAY[__MODES__]', 'ARRAY[' + ','.join("'%s'" % x.strip() for x in modes.split(',')) + ']')
ctl = ctl.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m)
text = (m + '\n' + m + '\n' if '--with-migration' in sys.argv[3:] else '') + ctl
open(out, 'w').write(text)
print(out, len(text))
