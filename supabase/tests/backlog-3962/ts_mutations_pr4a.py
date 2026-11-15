#!/usr/bin/env python3
"""BACKLOG-3962 PR4a portal controls. Needs a committed tree (restores with git checkout --).
Each mutation is an exact, once-only replacement; prints MUTATION APPLIED + numstat, then runs the
PR4a suites plus every callback, desktop and domain suite and prints the counts and every red test.
Usage: python3 supabase/tests/backlog-3962/ts_mutations_pr4a.py [name ...]"""
import os, re, subprocess, sys
ROOT = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip()
BP = os.path.join(ROOT, 'broker-portal')
TESTS = ['__tests__/jit-solo-3962-pr4a', '__tests__/app/auth', '__tests__/agentFloor-3080', '__tests__/join-guard-4012',
         '__tests__/member-name-3991', '__tests__/domain-claims-3962', '__tests__/domain-capture-3962']
JJ = 'broker-portal/lib/auth/jitJoin.ts'
RT = 'broker-portal/app/auth/callback/route.ts'
LG = 'broker-portal/app/login/page.tsx'
PG = 'broker-portal/app/auth/desktop/callback/page.tsx'
DA = 'broker-portal/lib/actions/desktopJitJoin.ts'
UI = 'broker-portal/app/dashboard/settings/domain/DomainSettingsClient.tsx'
AC = 'broker-portal/lib/actions/domainClaim.ts'
SN = 'broker-portal/lib/email/templates/simple-notice.ts'
M = {
  # R1: existing_account falls back to org_not_setup
  'R1_existing_unmapped': (JJ, "const OWN_MESSAGE = ['jit_disabled', 'billing_setup_pending', 'existing_account', 'already_placed'] as const;",
      "const OWN_MESSAGE = ['jit_disabled', 'billing_setup_pending', 'already_placed'] as const;"),
  # R1: domain_managed mapped to org_not_setup
  'R1_managed_to_org_not_setup': (RT, "        jitErrorCode = 'domain_managed';\n", "        jitErrorCode = 'org_not_setup';\n"),
  # precedence: domain_managed replaces every code
  'R1_managed_overrides_all': (JJ, "  return errorCode === null || errorCode === 'org_not_setup' || errorCode === 'jit_disabled';\n",
      "  return errorCode !== undefined;\n"),
  # precedence: floor owners are asked (and blocked) too
  'R1_managed_before_floor': (RT, "      if (access.kind === 'floor') {\n        return finish(`${origin}${next}`);\n      }\n\n      // BACKLOG-3962 PR4a",
      "      if (access.kind === 'floor' && !(await domainManagedFor(supabase))) {\n        return finish(`${origin}${next}`);\n      }\n\n      // BACKLOG-3962 PR4a"),
  # R1: login copy missing (falls to no message)
  'R1_login_copy_missing': (LG, "  existing_account:\n", "  existing_account_x:\n"),
  # D1a: the JIT step not awaited (fire and forget)
  'D1a_not_awaited': (PG, "      const placement: DesktopJitResult = await desktopJitJoin(session.access_token).catch(\n        (): DesktopJitResult => ({ status: 'ok' })\n      );\n",
      "      void desktopJitJoin(session.access_token).catch(() => undefined);\n      const placement = { status: 'ok' } as DesktopJitResult;\n"),
  # D1b / v2 item 6: domain_managed still deep-links
  'D1b_managed_still_links': (PG, "        setStatus('domain_managed');\n        return;\n", "        setStatus('domain_managed');\n"),
  # D1: no bearer header (the action would not act as the person)
  'D1_no_bearer': (DA, "      global: { headers: { Authorization: `Bearer ${accessToken}` } },\n", ""),
  # D1: pending invitation no longer stops JIT
  'D1_no_pending_invite_check': (DA, "    if (hasPendingInvite === true) return OK;\n", ""),
  # T1: the switch sends the stored value back
  'T1_ui_not_flipped': (UI, "onClick={() => handleBlockSolo(claim.id, !claim.blockSoloSignups)}", "onClick={() => handleBlockSolo(claim.id, true)}"),
  # T1: offered on every listed claim
  'T1_ui_any_status': (UI, "  const verifiedClaims = claims.filter((c) => c.status === 'verified');\n", "  const verifiedClaims = claims;\n"),
  # T1: the action on the server-role client
  'T1_action_service_client': (AC, "  const { data, error } = (await access.supabase.rpc('domain_claim_set_block_solo', {",
      "  const { data, error } = (await createServiceClient({ actorId: access.userId }).rpc('domain_claim_set_block_solo', {"),
  # T1: support session not refused
  'T1_action_no_impersonation_guard': (AC, "export async function setBlockSoloSignups(claimId: string, on: boolean): Promise<DomainClaimActionResult> {\n  const blocked = await blockWriteDuringImpersonation();\n  if (blocked) return fail(blocked.error);\n",
      "export async function setBlockSoloSignups(claimId: string, on: boolean): Promise<DomainClaimActionResult> {\n"),
  # N1: valign removed
  'N1_valign_removed': (SN, '`<td valign="top" style="padding-right:', '`<td style="padding-right:'),
}
names = sys.argv[1:] or list(M)
if subprocess.run(['git', 'diff', '--quiet'], cwd=ROOT).returncode != 0:
    sys.exit('tree not clean: commit first')
for n in names:
    rel, old, new = M[n]
    p = os.path.join(ROOT, rel); s = open(p).read()
    if s.count(old) != 1:
        print(f'{n}: MUTATION NOT APPLIED (found {s.count(old)})'); continue
    open(p, 'w').write(s.replace(old, new))
    ns = subprocess.check_output(['git', 'diff', '--numstat', '--', rel], cwd=ROOT, text=True).strip()
    print(f'{n}: MUTATION APPLIED [{ns}] -> {(new.strip() or "(line removed)")[:90]}')
    # --bail=0: the root jest config sets bail: 1, which stops after the first failing suite and
    # would hide the other suites a mutation turns red.
    out = subprocess.run(['npx', 'jest', '--bail=0', *TESTS], cwd=BP, capture_output=True, text=True)
    txt = out.stderr + out.stdout
    t = re.search(r'Tests:\s+(.*)', txt)
    su = re.search(r'Test Suites:\s+(.*)', txt)
    fails = list(dict.fromkeys(re.findall(r'^\s*● (.+?)\s*$', txt, re.M)))
    fails = [f for f in fails if not f.startswith('Console')]
    print(f'  suites {su.group(1) if su else "?"} | tests {t.group(1) if t else "NO TEST COUNT"} | red ({len(fails)}):')
    for f in fails:
        print(f'    - {f}')
    if t is None or ' 0 total' in t.group(1) or (su and ' of ' in su.group(1)):
        print('  WARNING: no test count / zero tests / not every suite ran')
    subprocess.run(['git', 'checkout', '--', rel], cwd=ROOT, check=True)
