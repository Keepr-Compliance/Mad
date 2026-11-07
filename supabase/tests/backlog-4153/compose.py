#!/usr/bin/env python3
"""BACKLOG-4153: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> <modes> [--migration N]
  <modes>        comma list of mode names (see controls.sql apply_mode)
  --migration N  prepend the 4153 migration N times (N=2 proves the re-run is a no-op that
                 still passes the pre/post checks). Omit to run against the current body.
The controls end in RAISE, so the whole call rolls back.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261106120000_backlog_4153_unlock_unassigned_guard.sql')
out, modes = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
n = int(args[args.index('--migration') + 1]) if '--migration' in args else 0
ctl = open(os.path.join(here, 'controls.sql')).read()
ctl = ctl.replace('__MODES__', ','.join("'%s'" % m.strip() for m in modes.split(',')))
guard = open(os.path.join(here, 'guard.txt')).read()
assert '$g$' not in guard and ctl.count('__GUARD__') == 1
ctl = ctl.replace('__GUARD__', '$g$' + guard + '$g$')
text = (open(mig).read() + '\n') * n + ctl
open(out, 'w').write(text)
print(out, len(text), 'migration x', n)
