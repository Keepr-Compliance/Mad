#!/usr/bin/env python3
"""BACKLOG-4170 PR2b mutations. For each mode: exact-string replace on the migration FILE, scoped to one
function's CREATE ... $function$; block where a function is named (exits unless each fragment matches
exactly the expected number of times), refresh the file's own post-md5 pins so the second apply passes
the pre-pin (a wrong author would pin their own text), print MUTATION APPLIED + the changed lines, show
`git diff --numstat`, run the controls (one keepr-test transaction ending in RAISE, so nothing
persists), assert a non-zero control count, restore the file with `git checkout --`, and assert the
tree is clean. Commit the migration BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, re, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from compose import bodies, SIGS  # noqa: E402
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261111115000_backlog_4170_support_group_e_permissions.sql'
mig = os.path.join(root, rel)
PIN = dict(SIGS)

AGENT = "  v_is_agent := EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id);"
AGENT_NEW = "  v_is_agent := public.has_permission(v_caller_id, 'support.view');"
INTERNAL_ML = "  v_is_internal := EXISTS (\n    SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller\n  );"
INTERNAL_NEW = "  v_is_internal := public.has_permission(v_caller, 'support.view');"
INLINE = "    OR EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller)"
# mode -> [(function name or None for the whole file, old, new, expected match count)]
MUT = {
  # one per function: the production internal-role line left in place (the 3 inline ones = INLINE_left)
  'IS_AGENT_kept_add_message': [('support_add_message', "    v_is_agent := public.has_permission(auth.uid(), 'support.view');",
                                 "    v_is_agent := EXISTS (SELECT 1 FROM internal_roles WHERE user_id = auth.uid());", 1)],
  'IS_AGENT_kept_get_ticket_detail': [('support_get_ticket_detail', AGENT_NEW, AGENT, 1)],
  'IS_AGENT_kept_list_tickets': [('support_list_tickets', AGENT_NEW, AGENT, 1)],
  'IS_AGENT_kept_list_attachments': [('support_list_attachments', INTERNAL_NEW, INTERNAL_ML, 1)],
  'IS_AGENT_kept_list_events': [('support_list_events', INTERNAL_NEW, INTERNAL_ML, 1)],
  'IS_AGENT_kept_record_attachment_access': [('support_record_attachment_access', INTERNAL_NEW,
      "  v_is_internal := EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller);", 1)],
  'INLINE_left_add_attachment': [('support_add_attachment', "    OR public.has_permission(v_uploader_id, 'support.view')",
                                  "    OR EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_uploader_id)", 1)],
  'INLINE_left_add_diagnostic_attachment': [('support_add_diagnostic_attachment', "    OR public.has_permission(v_caller, 'support.view')", INLINE, 1)],
  'INLINE_left_delete_own_attachment': [('support_delete_own_attachment',
      "    OR public.has_any_permission(v_caller, ARRAY['support.manage', 'support.admin'])", INLINE, 1)],
  # support_add_attachment refuses a requester who is not an agent
  'RAISE_non_agent': [('support_add_attachment', "    support_is_ticket_requester(p_ticket_id::text)\n    OR public.has_permission(v_uploader_id",
                       "    false\n    OR public.has_permission(v_uploader_id", 1)],
  # signed-in requester matched by requester_id only (the requester_email branch dropped)
  'REQUESTER_branch_changed': [('support_get_ticket_detail',
      "      AND (requester_id = v_caller_id OR requester_email = (SELECT email FROM auth.users WHERE id = v_caller_id))",
      "      AND requester_id = v_caller_id", 1)],
  # support_list_tickets requester filter matched by requester_id only (both queries)
  'REQUESTER_list_changed': [('support_list_tickets', "OR (t.requester_id = v_caller_id OR t.requester_email = v_caller_email)",
                              "OR t.requester_id = v_caller_id", 2)],
  # signed-out reader no longer has to match the ticket's requester_email
  'REQUESTER_anon_changed': [('support_get_ticket_detail', "      AND requester_email = p_requester_email\n",
                              "      AND p_requester_email IS NOT NULL\n", 1)],
  # delete override keyed on support.view
  'DELETE_override_view': [('support_delete_own_attachment',
      "    OR public.has_any_permission(v_caller, ARRAY['support.manage', 'support.admin'])",
      "    OR public.has_permission(v_caller, 'support.view')", 1)],
  # a grant changed (anon loses support_list_events)
  'GRANT_changed': [(None, "\n-- Grants: unchanged.\n",
                     "\n-- Grants: unchanged.\nREVOKE EXECUTE ON FUNCTION public.support_list_events(uuid) FROM PUBLIC, anon;\n", 1)],
  # a refusal's RAISE text changed
  'REFUSAL_text_changed': [('support_add_message', "    RAISE EXCEPTION 'Only agents can add internal notes';",
                            "    RAISE EXCEPTION 'support.view required to add internal notes';", 1)],
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


def apply(body, fn, old, new, cnt, mode):
    if fn is None:
        start, end = 0, len(body)
    else:
        start = body.index('CREATE OR REPLACE FUNCTION public.%s(' % fn)
        end = body.index('$function$;', start)
    seg = body[start:end]
    n = seg.count(old)
    if n != cnt:
        sys.exit('%s MUTATION NOT APPLIED: fragment matched %d times in %s, expected %d' % (mode, n, fn, cnt))
    return body[:start] + seg.replace(old, new) + body[end:]


if __name__ == '__main__':
    if sh('git', 'status', '--porcelain', '--', rel).stdout.strip():
        sys.exit('migration has uncommitted changes; commit before mutating')
    modes = list(MUT) if sys.argv[1] == 'all' else sys.argv[1].split(',')
    for mode in modes:
        body = open(mig).read()
        for fn, old, new, cnt in MUT[mode]:
            body = apply(body, fn, old, new, cnt, mode)
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
