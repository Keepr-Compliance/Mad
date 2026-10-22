#!/usr/bin/env python3
"""Exact-once mutation of a SQL file (BACKLOG-3851 PR-2f mutation discipline).

Usage: mutate.py <src.sql> <out.sql> <old-text-file> <new-text-file>
Raises unless <old> occurs exactly once. Prints MUTATION APPLIED, the mutated line(s) and
`git diff --no-index --numstat` of src vs out.
"""
import subprocess, sys
src, out, oldf, newf = sys.argv[1:5]
s = open(src).read(); old = open(oldf).read(); new = open(newf).read()
n = s.count(old)
if n != 1:
    raise SystemExit(f"MUTATION NOT APPLIED: {n} matches")
open(out, "w").write(s.replace(old, new))
print("MUTATION APPLIED")
print("  - " + old.strip().replace("\n", "\n  - "))
print("  + " + new.strip().replace("\n", "\n  + "))
d = subprocess.run(["git", "diff", "--no-index", "--numstat", src, out], capture_output=True, text=True)
print("numstat:", d.stdout.strip())
