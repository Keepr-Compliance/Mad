#!/usr/bin/env python3
"""BACKLOG-2866 control harness.

Breaks the gate on purpose, one mutation at a time, and records which suites go
red. A green check carries no information until it has been made to fail.

Restores from an in-memory backup (never `git checkout --`, which stages the
file and hides the revert).
"""
import os
import re
import shutil
import subprocess
import sys

# Repo root, derived from this file's location — the worktree this was written
# in is deleted after merge, so a hardcoded path would make the harness
# unrunnable for anyone reproducing the controls.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NPX = shutil.which("npx")
if NPX is None:
    sys.exit("npx not found on PATH")
ENV = dict(os.environ, ELECTRON_RUN_AS_NODE="1")

SUITES = {
    "S1 gate-unit": "src/services/__tests__/exportReviewGate-2866.test.ts",
    "S2 hook-routes-1-2-3": "src/components/transactionDetailsModule/hooks/__tests__/useCompleteTransaction.exportGate-2866.test.tsx",
    "S3 wiring-routes-1-2-3": "src/components/__tests__/TransactionDetails.exportReviewGate-2866.test.tsx",
    "S4 bulk-route-4": "src/components/transaction/hooks/__tests__/useBulkActions.exportGate-2866.test.ts",
    "S5 exportPlan-tripwire": "electron/__tests__/exportPlan.noReviewFilter-2866.test.ts",
    "S6 pre-existing-2792": "src/components/transactionDetailsModule/hooks/__tests__/useCompleteTransaction-2792.test.tsx",
    "S7 pre-existing-2849": "src/components/__tests__/TransactionDetails.exportDestination-2849.test.tsx",
    "S8 pre-existing-paywall": "src/components/transaction/hooks/__tests__/useBulkActions.paywall.test.ts",
}

GATE = "src/services/exportReviewGate.ts"
DETAILS = "src/components/TransactionDetails.tsx"
BULK = "src/components/transaction/hooks/useBulkActions.ts"
PLAN = "electron/services/exportPlan.ts"


def run(paths):
    """Return {suite: (failed, passed)} for the given suite paths."""
    out = subprocess.run(
        [NPX, "electron", "./node_modules/jest/bin/jest.js", "--bail=0", "--silent"]
        + paths,
        cwd=ROOT,
        capture_output=True,
        text=True,
        env=ENV,
    )
    text = out.stdout + out.stderr
    m = re.search(r"^Tests:\s+(?:(\d+) failed, )?(?:(\d+) skipped, )?(\d+) passed", text, re.M)
    if not m:
        return None, text
    return (int(m.group(1) or 0), int(m.group(3))), text


def measure(label, mutations):
    """Apply mutations (list of (path, old, new)), run every suite, restore."""
    backups = {}
    for path, old, new in mutations:
        full = f"{ROOT}/{path}"
        if full not in backups:
            backups[full] = open(full).read()
        s = open(full).read()
        if old not in s:
            print(f"  !! MUTATION DID NOT APPLY in {path}: {old[:60]!r}")
            for f, c in backups.items():
                open(f, "w").write(c)
            return
        open(full, "w").write(s.replace(old, new, 1))

    print(f"\n=== {label} ===")
    try:
        for name, path in SUITES.items():
            res, text = run([path])
            if res is None:
                print(f"  {name:26s} SUITE ERROR (did not run)")
                print("   ", text.strip().splitlines()[-3:])
                continue
            failed, passed = res
            mark = "RED " if failed else "green"
            print(f"  {name:26s} {mark} — {failed} failed, {passed} passed")
    finally:
        for f, c in backups.items():
            open(f, "w").write(c)


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"

    if which in ("all", "baseline"):
        measure("BASELINE — no mutation", [])

    if which in ("all", "gate"):
        # THE control: ONE mutation, in the ONE gate. Every route must redden.
        measure(
            "CONTROL A — mutate the gate ONCE (count > 0  ->  count > 999)",
            [(GATE, "if (state.count > 0) {", "if (state.count > 999) {")],
        )

    if which in ("all", "unreadable"):
        measure(
            "CONTROL A2 — gate stops blocking an UNREADABLE queue (treat throw as empty)",
            [(GATE, "blocked.push({ ...target, count: UNREADABLE_REVIEW_COUNT });\n      continue;",
              "continue;")],
        )

    if which in ("all", "route2"):
        measure(
            "CONTROL B1 — revert ROUTE 2 wiring (header Export button)",
            [(DETAILS, "onShowExportModal={() => { void complete.requestExport(); }}",
              "onShowExportModal={() => setShowExportModal(true)}")],
        )

    if which in ("all", "route3"):
        measure(
            "CONTROL B2 — revert ROUTE 3 wiring (submit modal's Export offer)",
            [(DETAILS, "            setShowSubmitModal(false);\n            void complete.requestExport();",
              "            setShowSubmitModal(false);\n            setShowExportModal(true);")],
        )

    if which in ("all", "route4"):
        measure(
            "CONTROL B3 — revert ROUTE 4 wiring (bulk export gate call)",
            [(BULK, "        if (!gate.allowed) {", "        if (false) {")],
        )

    if which in ("all", "plan"):
        measure(
            "CONTROL B4 — teach exportPlan.ts about review state (the filter tripwire)",
            [(PLAN, "export function resolveExportPlan",
              "const _leak = 'address_missing';\nexport function resolveExportPlan")],
        )
