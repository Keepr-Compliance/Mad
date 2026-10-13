#!/usr/bin/env python3
"""BACKLOG-3878 mutants of the 3878 migration: the most likely wrong implementations.

Each mutant is a list of edits (old, new). `apply` raises unless `old` occurs
exactly once, so a mutant that did not apply is never counted.

usage: mutants.py list                      -> name|target controls
       mutants.py apply <name> <src> <out>
       mutants.py classify < status-lines   -> INVALID (any ERROR or no line), KILLED (>=1 FAIL), SURVIVED
"""
import sys

WHEN = ("  WHEN ((OLD.status IS DISTINCT FROM 'suspended' AND NEW.status = 'suspended')\n"
        "        OR (OLD.status = 'suspended' AND NEW.status = 'active'))\n")
PAUSE_IF = "  IF NEW.status = 'suspended' AND OLD.status IS DISTINCT FROM 'suspended' THEN\n"
RESUME_IF = "  ELSIF OLD.status = 'suspended' AND NEW.status = 'active' THEN\n"
STAMP = "  v_stamp := (floor(extract(epoch FROM clock_timestamp()) * 1000000))::bigint::text;\n"
LOOP = "    SELECT sc.stripe_mode FROM public.stripe_customers sc WHERE sc.user_id = NEW.user_id\n"
VALUES = "      VALUES (v_cust.stripe_mode, v_kind, NEW.user_id,\n"
INNER_BEGIN = "    BEGIN\n      INSERT INTO public.billing_outbox"
INNER_EXC = ("    EXCEPTION WHEN OTHERS THEN\n"
             "      RAISE WARNING 'BACKLOG-3878: % row not enqueued for user % (%): % %',\n"
             "        v_kind, NEW.user_id, v_cust.stripe_mode, SQLSTATE, SQLERRM;\n"
             "    END;\n")
OUTER_EXC = ("EXCEPTION WHEN OTHERS THEN\n"
             "  RAISE WARNING 'BACKLOG-3878: licence % billing enqueue failed: % %', NEW.user_id, SQLSTATE, SQLERRM;\n"
             "  RETURN NULL;\n")
TRIGGER_HEAD = ("DROP TRIGGER IF EXISTS billing_pause_resume_on_licence_status ON public.licenses;\n"
                "CREATE TRIGGER billing_pause_resume_on_licence_status\n"
                "  AFTER UPDATE OF status ON public.licenses\n"
                "  FOR EACH ROW\n")

MUTANTS = {
    # Resume on any exit from suspended (reinstated to expired/cancelled would charge a month).
    'resume-any-exit': ([(WHEN, WHEN.replace("NEW.status = 'active'))", "NEW.status IS DISTINCT FROM 'suspended'))")),
                         (RESUME_IF, "  ELSIF OLD.status = 'suspended' AND NEW.status IS DISTINCT FROM 'suspended' THEN\n")], 'w10'),
    # Pause on every write that leaves the licence suspended (no transition check).
    'pause-on-any-suspended-write': ([(WHEN, ""), (PAUSE_IF, "  IF NEW.status = 'suspended' THEN\n")], 'w09 w02'),
    # NULL old status never matches '<>' (SR R9).
    'old-status-not-null-safe': ([(WHEN, WHEN.replace("OLD.status IS DISTINCT FROM 'suspended'", "OLD.status <> 'suspended'")),
                                  (PAUSE_IF, PAUSE_IF.replace("OLD.status IS DISTINCT FROM 'suspended'", "OLD.status <> 'suspended'"))], 'w12'),
    # Dedupe key on updated_at (now(), transaction-stable): second cycle in one transaction dropped.
    'key-on-updated-at': ([(STAMP, "  v_stamp := (floor(extract(epoch FROM NEW.updated_at) * 1000000))::bigint::text;\n")], 'w11'),
    # SR R6: keyed on the mirror row, not the customer.
    'keyed-on-mirror': ([(LOOP, "    SELECT bs.stripe_mode FROM public.billing_subscriptions bs WHERE bs.user_id = NEW.user_id\n"
                                "       AND bs.status IN ('active', 'trialing', 'past_due', 'incomplete')\n")], 'w08'),
    # Mode hard-coded.
    'mode-hardcoded-live': ([(VALUES, "      VALUES ('live', v_kind, NEW.user_id,\n")], 'w01 w04'),
    # A failed enqueue aborts the suspension.
    'no-exception-wrappers': ([(INNER_BEGIN, "    INSERT INTO public.billing_outbox".replace("    INSERT", "      INSERT")), (INNER_EXC, ""), (OUTER_EXC, "")], 'w14'),
    'no-revoke': ([("REVOKE EXECUTE ON FUNCTION public._billing_on_licence_suspension() FROM PUBLIC, anon, authenticated;\n", "")], 'w15'),
    # Only the pause half (resume left to someone else).
    'no-resume-branch': ([(WHEN, "  WHEN (OLD.status IS DISTINCT FROM 'suspended' AND NEW.status = 'suspended')\n")], 'w04 w05 w06'),
    # No database hook at all.
    'no-trigger': ([(TRIGGER_HEAD + WHEN + "  EXECUTE FUNCTION public._billing_on_licence_suspension();\n", "")], 'w01 w02 w03'),
}


def apply(name, src, out):
    edits, _ = MUTANTS[name]
    s = open(src).read()
    for old, new in edits:
        n = s.count(old)
        if n != 1:
            raise SystemExit(f'{name}: expected 1 match, found {n}: {old[:60]!r}')
        s = s.replace(old, new)
    open(out, 'w').write(s)


def classify(lines):
    lines = [l for l in lines if l.strip()]
    if not lines or any(l.startswith('ERROR|') for l in lines):
        return 'INVALID'
    return 'KILLED' if any(l.startswith('FAIL|') for l in lines) else 'SURVIVED'


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'list':
        for k, (_, t) in MUTANTS.items():
            print(f'{k}|{t}')
    elif cmd == 'apply':
        apply(*sys.argv[2:5])
    elif cmd == 'classify':
        print(classify(sys.stdin.read().splitlines()))
