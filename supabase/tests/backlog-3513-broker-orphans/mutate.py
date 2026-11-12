#!/usr/bin/env python3
"""BACKLOG-3513 orphans: DB mutations on migration 20261112210000 (keepr-test, rolled back).

Usage: mutate.py [MODE ...]   (all modes when none given)
Each mode: exact replace in the committed migration (stops unless the fragment matches once), prints
MUTATION APPLIED + git diff --numstat, runs run.sh, asserts a non-zero control count, restores the file
with git checkout and asserts the tree is clean. Run `select pg_stat_statements_reset()` after the loop.
"""
import json, os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.abspath(os.path.join(here, '..', '..', '..'))
REL = 'supabase/migrations/20261112210000_backlog_3513_broker_report_orphans.sql'
PATH = os.path.join(root, REL)
M = {
  'OM1_ORPHANS_NO_ROLE_CHECK': (
    "     OR coalesce(public._broker_report_member_role(p_org, v_uid), '') NOT IN ('broker', 'admin', 'it_admin')\n", ""),
  'OM2_ORPHANS_ANY_ORG': (
    "     WHERE d.organization_id = p_org\n       AND (d.owner_user_id IS NULL",
    "     WHERE (d.owner_user_id IS NULL"),
  'OM3_ORPHANS_NO_OWNER_TERM': (
    "     WHERE d.organization_id = p_org\n       AND (d.owner_user_id IS NULL\n            OR public._broker_report_member_role(d.organization_id, d.owner_user_id) IS NULL));",
    "     WHERE d.organization_id = p_org);"),
  'OM4_FLAG_IGNORES_OWNER': (
    "      AND d.owner_user_id IS DISTINCT FROM v_uid\n      AND (d.owner_user_id IS NULL\n           OR public._broker_report_member_role(d.organization_id, d.owner_user_id) IS NULL)));",
    "      AND d.owner_user_id IS DISTINCT FROM v_uid));"),
  'OM5_DEF_GET_OPEN_FOR_ORPHANS': (
    "  IF v_level IS NULL THEN\n",
    "  IF v_level IS NULL AND NOT EXISTS (SELECT 1 FROM public.broker_report_definitions x WHERE x.id = p_def AND x.owner_user_id IS NULL) THEN\n"),
  'OM6_NO_ANON_REVOKE': (
    "REVOKE ALL ON FUNCTION public.broker_report_orphans(uuid) FROM PUBLIC, anon;",
    "REVOKE ALL ON FUNCTION public.broker_report_orphans(uuid) FROM PUBLIC;"),
  'OM7_FLAG_ANY_ROLE': (
    "      coalesce(public._broker_report_member_role(d.organization_id, v_uid), '') IN ('broker', 'admin', 'it_admin')\n      AND ",
    "      "),
}
def sh(*a): return subprocess.run(a, cwd=root, capture_output=True, text=True)
assert sh('git', 'status', '--porcelain', '--', REL).stdout.strip() == '', 'migration not committed / dirty'
for name in (sys.argv[1:] or list(M)):
    old, new = M[name]
    src = open(PATH).read()
    n = src.count(old)
    if n != 1:
        print(f'{name}: fragment matched {n} times - NOT APPLIED'); continue
    mutated = src.replace(old, new)
    # A def_get mutation changes its body, which the pin's second-run branch would refuse: let the pin
    # accept the mutated body (so the behaviour is what is measured; C_def_get_body still reds).
    import hashlib
    i = mutated.index('CREATE OR REPLACE FUNCTION public.broker_report_def_get(')
    a = mutated.index('AS $function$', i) + len('AS $function$'); b = mutated.index('$function$', a)
    h = hashlib.md5(mutated[a:b].encode()).hexdigest()
    if h != 'cb8bc16c908873fb53cf0ff34b146b7b':
        mutated = mutated.replace("'cb8bc16c908873fb53cf0ff34b146b7b'", "'" + h + "'")
        print(f'  (pin accepts mutated def_get body {h})')
    open(PATH, 'w').write(mutated)
    ns = sh('git', 'diff', '--numstat', '--', REL).stdout.split()
    assert ns, 'no diff'
    print(f'{name}: MUTATION APPLIED numstat {ns[0]}/{ns[1]}')
    out = subprocess.run([os.path.join(here, 'run.sh')], capture_output=True, text=True).stdout
    sh('git', 'checkout', '--', REL)
    assert sh('git', 'status', '--porcelain', '--', REL).stdout.strip() == '', 'restore failed'
    try:
        d = json.loads(out[:out.rindex('}') + 1])
    except Exception:
        print('  NO RESULT:', out[:400]); continue
    assert d['total'] > 0, 'zero controls'
    print(f"  total {d['total']} fail {d['fail']}: {', '.join(sorted(d['reds']))}")
