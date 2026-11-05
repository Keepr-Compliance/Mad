#!/usr/bin/env python3
"""BACKLOG-4144 M1 mutations. For each mode: exact-string replace on the migration FILE (exits unless the
fragment matches exactly once), print MUTATION APPLIED + the changed line(s), show `git diff --numstat`,
run the controls with --with-migration (one keepr-test transaction ending in RAISE, so nothing
persists), assert a non-zero control count, restore the file with `git checkout --`, and assert
`git status --porcelain` is empty. Commit the migration BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261105100000_backlog_4144_report_access.sql'
mig = os.path.join(root, rel)

SA_JOIN = ("    WHEN EXISTS (\n"
           "      SELECT 1\n"
           "      FROM internal_roles ir\n"
           "      JOIN admin_roles ar ON ar.id = ir.role_id\n"
           "      WHERE ir.user_id = p_user\n"
           "        AND ar.is_system\n"
           "    ) THEN 'owner'\n")
MUT = {
  # the helper no longer requires analytics.view
  'ELIG_helper_skips_analytics_view': [("    WHEN NOT public._report_share_eligible(p_user) THEN NULL\n", "")],
  # access does not start closed: every analytics.view holder gets a viewer row on every report
  'SEED_rows_for_analytics_view_holders': [(
    "ALTER TABLE public.report_access ENABLE ROW LEVEL SECURITY;\n",
    "ALTER TABLE public.report_access ENABLE ROW LEVEL SECURITY;\n"
    "INSERT INTO public.report_access (report_key, user_id, role) SELECT k.report_key, ir.user_id, 'viewer' FROM public.reports k CROSS JOIN public.internal_roles ir WHERE public._report_share_eligible(ir.user_id) ON CONFLICT DO NOTHING;\n")],
  # owner check through the caller-bound is_super_admin() instead of its own is_system join
  'SA_is_super_admin_not_join': [(SA_JOIN, "    WHEN public.is_super_admin(p_user) THEN 'owner'\n")],
  # the four 4087 recipient paths without the report-access predicate, one at a time
  'SHARED1_list_no_access_check': [("\n      AND public._report_access_role(v_caller_id, v.report_key) IS NOT NULL\n  ) x;", "\n  ) x;")],
  'SHARED2_editor_save_no_access_check': [("\n      AND public._report_access_role(v_caller_id, v_view_key) IS NOT NULL;", ";")],
  'SHARED3_candidates_no_access_check': [("\n      AND public._report_access_role(ir.user_id, v_view_key) IS NOT NULL\n  ) c;", "\n  ) c;")],
  'SHARED4_share_set_grantee_no_access_check': [("\n    AND public._report_access_role(p_user_id, v.report_key) IS NOT NULL\n  FOR UPDATE;", "\n  FOR UPDATE;")],
  # a viewer may share views on the report
  'VIEWER_may_share_views': [("    AND public._report_access_role(v_caller_id, v.report_key) IN ('editor', 'owner')\n    AND public._report_access_role(p_user_id",
                              "    AND public._report_access_role(v_caller_id, v.report_key) IS NOT NULL\n    AND public._report_access_role(p_user_id")],
  # report_access_set by any access holder, not only an owner (Super Admin)
  'NONOWNER_access_set': [("  IF public._report_access_role(v_caller_id, p_key) IS DISTINCT FROM 'owner'\n     OR p_user_id IS NULL",
                           "  IF public._report_access_role(v_caller_id, p_key) IS NULL\n     OR p_user_id IS NULL")],
  # report_access_list says why it refused
  'LEAK_refusal_message': [("    RAISE EXCEPTION 'Report not found';\n  END IF;\n\n  SELECT COALESCE(jsonb_agg(jsonb_build_object(\n    'user_id', ra.user_id,",
                            "    RAISE EXCEPTION 'Only a report owner can list access';\n  END IF;\n\n  SELECT COALESCE(jsonb_agg(jsonb_build_object(\n    'user_id', ra.user_id,")],
  # the private helper is callable by authenticated
  'HELPER_execute_granted': [("REVOKE EXECUTE ON FUNCTION public._report_access_role(UUID, TEXT) FROM PUBLIC, anon, authenticated;\n",
                              "REVOKE EXECUTE ON FUNCTION public._report_access_role(UUID, TEXT) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public._report_access_role(UUID, TEXT) TO authenticated;\n")],
  # the grants table is readable by authenticated
  'TABLE_select_granted': [("ALTER TABLE public.report_access ENABLE ROW LEVEL SECURITY;\n",
                            "ALTER TABLE public.report_access ENABLE ROW LEVEL SECURITY;\nGRANT SELECT ON public.report_access TO authenticated;\n")],
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
        out = subprocess.run([os.path.join(here, 'run.sh'), '--with-migration'], capture_output=True, text=True)
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
