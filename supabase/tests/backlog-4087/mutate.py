#!/usr/bin/env python3
"""BACKLOG-4087 mutations. For each mode: exact-string replace on the migration FILE (raises unless the
fragment matches exactly once), print MUTATION APPLIED + the new line(s), show `git diff --numstat`,
run the controls with --with-migration (one keepr-test transaction ending in RAISE, so nothing
persists), restore the file with `git checkout --`, and assert `git status --porcelain` is empty.
Commit the migration BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]
"""
import os, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261104200000_backlog_4087_report_view_shares.sql'
mig = os.path.join(root, rel)

ELIG_JOIN = ("    JOIN admin_role_permissions arp ON arp.role_id = ir.role_id\n"
             "    JOIN admin_permissions ap ON ap.id = arp.permission_id\n"
             "    WHERE ir.user_id = p_user_id\n"
             "      AND ap.key = 'analytics.view'\n")
MUT = {
  # eligibility = internal role only (analytics.view not required)
  'M1_elig_internal_only': [(ELIG_JOIN, "    WHERE ir.user_id = p_user_id\n")],
  # list: no read-time eligibility check (neither caller nor owner)
  'M1b_list_no_readtime_check': [("      AND public._report_share_eligible(v_caller_id)\n      AND public._report_share_eligible(v.user_id)\n  ) x;", "  ) x;")],
  # list: shared rows carry the owner's pin and default
  'M2_no_mask': [("      'pinned', false,\n      'is_default', false,", "      'pinned', v.pinned,\n      'is_default', v.is_default,")],
  # list: only is_default masked, the pin leaks
  'M2b_mask_default_only': [("      'pinned', false,\n      'is_default', false,", "      'pinned', v.pinned,\n      'is_default', false,")],
  # editor save writes name + pinned as well
  'M3_editor_writes_name_pin': [("      SET filters = coalesce(p_filters, '{}'::jsonb),\n          metric = p_metric,\n          updated_at = now()\n      WHERE id = p_id\n      RETURNING id INTO v_view_id;\n\n      RETURN",
                                 "      SET name = btrim(p_name),\n          pinned = p_pinned,\n          filters = coalesce(p_filters, '{}'::jsonb),\n          metric = p_metric,\n          updated_at = now()\n      WHERE id = p_id\n      RETURNING id INTO v_view_id;\n\n      RETURN")],
  # the pin cap is counted on the editor
  'M4_pincap_on_editor': [("    IF v_is_editor THEN\n",
                           "    IF v_is_editor AND p_pinned AND (SELECT count(*) FROM report_saved_views WHERE user_id = v_caller_id AND report_key = p_report_key AND pinned) >= 5 THEN\n      RAISE EXCEPTION 'At most 5 pinned cards per report. Unpin one first.';\n    END IF;\n    IF v_is_editor THEN\n")],
  # list: the owner's eligibility is not checked
  'M5_list_no_owner_check': [("      AND public._report_share_eligible(v.user_id)\n  ) x;", "  ) x;")],
  # save: the owner's eligibility is not checked on the editor path
  'M5b_save_no_owner_check': [("      AND public._report_share_eligible(v_caller_id)\n      AND public._report_share_eligible(v_owner_id);", "      AND public._report_share_eligible(v_caller_id);")],
  # a viewer may save
  'M6_viewer_can_save': [("WHERE s.view_id = p_id AND s.user_id = v_caller_id AND s.role = 'editor'", "WHERE s.view_id = p_id AND s.user_id = v_caller_id")],
  # an editor may re-share
  'M7_editor_reshares': [("  WHERE v.id = p_view_id\n    AND v.user_id = v_caller_id\n    AND p_user_id IS NOT NULL",
                          "  WHERE v.id = p_view_id\n    AND (v.user_id = v_caller_id OR EXISTS (SELECT 1 FROM report_saved_view_shares s0 WHERE s0.view_id = v.id AND s0.user_id = v_caller_id AND s0.role = 'editor'))\n    AND p_user_id IS NOT NULL")],
  # list: Super Admin sees every view of the report
  'M8_superadmin_bypass_list': [("    FROM report_saved_views v\n    WHERE v.user_id = v_caller_id\n      AND v.report_key = p_report_key\n\n    UNION ALL",
                                 "    FROM report_saved_views v\n    WHERE (v.user_id = v_caller_id OR EXISTS (SELECT 1 FROM internal_roles ir2 JOIN admin_roles ar ON ar.id = ir2.role_id WHERE ir2.user_id = v_caller_id AND ar.name = 'Super Admin'))\n      AND v.report_key = p_report_key\n\n    UNION ALL")],
  # the helper is callable by authenticated (an eligibility oracle)
  'M9_helper_granted': [("REVOKE EXECUTE ON FUNCTION public._report_share_eligible(UUID) FROM PUBLIC, anon, authenticated;",
                         "REVOKE EXECUTE ON FUNCTION public._report_share_eligible(UUID) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public._report_share_eligible(UUID) TO authenticated;")],
  # the remove RPC tells a missing id from another user's view
  'M10_remove_oracle': [("  IF v_view_id IS NULL THEN\n    RAISE EXCEPTION 'Saved view not found';\n  END IF;\n\n  DELETE FROM report_saved_views",
                         "  IF v_view_id IS NULL AND EXISTS (SELECT 1 FROM report_saved_views x WHERE x.id = p_id) THEN\n    RAISE EXCEPTION 'Only the view owner can delete it';\n  END IF;\n  IF v_view_id IS NULL THEN\n    RAISE EXCEPTION 'Saved view not found';\n  END IF;\n\n  DELETE FROM report_saved_views")],
  # the shares table is readable by authenticated
  'M11_table_select_granted': [("ALTER TABLE public.report_saved_view_shares ENABLE ROW LEVEL SECURITY;",
                                "ALTER TABLE public.report_saved_view_shares ENABLE ROW LEVEL SECURITY;\nGRANT SELECT ON public.report_saved_view_shares TO authenticated;")],
}

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)

if sh('git', 'status', '--porcelain', '--', rel).stdout.strip():
    sys.exit('migration has uncommitted changes; commit before mutating')

for mode in sys.argv[1].split(','):
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
    print('MUTATION APPLIED numstat=%s' % ns)
    for l in changed:
        print('  %s %s' % (l[0], l[1:].strip()[:150]))
    try:
        out = subprocess.run([os.path.join(here, 'run.sh'), '--with-migration'], capture_output=True, text=True)
        o = out.stdout
        try:
            d = json.loads(o[o.index('{'):])
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
