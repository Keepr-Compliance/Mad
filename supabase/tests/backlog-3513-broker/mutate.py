#!/usr/bin/env python3
"""BACKLOG-3513 PR-2 mutations. For each mode: exact-string replace on the migration FILE (exits unless
every fragment matches exactly once), re-point the pin's post md5 for admin_get_org_activity at the
mutated text, print MUTATION APPLIED + the changed lines, show `git diff --numstat`, run the controls
(one keepr-test transaction ending in RAISE, so nothing persists), assert a non-zero control count,
restore the file with `git checkout --`, and assert the file is clean. Commit the migration first.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import hashlib, json, os, re, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261112200000_backlog_3513_broker_report_definitions.sql'
mig = os.path.join(root, rel)

EFF = "  v_eff := public.broker_report_scope(p_org, p_def) ->> 'effective_scope';\n"
F5_GATE = ("  IF p_org IS NULL OR v_base IS NULL\n     OR NOT coalesce(public._org_feature_allowed(p_org, 'broker_reports'), false) THEN\n"
           "    RAISE EXCEPTION 'Report not found';\n  END IF;\n  IF v_base = 'all'")
PORTAL = ("  IF v_base = 'all' AND NOT coalesce(public._org_feature_allowed(p_org, 'broker_portal_access'), false) THEN\n"
          "    RAISE EXCEPTION 'Report not found';\n  END IF;\n")
SHARE_GATE = ("  IF d.id IS NULL OR v_level IS NULL OR v_level NOT IN ('owner', 'editor') THEN\n    RAISE EXCEPTION 'Report not found';\n"
              "  END IF;\n  IF p_level IS NULL")
F10_SCOPE = "  v_scope := coalesce(p_row_scope, d.row_scope);\n"
MUT = {
  # D1 paired: F6 DEFINER AND effective scope taken from the definition's row_scope
  'M01_D1_DEFINER_PLUS_ROWSCOPE': [("STABLE\nSECURITY INVOKER\nSET search_path", "STABLE\nSECURITY DEFINER\nSET search_path"),
      (EFF, "  PERFORM public.broker_report_scope(p_org, p_def);\n"
            "  v_eff := coalesce((SELECT d.row_scope FROM public.broker_report_definitions d WHERE d.id = p_def), 'all');\n")],
  # DEFINER alone (expected: catalog control only; see report)
  'M02_DEFINER_ALONE': [("STABLE\nSECURITY INVOKER\nSET search_path", "STABLE\nSECURITY DEFINER\nSET search_path")],
  # D2: scope from the OWNER (an agent-owned report shows own rows to everyone)
  'M03_SCOPE_FROM_OWNER': [("      WHEN v_base = 'own' THEN 'own'\n",
      "      WHEN v_base = 'own' THEN 'own'\n      WHEN (SELECT public._broker_report_member_role(p_org, d2.owner_user_id) FROM public.broker_report_definitions d2 WHERE d2.id = p_def) = 'agent' THEN 'own'\n")],
  # D3: 'own' applied to editors / 'own' ignored
  'M04_OWN_APPLIES_TO_EDITORS': [("      WHEN v_level = 'viewer' AND v_row_scope = 'own' THEN 'own'\n",
                                  "      WHEN v_level IN ('viewer', 'editor') AND v_row_scope = 'own' THEN 'own'\n")],
  'M05_OWN_IGNORED': [("      WHEN v_level = 'viewer' AND v_row_scope = 'own' THEN 'own'\n", "")],
  # D4 (C4): service-off branch dropped
  'M06_NO_SERVICE_OFF': [("      WHEN v_off THEN 'own'\n", "")],
  # D5: editor may transfer / agent cap re-added
  'M07_EDITOR_TRANSFERS': [("  IF d.id IS NULL OR public._broker_report_level(p_def) IS DISTINCT FROM 'owner'\n     OR p_new_owner IS NULL",
                            "  IF d.id IS NULL OR public._broker_report_level(p_def) NOT IN ('owner', 'editor')\n     OR p_new_owner IS NULL")],
  'M08_AGENT_CAP_ON_TRANSFER': [("     OR public._broker_report_member_role(d.organization_id, p_new_owner) IS NULL THEN",
                                 "     OR coalesce(public._broker_report_member_role(d.organization_id, p_new_owner), 'agent') = 'agent' THEN")],
  # D6: editor may delete / share gate = any level
  'M09_EDITOR_DELETES': [("  IF d.id IS NULL OR public._broker_report_level(p_def) IS DISTINCT FROM 'owner' THEN\n    RAISE EXCEPTION 'Report not found';\n  END IF;\n  DELETE FROM public.broker_report_saved_views",
                          "  IF d.id IS NULL OR public._broker_report_level(p_def) NOT IN ('owner', 'editor') THEN\n    RAISE EXCEPTION 'Report not found';\n  END IF;\n  DELETE FROM public.broker_report_saved_views")],
  'M10_SHARE_ANY_LEVEL': [(SHARE_GATE, SHARE_GATE.replace(" OR v_level NOT IN ('owner', 'editor')", ""))],
  # D7: role grant not matched on the exact role
  'M11_ROLE_ANY': [("            OR (g.principal_type = 'role' AND g.principal_role = v_role))",
                    "            OR (g.principal_type = 'role'))")],
  # D9: email in candidates / candidates from every organization
  'M12_CANDIDATE_EMAIL': [("               'kind', 'person', 'id', m.user_id,\n",
                           "               'kind', 'person', 'id', m.user_id, 'email', (SELECT u.email FROM public.users u WHERE u.id = m.user_id),\n")],
  'M13_CANDIDATES_ALL_ORGS': [("       WHERE m.organization_id = v_org\n         AND m.license_status = 'active'\n         AND m.user_id IS NOT NULL\n         AND o.personal",
                               "       WHERE m.license_status = 'active'\n         AND m.user_id IS NOT NULL\n         AND o.personal")],
  # D10: text GREATEST instead of integer rank
  'M14_TEXT_GREATEST': [("  v_rank int;\n", "  v_rank text;\n"),
      ("    SELECT CASE g.level WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 END AS r\n", "    SELECT g.level AS r\n"),
      ("    SELECT 1 WHERE v_def.general_access = 'organization'\n", "    SELECT 'viewer' WHERE v_def.general_access = 'organization'\n"),
      ("  RETURN CASE v_rank WHEN 2 THEN 'editor' WHEN 1 THEN 'viewer' END;\n", "  RETURN v_rank;\n")],
  # D12: audit without 'from' / audit on an unchanged level / reader drops report_name
  'M15_AUDIT_NO_FROM': [("        jsonb_build_object('member_id', v_member, 'from', v_old, 'to', p_level));",
                         "        jsonb_build_object('member_id', v_member, 'to', p_level));")],
  'M16_AUDIT_UNCHANGED': [("    IF v_old IS DISTINCT FROM p_level THEN\n      SELECT m.id INTO v_member",
                           "    IF true THEN\n      SELECT m.id INTO v_member")],
  'M17_READER_NO_REPORT_NAME': [("'plan', 'notified', 'report_name')))", "'plan', 'notified')))")],
  # V1: uploading child supersedes / child outside the scoped set supersedes
  'M18_CHILD_UPLOADING': [("              AND c.status <> 'uploading'\n", "")],
  'M19_CHILD_SCOPE': [("              AND (v_eff = 'all' OR c.submitted_by = v_uid))", "              )")],
  # V2: F5 non-member refusal / portal access check
  'M20_F5_NONMEMBER': [(F5_GATE, F5_GATE.replace("IF p_org IS NULL OR v_base IS NULL\n", "IF p_org IS NULL\n"))],
  'M21_F5_NO_PORTAL_CHECK': [(PORTAL, "")],
  # C8: delete leaves the d-<id> views
  'M22_DELETE_KEEPS_VIEWS': [("  DELETE FROM public.broker_report_saved_views\n   WHERE organization_id = d.organization_id AND report_key = lower('d-' || p_def::text);\n", "")],
  # C6: take-over while the owner is active / by an agent
  'M23_TAKEOVER_OWNER_ACTIVE': [("     OR (d.owner_user_id IS NOT NULL\n         AND public._broker_report_member_role(d.organization_id, d.owner_user_id) IS NOT NULL) THEN",
                                 "     THEN")],
  # SR N1: the owner-active check skipped for an it_admin caller only
  'M35_OWNER_ACTIVE_SKIPPED_FOR_IT_ADMIN': [("     OR (d.owner_user_id IS NOT NULL\n         AND public._broker_report_member_role(d.organization_id, d.owner_user_id) IS NOT NULL) THEN",
      "     OR (d.owner_user_id IS NOT NULL\n         AND public._broker_report_member_role(d.organization_id, v_uid) IS DISTINCT FROM 'it_admin'\n         AND public._broker_report_member_role(d.organization_id, d.owner_user_id) IS NOT NULL) THEN")],
  'M24_TAKEOVER_ANY_ROLE': [("'') NOT IN ('broker', 'admin', 'it_admin')", "'') = ''")],
  'M34_TAKEOVER_NO_IT_ADMIN': [("'') NOT IN ('broker', 'admin', 'it_admin')", "'') NOT IN ('broker', 'admin')")],
  # R2: take-over without the broker_reports check
  'M33_TAKEOVER_NO_FEATURE': [("     OR NOT coalesce(public._org_feature_allowed(d.organization_id, 'broker_reports'), false)\n     OR (d.owner_user_id",
                               "     OR (d.owner_user_id")],
  # R1: removing 'admins' deletes the admin row only
  'M32_REMOVE_ADMINS_PARTIAL': [("    v_roles := CASE WHEN p_id = 'admins' THEN ARRAY['admin', 'it_admin'] ELSE ARRAY[p_id] END;",
                                 "    v_roles := CASE WHEN p_id = 'admins' THEN ARRAY['admin'] ELSE ARRAY[p_id] END;")],
  # founder ruling: 'admins' writes admin only
  'M25_ADMINS_ADMIN_ONLY': [("      v_roles := v_roles || ARRAY['admin', 'it_admin'];", "      v_roles := v_roles || ARRAY['admin'];")],
  # 'admins' not collapsed on read
  'M31_SHARE_LIST_NO_COLLAPSE': [("            THEN 'admins' ELSE g.principal_role END AS rid,", "            THEN g.principal_role ELSE g.principal_role END AS rid,")],
  # D15: no stale check
  'M26_NO_STALE_CHECK': [("  IF p_expected_updated_at IS DISTINCT FROM d.updated_at THEN", "  IF false THEN")],
  # D8: a REVOKE dropped
  'M27_REVOKE_DROPPED': [("REVOKE ALL ON FUNCTION public._broker_report_level(uuid) FROM PUBLIC, anon, authenticated;",
                          "REVOKE ALL ON FUNCTION public._broker_report_level(uuid) FROM PUBLIC, anon;")],
  # founder ruling: row-scope setter restricted to the owner
  'M28_ROWSCOPE_OWNER_ONLY': [(F10_SCOPE, F10_SCOPE + "  IF v_scope IS DISTINCT FROM d.row_scope AND v_level <> 'owner' THEN\n    RAISE EXCEPTION 'Report not found';\n  END IF;\n")],
  # F15: a viewer may remove anyone
  'M29_REMOVE_ANYONE': [("    IF v_level NOT IN ('owner', 'editor') AND v_user IS DISTINCT FROM v_uid THEN", "    IF false THEN")],
  # F10: a viewer may update
  'M30_VIEWER_UPDATES': [("  IF d.id IS NULL OR v_level IS NULL OR v_level NOT IN ('owner', 'editor') THEN\n    RAISE EXCEPTION 'Report not found';\n  END IF;\n  v_scope",
                          "  IF d.id IS NULL OR v_level IS NULL THEN\n    RAISE EXCEPTION 'Report not found';\n  END IF;\n  v_scope")],
}

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)

def refresh_pin(t):
    m = re.search(r'CREATE OR REPLACE FUNCTION public\.admin_get_org_activity\(.*?AS \$function\$(.*?)\$function\$', t, re.S)
    h = hashlib.md5(m.group(1).encode()).hexdigest()
    t, n = re.subn(r"(ARRAY\['93ee729f73f23ecd90ffe49ca6d60704', ')[0-9a-f]{32}(')", lambda x: x.group(1) + h + x.group(2), t)
    if n != 1:
        sys.exit('reader pin row matched %d times' % n)
    return t

if sh('git', 'status', '--porcelain', '--', rel).stdout.strip():
    sys.exit('migration has uncommitted changes; commit before mutating')

modes = list(MUT) if sys.argv[1] == 'all' else sys.argv[1].split(',')
for mode in modes:
    body = open(mig).read()
    for old, new in MUT[mode]:
        n = body.count(old)
        if n != 1:
            sys.exit('%s MUTATION NOT APPLIED: fragment matched %d times: %r' % (mode, n, old[:80]))
        body = body.replace(old, new)
    body = refresh_pin(body)
    open(mig, 'w').write(body)
    ns = sh('git', 'diff', '--numstat', '--', rel).stdout.strip()
    if not ns:
        sys.exit('%s MUTATION NOT APPLIED: git diff empty' % mode)
    changed = [l for l in sh('git', 'diff', '-U0', '--', rel).stdout.splitlines()
               if l[:1] in '+-' and not l.startswith(('+++', '---')) and '93ee729f' not in l]
    print('== %s' % mode)
    print('MUTATION APPLIED numstat=%s/%s' % tuple(ns.split('\t')[:2]))
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
        print('RESTORED clean=%s' % (st == ''), flush=True)
        if st:
            sys.exit('restore failed')
