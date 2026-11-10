#!/usr/bin/env python3
"""BACKLOG-4170 PR2c: write the migration from the PR2b bodies of the 3 touched functions plus exact,
count-checked replacements. Re-running it reproduces the committed file byte for byte (CI-free check:
`python3 gen_migration.py --check`)."""
import hashlib, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
MIGS = os.path.join(here, '..', '..', 'migrations')
SRC = os.path.join(MIGS, '20261111115000_backlog_4170_support_group_e_permissions.sql')
OUT = os.path.join(MIGS, '20261111125000_backlog_4170_support_requester_checks.sql')
NAMES = [('support_add_message', 'public.support_add_message(uuid,text,text,text,text)'),
         ('support_get_ticket_detail', 'public.support_get_ticket_detail(uuid,text)'),
         ('support_list_events', 'public.support_list_events(uuid)')]

EDITS = {
  'support_add_message': [
    # signed-in non-agent: the requester rule support_get_ticket_detail applies to a signed-in non-agent
    ("    v_is_agent := public.has_permission(auth.uid(), 'support.view');\n",
     "    v_is_agent := public.has_permission(auth.uid(), 'support.view');\n"
     "    IF NOT v_is_agent AND NOT EXISTS (\n"
     "      SELECT 1 FROM support_tickets\n"
     "      WHERE id = p_ticket_id\n"
     "      AND (requester_id = auth.uid() OR requester_email = (SELECT email FROM auth.users WHERE id = auth.uid()))\n"
     "    ) THEN\n"
     "      RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;\n"
     "    END IF;\n"),
    # signed out: p_sender_email must be the ticket's requester_email (case-insensitive)
    ("      RAISE EXCEPTION 'sender_email is required for unauthenticated messages';\n    END IF;\n",
     "      RAISE EXCEPTION 'sender_email is required for unauthenticated messages';\n    END IF;\n"
     "    IF NOT EXISTS (\n"
     "      SELECT 1 FROM support_tickets\n"
     "      WHERE id = p_ticket_id\n"
     "      AND lower(requester_email) = lower(p_sender_email)\n"
     "    ) THEN\n"
     "      RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;\n"
     "    END IF;\n"),
  ],
  'support_get_ticket_detail': [
    ("  LEFT JOIN profiles p ON p.id = e.actor_id\n  WHERE e.ticket_id = p_ticket_id;\n",
     "  LEFT JOIN profiles p ON p.id = e.actor_id\n  WHERE e.ticket_id = p_ticket_id\n"
     "  AND (v_is_agent OR NOT ((e.event_type = 'message_added' AND e.new_value IS NOT DISTINCT FROM 'internal_note') OR e.event_type = 'internal_note_deleted'));\n"),
  ],
  'support_list_events': [
    ("    FROM support_ticket_events e\n    WHERE e.ticket_id = p_ticket_id),\n",
     "    FROM support_ticket_events e\n    WHERE e.ticket_id = p_ticket_id\n"
     "    AND (v_is_internal OR NOT ((e.event_type = 'message_added' AND e.new_value IS NOT DISTINCT FROM 'internal_note') OR e.event_type = 'internal_note_deleted'))),\n"),
  ],
}

MARK = {
  'support_add_message': "-- Intentionally callable by anon: a signed-out requester replies to their own ticket (p_sender_email must equal the ticket's requester_email, case-insensitive)",
  'support_get_ticket_detail': "-- Intentionally callable by anon: a signed-out requester reads their own ticket (p_requester_email must match)",
  'support_list_events': "-- Intentionally callable by anon: returns [] to a caller with no user id",
}

HEADER = """-- BACKLOG-4170 PR2c — support functions: requester checks and event filtering
--
-- support_add_message
--   A caller without support.view may add a message only to a ticket they requested:
--     signed in   requester_id = auth.uid() OR requester_email = the caller's auth email (the rule
--                 support_get_ticket_detail and support_is_ticket_requester apply to a signed-in
--                 non-agent)
--     signed out  lower(requester_email) = lower(p_sender_email)
--   Any other ticket gets the function's existing reply for an unknown ticket ('Ticket not found').
--   Agents (support.view) are unchanged.
-- support_get_ticket_detail, support_list_events
--   A caller without support.view does not receive event rows with event_type = 'message_added'
--   and new_value = 'internal_note', or with event_type = 'internal_note_deleted'. Agents receive
--   every row, as before.
--
-- Only those lines differ from the PR2b bodies (20261111115000). Every other line and every RAISE
-- text is unchanged.
--
-- Grants: unchanged (no REVOKE / GRANT in this file). PUBLIC, anon, authenticated and service_role
-- keep EXECUTE on all 3. Intentionally callable signed out:
--   support_add_message          a signed-out requester replies to their ticket (p_sender_email)
--   support_get_ticket_detail    a signed-out requester reads their ticket (p_requester_email)
--   support_list_events          returns [] to a caller with no user id
--
-- Pre-pin: the migration stops unless each body is the PR2b text or this file's text.
-- Rollback: supabase/tests/backlog-4170-p2c/rollback-4170-p2c.sql (PR2b text; ACL unchanged).
"""


def blocks(text):
    """{name: (full CREATE ... $function$; statement, body)}"""
    out = {}
    for m in re.finditer(r'CREATE OR REPLACE FUNCTION public\.(\w+)\(.*?AS \$function\$(.*?)\$function\$;', text, re.S):
        out[m.group(1)] = (m.group(0), m.group(2))
    return out


def build():
    src = blocks(open(SRC).read())
    stmts, pins = [], []
    for name, sig in NAMES:
        stmt, body = src[name]
        new = body
        for old, rep in EDITS[name]:
            assert new.count(old) == 1, (name, old[:60], new.count(old))
            new = new.replace(old, rep)
        stmts.append(MARK[name] + '\n' + stmt.replace(body, new))
        pins.append("        ('%s', '%s', '%s')" % (sig, hashlib.md5(body.encode()).hexdigest(), hashlib.md5(new.encode()).hexdigest()))
    pin = ("DO $pin$\nDECLARE r record;\nBEGIN\n  FOR r IN\n    SELECT v.sig, v.prev, v.post, md5(p.prosrc) AS cur\n      FROM (VALUES\n"
           + ',\n'.join(pins) +
           "\n      ) AS v(sig, prev, post)\n      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.sig)\n  LOOP\n"
           "    IF r.cur IS NULL THEN\n      RAISE EXCEPTION 'BACKLOG-4170 PR2c: % not found', r.sig;\n    END IF;\n"
           "    IF r.cur NOT IN (r.prev, r.post) THEN\n"
           "      RAISE EXCEPTION 'BACKLOG-4170 PR2c: % body changed (md5 %); re-review before applying', r.sig, r.cur;\n"
           "    END IF;\n  END LOOP;\nEND\n$pin$;\n")
    return HEADER + '\n' + pin + '\n' + '\n\n'.join(stmts) + '\n'


if __name__ == '__main__':
    t = build()
    if '--check' in sys.argv:
        ok = open(OUT).read() == t
        print('GEN CHECK', 'EQUAL' if ok else 'DIFFERS'); sys.exit(0 if ok else 1)
    open(OUT, 'w').write(t)
    print(OUT, len(t))
