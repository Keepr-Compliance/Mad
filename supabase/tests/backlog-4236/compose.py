#!/usr/bin/env python3
"""BACKLOG-4236 PR-1: build one SQL text for a single kt-sql call (one transaction ending in RAISE).

Usage: compose.py <out.sql> [controls file, default controls.sql]
Order: the rollback (every object is created fresh: CREATE OR REPLACE keeps an existing ACL), M1 twice,
M2 twice (the second apply proves each re-runs cleanly), lib/helpers.sql, lib/fixtures.sql,
lib/contract-4243.sql, the controls. The controls embed the rollback and both migrations for G1. Files are read from the working
tree, so a mutation applied by mutate.py is what runs. __RUN__ is a random value per run.
"""
import os, secrets, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations')
M1 = open(os.path.join(mig, '20261112180000_backlog_4236_cloud_autosave_feature_keys.sql')).read()
M2 = open(os.path.join(mig, '20261112190000_backlog_4236_cloud_autosave_schema.sql')).read()
out = sys.argv[1]
ctl = open(os.path.join(here, sys.argv[2] if len(sys.argv) > 2 else 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback-4236.sql')).read()
hl = open(os.path.join(here, 'lib', 'helpers.sql')).read()
fx = open(os.path.join(here, 'lib', 'fixtures.sql')).read()
k6 = open(os.path.join(here, 'lib', 'contract-4243.sql')).read()
for tag in ('$rbx$', '$mg1$', '$mg2$', '$run$', '$drv4236$', '$h$'):
    assert tag not in rb and tag not in M1 and tag not in M2, tag
assert ctl.count('__ROLLBACK__') <= 1 and ctl.count('__M1__') <= 1 and ctl.count('__M2__') <= 1
# first statement of the transaction: keep this call's statements out of pg_stat_statements
text = ("SET LOCAL pg_stat_statements.track = 'none';\nSET LOCAL lock_timeout = '10s';\n" + rb + '\n' + M1 + '\n' + M1 + '\n' + M2 + '\n' + M2 + '\n' + hl + '\n' + fx + '\n' + k6 + '\n'
        + ctl.replace('__ROLLBACK__', rb).replace('__M1__', M1).replace('__M2__', M2))
text = text.replace('__RUN__', secrets.token_hex(12))
assert '__RUN__' not in text
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as fh:
    fh.write(text)
print(out, len(text))
