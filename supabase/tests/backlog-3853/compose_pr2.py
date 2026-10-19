#!/usr/bin/env python3
"""BACKLOG-3853 PR-2: build one SQL text for a single execute_sql call on keepr-test.

Usage: compose_pr2.py <out.sql> <modes> [--with-migration]
The controls end in RAISE, so the whole call rolls back (migration included).
The prior function bodies (the "today's code" mutants) come from rollback-3853-pr2.sql.
"""
import os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261019090000_backlog_3853_subscription_engine.sql')
out, modes = sys.argv[1], sys.argv[2]
rb = open(os.path.join(here, 'rollback-3853-pr2.sql')).read()
def block(name):
    m = re.search(r'-- <<%s\n(.*?)\n-- %s>>' % (name, name), rb, re.S)
    assert m, name
    return m.group(1)
ctl = open(os.path.join(here, 'pr2-controls.sql')).read()
for ph, name in (('__PR1_APPLY__', 'PR1_APPLY'), ('__PR1_AUTO__', 'PR1_AUTO'), ('__PF_BEFORE__', 'PF_BEFORE')):
    assert ctl.count(ph) == 1, ph
    body = block(name)
    assert '$pr1a$' not in body and '$pr1b$' not in body and '$pfb$' not in body
    ctl = ctl.replace(ph, body)
assert ctl.count('ARRAY[__MODES__]') == 1
ctl = ctl.replace('ARRAY[__MODES__]', 'ARRAY[' + ','.join("'%s'" % m.strip() for m in modes.split(',')) + ']')
text = (open(mig).read() + '\n' if '--with-migration' in sys.argv[3:] else '') + ctl
open(out, 'w').write(text)
print(out, len(text))
