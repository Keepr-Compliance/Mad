#!/usr/bin/env python3
"""BACKLOG-4086: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> <modes> [--with-migration]
--with-migration puts the migration in front TWICE (the second apply proves it is idempotent).
The controls end in RAISE, so the whole call rolls back (migration included when composed in).
The rollback file is embedded so S5 can run it inside a subtransaction.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261031000000_backlog_4086_support_sla_settings.sql')
out, modes = sys.argv[1], sys.argv[2]
ctl = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback-4086.sql')).read()
assert ctl.count('ARRAY[__MODES__]') == 1 and ctl.count('__ROLLBACK__') == 1 and '$rb$' not in rb
ctl = ctl.replace('ARRAY[__MODES__]', 'ARRAY[' + ','.join("'%s'" % m.strip() for m in modes.split(',')) + ']')
ctl = ctl.replace('__ROLLBACK__', rb)
m = open(mig).read()
text = (m + '\n' + m + '\n' if '--with-migration' in sys.argv[3:] else '') + ctl
open(out, 'w').write(text)
print(out, len(text))
