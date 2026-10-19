#!/usr/bin/env python3
"""BACKLOG-3853 PR-2A: build one SQL text for a single execute_sql call on keepr-test.

Usage: compose_pr2a.py <out.sql> <modes> [--with-migration]
The controls end in RAISE, so the whole call rolls back (migration included).
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261019030000_backlog_3853_admin_save_deal.sql')
out, modes = sys.argv[1], sys.argv[2]
ctl = open(os.path.join(here, 'pr2a-controls.sql')).read()
assert ctl.count('ARRAY[__MODES__]') == 1
ctl = ctl.replace('ARRAY[__MODES__]', 'ARRAY[' + ','.join("'%s'" % m.strip() for m in modes.split(',')) + ']')
text = (open(mig).read() + '\n' if '--with-migration' in sys.argv[3:] else '') + ctl
open(out, 'w').write(text)
print(out, len(text))
