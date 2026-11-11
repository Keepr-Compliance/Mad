#!/usr/bin/env python3
"""BACKLOG-4170 PR1 mutations. For each mode: exact-string replace on the migration FILE (exits unless each
fragment matches exactly the expected number of times), refresh the file's own post-md5 pins so the
second apply passes the pre-pin (a wrong author would pin their own text), print MUTATION APPLIED + the
changed lines, show `git diff --numstat`, run the controls (one keepr-test transaction ending in RAISE,
so nothing persists), assert a non-zero control count, restore the file with `git checkout --`, and
assert the tree is clean. Commit the migration BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, re, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from compose import bodies  # noqa: E402
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261111100000_backlog_4170_admin_group_a_permissions.sql'
mig = os.path.join(root, rel)
PIN = {'search_users': 'public.admin_search_users(text,integer)', 'get_user_detail': 'public.admin_get_user_detail(uuid)',
       'list_organizations': 'public.admin_list_organizations()',
       'get_audit_logs': 'public.admin_get_audit_logs(integer,integer,text,text,timestamptz,timestamptz)',
       'billing_live': 'public.admin_get_brokerage_billing_live()', 'solo_trial': 'public.admin_get_solo_trial_setting()'}

# (old, new, expected match count)
MUT = {
  # internal role OR permission instead of AND (NOT a AND NOT b admits a caller holding either)
  'OR_not_AND': [("  IF NOT has_internal_role(auth.uid()) OR NOT public.has_permission(auth.uid(), 'organizations.view') THEN",
                  "  IF NOT has_internal_role(auth.uid()) AND NOT public.has_permission(auth.uid(), 'organizations.view') THEN", 1)],
  # list_organizations keyed on the wrong permission
  'WRONG_KEY': [("public.has_permission(auth.uid(), 'organizations.view')", "public.has_permission(auth.uid(), 'organizations.edit')", 1)],
  # the plans.view branch compared with = (NOT(false OR NULL) is NULL, so the IF does not raise)
  'AUDIT_NULL_UNSAFE': [("p_action IS NOT DISTINCT FROM 'billing.solo_trial_updated'", "p_action = 'billing.solo_trial_updated'", 1)],
  # the plans.view branch without the action filter
  'AUDIT_no_action': [("(p_action IS NOT DISTINCT FROM 'billing.solo_trial_updated'\n        AND public.has_permission(auth.uid(), 'plans.view'))",
                       "public.has_permission(auth.uid(), 'plans.view')", 1)],
  # admin_get_solo_trial_setting's guard left as production (the can_edit has_permission line stays)
  'SOLO_left': [("  IF NOT coalesce(public.has_internal_role(v_uid), false)\n"
                 "     OR NOT coalesce(public.has_any_permission(v_uid, ARRAY['plans.view', 'billing.pricebook']), false) THEN",
                 "  IF NOT coalesce(public.has_internal_role(v_uid), false) THEN", 1)],
  # anon left holding EXECUTE on one function
  'ANON_not_revoked': [("REVOKE EXECUTE ON FUNCTION public.admin_search_users(text, integer) FROM PUBLIC, anon;",
                        "REVOKE EXECUTE ON FUNCTION public.admin_search_users(text, integer) FROM PUBLIC;", 1)],
  # a refusal's RAISE text changed (admin_get_audit_logs)
  'REFUSAL_text_changed': [("    RAISE EXCEPTION 'Unauthorized: internal role required';\n  END IF;\n\n  SELECT count(*) INTO v_total",
                            "    RAISE EXCEPTION 'Unauthorized: audit.view required';\n  END IF;\n\n  SELECT count(*) INTO v_total", 1)],
  # admin_list_organizations' refusal shape changed
  'REFUSAL_shape_changed': [("RETURN jsonb_build_object('success', false, 'error', 'not_authorized');",
                             "RETURN jsonb_build_object('success', false, 'error', 'forbidden');", 1)],
}


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)


def repin(text):
    for k, h in bodies(text).items():
        rx = r"(\('%s', '[0-9a-f]{32}', ')[0-9a-f]{32}('\))" % re.escape(PIN[k])
        text, n = re.subn(rx, r'\g<1>%s\g<2>' % h, text)
        if n != 1:
            sys.exit('pin for %s matched %d times' % (k, n))
    return text


if __name__ == '__main__':
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
        open(mig, 'w').write(repin(body))
        ns = sh('git', 'diff', '--numstat', '--', rel).stdout.strip()
        if not ns:
            sys.exit('%s MUTATION NOT APPLIED: git diff empty' % mode)
        changed = [l for l in sh('git', 'diff', '-U0', '--', rel).stdout.splitlines()
                   if l[:1] in '+-' and not l.startswith(('+++', '---'))]
        print('== %s' % mode)
        print('MUTATION APPLIED numstat=%s/%s' % tuple(ns.split('\t')[:2]))
        for l in changed:
            print('  %s %s' % (l[0], l[1:].strip()[:160]))
        try:
            out = subprocess.run([os.path.join(here, 'run.sh')], capture_output=True, text=True)
            o = out.stdout
            try:
                d = json.loads(o[o.index('{'):o.rindex('}') + 1])
                print('RESULT total=%s pass=%s fail=%s' % (d['total'], d['pass'], d['fail']))
                print('REDS ' + ','.join(sorted(d['reds'])))
                if not d['total']:
                    print('ZERO CONTROLS RAN')
                if not d['fail']:
                    print('MUTANT SURVIVED')
            except Exception:
                print('NO RESULT ' + o[:800] + out.stderr[:400])
        finally:
            sh('git', 'checkout', '--', rel)
            st = sh('git', 'status', '--porcelain', '--', rel).stdout.strip()
            print('RESTORED clean=%s' % (st == ''))
            if st:
                sys.exit('restore failed')
