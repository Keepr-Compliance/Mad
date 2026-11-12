#!/usr/bin/env python3
"""BACKLOG-4186 PR A: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql>
The two read functions are DROPPED first, so a mutation of the REVOKE lines is measured against
freshly created functions (CREATE OR REPLACE on an existing function keeps its old ACL, which
would hide a dropped REVOKE once the migration is applied on keepr-test for real). Then the
migration is applied TWICE (the second apply proves it is idempotent), then the controls, which
end in RAISE, so the whole call rolls back. The rollback script is embedded for the rollback check.
Files are read from the working tree, so a mutation applied by mutate.py is what runs.
"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261109210000_backlog_4186_sender_rule_set_reads.sql')
out = sys.argv[1]
ctl = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback-4186.sql')).read()
m = open(mig).read()
assert ctl.count('__ROLLBACK__') == 1
for tag in ('$rb$', '$b$', '$f$', '$drv$'):
    assert tag not in rb and tag not in m, tag
drop = ('DROP FUNCTION IF EXISTS public.sender_rule_set_admin_content(BIGINT);\n'
        'DROP FUNCTION IF EXISTS public.sender_rule_set_admin_state();\n')
text = drop + m + '\n' + m + '\n' + ctl.replace('__ROLLBACK__', rb)
open(out, 'w').write(text)
print(out, len(text))
