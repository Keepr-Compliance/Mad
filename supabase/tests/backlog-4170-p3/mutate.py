#!/usr/bin/env python3
"""BACKLOG-4170 PR3 mutations. For each mode: exact-string replace on the migration (or rollback) FILE
(exits unless each fragment matches exactly the expected number of times), print MUTATION APPLIED + the
changed lines, show `git diff --numstat`, run the controls (rollback first, so the run starts from the
production text; one keepr-test transaction ending in RAISE, so nothing persists), assert a non-zero
control count, restore the file with `git checkout --`, and assert the tree is clean. Commit the
migration BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
MIG = 'supabase/migrations/20261111120000_backlog_4170_shared_table_policies.sql'
RB = 'supabase/tests/backlog-4170-p3/rollback-4170-p3.sql'
REQ = "    OR (user_id IN (SELECT public.support_my_requester_ids()))\n"


def section(n, nxt):
    """text of migration section n up to (not including) the banner of section nxt"""
    body = open(os.path.join(root, MIG)).read()
    a = body.index('-- %d. ' % n)
    a = body.rindex('-- =====', 0, a)
    b = body.index('-- ' + nxt, a)
    b = body.rindex('-- =====', 0, b)
    return body[a:b]


# mode -> (file, [(old, new, expected match count)])
MUT = {
  # a new permissive policy added beside the old one instead of ALTER POLICY in place
  'PERMISSIVE_beside': (MIG, [('ALTER POLICY "Internal users can view roles" ON public.admin_roles\n  USING (',
                               'DROP POLICY IF EXISTS m4170p3_roles_beside ON public.admin_roles;\n'
                               'CREATE POLICY m4170p3_roles_beside ON public.admin_roles FOR SELECT TO authenticated\n  USING (', 1)]),
  # billing tables keyed on support.view instead of the requester set (SR PR3-a)
  'WRONG_REQUESTER_KEY': (MIG, [(REQ, "    OR (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.view']))\n", 3)]),
  # credit_ledger own-row branch dropped
  'OWN_ROW_dropped': (MIG, [("ALTER POLICY credit_ledger_select_own ON public.credit_ledger\n  USING (\n"
                             "    (( SELECT auth.uid() AS uid) = user_id)\n    OR (SELECT",
                             "ALTER POLICY credit_ledger_select_own ON public.credit_ledger\n  USING (\n    (SELECT", 1)]),
  # stripe_customers own-row branch without the live-mode condition
  'STRIPE_live_dropped': (MIG, [("((( SELECT auth.uid() AS uid) = user_id) AND (stripe_mode = 'live'::text))",
                                 "(( SELECT auth.uid() AS uid) = user_id)", 1)]),
  # admin_roles without the own-role branch (SR PR3-b)
  'OWN_ROLE_dropped': (MIG, [("\n    OR (id IN (SELECT ir.role_id FROM public.internal_roles ir WHERE ir.user_id = (SELECT auth.uid())))", "", 1)]),
  # invitations keyed internal_users.view only (SR PR3-d)
  'INVITE_view_only': (MIG, [("ARRAY['internal_users.view', 'internal_users.manage']", "ARRAY['internal_users.view']", 1)]),
  # email_delivery_log left on the PUBLIC role list (SR PR3-e)
  'LOGS_roles_public': (MIG, [("  TO authenticated\n", "", 1)]),
  # support_templates_select left at USING (true) (scope row b447c887)
  'TEMPLATES_true_left': (MIG, [(None, 16, '17-18. ')]),
  # organization_plans without support.view (SR PR3-c)
  'ORGPLANS_no_support_view': (MIG, [("ARRAY['organizations.view', 'users.view', 'support.view']", "ARRAY['organizations.view', 'users.view']", 1)]),
  # one table keyed on the wrong permission
  'WRONG_KEY': (MIG, [("ARRAY['audit.view']", "ARRAY['users.view']", 1)]),
  # the most likely wrong fix: the internal-role branch kept beside the new key
  'INTERNAL_kept': (MIG, [("    OR (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['billing.view']))\n  );\n\n-- ============================================================\n-- 5.",
                           "    OR (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['billing.view']))\n    OR has_internal_role(( SELECT auth.uid() AS uid))\n  );\n\n-- ============================================================\n-- 5.", 1)]),
  # one policy left unaltered
  'LIFECYCLE_unaltered': (MIG, [(None, 14, '15. ')]),
  # sections 17-18 absent: the two inline-join policies left as they were
  'DEPS_inline_left': (MIG, [(None, 17, None)]),
  # sections 17-18 without WITH CHECK (ALTER POLICY then keeps the previous inline check)
  'DEP_check_left': (MIG, [("  )\n  WITH CHECK (\n    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.manage', 'support.admin']))\n  );\n", "  );\n", 1)]),
  # the rollback file drifted from the production text (digest control)
  'ROLLBACK_drift': (RB, [("ALTER POLICY support_templates_select ON public.support_response_templates\n  USING (true);",
                           "ALTER POLICY support_templates_select ON public.support_response_templates\n  USING ((( SELECT auth.uid() AS uid) IS NOT NULL));", 1)]),
}


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)


for rel in (MIG, RB):
    if sh('git', 'status', '--porcelain', '--', rel).stdout.strip():
        sys.exit('%s has uncommitted changes; commit before mutating' % rel)

modes = list(MUT) if sys.argv[1] == 'all' else sys.argv[1].split(',')
summary = []
for mode in modes:
    rel, edits = MUT[mode]
    path = os.path.join(root, rel)
    body = open(path).read()
    for old, new, cnt in edits:
        if old is None:  # remove a whole section (new = its number, cnt = next section number or None)
            if cnt is None:
                a = body.rindex('-- =====', 0, body.index('-- 17-18. '))
                frag = body[a:]
            else:
                frag = section(new, cnt)
            if body.count(frag) != 1 or 'ALTER POLICY' not in frag:
                sys.exit('%s MUTATION NOT APPLIED: section not found once' % mode)
            body = body.replace(frag, '')
            continue
        n = body.count(old)
        if n != cnt:
            sys.exit('%s MUTATION NOT APPLIED: fragment matched %d times, expected %d' % (mode, n, cnt))
        body = body.replace(old, new)
    open(path, 'w').write(body)
    ns = sh('git', 'diff', '--numstat', '--', rel).stdout.strip()
    if not ns:
        sys.exit('%s MUTATION NOT APPLIED: git diff empty' % mode)
    changed = [l for l in sh('git', 'diff', '-U0', '--', rel).stdout.splitlines()
               if l[:1] in '+-' and not l.startswith(('+++', '---'))]
    print('== %s (%s)' % (mode, os.path.basename(rel)))
    print('MUTATION APPLIED numstat=%s/%s' % tuple(ns.split('\t')[:2]))
    for l in changed[:12]:
        print('  %s %s' % (l[0], l[1:].strip()[:150]))
    if len(changed) > 12:
        print('  ... %d changed lines' % len(changed))
    try:
        out = subprocess.run([os.path.join(here, 'run.sh')], capture_output=True, text=True)
        o = out.stdout
        try:
            d = json.loads(o[o.index('{'):o.rindex('}') + 1])
            print('RESULT total=%s pass=%s fail=%s reds=%s' % (d['total'], d['pass'], d['fail'], ','.join(sorted(d['reds']))))
            if not d['total']:
                print('ZERO CONTROLS RAN')
            summary.append((mode, d['total'], d['fail']))
        except Exception:
            print('NO RESULT ' + o[:800] + out.stderr[:400])
            summary.append((mode, 0, 'NO RESULT'))
    finally:
        sh('git', 'checkout', '--', rel)
        st = sh('git', 'status', '--porcelain', '--', rel).stdout.strip()
        print('RESTORED clean=%s' % (st == ''))
        if st:
            sys.exit('restore failed')
print('SUMMARY ' + ' '.join('%s=%s/%s' % s for s in summary))
bad = [s for s in summary if not s[1] or s[2] in (0, 'NO RESULT')]
if bad:
    print('NOT RED: ' + ','.join(s[0] for s in bad)); sys.exit(1)
