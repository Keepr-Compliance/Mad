#!/usr/bin/env python3
"""BACKLOG-4263 PR-2 (R7): the portal fixture for list_all_deals, regenerated with THIS migration's reader.
Runs the PR-1 harness (supabase/tests/backlog-4263/harness.py) with --no-mutants, with this migration inserted
right after PR-1's migration in the composed call, writes the FX_* outputs to argv[1] in the fixture format,
and prints whether they equal broker-portal/__tests__/mcp/fixtures/data-tools-4263.json. One rolled-back call."""
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
pr1 = os.path.join(here, '..', 'backlog-4263')
sys.path.insert(0, pr1)
OUT = sys.argv[1]
sys.argv = ['harness.py', 'run', '--no-mutants', '--fixtures=' + OUT]
import harness as P1
MIG2 = open(os.path.join(here, '..', '..', 'migrations', '20261118110000_backlog_4263_todo_server_core.sql')).read()
orig = P1.compose
def compose(with_mutants=True, only=None):
    t = orig(with_mutants=False, only=None)
    anchor = P1.MIG + '\n' + P1.MIG + '\n' + P1.HL
    assert t.count(anchor) == 1
    return t.replace(anchor, P1.MIG + '\n' + P1.MIG + '\n' + MIG2 + '\n' + P1.HL)
P1.compose = compose
try:
    P1.main()
except SystemExit:
    pass
import subprocess
subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), '-c', 'select extensions.pg_stat_statements_reset()'], capture_output=True)
ref = json.load(open(os.path.join(here, '..', '..', '..', 'broker-portal', '__tests__', 'mcp', 'fixtures', 'data-tools-4263.json')))
new = json.load(open(OUT))
diff = [k for k in sorted(set(ref) | set(new)) if ref.get(k) != new.get(k)]
print('FIXTURE with this migration\'s reader: %s (%d outputs; differing: %s)' % ('IDENTICAL' if not diff else 'DIFFERENT', len(new), diff))
