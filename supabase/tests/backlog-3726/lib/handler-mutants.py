#!/usr/bin/env python3
"""BACKLOG-3726 handler mutants: each exact-string replacement must match once,
then the jest suite runs; the original file is written back afterwards."""
import json, os, re, subprocess, sys
F = "supabase/functions/submission-sweep/handler.ts"
T = "tests/edge-functions/submissionSweep.test.ts"
M = [
  ("H1", "        if (allRemoved) finishIds.push(s.id);", "        finishIds.push(s.id);", "a failed remove still finishes the row"),
  ("H2", 'const live = deps.getEnv("SUBMISSION_SWEEP_MODE") === "live" && body?.dry_run !== true;',
         'const live = deps.getEnv("SUBMISSION_SWEEP_MODE") !== "dry_run" && body?.dry_run !== true;', "unset mode = live"),
  ("H3", 'const live = deps.getEnv("SUBMISSION_SWEEP_MODE") === "live" && body?.dry_run !== true;',
         'const live = deps.getEnv("SUBMISSION_SWEEP_MODE") === "live" || body?.dry_run === false;', "body can upgrade to live"),
  ("H4", "deps.log(JSON.stringify({ submission_sweep: outcome, ...counts }));",
         "deps.log(JSON.stringify({ submission_sweep: outcome, ...counts, subs }));", "log carries ids and paths"),
  ("H5", "  if (!res.ok) throw new SweepError(stage, res.status);\n  return await res.json();",
         "  if (!res.ok) throw new Error(await res.text());\n  return await res.json();", "error carries the response body"),
  ("H6", "  if (!expected || !timingSafeEqual(presented, expected)) return json({ error: \"Unauthorized\" }, 401);",
         "  if (false) return json({ error: \"Unauthorized\" }, 401);", "secret not compared"),
  ("H7", "  if (!LOCAL_HOSTS.has(host)) return 0;\n", "", "test delay honoured in production"),
  ("H8", "        for (const part of chunks(Array.isArray(s.paths) ? s.paths : [], REMOVE_CHUNK)) {",
         "        for (const part of [Array.isArray(s.paths) ? s.paths : []]) {", "no chunking"),
]
orig = open(F).read()
bad = 0
try:
  for name, old, new, desc in M:
    if orig.count(old) != 1:
      print(f"{name}: MUTATION NOT APPLIED ({orig.count(old)} matches)"); sys.exit(1)
    open(F, "w").write(orig.replace(old, new))
    print(f"{name} MUTATION APPLIED: {desc}")
    r = subprocess.run(["npx", "jest", T], capture_output=True, text=True)
    m = re.search(r"Tests:\s+(?:(\d+) failed, )?(?:(\d+) passed, )?(\d+) total", r.stderr + r.stdout)
    if not m or int(m.group(3)) == 0:
      print("  Tests: 0 total or no summary -> FAILURE"); bad += 1; continue
    failed_n, total = int(m.group(1) or 0), int(m.group(3))
    names = re.findall(r"● (.+?)\n", r.stderr)
    print(f"  red {failed_n}/{total}: {names[:2]}")
    if failed_n == 0: bad += 1
finally:
  open(F, "w").write(orig)
print(f"handler mutants: {len(M)} run, {bad} not red")
sys.exit(1 if bad else 0)
