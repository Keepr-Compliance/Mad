#!/usr/bin/env python3
"""BACKLOG-4185 PR A: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql>
The rollback runs FIRST, so the migration is measured against a table without the new columns
even after it has been applied to keepr-test for real. Then the migration is applied TWICE (the
second apply proves it is re-runnable), then mutations.sql (empty unless mutate.py filled the
slot), then controls.sql, which ends in RAISE, so the whole call rolls back. The rollback is also
embedded in controls.sql for the rollback check. Files are read from the working tree, so a
mutation applied by mutate.py is what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261112150000_backlog_4185_device_hardware_profile.sql')
out = sys.argv[1]
ctl = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback-4185.sql')).read()
mu = open(os.path.join(here, 'mutations.sql')).read()
m = open(mig).read()
assert ctl.count('__ROLLBACK__') == 1
for tag in ('$drv$', '$b$', '$f$', '$q$'):
    assert tag not in rb and tag not in m and tag not in mu, tag
for stmt in ('BEGIN;', 'COMMIT;'):
    assert stmt not in m.upper(), 'migration must not carry its own ' + stmt
text = rb + '\n' + m + '\n' + m + '\n' + mu + '\n' + ctl.replace('__ROLLBACK__', rb)
open(out, 'w').write(text)
print(out, len(text))
