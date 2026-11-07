#!/usr/bin/env python3
"""BACKLOG-3511 mutations. For each mode: exact-string replace on the target FILE (exits unless each
fragment matches exactly the expected number of times), print MUTATION APPLIED + the changed lines,
show `git diff --numstat`, then run what can see it:
  - migration / prelude targets: the SQL controls (run.sh controls --with-migration: rollback first,
    one keepr-test transaction ending in RAISE, so nothing persists), asserting a non-zero count;
  - migration / planRule targets: the broker-portal parity suite (__tests__/reports-3511), asserting
    a non-zero test count.
Then restore the file with `git checkout --` and assert the tree is clean. Commit everything BEFORE
running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, re, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
MIG = 'supabase/migrations/20261108190000_backlog_3511_broker_report_readers.sql'
PRE = 'supabase/tests/backlog-3511/prelude.sql'
TSR = 'packages/shared/src/billing/planRule.ts'

# mode: (target, [(old, new, expected match count)])
MUT = {
  # the helper answers 'all' for agents
  'AGENT_gets_all': (MIG, [("WHEN m.role = 'agent' THEN 'own'", "WHEN m.role = 'agent' THEN 'all'", 1)]),
  # the active check is skipped
  'ACTIVE_skipped': (MIG, [("     AND m.license_status = 'active'\n", "", 1)]),
  # the org check is skipped
  'ORG_skipped': (MIG, [("   WHERE m.organization_id = p_org\n     AND m.user_id", "   WHERE m.user_id", 1)]),
  # the personal-organization exclusion is skipped
  'PERSONAL_skipped': (MIG, [("     AND o.personal_owner_user_id IS NULL\n", "", 1)]),
  # the own-row policy lacks the uid filter
  'OWN_policy_no_uid': (PRE, [("= 'own' AND agent_user_id = (SELECT auth.uid()));", "= 'own');", 1)]),
  # anon (and PUBLIC) keep EXECUTE
  'ANON_keeps_execute': (MIG, [("REVOKE EXECUTE ON FUNCTION public.org_report_scope(uuid) FROM PUBLIC, anon;\n", "", 1)]),
  # it_admin left out of the TypeScript full roles
  'TS_no_it_admin': (TSR, [("export const FULL_PORTAL_ROLES = ['broker', 'admin', 'it_admin'] as const;",
                            "export const FULL_PORTAL_ROLES = ['broker', 'admin'] as const;", 1)]),
}

def sh(*a, cwd=root):
    return subprocess.run(a, capture_output=True, text=True, cwd=cwd)

def sql_controls():
    out = subprocess.run([os.path.join(here, 'run.sh'), 'controls', '--with-migration'], capture_output=True, text=True)
    o = out.stdout
    try:
        d = json.loads(o[o.index('{'):o.rindex('}') + 1])
        print('  SQL   total=%s pass=%s fail=%s reds=%s' % (d['total'], d['pass'], d['fail'], ','.join(sorted(d['reds'])) or '-'))
        if not d['total']:
            print('  SQL   ZERO CONTROLS RAN')
    except Exception:
        print('  SQL   NO RESULT ' + o[:600] + out.stderr[:300])

def jest_parity():
    out = sh('npx', 'jest', '__tests__/reports-3511', '--json', '--silent', cwd=os.path.join(root, 'broker-portal'))
    try:
        d = json.loads(out.stdout)
        failed = sorted({a['title'] for t in d['testResults'] for a in t['assertionResults'] if a['status'] == 'failed'})
        print('  JEST  total=%s pass=%s fail=%s reds=%s' % (d['numTotalTests'], d['numPassedTests'], d['numFailedTests'], ' | '.join(failed) or '-'))
        if not d['numTotalTests']:
            print('  JEST  ZERO TESTS RAN')
        if d['numFailedTests'] == 0 and d['numRuntimeErrorTestSuites']:
            print('  JEST  suite failed to run')
    except Exception:
        print('  JEST  NO RESULT ' + out.stdout[:300] + out.stderr[-600:])

for rel in (MIG, PRE, TSR):
    if sh('git', 'status', '--porcelain', '--', rel).stdout.strip():
        sys.exit('%s has uncommitted changes; commit before mutating' % rel)

modes = list(MUT) if sys.argv[1] == 'all' else sys.argv[1].split(',')
for mode in modes:
    rel, frags = MUT[mode]
    path = os.path.join(root, rel)
    body = open(path).read()
    for old, new, cnt in frags:
        n = body.count(old)
        if n != cnt:
            sys.exit('%s MUTATION NOT APPLIED: fragment matched %d times, expected %d' % (mode, n, cnt))
        body = body.replace(old, new)
    open(path, 'w').write(body)
    try:
        ns = sh('git', 'diff', '--numstat', '--', rel).stdout.strip()
        if not ns:
            sys.exit('%s MUTATION NOT APPLIED: git diff empty' % mode)
        changed = [l for l in sh('git', 'diff', '-U0', '--', rel).stdout.splitlines()
                   if l[:1] in '+-' and not l.startswith(('+++', '---'))]
        print('== %s (%s)' % (mode, rel))
        print('MUTATION APPLIED numstat=%s/%s' % tuple(ns.split('\t')[:2]))
        for l in changed:
            print('  %s %s' % (l[0], l[1:].strip()[:150]))
        if rel in (MIG, PRE):
            sql_controls()
        if rel in (MIG, TSR):
            jest_parity()
    finally:
        sh('git', 'checkout', '--', rel)
        st = sh('git', 'status', '--porcelain', '--', rel).stdout.strip()
        print('RESTORED clean=%s' % (st == ''))
        if st:
            sys.exit('restore failed')
