#!/usr/bin/env python3
"""BACKLOG-4192 D4: the migration's md5 pre-check refuses an altered base. keepr-test only.
One call per case, each inside BEGIN ... ROLLBACK (an error aborts the whole call), so nothing
persists. Case 'altered': the base body of pm_get_board_tasks gets one extra comment line first;
expected: error '4192 pre-check'. Case 'unaltered': the migration alone; expected: no error.
Usage: d4_precheck.py   (prints both outcomes)"""
import os, subprocess
here = os.path.dirname(os.path.abspath(__file__))
mig = open(os.path.join(here, '..', '..', 'migrations', '20261107120000_backlog_4192_pending_uat_board.sql')).read()
base = open(os.path.join(here, 'base', 'pm_get_board_tasks.sql')).read()
OLD = "  v_columns JSONB;\n"
assert base.count(OLD) == 1
altered = base.replace(OLD, OLD + "  -- d4 altered base\n").rstrip('\n') + ';\n'
assert altered != base
print('MUTATION APPLIED: extra comment line after', OLD.strip())
kt = os.path.expanduser('~/.claude/bin/kt-sql')
for case, sql in [('altered', 'BEGIN;\n' + altered + mig + '\nROLLBACK;'),
                  ('unaltered', 'BEGIN;\n' + mig + '\nROLLBACK;')]:
    p = subprocess.run([kt, '-c', sql], capture_output=True, text=True)
    print(case, 'exit', p.returncode, (p.stdout + p.stderr).strip()[:400])
