#!/usr/bin/env python3
"""BACKLOG-3513 PR-3f (20261112220000) mutations. For each mode: exact-string replace on the migration FILE (exits unless
every fragment matches exactly once), re-point the pin's post md5 for broker_report_def_get at the
mutated text, print MUTATION APPLIED + the changed lines, show `git diff --numstat`, run the controls
(one keepr-test transaction ending in RAISE, so nothing persists), assert a non-zero control count,
restore the file with `git checkout --`, and assert the file is clean. Commit the migration first.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import hashlib, json, os, re, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261112220000_backlog_3513_broker_report_reassign.sql'
mig = os.path.join(root, rel)

MUT = {
  # likely wrong build 1: admin allowed even when an active it_admin exists
  'R01_ADMIN_ALWAYS': [("  RETURN v_role = 'it_admin'\n      OR (v_role = 'admin' AND NOT EXISTS (",
                        "  RETURN v_role IN ('it_admin', 'admin')\n      OR (v_role = 'admin' AND NOT EXISTS (")],
  # likely wrong build 2: reassign allowed while the owner is active
  'R02_OWNER_ACTIVE_OK': [("     OR (d.owner_user_id IS NOT NULL\n         AND public._broker_report_member_role(d.organization_id, d.owner_user_id) IS NOT NULL) THEN\n    RETURN false;",
                           "     THEN\n    RETURN false;")],
  # likely wrong build 3: the old take_over left callable
  'R03_TAKE_OVER_KEPT': [("DROP FUNCTION IF EXISTS public.broker_report_take_over(uuid);\n", "")],
  # broker allowed too
  'R04_BROKER_ALLOWED': [("  RETURN v_role = 'it_admin'\n", "  RETURN v_role IN ('it_admin', 'broker')\n")],
  # new owner not checked for active membership
  'R05_NO_NEW_OWNER_CHECK': [("     OR p_new_owner IS NOT DISTINCT FROM d.owner_user_id\n     OR public._broker_report_member_role(d.organization_id, p_new_owner) IS NULL THEN",
                              "     OR p_new_owner IS NOT DISTINCT FROM d.owner_user_id THEN")],
  # new owner may be the current owner
  'R06_SAME_OWNER_OK': [("     OR p_new_owner IS NOT DISTINCT FROM d.owner_user_id\n", "")],
  # feature check dropped
  'R07_NO_FEATURE': [("     OR NOT coalesce(public._org_feature_allowed(d.organization_id, 'broker_reports'), false)\n     OR (d.owner_user_id", "     OR (d.owner_user_id")],
  # the NULL-role bug found while building (non-member caller passes)
  'R08_NULL_ROLE': [("  v_role := coalesce(public._broker_report_member_role(d.organization_id, v_uid), '');",
                     "  v_role := public._broker_report_member_role(d.organization_id, v_uid);"),
                    ("     OR NOT coalesce(public._broker_report_reassign_eligible(p_def), false)\n     OR p_new_owner IS NULL",
                     "     OR NOT public._broker_report_reassign_eligible(p_def)\n     OR p_new_owner IS NULL")],
  # the new owner's grant row kept
  'R09_GRANT_KEPT': [("  DELETE FROM public.broker_report_definition_grants\n   WHERE definition_id = p_def AND principal_type = 'user' AND principal_user_id = p_new_owner;\n", "")],
  # audit without 'from'
  'R10_AUDIT_NO_FROM': [("                       'from', public._broker_report_person_name(d.owner_user_id),\n", "")],
  # a suspended it_admin counts as present
  'R11_INACTIVE_IT_ADMIN_COUNTS': [("               AND m.role = 'it_admin'\n               AND m.license_status = 'active'\n", "               AND m.role = 'it_admin'\n")],
  # candidates without the eligibility gate
  'R12_CANDIDATES_UNGATED': [("  IF NOT coalesce(public._broker_report_reassign_eligible(p_def), false) THEN\n    RAISE EXCEPTION 'Report not found';\n  END IF;\n  SELECT organization_id INTO v_org",
                              "  SELECT organization_id INTO v_org")],
  # def_get answers true for everyone
  'R13_DEF_GET_ALWAYS_TRUE': [("    'reassign_available', coalesce(public._broker_report_reassign_eligible(p_def), false));",
                               "    'reassign_available', true);")],
  # the private helper callable by authenticated
  'R14_HELPER_GRANTED': [("REVOKE ALL ON FUNCTION public._broker_report_reassign_eligible(uuid) FROM PUBLIC, anon, authenticated;",
                          "REVOKE ALL ON FUNCTION public._broker_report_reassign_eligible(uuid) FROM PUBLIC, anon;")],
}

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)

def refresh_pin(t):
    m = re.search(r'CREATE OR REPLACE FUNCTION public\.broker_report_def_get\(.*?AS \$function\$(.*?)\$function\$', t, re.S)
    h = hashlib.md5(m.group(1).encode()).hexdigest()
    t, n = re.subn(r"(ARRAY\['cb8bc16c908873fb53cf0ff34b146b7b', ')[0-9a-f]{32}(')", lambda x: x.group(1) + h + x.group(2), t)
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
               if l[:1] in '+-' and not l.startswith(('+++', '---')) and 'cb8bc16c' not in l]
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
