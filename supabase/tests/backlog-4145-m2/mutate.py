#!/usr/bin/env python3
"""BACKLOG-4145 M2 mutations. For each mode: exact-string replace on the migration FILE (exits unless each
fragment matches exactly the expected number of times), print MUTATION APPLIED + the changed lines,
show `git diff --numstat`, run the controls (rollback first, so the run starts from the production text;
one keepr-test transaction ending in RAISE, so nothing persists), assert a non-zero control count,
restore the file with `git checkout --`, and assert the tree is clean. Commit the migration BEFORE
running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261108160000_backlog_4145_shared_table_rls.sql'
mig = os.path.join(root, rel)

LIC = ("ALTER POLICY licenses_select_public ON public.licenses\n"
       "  USING (\n"
       "    (( SELECT auth.uid() AS uid) = user_id)\n"
       "    OR (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['users.view']))\n"
       "    OR (user_id IN (SELECT public.support_my_requester_ids()))\n"
       "  );\n")
# (old, new, expected match count)
MUT = {
  # a new permissive policy added beside the old one instead of ALTER POLICY in place
  'PERMISSIVE_beside': [("ALTER POLICY users_select_public ON public.users\n  USING (",
                         "DROP POLICY IF EXISTS m4145_users_beside ON public.users;\n"
                         "CREATE POLICY m4145_users_beside ON public.users FOR SELECT TO authenticated\n  USING (", 1)],
  # requester read keyed on requester_email as well as requester_id
  'KEY_requester_email': [("    OR (id IN (SELECT public.support_my_requester_ids()))\n",
                           "    OR (id IN (SELECT public.support_my_requester_ids()))\n"
                           "    OR (email IN (SELECT t.requester_email FROM support_tickets t WHERE t.assignee_id = (SELECT auth.uid())))\n", 1)],
  # devices without the own-row branch
  'NO_own_row_devices': [("    (( SELECT auth.uid() AS uid) = user_id)\n    OR (SELECT public.report_my_access('analytics')) IS NOT NULL\n"
                          "    OR (SELECT public.report_my_access('user-activity')) IS NOT NULL\n",
                          "    (SELECT public.report_my_access('analytics')) IS NOT NULL\n"
                          "    OR (SELECT public.report_my_access('user-activity')) IS NOT NULL\n", 1)],
  # the not-internal exclusion kept on the ticket requester_id branch
  'INTERNAL_exclusion_kept': [("    OR (requester_id = ( SELECT auth.uid() AS uid))\n",
                               "    OR ((requester_id = ( SELECT auth.uid() AS uid)) AND (NOT (EXISTS ( SELECT 1 FROM internal_roles"
                               " WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid))))))\n", 1)],
  # organizations without users.view (InviteUserDialog reads organizations from the browser)
  'ORGS_missing_users_view': [("ARRAY['organizations.view', 'users.view', 'users.edit']", "ARRAY['organizations.view', 'users.edit']", 1)],
  # licenses left unaltered (keeps has_internal_role)
  'LICENSES_unaltered': [(LIC, "", 1)],
  # child-table email read back on auth.users (not readable by authenticated)
  'AUTH_users_email_back': [("(t.requester_email = (auth.jwt() ->> 'email'::text))",
                             "(t.requester_email = (( SELECT users.email FROM auth.users WHERE (users.id = ( SELECT auth.uid() AS uid))))::text)", 4)],
  # the five support policies left on the PUBLIC role list
  'ROLES_public_kept': [("  TO authenticated\n  USING (", "  USING (", 5)],
  # a typo'd permission key
  'TYPO_permission_key': [("ARRAY['users.view', 'organizations.view']", "ARRAY['user.view', 'organizations.view']", 1)],
}

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)

if sh('git', 'status', '--porcelain', '--', rel).stdout.strip():
    sys.exit('migration has uncommitted changes; commit before mutating')

modes = list(MUT) if sys.argv[1] == 'all' else sys.argv[1].split(',')
for mode in modes:
    body = open(mig).read()
    for old, new, cnt in MUT[mode]:
        n = body.count(old)
        if n != cnt:
            sys.exit('%s MUTATION NOT APPLIED: fragment matched %d times, expected %d' % (mode, n, cnt))
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
