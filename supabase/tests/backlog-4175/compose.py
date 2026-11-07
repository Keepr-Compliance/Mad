#!/usr/bin/env python3
"""BACKLOG-4175 migration A: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> [--with-migration]
--with-migration puts the migration in front TWICE (the second apply proves it is idempotent).
The controls end in RAISE, so the whole call rolls back (migration included when composed in).
The rollback script and corpus.json are embedded so S20 and S11 can use them. Files are read from
the working tree, so a mutation applied by mutate.py is what runs.
"""
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261108100000_backlog_4175_sender_rule_sets.sql')
out = sys.argv[1]
ctl = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback-4175.sql')).read()
corpus = open(os.path.join(here, 'corpus.json')).read().strip()
json.loads(corpus)
m = open(mig).read()
assert ctl.count('__ROLLBACK__') == 1 and ctl.count('__CORPUS__') == 1
for tag in ('$rb$', '$cp$', '$b$', '$f$', '$drv$'):
    assert tag not in rb and tag not in m and tag not in corpus, tag
ctl = ctl.replace('__ROLLBACK__', rb).replace('__CORPUS__', corpus)
text = (m + '\n' + m + '\n' if '--with-migration' in sys.argv[2:] else '') + ctl
open(out, 'w').write(text)
print(out, len(text))
