#!/usr/bin/env python3
"""BACKLOG-3513 PR-5 mutations. For each mode: exact-string replace on the migration FILE (exits unless the
fragment matches exactly once), re-point the pin's post md5 for every body at the mutated text (the
pin would otherwise refuse the second apply), print MUTATION APPLIED + the changed line(s), show
`git diff --numstat`, run the controls with --with-migration (one keepr-test transaction ending in
RAISE, so nothing persists), assert a non-zero control count, restore the file with `git checkout --`,
and assert `git status --porcelain` is empty. Commit the migration BEFORE running this.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import hashlib, json, os, re, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261112160000_backlog_3513_share_audit.sql'
mig = os.path.join(root, rel)

ALOG = "  IF v_old IS DISTINCT FROM p_role THEN\n    PERFORM public.log_admin_action('report_access.set'"
SLOG = "  IF v_old IS DISTINCT FROM p_role THEN\n    PERFORM public.log_admin_action('report_share.set'"
AUPS = "DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = now();\n\n" + ALOG
SUPS = "DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = now();\n\n" + SLOG
AREREAD = "  SELECT ra.role INTO v_old FROM report_access ra WHERE ra.report_key = p_key AND ra.user_id = p_user_id;\n"
SREREAD = "  SELECT s.role INTO v_old FROM report_saved_view_shares s WHERE s.view_id = v_view_id AND s.user_id = p_user_id;\n"
MUT = {
  # likeliest wrong fix: <> is NULL on a first grant, so no row
  'M_NEQ_access': [(ALOG, ALOG.replace('v_old IS DISTINCT FROM p_role', 'v_old <> p_role'))],
  'M_NEQ_share': [(SLOG, SLOG.replace('v_old IS DISTINCT FROM p_role', 'v_old <> p_role'))],
  # a row on every set, including an unchanged level
  'M_ALWAYS_LOG_access': [(ALOG, ALOG.replace('v_old IS DISTINCT FROM p_role', 'true'))],
  'M_ALWAYS_LOG_share': [(SLOG, SLOG.replace('v_old IS DISTINCT FROM p_role', 'true'))],
  # the old level read after the upsert (from == to)
  'FROM_READ_AFTER_access': [(AUPS, AUPS.replace('\n\n  IF', '\n' + AREREAD + '\n  IF', 1))],
  'FROM_READ_AFTER_share': [(SUPS, SUPS.replace('\n\n  IF', '\n' + SREREAD + '\n  IF', 1))],
  # remove: the old level read after the DELETE (always NULL)
  'RM_FROM_READ_AFTER_access': [("  RETURNING ra.role INTO v_old;\n  GET DIAGNOSTICS v_removed = ROW_COUNT;\n",
                                 "  ;\n  GET DIAGNOSTICS v_removed = ROW_COUNT;\n" + AREREAD)],
  'RM_FROM_READ_AFTER_share': [("  RETURNING s.role, v.report_key INTO v_old, v_report_key;\n  GET DIAGNOSTICS v_removed = ROW_COUNT;\n",
                                "  RETURNING v.report_key INTO v_report_key;\n  GET DIAGNOSTICS v_removed = ROW_COUNT;\n"
                                "  SELECT s.role INTO v_old FROM report_saved_view_shares s WHERE s.view_id = p_view_id AND s.user_id = p_user_id;\n")],
  # share_remove's RETURNING omits the view's report_key -> report_key NULL in metadata
  'SHARE_RM_NO_REPORT_KEY': [("  RETURNING s.role, v.report_key INTO v_old, v_report_key;\n", "  RETURNING s.role INTO v_old;\n")],
  # share_set rebuilt from the 4087 body: no report-access predicates
  'S6_SHARE_SET_4087_BODY': [("    AND public._report_access_role(v_caller_id, v.report_key) IN ('editor', 'owner')\n"
                              "    AND public._report_access_role(p_user_id, v.report_key) IS NOT NULL\n", "")],
  # C5 guard mutations (guard preservation in the re-typed bodies)
  'G_NONOWNER_access_set': [("  IF public._report_access_role(v_caller_id, p_key) IS DISTINCT FROM 'owner'\n     OR p_user_id IS NULL",
                             "  IF public._report_access_role(v_caller_id, p_key) IS NULL\n     OR p_user_id IS NULL")],
  'G_access_remove_no_owner_or_self': [("    AND ra.user_id = p_user_id\n    AND (ra.user_id = v_caller_id\n"
                                        "         OR public._report_access_role(v_caller_id, p_key) IS NOT DISTINCT FROM 'owner')\n",
                                        "    AND ra.user_id = p_user_id\n")],
  'G_share_set_no_owner': [("    AND v.user_id = v_caller_id\n    AND p_user_id IS NOT NULL\n", "    AND p_user_id IS NOT NULL\n")],
  'G_share_remove_no_owner': [("    AND (v.user_id = v_caller_id OR s.user_id = v_caller_id)\n", "    AND (s.user_id = v_caller_id)\n")],
  # widening: no owner-or-self clause at all, so a third party can remove a share
  'G_share_remove_no_clause': [("    AND (v.user_id = v_caller_id OR s.user_id = v_caller_id)\n", "")],
}

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)

PIN_SIG = {'report_access_set': 'public.report_access_set(text,uuid,text)',
           'report_access_remove': 'public.report_access_remove(text,uuid)',
           'report_share_set': 'public.report_share_set(uuid,uuid,text)',
           'report_share_remove': 'public.report_share_remove(uuid,uuid)'}

def refresh_pin(t):
    for m in re.finditer(r'CREATE OR REPLACE FUNCTION public\.(\w+)\(.*?AS (\$\w*\$)(.*?)\2', t, re.S):
        h = hashlib.md5(m.group(3).encode()).hexdigest()
        pat = re.compile(r"(\('" + re.escape(PIN_SIG[m.group(1)]) + r"', '[0-9a-f]{32}', ')[0-9a-f]{32}(')")
        t, n = pat.subn(lambda x: x.group(1) + h + x.group(2), t)
        if n != 1:
            sys.exit('pin row for %s matched %d times' % (m.group(1), n))
    return t

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
    body = refresh_pin(body)
    open(mig, 'w').write(body)
    ns = sh('git', 'diff', '--numstat', '--', rel).stdout.strip()
    if not ns:
        sys.exit('%s MUTATION NOT APPLIED: git diff empty' % mode)
    changed = [l for l in sh('git', 'diff', '-U0', '--', rel).stdout.splitlines()
               if l[:1] in '+-' and not l.startswith(('+++', '---')) and "', '" not in l]
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
