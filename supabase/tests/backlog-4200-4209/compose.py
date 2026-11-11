#!/usr/bin/env python3
"""BACKLOG-4200 + 4209: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> <modes> [--with-migration]
The controls end in RAISE, so the whole call rolls back (migrations included when composed in).
__GUARD4200__ / __GUARD4209__ become each migration's own guard DO block, dollar-quoted, so
G_guard_4200 / G_guard_4209 run that exact text.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig_dir = os.path.join(here, '..', '..', 'migrations')
MIGS = ['20261108170000_backlog_4200_auto_renew_off_notify.sql', '20261108180000_backlog_4209_org_reinstated_notify.sql']
out, modes = sys.argv[1], sys.argv[2]
migs = [open(os.path.join(mig_dir, m)).read() for m in MIGS]


def guard(mig):
    a = mig.index('DO $guard$')
    b = mig.index('\n$guard$;', a) + len('\n$guard$')
    g = mig[a:b]
    assert g.startswith('DO $guard$') and g.endswith('$guard$') and '$gq$' not in g
    return '$gq$' + g + '$gq$'


ctl = open(os.path.join(here, 'controls.sql')).read()
for tok in ('ARRAY[__MODES__]', '__GUARD4200__', '__GUARD4209__'):
    assert ctl.count(tok) == 1, tok
ctl = ctl.replace('ARRAY[__MODES__]', 'ARRAY[' + ','.join("'%s'" % m.strip() for m in modes.split(',')) + ']')
ctl = ctl.replace('__GUARD4200__', guard(migs[0])).replace('__GUARD4209__', guard(migs[1]))
text = (''.join(m + '\n' for m in migs) if '--with-migration' in sys.argv[3:] else '') + ctl
assert 'COMMIT' not in text.upper().replace('COMMITTED', '')
open(out, 'w').write(text)
print(out, len(text))
