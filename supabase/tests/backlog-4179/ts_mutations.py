#!/usr/bin/env python3
"""BACKLOG-4179 TS controls: each mutant is an exact, once-only replacement; the file is restored
from the text read before mutating (never git checkout). A run with 0 tests is a failure.
Run from the repo root: python3 supabase/tests/backlog-4179/ts_mutations.py"""
import re, subprocess, sys

ROUTE = 'broker-portal/app/auth/callback/route.ts'
SCIM = 'supabase/functions/scim/handlers/users.ts'
HP = 'broker-portal/lib/auth/alreadyPlaced.ts'
HS = 'supabase/functions/scim/shared/alreadyPlaced.ts'
RT = ('broker-portal', '__tests__/app/auth/callback/inviteLink-3684.test.ts')
ST = ('.', 'tests/edge-functions/scimSeats.test.ts')
CASES = [
    ('T1_route_mapping_dropped', ROUTE, '          if (isAlreadyPlacedError(acceptError)) {\n', '          if (false) {\n', RT),
    ('T2_scim_mapping_dropped', SCIM, '      if (isAlreadyPlacedError(memberError)) {\n', '      if (false) {\n', ST),
    ('T3_portal_helper_code_dropped', HP, "  return !!error && error.code === 'P0001' && error.message === ALREADY_PLACED_ERROR;\n",
     '  return !!error && error.message === ALREADY_PLACED_ERROR;\n', RT),
    ('T4_scim_helper_code_dropped', HS, '  return !!err && err.code === "P0001" && err.message === ALREADY_PLACED_ERROR;\n',
     '  return !!err && err.message === ALREADY_PLACED_ERROR;\n', ST),
]


def jest(cwd, path):
    r = subprocess.run(['npx', 'jest', path, '--bail=0'], cwd=cwd, capture_output=True, text=True)
    m = re.search(r'Tests:\s+(.*)', r.stdout + r.stderr)
    return r.returncode, (m.group(1).strip() if m else 'NO TESTS LINE')


for name, f, old, new, (cwd, test) in CASES:
    src = open(f).read()
    if src.count(old) != 1:
        print(f'{name}: MUTATION NOT APPLIED (pattern x{src.count(old)})'); sys.exit(2)
    open(f, 'w').write(src.replace(old, new))
    try:
        print(f'{name}: MUTATION APPLIED {f}: {new.strip()}')
        code, line = jest(cwd, test)
        print(f'{name}: exit={code} {line} -> {"RED" if code != 0 and "failed" in line else "GREEN (control did not fire)"}')
    finally:
        open(f, 'w').write(src)
code, line = jest(*RT); print(f'restored route suite: exit={code} {line}')
code, line = jest(*ST); print(f'restored scim suite: exit={code} {line}')
