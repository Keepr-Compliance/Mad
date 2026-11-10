#!/usr/bin/env python3
"""BACKLOG-4145 M1 mutations. For each mode: exact-string replace on the migration FILE (exits unless each
fragment matches exactly the expected number of times), print MUTATION APPLIED + the changed lines,
show `git diff --numstat`, run the controls with --with-migration (rollback first, so the run starts from the pre-migration
state; one keepr-test transaction ending in
RAISE, so nothing persists), assert a non-zero control count, restore the file with `git checkout --`,
and assert the tree is clean. Commit the migration BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261108150000_backlog_4145_shared_table_access_helpers.sql'
mig = os.path.join(root, rel)

SELF = "     OR p_user_id = v_uid\n"
GUARD_UPD = ("     OR (EXISTS (SELECT 1 FROM public.admin_roles WHERE id = v_cur_role_id AND is_system)\n"
             "         AND NOT EXISTS (SELECT 1 FROM public.admin_roles WHERE id = v_role_id AND is_system)\n"
             "         AND NOT EXISTS (SELECT 1 FROM public.internal_roles ir JOIN public.admin_roles ar ON ar.id = ir.role_id\n"
             "                          WHERE ar.is_system AND ir.user_id <> p_user_id))\n")
GUARD_REM = ("     OR (EXISTS (SELECT 1 FROM public.admin_roles WHERE id = v_cur_role_id AND is_system)\n"
             "         AND NOT EXISTS (SELECT 1 FROM public.internal_roles ir JOIN public.admin_roles ar ON ar.id = ir.role_id\n"
             "                          WHERE ar.is_system AND ir.user_id <> p_user_id))\n")
# (old, new, expected match count)
MUT = {
  # helper keyed on requester_email as well as requester_id
  'KEY_requester_email': [("  SELECT DISTINCT t.requester_id\n  FROM public.support_tickets t\n  WHERE t.requester_id IS NOT NULL\n",
                           "  SELECT DISTINCT u.id\n  FROM public.support_tickets t\n"
                           "  JOIN public.users u ON u.id = t.requester_id OR u.email = t.requester_email\n  WHERE u.id IS NOT NULL\n", 1)],
  # assigned branch without the support.view check
  'NO_support_view_check': [("        AND (SELECT public.has_permission((SELECT auth.uid()), 'support.view'))\n", "", 1)],
  # support.view branch without the assignee filter
  'NO_assignee_filter': [("        t.assignee_id = (SELECT auth.uid())\n        AND (SELECT", "        (SELECT", 1)],
  # support.admin branch missing
  'NO_support_admin_branch': [("      (SELECT public.has_permission((SELECT auth.uid()), 'support.admin'))\n      OR (", "      (", 1)],
  # anon keeps EXECUTE on the helper (default privileges grant it)
  'ANON_kept_on_helper': [("REVOKE EXECUTE ON FUNCTION public.support_my_requester_ids() FROM PUBLIC, anon;\n", "", 1)],
  # anon keeps its existing EXECUTE on admin_list_user_devices
  'ANON_kept_on_devices': [("REVOKE EXECUTE ON FUNCTION public.admin_list_user_devices(uuid) FROM PUBLIC, anon;\n", "", 1)],
  # RPC returns an extra column
  'RPC_extra_column': [("RETURNS TABLE (ticket_number integer, subject text, status text)\n",
                        "RETURNS TABLE (ticket_number integer, subject text, status text, requester_email text)\n", 1),
                       ("  SELECT t.ticket_number, t.subject, t.status\n", "  SELECT t.ticket_number, t.subject, t.status, t.requester_email\n", 1)],
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
        out = subprocess.run([os.path.join(here, 'run.sh'), 'controls', '--with-migration'], capture_output=True, text=True)
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
