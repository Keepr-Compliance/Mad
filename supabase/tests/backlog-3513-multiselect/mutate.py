#!/usr/bin/env python3
"""BACKLOG-3513 PR-3h (20261114100000) mutations. For each mode: exact-string replace on the migration FILE (exits unless
every fragment matches exactly once), re-point the pin's md5 for the new function at the mutated body, print
MUTATION APPLIED + the changed lines, show `git diff --numstat`, run the controls (one keepr-test transaction
ending in RAISE, so nothing persists), assert a non-zero control count, restore the file with `git checkout --`,
and assert the file is clean. Commit the migration first.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import hashlib, json, os, re, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261114100000_backlog_3513_submissions_rows_multi.sql'
mig = os.path.join(root, rel)

MUT = {
  # only the first status of the list is used
  'M01_FIRST_STATUS_ONLY': [("     AND (v_statuses IS NULL OR s.status::text = ANY (v_statuses))\n",
                             "     AND (v_statuses IS NULL OR s.status::text = v_statuses[1])\n")],
  # the agent filter dropped
  'M02_NO_AGENT_FILTER': [("     AND (v_agents IS NULL OR s.submitted_by = ANY (v_agents))\n", "")],
  # own scope ignored for the row itself
  'M03_SCOPE_TRUE': [("     AND (v_eff = 'all' OR s.submitted_by = v_uid)\n", "     AND (true OR s.submitted_by = v_uid)\n")],
  # SR 6: INVOKER -> DEFINER (caught by the pg_proc assertion)
  'M04_DEFINER': [("STABLE\nSECURITY INVOKER\nSET search_path = public\nAS $function$\n#variable_conflict",
                   "STABLE\nSECURITY DEFINER\nSET search_path = public\nAS $function$\n#variable_conflict")],
  # anon keeps the default EXECUTE
  'M05_NO_REVOKE': [("REVOKE EXECUTE ON FUNCTION public.broker_report_submissions_rows_multi(uuid, uuid, text[], uuid[], timestamptz, timestamptz, text, integer, integer) FROM PUBLIC, anon;\n", "")],
  # the 'pending' group loses under_review
  'M06_GROUP_MAP': [("             WHEN 'pending' THEN ARRAY['submitted', 'resubmitted', 'under_review']\n",
                     "             WHEN 'pending' THEN ARRAY['submitted', 'resubmitted']\n")],
  # 'all' in the list no longer means no filter
  'M07_ALL_NOT_HANDLED': [("cardinality(p_statuses) > 0 AND NOT coalesce('all' = ANY (p_statuses), false) THEN",
                           "cardinality(p_statuses) > 0 THEN")],
  # a NULL element turns the filter off
  'M08_NULL_ELEMENT': [("AND NOT coalesce('all' = ANY (p_statuses), false) THEN", "AND NOT ('all' = ANY (p_statuses)) THEN")],
  # '{}' agents filters everything out
  'M09_EMPTY_AGENTS': [("  IF p_agents IS NOT NULL AND cardinality(p_agents) > 0 THEN\n", "  IF p_agents IS NOT NULL THEN\n")],
  # the pin no longer checks broker_report_scope
  'M10_PIN_NO_SCOPE': [("        ('public.broker_report_scope(uuid,uuid)', ARRAY['86899bd79510d5c29d6f33374e1040ff'], false),\n", "")],
  # search_path not pinned
  'M11_NO_SEARCH_PATH': [("SECURITY INVOKER\nSET search_path = public\nAS $function$\n#variable_conflict",
                          "SECURITY INVOKER\nAS $function$\n#variable_conflict")],
  # the pin accepts any body at the new name
  'M12_PIN_NEW_ANY': [("    IF r.cur IS NULL AND r.may_be_absent THEN\n", "    IF r.may_be_absent THEN\n")],
}

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)

def refresh_pin(t):
    m = re.search(r'CREATE OR REPLACE FUNCTION public\.broker_report_submissions_rows_multi\(.*?AS \$function\$(.*?)\$function\$', t, re.S)
    h = hashlib.md5(m.group(1).encode()).hexdigest()
    t, n = re.subn(r"(\n         ARRAY\[')[0-9a-f]{32}('\], true\))", lambda x: x.group(1) + h + x.group(2), t)
    if n != 1:
        sys.exit('new-function pin row matched %d times' % n)
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
               if l[:1] in '+-' and not l.startswith(('+++', '---')) and not re.search(r"^\S\s+ARRAY\['[0-9a-f]{32}'\], true\)", l)]
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
