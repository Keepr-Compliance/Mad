#!/usr/bin/env python3
"""BACKLOG-4007 People v2 JS controls. Each mutation: exact-once replace (raises on 0 or 2+),
MUTATION APPLIED + md5 before/after printed, the named suite run with bail off, the test count
asserted non-zero, failures recorded, the file restored with `git checkout --` (the fix is
committed first). Usage: js_mutations.py <repo root> [J16,J17,...]  (optional id filter)"""
import hashlib, json, re, subprocess, sys
root = sys.argv[1]
B, A = 'broker-portal', 'admin-portal'
M = [
  ('J1 confirm step', 'packages/ui/src/components/org-people.tsx', "if (r.error === 'role_change_needs_confirm') {", "if (false) {", B, '__tests__/billing-login-4007/orgPeople.test.tsx'),
  ('J2 IdP-managed pickable', 'packages/ui/src/components/org-people.tsx', "  if (m.idp_managed) return 'Managed by your identity provider.';\n", "", B, '__tests__/billing-login-4007/orgPeople.test.tsx'),
  ('J3 broker edits IT row', 'packages/ui/src/components/org-people.tsx', "if (role === 'it' || role === 'msp') return view.can_edit_it !== false;", "if (role === 'it' || role === 'msp') return true;", B, '__tests__/billing-login-4007/orgPeople.test.tsx'),
  ('J4 phone field for IT admin', 'packages/ui/src/components/org-people.tsx', "const phoneEditable = editable && view.can_edit_phone === true;", "const phoneEditable = editable;", B, '__tests__/billing-login-4007/orgPeople.test.tsx'),
  ('J5 modal People submit -> inviteUser', 'broker-portal/components/users/InviteUserModal.tsx', "    if (people) {\n      try {", "    if (false) {\n      try {", B, '__tests__/people-v2-4007/peopleV2.test.tsx'),
  ('J6 IT action gate = People list', 'broker-portal/lib/actions/orgContacts.ts', "  if (role === 'it' || role === 'msp') return PEOPLE_IT_ROLES;\n", "", B, '__tests__/billing-login-4007'),
  ('J7 Stripe phone not read', 'broker-portal/lib/billing/brokerageSync.ts', "phone = (await rpc<string | null>(service, '_org_billing_contact_phone', { p_org: org })) ?? null;", "phone = null;", B, '__tests__/lib/billing/outboxKinds/sync_org_subscription.convergence.test.ts'),
  ('J8 removal refusal unworded', 'broker-portal/lib/actions/removeUser.ts', "if (deleteError.message?.includes('billing_contact_member')) {", "if (false) {", B, '__tests__/people-v2-4007/peopleV2.test.tsx'),
  ('J9 My Account phone not saved', 'broker-portal/lib/actions/myPhone.ts', "supabase.rpc('my_phone_set', { p_phone: phone.trim() })", "supabase.rpc('my_phone_get', { p_phone: phone.trim() })", B, '__tests__/people-v2-4007/peopleV2.test.tsx'),
  ('J10 setup login email not sent', 'broker-portal/lib/actions/billingSetup.ts', "  if (isBillingLoginCreated(r.billing_login)) {", "  if (false) {", B, '__tests__/billing-login-4007/setupBillingLogin.test.tsx'),
  ('J11 reassigned email ignores a later change', 'broker-portal/lib/billing/billingContactReassigned.ts', "  if ((contact as { member_id?: string } | null)?.member_id !== memberId) {", "  if (false) {", B, '__tests__/lib/billing/outboxKinds/notify_billing_contact_reassigned.convergence.test.ts'),
  ('J12 admin dialog People submit -> inviteUser', 'admin-portal/app/dashboard/users/components/InviteUserDialog.tsx', "    if (people) {\n      const r = await people.submit({", "    if (false) {\n      const r = await people!.submit({", A, '__tests__/people-v2-4007'),
  ('J13 admin IT invite emailed as billing-only', 'admin-portal/lib/actions/orgContacts.ts', "        ...(billingOnly ? { billingOnly: true } : {}),", "        billingOnly: true,", A, '__tests__/people-4007-pr4'),
  ('J14 deal save carries the contact', 'admin-portal/lib/actions/brokerageBilling.ts', "    p_billing_contact_email: null,", "    p_billing_contact_email: '',", A, '__tests__/onboarding-4007/dealEditor.test.tsx'),
  ('J15 broker in the IT list', 'broker-portal/lib/people-roles.ts', "export const PEOPLE_IT_ROLES = ['admin', 'it_admin'] as const;", "export const PEOPLE_IT_ROLES = ['admin', 'it_admin', 'broker'] as const;", B, '__tests__/billing-login-4007/peopleRoles.test.tsx'),
  ('J16 deactivate refusal unworded', 'broker-portal/lib/actions/deactivateUser.ts', "if (updateError.message?.includes('billing_contact_member')) {", "if (false) {", B, '__tests__/lib/actions/deactivateUser-service-write.test.ts'),
  ('J17 cancel-invite billing contact not refused', 'admin-portal/app/api/users/cancel-invite/route.ts', "  if (billingContact) {", "  if (false) {", A, '__tests__/people-v2-4007/cancelInviteBillingContact.test.ts'),
]
if len(sys.argv) > 2:
    keep = set(sys.argv[2].split(','))
    M = [x for x in M if x[0].split()[0] in keep]

def md5(p): return hashlib.md5(open(p, 'rb').read()).hexdigest()[:8]

def run(app, target):
    if app == B:
        cmd = ['npx', 'jest', target, '--bail=0', '--silent']
    else:
        cmd = ['npx', 'vitest', 'run', target]
    out = subprocess.run(cmd, cwd=f'{root}/{app}', capture_output=True, text=True)
    t = out.stdout + out.stderr
    if app == B:
        m = re.search(r'Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(\d+) passed, (\d+) total', t) or re.search(r'Tests:\s+(\d+) failed, (\d+) total', t)
        failed = int(m.group(1) or 0) if m and m.lastindex == 3 else (int(m.group(1)) if m else -1)
        total = int(m.group(m.lastindex)) if m else 0
    else:
        t2 = re.sub(r'\x1b\[[0-9;]*m', '', t)
        m = re.search(r'Tests\s+(?:(\d+) failed)?(?:\s*\|\s*)?(?:(\d+) passed)?\s*\((\d+)\)', t2)
        failed = int(m.group(1) or 0) if m else -1
        total = int(m.group(3)) if m else 0
    return failed, total

res = []
for name, f, old, new, app, target in M:
    p = f'{root}/{f}'
    s = open(p).read()
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'MUTATION NOT APPLIED {name}: {n} matches')
    before = md5(p)
    open(p, 'w').write(s.replace(old, new))
    after = md5(p)
    if before == after:
        raise SystemExit(f'MUTATION NOT APPLIED {name}: md5 unchanged')
    print(f'MUTATION APPLIED {name} {f} {before}->{after}', flush=True)
    failed, total = run(app, target)
    subprocess.run(['git', '-C', root, 'checkout', '--', f], check=True)
    assert md5(p) == before
    if total == 0:
        raise SystemExit(f'{name}: 0 tests ran (a failure)')
    res.append({'mutation': name, 'file': f, 'suite': target, 'failed': failed, 'total': total, 'red': failed > 0})
    print(json.dumps(res[-1]), flush=True)
print('SUMMARY', sum(r['red'] for r in res), 'of', len(res), 'red')
