#!/usr/bin/env python3
"""BACKLOG-3846 mutants of the 3846 migration: the most likely wrong implementations.

Each mutant is a list of edits (old, new). `apply` raises unless `old` occurs
exactly once, so a mutant that did not apply is never counted.

usage: mutants.py list                      -> name|target controls
       mutants.py apply <name> <src> <out>
       mutants.py classify < status-lines   -> INVALID (any ERROR or no line), KILLED (>=1 FAIL), SURVIVED
"""
import sys

WHEN = "  WHEN (OLD.status = 'suspended' AND NEW.status = 'active')\n"
TRIGGER = ("DROP TRIGGER IF EXISTS billing_regrant_on_unsuspend ON public.licenses;\n"
           "CREATE TRIGGER billing_regrant_on_unsuspend\n"
           "  AFTER UPDATE OF status ON public.licenses\n"
           "  FOR EACH ROW\n" + WHEN +
           "  EXECUTE FUNCTION public._billing_on_licence_unsuspend();\n")
GRANT_CALL = "    v_result := public.grant_unlimited_from_subscription(NEW.user_id, v_cpe + interval '2 hours', v_mode);\n"
EXC = ("  EXCEPTION WHEN OTHERS THEN\n"
       "    RAISE WARNING 'BACKLOG-3846: unsuspend re-grant failed for user %: % %', NEW.user_id, SQLSTATE, SQLERRM;\n")
ROLE_CHECK = ("  IF auth.uid() IS NULL AND COALESCE(auth.role(), '') <> 'service_role' THEN\n"
              "    RAISE EXCEPTION 'log_admin_action: a signed-in user or the service role is required'\n"
              "      USING ERRCODE = '42501';\n"
              "  END IF;\n")

MUTANTS = {
    # R8: the step-0 WHEN clause also fires on suspended -> cancelled/expired.
    'when-not-suspended': ([(WHEN, "  WHEN (OLD.status = 'suspended' AND NEW.status IS DISTINCT FROM 'suspended')\n")], 'u09'),
    # The founder's literal rule without paused = false.
    'drop-paused': ([("     AND bs.paused = false\n", "")], 'u05'),
    'drop-period-end': ([("     AND bs.current_period_end > now()\n", "")], 'u04'),
    'drop-status': ([("     AND bs.status IN ('active', 'trialing')\n", "")], 'u06'),
    'no-buffer': ([(GRANT_CALL, GRANT_CALL.replace(" + interval '2 hours'", ""))], 'u01 u02 u03'),
    # A failed re-grant aborts the unsuspend.
    'no-exception-wrapper': ([("  BEGIN\n" + GRANT_CALL, GRANT_CALL), (EXC, ""), ("  END;\n  RETURN NULL;\nEND\n$fn$;", "  RETURN NULL;\nEND\n$fn$;")], 'u07'),
    # A 'refused' result raised instead of warned (R8 note) -> unsuspend aborts... wrapped, so harmless;
    # the real wrong implementation is RAISE EXCEPTION outside the wrapper:
    'refused-raises': ([("    IF v_result ->> 'status' IS DISTINCT FROM 'granted' THEN\n      RAISE WARNING",
                         "    IF v_result ->> 'status' IS DISTINCT FROM 'granted' THEN\n      RAISE EXCEPTION"),
                        (EXC, "")], 'u10'),
    'no-revoke-trigger-fn': ([("REVOKE EXECUTE ON FUNCTION public._billing_on_licence_unsuspend() FROM PUBLIC, anon, authenticated;\n", "")], 'u08'),
    # No database hook at all (e.g. a TypeScript hook after one admin call).
    'no-trigger': ([(TRIGGER, "")], 'u01 u02 u03'),
    # Fires on every status write, not only the transition.
    'no-when': ([(WHEN, "")], 'u09 u11'),
    # BACKLOG-3136 fix incomplete.
    'keep-not-null': ([("ALTER TABLE public.admin_audit_logs ALTER COLUMN actor_id DROP NOT NULL;\n", "")], 'k01 k02 k03'),
    'keep-anon-execute': ([("REVOKE EXECUTE ON FUNCTION public.log_admin_action(text, text, text, jsonb, inet, text) FROM PUBLIC, anon;\n", "")], 'k02 k03'),
    'no-role-check': ([(ROLE_CHECK, "")], 'k02'),
    'no-drift-guard': ([("  IF md5(v_src) <> 'df1ef32e483bab95212c7525be8c5fb2' AND v_src NOT LIKE '%BACKLOG-3136%' THEN",
                         "  IF false THEN")], 'k06'),
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
