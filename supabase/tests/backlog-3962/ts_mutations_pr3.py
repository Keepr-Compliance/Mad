#!/usr/bin/env python3
"""BACKLOG-3962 PR3a portal controls. Needs a committed tree (restores with git checkout --).
Each mutation is an exact, once-only replacement; prints MUTATION APPLIED + numstat, then runs jest
and prints the counts. Usage: python3 supabase/tests/backlog-3962/ts_mutations_pr3.py [name ...]"""
import os, re, subprocess, sys
ROOT = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip()
BP = os.path.join(ROOT, 'broker-portal')
M = {
  'T_cron_no_auth': ('broker-portal/app/api/cron/domain-capture-switch/route.ts',
      "  if (!isAuthorizedCronRequest(req.headers.get('authorization'))) {\n",
      "  if (false && !isAuthorizedCronRequest(req.headers.get('authorization'))) {\n",
      '__tests__/app/api/cron/cron-auth.test.ts'),
  'T_posted_org': ('broker-portal/lib/actions/domainCapture.ts',
      "    p_org: access.organizationId,\n",
      "    p_org: (input as unknown as { organizationId?: string }).organizationId ?? access.organizationId,\n",
      '__tests__/domain-capture-3962/domainCaptureAction.test.ts'),
  'T_payer_gets_switched_email': ('broker-portal/lib/domain/captureSwitch.ts',
      "      if (r.payer !== true && email) {\n",
      "      if (email) {\n",
      '__tests__/domain-capture-3962/captureSwitch.test.ts'),
  'T_seat_alert_per_person': ('broker-portal/lib/domain/captureSwitch.ts',
      "        const entry = unassignedByOrg.get(row.organization_id) ?? { emails: [], userIds: [] };\n",
      "        const entry = { emails: [] as string[], userIds: [] as string[] };\n        unassignedByOrg.set(row.switch_id, entry);\n",
      '__tests__/domain-capture-3962/captureSwitch.test.ts'),
  'T_dns_after_switch': ('broker-portal/lib/domain/captureSwitch.ts',
      "  for (const r of claims.values()) {\n",
      "  for (const r of [] as DueSwitch[]) {\n",
      '__tests__/domain-capture-3962/captureSwitch.test.ts'),
  'T_opt_out_no_confirm': ('broker-portal/lib/actions/domainCapture.ts',
      "  if (input?.confirm !== true) return fail(DOMAIN_CAPTURE_CONFIRM);\n",
      "",
      '__tests__/domain-capture-3962/domainCaptureAction.test.ts'),
  'T_notice_payer_not_passed': ('broker-portal/lib/domain/captureNotice.ts',
      "        payer: row.payer === true,\n",
      "",
      '__tests__/domain-capture-3962/domainCaptureAction.test.ts'),
  'T_notice_always_payer_copy': ('broker-portal/lib/email/templates/domain-capture-notice.ts',
      "${payer === true ? ' and stays on your own paid plan' : ''}",
      " and stays on your own paid plan",
      '__tests__/domain-capture-3962/emails.test.ts'),
  'T_setup_message_unmapped': ('broker-portal/lib/actions/domainCapture.ts',
      "    case 'billing_setup_incomplete':\n      return fail(DOMAIN_CAPTURE_BILLING_SETUP);\n",
      "",
      '__tests__/domain-capture-3962/domainCaptureAction.test.ts'),
  'T_route_accepts_capture_kind': ('broker-portal/app/api/email/seat-limit-reached/route.ts',
      "      (kind !== 'add' && kind !== 'reactivate')\n",
      "      (kind !== 'add' && kind !== 'reactivate' && kind !== 'domain_capture')\n",
      '__tests__/domain-capture-3962/emails.test.ts'),
}
names = sys.argv[1:] or list(M)
if subprocess.run(['git', 'diff', '--quiet'], cwd=ROOT).returncode != 0:
    sys.exit('tree not clean: commit first')
for n in names:
    rel, old, new, test = M[n]
    p = os.path.join(ROOT, rel); s = open(p).read()
    if s.count(old) != 1:
        print(f'{n}: MUTATION NOT APPLIED (found {s.count(old)})'); continue
    open(p, 'w').write(s.replace(old, new))
    ns = subprocess.check_output(['git', 'diff', '--numstat', '--', rel], cwd=ROOT, text=True).strip()
    print(f'{n}: MUTATION APPLIED [{ns}] -> {new.strip()[:90]}')
    out = subprocess.run(['npx', 'jest', test], cwd=BP, capture_output=True, text=True)
    t = re.search(r'Tests:\s+(.*)', out.stderr + out.stdout)
    txt = out.stderr + out.stdout
    fails = list(dict.fromkeys(re.findall(r'^\s*● (.+?)\s*$', txt, re.M)))
    fails = [f for f in fails if not f.startswith('Console')]
    print(f'  {t.group(1) if t else "NO TEST COUNT"} | red ({len(fails)}):')
    for f in fails:
        print(f'    - {f}')
    if t is None or ' 0 total' in t.group(1):
        print('  WARNING: no test count / zero tests')
    subprocess.run(['git', 'checkout', '--', rel], cwd=ROOT, check=True)
