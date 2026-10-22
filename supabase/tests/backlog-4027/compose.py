#!/usr/bin/env python3
"""BACKLOG-4027 PR-1: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> <modes> [--with-migration]
The controls end in RAISE, so the whole call rolls back (migration included when composed in).
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261021040000_backlog_4027_idp_roles.sql')
out, modes = sys.argv[1], sys.argv[2]
ctl = open(os.path.join(here, 'controls.sql')).read()
assert ctl.count('ARRAY[__MODES__]') == 1
ctl = ctl.replace('ARRAY[__MODES__]', 'ARRAY[' + ','.join("'%s'" % m.strip() for m in modes.split(',')) + ']')
text = (open(mig).read() + '\n' if '--with-migration' in sys.argv[3:] else '') + ctl
open(out, 'w').write(text)
print(out, len(text))
