#!/usr/bin/env python3
"""BACKLOG-3853 PR-1: build one SQL text for a single execute_sql call on keepr-test.

Usage: compose.py <out.sql> <modes> [--with-m1] [--placeholders <json file>]
  <modes>      comma list of mode names (see controls.sql apply_mode)
  --with-m1    prepend the M1 migration (dry run: M1 + controls in one rolled-back call)
  --placeholders  JSON {"__NAME__": "sql literal text"} for the policy-mutant from/to strings
The controls end in RAISE, so the whole call rolls back.
"""
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
m1 = os.path.join(here, '..', '..', 'migrations', '20261018230000_backlog_3853_brokerage_suspension_gates.sql')
out, modes = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
ctl = open(os.path.join(here, 'controls.sql')).read()
ctl = ctl.replace('__MODES__', ','.join("'%s'" % m.strip() for m in modes.split(',')))
ph = {}
if '--placeholders' in args:
    ph = json.load(open(args[args.index('--placeholders') + 1]))
for k, v in ph.items():
    assert ctl.count(k) >= 1, k
    ctl = ctl.replace(k, v)
import re
left = sorted(set(re.findall(r'__[A-Z_]+__', ctl)))
for k in left:  # unfilled placeholders: a literal that never matches (the mode would error, not pass)
    ctl = ctl.replace(k, "'UNFILLED %s'" % k.strip('_'))
text = (open(m1).read() + '\n' if '--with-m1' in args else '') + ctl
open(out, 'w').write(text)
print(out, len(text), 'unfilled:', left)
