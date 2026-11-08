#!/usr/bin/env python3
"""BACKLOG-4045b: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> <modes> [--with-migration]
The controls end in RAISE, so the whole call rolls back (migration included when composed in).
__GUARD__ becomes the migration's own guard DO block, dollar-quoted, so G_guard runs that exact text.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig_path = os.path.join(here, '..', '..', 'migrations', '20261107160000_backlog_4045_auto_renew_notify_choice.sql')
out, modes = sys.argv[1], sys.argv[2]
mig = open(mig_path).read()
a = mig.index('DO $guard$')
b = mig.index('\n$guard$;', a) + len('\n$guard$')
guard = mig[a:b]
assert guard.startswith('DO $guard$') and guard.endswith('$guard$') and '$gq$' not in guard
ctl = open(os.path.join(here, 'controls.sql')).read()
assert ctl.count('ARRAY[__MODES__]') == 1 and ctl.count('__GUARD__') == 1
ctl = ctl.replace('ARRAY[__MODES__]', 'ARRAY[' + ','.join("'%s'" % m.strip() for m in modes.split(',')) + ']')
ctl = ctl.replace('__GUARD__', '$gq$' + guard + '$gq$')
text = (mig + '\n' if '--with-migration' in sys.argv[3:] else '') + ctl
open(out, 'w').write(text)
print(out, len(text))
