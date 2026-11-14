#!/usr/bin/env python3
"""BACKLOG-4243 PR-3: compose the cloud_list_install_rows controls into ONE transaction that ends
in RAISE (nothing persists) and run it through kt-sql on the test project.

  run.py [baseline|install_term|owner_term] [--print]

A mutant is an exact-string replace that raises when the pattern does not match exactly once.
The results come back in the RAISE message: RESULTS {"L1_...": "PASS", ...}.
"""
import os, re, secrets, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
MIG = os.path.join(ROOT, "supabase/migrations/20261114130000_backlog_4243_cloud_list_install_rows.sql")
MUTANTS = {
    "baseline": None,
    "install_term": ("AND d.source_install_id = $2 /*INSTALL:list_rows*/", "AND $2 IS NOT NULL /*INSTALL:list_rows*/"),
    "owner_term": ("WHERE t.owner_user_id = $1 AND d.owner_user_id = $1 /*OWNER:list_rows*/", "WHERE $1 IS NOT NULL /*OWNER:list_rows*/"),
}

def compose(which):
    mig = open(MIG).read()
    m = MUTANTS[which]
    if m:
        n = mig.count(m[0])
        if n != 1:
            raise SystemExit(f"mutant {which}: pattern matched {n} times; NOT applied")
        mig = mig.replace(m[0], m[1])
        print(f"MUTATION APPLIED {which}: {m[1]}", file=sys.stderr)
    controls = open(os.path.join(HERE, "list-install-rows-controls.sql")).read().replace("__RUN__", secrets.token_hex(6))
    return "BEGIN;\n" + mig + "\n" + controls + "\nROLLBACK;\n"

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "baseline"
    sql = compose(which)
    if "--print" in sys.argv:
        print(sql)
        raise SystemExit(0)
    r = subprocess.run([os.path.expanduser("~/.claude/bin/kt-sql"), "-c", sql], capture_output=True, text=True)
    out = r.stdout + r.stderr
    raw = out.replace('\\\\', '\\').replace('\\"', '"')
    verdicts = re.findall(r'"(L\d_[a-z_]+)": "(PASS|FAIL)', raw)
    print(" ".join(f"{k}={v}" for k, v in sorted(verdicts)) if verdicts else out[-1500:])
