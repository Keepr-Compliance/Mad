#!/usr/bin/env python3
"""BACKLOG-3998 code mutants. Each: exact-once replace in one file, prove it applied
(git diff --numstat shows the file changed, MUTATION APPLIED printed), run the suite
(--bail=0 / vitest run), require a non-zero test count and at least one failure, then
restore the file byte-for-byte and verify git shows no diff. Run from the repo root of a
worktree with all work committed."""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
JEST = ['npx', 'jest', '--bail=0']
VITEST = ['npx', 'vitest', 'run']
ROUTE = 'admin-portal/app/api/internal-users/invite/route.ts'
SCIM = 'supabase/functions/scim/handlers/users.ts'
PLACE = 'supabase/functions/directory-sync/placement.ts'
ROUTE_T = ('admin-portal', VITEST + ['__tests__/internal-invite-3998'])
SCIM_T = ('.', JEST + ['tests/edge-functions/scimSeats.test.ts'])
PLACE_T = ('.', JEST + ['tests/edge-functions/directorySyncPlacement.test.ts'])

MUTANTS = [
    ('J1', ROUTE, "  if (error.code !== 'P0002') {", "  if (!error.message?.includes('No user found')) {",
     'route: not-found recognised by message, not SQLSTATE', ROUTE_T),
    ('J2', ROUTE, "  if (error.code !== 'P0002') {", "  if (false) {", 'route: every RPC error becomes an invitation', ROUTE_T),
    ('J3', SCIM, '''  const { data: existingId, error: lookupError } = await supabaseAdmin.rpc(
    "user_id_for_auth_email",
    { p_email: email },
  );
  if (lookupError) {
    await logScimOperation(supabaseAdmin, {
      organizationId: auth.orgId,
      operation: "CREATE",
      resourceType: "User",
      externalId: externalId,
      requestPayload: body,
      responseStatus: 500,
      errorMessage: "Failed to look up the person by sign-in email",
      scimTokenId: auth.tokenId,
    });
    return scimError(500, "Failed to create user");
  }
  const existingByEmail = typeof existingId === "string" ? { id: existingId } : null;
''', '''  const { data: existingByEmail } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();
''', 'SCIM: lookup by stored users.email (the code before this change)', SCIM_T),
    ('J4', PLACE, '''  if (otherOrgs.some((o) => o.personal_owner_user_id === null)) {
    return { kind: "skip", userId, reason: "already_placed" };
  }
''', '', 'directory sync: other-brokerage guard removed', PLACE_T),
    ('J5', PLACE, '  return { kind: "skip", userId, reason: "personal_account" };',
     '  return { kind: "add", userId };', 'directory sync: personal-account person added', PLACE_T),
    ('J6', PLACE, '    .filter((id) => id !== orgId);', '    .filter(() => true);',
     'directory sync: this organization counted as another', PLACE_T),
    ('J7', PLACE, '  if (orgError || otherOrgs.length !== otherOrgIds.length) {', '  if (orgError) {',
     'directory sync: missing organization row not treated as a failed read', PLACE_T),
    ('J8', SCIM, '  if (lookupError) {\n    await logScimOperation(', '  if (false) {\n    await logScimOperation(',
     'SCIM: lookup error not checked (read as no such person)', SCIM_T),
]


def run(cmd, cwd):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def counts(out):
    m = re.search(r'Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(\d+) passed, (\d+) total', out)
    if m:
        return int(m.group(1) or 0), int(m.group(3))
    m = re.search(r'Tests\s+(?:(\d+) failed \| )?(\d+) passed \((\d+)\)', out)
    if m:
        return int(m.group(1) or 0), int(m.group(3))
    m = re.search(r'Tests\s+(\d+) failed \((\d+)\)', out)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None, 0


ok_all = True
for mid, rel, anchor, repl, what, (cwd, cmd) in MUTANTS:
    path = ROOT / rel
    orig = path.read_bytes()
    text = orig.decode()
    n = text.count(anchor)
    if n != 1:
        print(f'{mid} ANCHOR occurs {n} times in {rel}; not run')
        ok_all = False
        continue
    path.write_text(text.replace(anchor, repl))
    try:
        ns = subprocess.run(['git', 'diff', '--numstat', '--', rel], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        if not ns:
            print(f'{mid} NOT APPLIED')
            ok_all = False
            continue
        print(f'{mid} MUTATION APPLIED ({ns}) {what}')
        rc, out = run(cmd, ROOT / cwd)
        failed, total = counts(out)
        red = total > 0 and (failed or 0) > 0
        print(f'    tests total={total} failed={failed} -> {"RED" if red else "GREEN (NOT CAUGHT)"}')
        if not red:
            ok_all = False
            print(out[-1500:])
    finally:
        path.write_bytes(orig)
        left = subprocess.run(['git', 'diff', '--numstat', '--', rel], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        print(f'    restored: {"yes" if not left else "NO: " + left}')
        if left:
            sys.exit(2)
sys.exit(0 if ok_all else 1)
