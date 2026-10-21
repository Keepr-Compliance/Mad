#!/usr/bin/env python3
"""BACKLOG-4027 PR-1 jest mutations. Each: exact-once replace (raises on 0 or 2+ matches), print
MUTATION APPLIED + the mutated line, run the named jest file, report counts and failing tests,
restore the original text. Run from the repo root of the worktree, with the work committed."""
import os, re, subprocess, sys
root = os.getcwd()
E = 'tests/edge-functions/lastAdmin4027.test.ts'
A = 'broker-portal/__tests__/lib/actions/roleRefusals-4027.test.ts'
U = 'supabase/functions/scim/handlers/users.ts'
D = 'supabase/functions/directory-sync/index.ts'
N = 'supabase/functions/_shared/lastAdminNotify.ts'
M = [
  ('J1 create: userName only (emails[] ignored)', U, 'const emailCandidates = scimEmailCandidates(body);', 'const emailCandidates: string[] = [];', E),
  ('J2 invite claim: userName only', U, 'const candidates = p.emailCandidates && p.emailCandidates.length > 0 ? p.emailCandidates : [p.email];', 'const candidates = [p.email];', E),
  ('J3 DELETE: kept admin answered 204', U, 'if (!memberError && stored && stored.license_status !== "suspended") {', 'if (false) {', E),
  ('J4 PATCH active:false: kept admin answered 200', U, 'if (requestedActive === false && stored && stored.license_status !== "suspended") {', 'if (false) {', E),
  ('J5 de-dupe counts its own row (> 0)', N, '} else if ((recent ?? 0) > 1) {', '} else if ((recent ?? 0) > 0) {', E),
  ('J6 dir-sync: kept suspend not detected', D, '        if (stored && stored.license_status !== "suspended") {\n          result.skipped_last_admin++;', '        if (false) {\n          result.skipped_last_admin++;', E),
  ('J7 dir-sync: suspend without .select()', D, '          .eq("user_id", member.user_id)\n          .select("license_status");', '          .eq("user_id", member.user_id);', E),
  ('J8 deactivateUser counts admin + it_admin', 'broker-portal/lib/actions/deactivateUser.ts', "      .eq('role', 'admin')\n      .in('license_status'", "      .in('role', ['admin', 'it_admin'])\n      .in('license_status'", A),
  ('J9 deactivateUser: last_admin unmapped', 'broker-portal/lib/actions/deactivateUser.ts', "    if (updateError.message?.includes('last_admin')) {", "    if (false) {", A),
  ('J10 updateUserRole: managed_by_idp unmapped', 'broker-portal/lib/actions/updateUserRole.ts', "    if (updateError.message?.includes('managed_by_idp')) {", "    if (false) {", A),
  ('J11 bulkUpdateRole: last_admin unmapped', 'broker-portal/lib/actions/bulkUpdateRole.ts', "    if (error.message?.includes('last_admin')) {", "    if (false) {", A),
  ('J12 removeUser: last_admin unmapped', 'broker-portal/lib/actions/removeUser.ts', "    if (deleteError.message?.includes('last_admin')) {", "    if (false) {", A),
]
only = sys.argv[1:] 
for name, path, frm, to, test in M:
    if only and not any(name.startswith(o + ' ') for o in only): continue
    p = os.path.join(root, path); orig = open(p).read()
    n = orig.count(frm)
    if n != 1: print(f'MUTATION NOT APPLIED [{name}]: {n} matches'); continue
    open(p, 'w').write(orig.replace(frm, to))
    try:
        assert open(p).read() != orig
        print(f'MUTATION APPLIED [{name}] {path}: {to.splitlines()[0].strip()}')
        cwd = os.path.join(root, 'broker-portal') if test.startswith('broker-portal/') else root
        tp = test[len('broker-portal/'):] if test.startswith('broker-portal/') else test
        r = subprocess.run(['npx', 'jest', tp], cwd=cwd, capture_output=True, text=True)
        out = r.stdout + r.stderr
        m = re.search(r'Tests:\s+(.*)', out)
        fails = sorted(set(re.findall(r'^\s+● (.+?)$', out, re.M)) - {'Console'})
        print(f'   -> {m.group(1) if m else "NO COUNT"}; red: {fails}')
    finally:
        open(p, 'w').write(orig)
