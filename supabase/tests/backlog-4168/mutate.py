#!/usr/bin/env python3
"""BACKLOG-4168 mutations. For each mode: exact-string replace on the migration FILE (exits unless each
fragment matches exactly the expected number of times), print MUTATION APPLIED + the changed lines,
show `git diff --numstat`, run the controls with --with-migration (one keepr-test transaction ending in
RAISE, so nothing persists), assert a non-zero control count, restore the file with `git checkout --`,
and assert the tree is clean. Commit the migration BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261107100000_backlog_4168_admin_role_ceiling.sql'
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
  # the likely wrong fix: internal_users.manage only, no ceiling (the helper always says yes)
  'CEIL_manage_only': [("  SELECT CASE\n    WHEN p_grantor IS NULL OR p_role_id IS NULL THEN false\n",
                        "  SELECT CASE\n    WHEN p_grantor IS NOT NULL AND p_role_id IS NOT NULL THEN true\n    WHEN p_grantor IS NULL OR p_role_id IS NULL THEN false\n", 1)],
  # subset instead of strict subset
  'STRICT_to_subset': [("    ELSE EXISTS (\n", "    ELSE true OR EXISTS (\n", 1)],
  # no self check (update + remove)
  'SELF_removed': [(SELF, "", 2)],
  # no last-Super-Admin guard (update + remove)
  'GUARD_removed': [(GUARD_UPD, "", 1), (GUARD_REM, "", 1)],
  # neither: shows the guard is what holds the sole-Super-Admin case once the self check is gone
  'SELF_and_GUARD_removed': [(SELF, "", 2), (GUARD_UPD, "", 1), (GUARD_REM, "", 1)],
  # no ceiling on the target's CURRENT role (update + remove)
  'CURRENT_role_ceiling_removed': [("     OR NOT public._admin_can_grant_role_as(v_uid, v_cur_role_id)\n", "", 2)],
  # invitation policy back to the old ALL-on-has_internal_role (permissive policies OR together)
  'POLICY_back_to_ALL': [("DROP POLICY IF EXISTS internal_users_can_manage_invitations ON public.pending_internal_invitations;\n",
                          "DROP POLICY IF EXISTS internal_users_can_manage_invitations ON public.pending_internal_invitations;\n"
                          "CREATE POLICY internal_users_can_manage_invitations ON public.pending_internal_invitations FOR ALL TO authenticated "
                          "USING (public.has_internal_role((SELECT auth.uid()))) WITH CHECK (public.has_internal_role((SELECT auth.uid())));\n", 1)],
  # accept without re-checking the inviter
  'ACCEPT_no_inviter_check': [("     OR NOT public._admin_keys_held(v_inv.invited_by, ARRAY['internal_users.manage'])\n"
                               "     OR NOT public._admin_can_grant_role_as(v_inv.invited_by, v_inv.role_id)\n", "", 1)],
  # role CRUD without the key ceiling (create + update_role_permissions)
  'CRUD_no_key_ceiling': [("     OR NOT (public.is_super_admin(v_uid) OR public._admin_keys_held(v_uid, p_permission_keys))\n", "", 2)],
  # role editor may edit their own role
  'CRUD_own_role_allowed': [("     OR EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = v_uid AND role_id = p_role_id)\n", "", 1)],
  # one function (add) says why it refused
  'MSG_distinct_in_add': [("     OR NOT public._admin_can_grant_role_as(v_uid, v_role_id)\n  THEN\n    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';",
                           "     OR NOT public._admin_can_grant_role_as(v_uid, v_role_id)\n  THEN\n    RAISE EXCEPTION 'Cannot grant this role' USING ERRCODE = '42501';", 1)],
  # anon keeps EXECUTE on one writer
  'GRANT_anon_kept_on_remove': [("REVOKE EXECUTE ON FUNCTION public.admin_remove_internal_user(uuid) FROM PUBLIC, anon;\n", "", 1)],
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
