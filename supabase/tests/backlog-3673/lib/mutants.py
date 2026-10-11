#!/usr/bin/env python3
"""BACKLOG-3673 mutants.

Kinds:
  - edit:    exact-string replacement on the migration.
  - rbedit:  exact-string replacement on the data rollback (ROLLBACK_FILE).
`apply` raises unless the pattern occurs exactly once, so a mutant that did not
apply can never be counted.

usage: mutants.py list
       mutants.py apply <name> <migration> <rollback> <out-migration> <out-rollback>
       mutants.py classify < status-lines

classify reads the PASS|/FAIL|/ERROR| lines of every target control run
against one mutant and prints its verdict:
  INVALID   any ERROR line, or no status line at all: the run proved nothing
  KILLED    no ERROR and at least one FAIL: a control's assertion saw the mutant
  SURVIVED  only PASS lines
"""
import sys

MUTANTS = {
    # name: (kind, old, new, target controls)
    "m01-no-writeonce-guard": (
        "edit",
        "  IF OLD.onboarding_completed_at IS NOT NULL THEN\n"
        "    NEW.onboarding_completed_at := OLD.onboarding_completed_at;\n"
        "  END IF;\n",
        "",
        "c3-authenticated c5a-rollback"),
    "m02-authenticated-keeps-execute": (
        "edit",
        "REVOKE ALL ON FUNCTION public.users_keep_onboarding_completed() FROM authenticated;\n",
        "",
        "c2-apply"),
    "m03-backfill-wrong-value": (
        "edit",
        "   SET onboarding_completed_at = email_onboarding_completed_at\n",
        "   SET onboarding_completed_at = now()\n",
        "c2-apply"),
    "m04-no-drop-if-exists": (
        "edit",
        "DROP TRIGGER IF EXISTS users_keep_onboarding_completed ON public.users;\n",
        "",
        "c4-apply-twice"),
    "r01-rollback-without-disable": (
        "rbedit",
        "ALTER TABLE public.users DISABLE TRIGGER users_keep_onboarding_completed;\n",
        "",
        "c5a-rollback"),
    "r02-rollback-keyed-on-value": (
        "rbedit",
        "UPDATE public.users SET onboarding_completed_at = NULL WHERE id IN (SELECT id FROM r3673_ids);\n",
        "UPDATE public.users SET onboarding_completed_at = NULL WHERE onboarding_completed_at IS NOT NULL;\n",
        "c5a-rollback"),
}


def classify(lines):
    status = [l.split("|", 1)[0] for l in lines if l.split("|", 1)[0] in ("PASS", "FAIL", "ERROR")]
    if not status or "ERROR" in status:
        return "INVALID"
    if "FAIL" in status:
        return "KILLED"
    return "SURVIVED"


def main():
    if sys.argv[1] == "classify":
        print(classify(sys.stdin.read().splitlines()))
        return
    if sys.argv[1] == "list":
        for k, v in MUTANTS.items():
            print(f"{k}|{v[-1]}")
        return
    if sys.argv[1] != "apply":
        raise SystemExit(__doc__)
    name, mig, rb, out_mig, out_rb = sys.argv[2:7]
    kind, a, b, _targets = MUTANTS[name]
    srcs = {"edit": open(mig).read(), "rbedit": open(rb).read()}
    n = srcs[kind].count(a)
    if n != 1:
        raise SystemExit(f"mutant {name}: pattern occurs {n} times (need exactly 1)")
    srcs[kind] = srcs[kind].replace(a, b)
    open(out_mig, "w").write(srcs["edit"])
    open(out_rb, "w").write(srcs["rbedit"])


if __name__ == "__main__":
    main()
