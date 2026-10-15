#!/usr/bin/env python3
"""BACKLOG-3675 mutants.

Two kinds:
  - edit:   an exact-string replacement on the migration. `apply` raises unless
            the pattern occurs exactly once, so a mutant that did not apply can
            never be counted as survived.
  - append: extra SQL run after the migration (a policy change the migration
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
    "m01-plan-rows-on": (
        "edit", "SELECT p.id, fd.id, false, 'false'", "SELECT p.id, fd.id, true, 'true'",
        "d4-off-everywhere d2-override-grants"),
    "m02-min-tier-team": (
        "edit", "  NULL,\n  162,", "  'team',\n  162,",
        "d2-override-grants d4-off-everywhere"),
    "m03-default-true": (
        "edit", "  'boolean',\n  'false',", "  'boolean',\n  'true',",
        "d4-off-everywhere"),
    "m04-no-conflict-guard": (
        "edit", "ON CONFLICT (key) DO NOTHING;", ";",
        "d3-apply-twice"),
    "m05-authenticated-update-policy": (
        "append",
        "CREATE POLICY t3675_mut_update ON public.organization_plans FOR UPDATE TO authenticated USING (true) WITH CHECK (true);\n",
        None, "d1-no-self-grant"),
    "m06-no-member-select-policy": (
        "append",
        "DROP POLICY IF EXISTS organization_plans_select_authenticated ON public.organization_plans;\n",
        None, "d5-member-reads-overrides"),
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
