#!/usr/bin/env python3
"""BACKLOG-3674 mutants.

Two kinds:
  - edit:   an exact-string replacement on the migration. `apply` raises unless
            the pattern occurs exactly once, so a mutant that did not apply can
            never be counted as survived.
  - append: extra SQL run after the migration (a change the migration or the app
            must not make), written to the extra file.

usage: mutants.py list
       mutants.py apply <name> <migration> <out-migration> <out-extra>
       mutants.py classify < status-lines

classify reads the PASS|/FAIL|/ERROR| lines of every target control run
against one mutant and prints its verdict:
  INVALID   any ERROR line, or no status line at all: the run proved nothing
  KILLED    no ERROR and at least one FAIL: a control's assertion saw the mutant
  SURVIVED  only PASS lines
"""
import sys

MUTANTS = {
    # name: (kind, old_or_sql, new_or_None, target controls)
    "m01-no-grant": (
        "edit", "GRANT UPDATE (tour_dismissed_at) ON public.users TO authenticated;\n", "",
        "d2-grants d3-writes"),
    "m02-grant-to-anon": (
        "edit", "ON public.users TO authenticated;", "ON public.users TO authenticated, anon;",
        "d2-grants d3-writes"),
    "m03-type-text": (
        "edit", "ADD COLUMN IF NOT EXISTS tour_dismissed_at timestamptz;", "ADD COLUMN IF NOT EXISTS tour_dismissed_at text;",
        "d1-column-shape"),
    "m04-no-if-not-exists": (
        "edit", "ADD COLUMN IF NOT EXISTS tour_dismissed_at", "ADD COLUMN tour_dismissed_at",
        "d4-apply-twice"),
    "m05-app-no-is-null-guard": (
        "append",
        "CREATE OR REPLACE FUNCTION pg_temp.app_dismiss(p_target text, p_ts text) RETURNS text LANGUAGE sql AS $m$\n"
        "  SELECT format('update public.users set tour_dismissed_at = %L where id = %L', p_ts, '{' || p_target || '}')\n$m$;\n",
        None, "d3-writes"),
    "m06-table-level-update-grant": (
        "edit", "GRANT UPDATE (tour_dismissed_at) ON public.users", "GRANT UPDATE ON public.users",
        "d2-grants"),
    "m07-backfill-from-setup": (
        "append",
        "UPDATE public.users SET tour_dismissed_at = now() WHERE id = pg_temp.id('u_a');\n",
        None, "d1-column-shape"),
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
        raise SystemExit("usage: mutants.py list | apply <name> <migration> <out-migration> <out-extra>")
    name, mig, out_mig, out_extra = sys.argv[2:6]
    kind, a, b, _targets = MUTANTS[name]
    src = open(mig).read()
    extra = ""
    if kind == "edit":
        n = src.count(a)
        if n != 1:
            raise SystemExit(f"mutant {name}: pattern occurs {n} times (need exactly 1)")
        src = src.replace(a, b)
    else:
        extra = a
    open(out_mig, "w").write(src)
    open(out_extra, "w").write(extra)


if __name__ == "__main__":
    main()
