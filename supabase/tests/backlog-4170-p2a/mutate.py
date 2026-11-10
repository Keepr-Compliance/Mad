#!/usr/bin/env python3
"""BACKLOG-4170 PR2a mutations. For each mode: exact-string replace on the migration FILE (exits unless each
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
from compose import bodies, SIGS  # noqa: E402
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261111110000_backlog_4170_support_group_d_permissions.sql'
mig = os.path.join(root, rel)
PIN = dict(SIGS)

STATS = ("  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) %s public.has_permission(auth.uid(), 'support.view') THEN\n"
         "    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';\n  END IF;\n\n"
         "  SELECT COUNT(*) INTO v_total FROM support_tickets WHERE status NOT IN ('closed');")
LIST_TPL = ("CREATE OR REPLACE FUNCTION public.support_list_templates()\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n"
            " SET search_path TO 'public'\nAS $function$\nBEGIN\n"
            "  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) OR NOT %s THEN")
# (old, new, expected match count)
MUT = {
  # internal role OR permission instead of AND (NOT a AND NOT b admits a caller holding either)
  'OR_not_AND': [(STATS % 'OR NOT', STATS % 'AND NOT', 1)],
  # support_assign_ticket keyed on the wrong permission
  'WRONG_KEY': [("  ) OR NOT public.has_permission(v_caller_id, 'support.view') THEN\n    RAISE EXCEPTION 'Only authenticated agents can assign tickets';",
                 "  ) OR NOT public.has_permission(v_caller_id, 'support.assign') THEN\n    RAISE EXCEPTION 'Only authenticated agents can assign tickets';", 1)],
  # support_create_template keyed on support.view instead of support.manage | support.admin
  'TEMPLATES_view': [("  ) OR NOT public.has_any_permission(v_caller_id, ARRAY['support.manage', 'support.admin']) THEN\n    RAISE EXCEPTION 'Only authenticated agents can create templates'",
                      "  ) OR NOT public.has_permission(v_caller_id, 'support.view') THEN\n    RAISE EXCEPTION 'Only authenticated agents can create templates'", 1)],
  # support_list_templates narrowed to support.manage | support.admin (agents lose the template picker)
  'LIST_TEMPLATES_narrowed': [(LIST_TPL % "public.has_permission(auth.uid(), 'support.view')",
                               LIST_TPL % "public.has_any_permission(auth.uid(), ARRAY['support.manage', 'support.admin'])", 1)],
  # anon left holding EXECUTE on one function
  'ANON_not_revoked': [("REVOKE EXECUTE ON FUNCTION public.support_search_requesters(text) FROM PUBLIC, anon;",
                        "REVOKE EXECUTE ON FUNCTION public.support_search_requesters(text) FROM PUBLIC;", 1)],
  # a refusal's RAISE text changed (support_remove_participant)
  'REFUSAL_text_changed': [("    RAISE EXCEPTION 'Only agents can remove participants';",
                            "    RAISE EXCEPTION 'support.view required to remove participants';", 1)],
  # support_bulk_update_tickets/5 left as production (one of three overloads forgotten)
  'D_left': [("  -- AUTH GUARD\n  IF v_caller_id IS NULL OR NOT EXISTS (\n    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id\n"
              "  ) OR NOT public.has_permission(v_caller_id, 'support.view') THEN\n    RAISE EXCEPTION 'Only authenticated agents can bulk update tickets';",
              "  -- AUTH GUARD\n  IF v_caller_id IS NULL OR NOT EXISTS (\n    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id\n"
              "  ) THEN\n    RAISE EXCEPTION 'Only authenticated agents can bulk update tickets';", 1)],
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
