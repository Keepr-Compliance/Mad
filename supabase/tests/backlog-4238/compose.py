#!/usr/bin/env python3
"""BACKLOG-4238 PR-1: build one SQL text for a single kt-sql call (one transaction ending in RAISE).

Usage: compose.py <out.sql> [controls file, default controls.sql]
Order: the rollback (so every object is created fresh: CREATE OR REPLACE keeps an existing ACL),
the migration TWICE (the second apply proves it re-runs cleanly), lib/helpers.sql, the controls.
The controls embed the rollback and the migration for G1. Files are read from the working tree,
so a mutation applied by mutate.py is what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(here, '..', '..', 'migrations', '20261112170000_backlog_4238_mcp_oauth_server.sql')
out = sys.argv[1]
ctl_name = sys.argv[2] if len(sys.argv) > 2 else 'controls.sql'
ctl = open(os.path.join(here, ctl_name)).read()
rb = open(os.path.join(here, 'rollback-4238.sql')).read()
hl = open(os.path.join(here, 'lib', 'helpers.sql')).read()
m = open(MIG).read()
for tag in ('$rbx4238$', '$mg4238$', '$run$', '$drv4238$', '$h$', '$s$'):
    assert tag not in rb and tag not in m, tag
assert ctl.count('__ROLLBACK__') <= 1 and ctl.count('__MIGRATION__') <= 1
pre = open(os.path.join(here, 'lib', 'pre-' + ctl_name)).read() if os.path.exists(os.path.join(here, 'lib', 'pre-' + ctl_name)) else ''
text = pre + rb + '\n' + m + '\n' + m + '\n' + hl + '\n' + ctl.replace('__ROLLBACK__', rb).replace('__MIGRATION__', m)
open(out, 'w').write(text)
print(out, len(text))
