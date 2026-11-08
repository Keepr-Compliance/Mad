#!/usr/bin/env python3
"""BACKLOG-3514 mutations. For each mode: exact-string replace on the target FILE (exits unless each
fragment matches exactly the expected number of times), print MUTATION APPLIED + the changed lines,
show `git diff --numstat`, then run what can see it:
  - migration targets: the SQL controls (run.sh controls --with-migration: rollback first, one
    keepr-test transaction ending in RAISE, so nothing persists), asserting a non-zero count;
  - broker-portal targets: the broker-portal suites __tests__/reports-3514 and reports-3505,
    asserting a non-zero test count.
Then restore the file with `git checkout --` and assert the tree is clean. Commit everything BEFORE
running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, re, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
MIG = 'supabase/migrations/20261108220000_backlog_3514_broker_saved_views.sql'
API = 'broker-portal/lib/reports/saved-views/broker-views-api.ts'
DEG = 'broker-portal/lib/reports/saved-views/degrade.ts'

LIST_FROM = ("      FROM public.broker_report_saved_views v\n"
             "     WHERE v.organization_id = p_org\n")
LIST_FROM_SHARED = ("      FROM (SELECT id, name, filters, metric, pinned, is_default, created_at, updated_at, report_key, user_id,\n"
                    "                   p_org AS organization_id FROM public.report_saved_views\n"
                    "            UNION ALL\n"
                    "            SELECT id, name, filters, metric, pinned, is_default, created_at, updated_at, report_key, user_id,\n"
                    "                   organization_id FROM public.broker_report_saved_views) v\n"
                    "     WHERE v.organization_id = p_org\n")
PIN_LOCK = ("    PERFORM pg_advisory_xact_lock(\n"
            "      hashtextextended('broker_report_saved_views:' || v_org::text || ':' || v_uid::text || ':' || v_key, 3514)\n"
            "    ) /*PIN_LOCK*/;\n")

# mode: (target, [(old, new, expected match count)])
MUT = {
  # update gates on the argument org instead of the row's org
  'UPDATE_uses_p_org': (MIG, [("v_org := v_org /*UPDATE_ORG*/;", "v_org := p_org;", 1)]),
  # remove gates on the argument org instead of the row's org
  'REMOVE_uses_p_org': (MIG, [("public._broker_report_views_gate(v_org /*REMOVE_ORG*/)", "public._broker_report_views_gate(p_org)", 1)]),
  # list without the owner predicate
  'LIST_no_owner': (MIG, [("\n       AND v.user_id = v_uid /*LIST_OWNER*/", "", 1)]),
  # the broker list reads the admin table too (the rejected reuse design)
  'LIST_reads_admin_table_sql': (MIG, [(LIST_FROM, LIST_FROM_SHARED, 1)]),
  # the broker adapter calls the admin list function
  'LIST_reads_admin_table_ts': (API, [("list: 'broker_report_list_views',", "list: 'report_list_saved_views',", 1)]),
  # the plan-feature check is skipped
  'FEATURE_skipped': (MIG, [("\n     AND coalesce(public._org_feature_allowed(p_org, 'broker_reports'), false) /*FEATURE*/", "", 1)]),
  # organization and report key become mutable
  'ORG_KEY_mutable': (MIG, [("IF NEW.organization_id IS DISTINCT FROM OLD.organization_id /*IMMUTABLE_ORG*/\n"
                             "     OR NEW.report_key IS DISTINCT FROM OLD.report_key /*IMMUTABLE_KEY*/\n"
                             "     OR NEW.user_id", "IF NEW.user_id", 1)]),
  # degrade throws on an unknown filter key instead of stripping it
  'DEGRADE_throws': (DEG, [("dropped.push(`filter ${key}`) /*STRIP_UNKNOWN_FILTER*/;", "throw new Error(`unknown filter ${key}`);", 1)]),
  # anon (via PUBLIC) keeps EXECUTE on the list function
  'ANON_keeps_execute': (MIG, [("REVOKE EXECUTE ON FUNCTION public.broker_report_list_views(uuid, text) FROM PUBLIC, anon;\n", "", 1)]),
  # the pin count runs without the lock
  'PIN_no_lock': (MIG, [(PIN_LOCK, "", 1)]),
}

def sh(*a, cwd=root):
    return subprocess.run(a, capture_output=True, text=True, cwd=cwd)

def sql_controls():
    out = subprocess.run([os.path.join(here, 'run.sh'), 'controls', '--with-migration'], capture_output=True, text=True)
    o = out.stdout
    try:
        d = json.loads(o[o.index('{'):o.rindex('}') + 1])
        print('  SQL   total=%s pass=%s fail=%s reds=%s' % (d['total'], d['pass'], d['fail'], ','.join(sorted(d['reds'])) or '-'))
        if not d['total']:
            print('  SQL   ZERO CONTROLS RAN')
    except Exception:
        print('  SQL   NO RESULT ' + o[:600] + out.stderr[:300])

def jest_portal():
    out = sh('npx', 'jest', '__tests__/reports-3514', '__tests__/reports-3505', cwd=os.path.join(root, 'broker-portal'))
    err = out.stderr
    m = re.search(r'^Tests:\s+(.*)$', err, re.M)
    if not m:
        print('  JEST  NO RESULT ' + err[-600:]); return
    nums = dict((k, int(v)) for v, k in re.findall(r'(\d+) (failed|passed|total)', m.group(1)))
    reds = sorted(set(re.findall(r'^\s+● (.*)$', err, re.M)))
    print('  JEST  total=%s pass=%s fail=%s reds=%s' % (nums.get('total', 0), nums.get('passed', 0), nums.get('failed', 0), ' | '.join(reds) or '-'))
    if not nums.get('total'):
        print('  JEST  ZERO TESTS RAN')

for rel in (MIG, API, DEG):
    if sh('git', 'status', '--porcelain', '--', rel).stdout.strip():
        sys.exit('%s has uncommitted changes; commit before mutating' % rel)

modes = list(MUT) if sys.argv[1] == 'all' else sys.argv[1].split(',')
for mode in modes:
    rel, frags = MUT[mode]
    path = os.path.join(root, rel)
    body = open(path).read()
    for old, new, cnt in frags:
        n = body.count(old)
        if n != cnt:
            sys.exit('%s MUTATION NOT APPLIED: fragment matched %d times, expected %d' % (mode, n, cnt))
        body = body.replace(old, new)
    open(path, 'w').write(body)
    try:
        ns = sh('git', 'diff', '--numstat', '--', rel).stdout.strip()
        if not ns:
            sys.exit('%s MUTATION NOT APPLIED: git diff empty' % mode)
        changed = [l for l in sh('git', 'diff', '-U0', '--', rel).stdout.splitlines()
                   if l[:1] in '+-' and not l.startswith(('+++', '---'))]
        print('== %s (%s)' % (mode, rel))
        print('MUTATION APPLIED numstat=%s/%s' % tuple(ns.split('\t')[:2]))
        for l in changed:
            print('  %s %s' % (l[0], l[1:].strip()[:150]))
        if rel == MIG:
            sql_controls()
        else:
            jest_portal()
    finally:
        sh('git', 'checkout', '--', rel)
        st = sh('git', 'status', '--porcelain', '--', rel).stdout.strip()
        print('RESTORED clean=%s' % (st == ''))
        if st:
            sys.exit('restore failed')
