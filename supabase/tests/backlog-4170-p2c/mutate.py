#!/usr/bin/env python3
"""BACKLOG-4170 PR2c mutations. For each mode: exact-string replace on the migration FILE, scoped to one
function's CREATE ... $function$; block (exits unless each fragment matches exactly the expected number
of times), refresh the file's own post-md5 pins so the second apply passes the pre-pin, print MUTATION
APPLIED + the changed lines, show `git diff --numstat`, run the controls (one keepr-test transaction
ending in RAISE), assert a non-zero control count, restore the file with `git checkout --`, and assert
the tree is clean. Commit the migration BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, re, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from compose import bodies, SIGS  # noqa: E402
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rel = 'supabase/migrations/20261111125000_backlog_4170_support_requester_checks.sql'
mig = os.path.join(root, rel)
PIN = dict(SIGS)

FILTER = "(v_is_agent OR NOT ((e.event_type = 'message_added' AND e.new_value IS NOT DISTINCT FROM 'internal_note') OR e.event_type = 'internal_note_deleted'))"
FILTER_I = "(v_is_internal OR NOT ((e.event_type = 'message_added' AND e.new_value IS NOT DISTINCT FROM 'internal_note') OR e.event_type = 'internal_note_deleted'))"
SIGNED_IN = ("    IF NOT v_is_agent AND NOT EXISTS (\n      SELECT 1 FROM support_tickets\n      WHERE id = p_ticket_id\n"
             "      AND (requester_id = auth.uid() OR requester_email = (SELECT email FROM auth.users WHERE id = auth.uid()))\n"
             "    ) THEN\n      RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;\n    END IF;\n")
SIGNED_OUT = ("    IF NOT EXISTS (\n      SELECT 1 FROM support_tickets\n      WHERE id = p_ticket_id\n"
              "      AND lower(requester_email) = lower(p_sender_email)\n"
              "    ) THEN\n      RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;\n    END IF;\n")
NEWTXT = "      RAISE EXCEPTION 'Access denied: you can only reply to your own tickets';\n    END IF;\n"
# mode -> [(function name or None for the whole file, old, new, expected match count)]
MUT = {
  # event filter removed (each function)
  'FILTER_removed_get_ticket_detail': [('support_get_ticket_detail', "\n  AND " + FILTER + ";", ";", 1)],
  'FILTER_removed_list_events': [('support_list_events', "\n    AND " + FILTER_I + "),", "),", 1)],
  # filter written with = instead of IS NOT DISTINCT FROM (drops message_added rows with a NULL new_value)
  'FILTER_eq_null_get_ticket_detail': [('support_get_ticket_detail', "e.new_value IS NOT DISTINCT FROM 'internal_note'", "e.new_value = 'internal_note'", 1)],
  'FILTER_eq_null_list_events': [('support_list_events', "e.new_value IS NOT DISTINCT FROM 'internal_note'", "e.new_value = 'internal_note'", 1)],
  # agents filtered too
  'AGENT_filtered_get_ticket_detail': [('support_get_ticket_detail', "(v_is_agent OR NOT ((e.event_type", "(false OR NOT ((e.event_type", 1)],
  'AGENT_filtered_list_events': [('support_list_events', "(v_is_internal OR NOT ((e.event_type", "(false OR NOT ((e.event_type", 1)],
  # requester check removed: both branches, then each branch alone
  'REQUESTER_CHECK_removed': [('support_add_message', SIGNED_IN, "", 1), ('support_add_message', SIGNED_OUT, "", 1)],
  'REQUESTER_CHECK_removed_signed_in': [('support_add_message', SIGNED_IN, "", 1)],
  'REQUESTER_CHECK_removed_signed_out': [('support_add_message', SIGNED_OUT, "", 1)],
  # signed-in requester matched by requester_id only (email-only requester locked out)
  'REQUESTER_signed_in_id_only': [('support_add_message',
      "      AND (requester_id = auth.uid() OR requester_email = (SELECT email FROM auth.users WHERE id = auth.uid()))\n",
      "      AND requester_id = auth.uid()\n", 1)],
  # signed-in check keyed on p_sender_email instead of the caller's identity
  'REQUESTER_signed_in_uses_sender_email': [('support_add_message',
      "      AND (requester_id = auth.uid() OR requester_email = (SELECT email FROM auth.users WHERE id = auth.uid()))\n",
      "      AND (requester_id = auth.uid() OR requester_email = COALESCE(p_sender_email, (SELECT email FROM auth.users WHERE id = auth.uid())))\n", 1)],
  # signed-out email compared case-sensitively
  'EMAIL_CASE_sensitive': [('support_add_message', "      AND lower(requester_email) = lower(p_sender_email)\n",
                            "      AND requester_email = p_sender_email\n", 1)],
  # internal_note_deleted condition removed (each function)
  'NOTE_DELETED_removed_get_ticket_detail': [('support_get_ticket_detail', " OR e.event_type = 'internal_note_deleted'));", "));", 1)],
  'NOTE_DELETED_removed_list_events': [('support_list_events', " OR e.event_type = 'internal_note_deleted'))),", "))),", 1)],
  # signed-out compare written with ILIKE
  'SR_signed_out_ilike': [('support_add_message', "      AND lower(requester_email) = lower(p_sender_email)\n",
                           "      AND requester_email ILIKE p_sender_email\n", 1)],
  # agents subjected to the requester check
  'AGENT_blocked': [('support_add_message', "    IF NOT v_is_agent AND NOT EXISTS (\n", "    IF NOT EXISTS (\n", 1)],
  # a refusal text that differs from the unknown-ticket reply
  'NEW_REFUSAL_TEXT': [('support_add_message', "    ) THEN\n      RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;\n    END IF;\n",
                         "    ) THEN\n" + NEWTXT, 2)],
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
