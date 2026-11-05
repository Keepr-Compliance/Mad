#!/usr/bin/env python3
"""BACKLOG-4144 M2 mutations. For each mode: exact-string replace on the migration FILE (exits unless each
fragment matches exactly once), print MUTATION APPLIED + the changed lines, show `git diff --numstat`,
run the controls (one keepr-test transaction ending in RAISE, nothing persists), assert a non-zero
control count, restore the file with `git checkout --`, and assert `git status --porcelain` is empty.
Commit the migration BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261105110000_backlog_4144_report_rls.sql'
mig = os.path.join(root, rel)

MUT = {
  # a new permissive policy beside the old internal-role one, instead of replacing its text
  'ADD_policy_beside_old': [(
    "ALTER POLICY analytics_events_select_own_or_internal ON public.analytics_events\n  USING (",
    "DROP POLICY IF EXISTS analytics_events_select_by_report ON public.analytics_events;\n"
    "CREATE POLICY analytics_events_select_by_report ON public.analytics_events FOR SELECT TO authenticated\n  USING (")],
  # the policies call the EXECUTE-revoked private helper instead of the caller-bound wrapper
  'PRIVATE_helper_not_wrapper': [(
    "AND (SELECT public.report_my_access('funnel')) IS NOT NULL",
    "AND (SELECT public._report_access_role((SELECT auth.uid()), 'funnel')) IS NOT NULL")],
  # funnel and exports keys swapped on analytics_events
  'SWAP_funnel_exports_keys': [(
    "      AND (SELECT public.report_my_access('funnel')) IS NOT NULL\n    )\n    OR (\n      event_name = 'export-completed'\n      AND (SELECT public.report_my_access('exports')) IS NOT NULL",
    "      AND (SELECT public.report_my_access('exports')) IS NOT NULL\n    )\n    OR (\n      event_name = 'export-completed'\n      AND (SELECT public.report_my_access('funnel')) IS NOT NULL")],
  # the own-rows branch left out of analytics_events
  'NO_own_rows_events': [("    ((SELECT auth.uid()) = user_id)\n    OR (\n      event_name IN", "    (\n      event_name IN")],
  # the own-rows branch left out of submission_attempts
  'NO_own_rows_submissions': [("    (user_id = (SELECT auth.uid()))\n    OR can_review_submission", "    can_review_submission")],
  # can_review_submission left out of submission_attempts
  'NO_can_review_submission': [("\n    OR can_review_submission(organization_id)", "")],
}

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)

if sh('git', 'status', '--porcelain', '--', rel).stdout.strip():
    sys.exit('migration has uncommitted changes; commit before mutating')

modes = list(MUT) if sys.argv[1] == 'all' else sys.argv[1].split(',')
for mode in modes:
    body = open(mig).read()
    for old, new in MUT[mode]:
        n = body.count(old)
        if n != 1:
            sys.exit('%s MUTATION NOT APPLIED: fragment matched %d times' % (mode, n))
        body = body.replace(old, new)
    open(mig, 'w').write(body)
    ns = sh('git', 'diff', '--numstat', '--', rel).stdout.strip()
    if not ns:
        sys.exit('%s MUTATION NOT APPLIED: git diff empty' % mode)
    changed = [l for l in sh('git', 'diff', '-U0', '--', rel).stdout.splitlines()
               if l[:1] in '+-' and not l.startswith(('+++', '---'))]
    print('== %s' % mode)
    print('MUTATION APPLIED numstat=%s' % ns.split('\t')[0] + '/' + ns.split('\t')[1])
    for l in changed:
        print('  %s %s' % (l[0], l[1:].strip()[:150]))
    try:
        out = subprocess.run([os.path.join(here, 'run.sh')], capture_output=True, text=True)
        o = out.stdout
        try:
            d = json.loads(o[o.index('{'):o.rindex('}') + 1])
            print('RESULT total=%s pass=%s fail=%s reds=%s' % (d['total'], d['pass'], d['fail'], ','.join(sorted(d['reds']))))
            if not d['total']:
                print('ZERO CONTROLS RAN')
        except Exception:
            print('NO RESULT ' + o[:800] + out.stderr[:400])
    finally:
        sh('git', 'checkout', '--', rel)
        st = sh('git', 'status', '--porcelain', '--', rel).stdout.strip()
        print('RESTORED clean=%s' % (st == ''))
        if st:
            sys.exit('restore failed')
