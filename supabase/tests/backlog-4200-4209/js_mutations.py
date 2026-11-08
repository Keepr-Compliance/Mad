#!/usr/bin/env python3
"""BACKLOG-4200 + 4209 JS controls (broker-portal jest, admin-portal vitest). Each mutation:
exact-once replace (raises on 0 or 2+), MUTATION APPLIED + md5 before/after printed, the named suite
run, the test count asserted non-zero, failures recorded, the file restored with `git checkout --`
(the fix is committed first). Runner copied from supabase/tests/backlog-4045b/js_mutations.py.
Usage: js_mutations.py <repo root> [id,id,...]  (optional id filter)"""
import hashlib, json, re, subprocess, sys
root = sys.argv[1]
names = []
B, A = 'broker-portal', 'admin-portal'
CARD = 'admin-portal/app/dashboard/organizations/[id]/components/BrokerageBillingCard.tsx'
ACT = 'admin-portal/lib/actions/brokerageBilling.ts'
DESC = 'admin-portal/lib/activity/describeActivity.ts'
UI45 = '__tests__/auto-renew-4045/notifyCheckbox.test.tsx'
UIRE = '__tests__/reinstate-4209/notifyCheckbox.test.tsx'
RPCRE = '__tests__/reinstate-4209/reinstateOrgAction.test.ts'
DT = '__tests__/activity-4036/describeActivity.test.ts'
OFF = 'broker-portal/lib/billing/autoRenewOffNotify.ts'
RE = 'broker-portal/lib/billing/orgReinstatedNotify.ts'
OFFT = '__tests__/lib/billing/outboxKinds/notify_auto_renew_off.convergence.test.ts'
RET = '__tests__/lib/billing/outboxKinds/notify_org_reinstated.convergence.test.ts'
TOFF = 'broker-portal/lib/email/templates/auto-renew-off.ts'
TON = 'broker-portal/lib/email/templates/auto-renew-on.ts'
TRE = 'broker-portal/lib/email/templates/org-reinstated.ts'
TAU = 'broker-portal/lib/email/templates/org-auto-reinstated.ts'
TBL = 'broker-portal/lib/email/templates/billing-line.ts'
BRK = 'broker-portal/lib/billing/brokerage.ts'
M = [
  # BACKLOG-4200 admin
  ('Aoff1m off dialog still offers no checkbox', CARD, "          notifyContactEmail={deal.billing_contact_email ?? ''}\n", "          notifyContactEmail={renewTarget === 'on' ? deal.billing_contact_email ?? '' : undefined}\n", A, UI45),
  ('Aoff2m card hardcodes notify true', CARD, "deal.version, notify ?? true)", "deal.version, true)", A, UI45),
  ('Doffm Activity ignores notified on auto_renew_off', DESC, "`${who} turned off auto-renew${emailed(row)}`", "`${who} turned off auto-renew`", A, DT),
  # BACKLOG-4209 admin
  ('Are1m reinstate dialog without the contact email', CARD, "          notifyContactEmail={deal?.billing_contact_email ?? ''}\n", "", A, UIRE),
  ('Are2m card drops notify on reinstate', CARD, "reinstateOrgAction(organizationId, note, notify ?? true)", "reinstateOrgAction(organizationId, note)", A, UIRE),
  ('Are4m action leaves p_notify out of the reinstate rpc', ACT, "    p_note: note.trim(),\n    p_notify: notify,\n  });", "    p_note: note.trim(),\n  });", A, RPCRE),
  ('Drem Activity ignores notified on reinstated', DESC, "`${who} reinstated the organization${emailed(row)}`", "`${who} reinstated the organization`", A, DT),
  # BACKLOG-4200 broker
  ('H2m off handler: no status check', OFF, "  if (d?.status !== 'canceling') {", "  if (!d) {", B, OFFT),
  ('H3m off handler: no superseded check', OFF, "  if ((await newestAutoRenewVersion(service, org)) !== version) {", "  if (false) {", B, OFFT),
  ('H4m off handler: compares org_deals.version', OFF, "  if ((await newestAutoRenewVersion(service, org)) !== version) {", "  if ((deal as { version?: number }).version !== version) {", B, OFFT),
  ('H5m off handler: alreadySent never true', OFF, "  if (await alreadySent(service, row.dedupe_key)) return;", "  if (false) return;", B, OFFT),
  ('H6m off handler: throws on no contact', OFF, "    console.info(`[billing/auto-renew-off] ${row.id}: no billing contact email; nothing to send`);\n    return;", "    throw new Error('no contact');", B, OFFT),
  ('H8m always formats the period end (C3)', OFF, "  if (!Number.isFinite(t) || t <= now) return null;", "  if (!Number.isFinite(t)) return null;", B, OFFT),
  ('E1m off template drops "As you requested,"', TOFF, "`As you requested, Keepr turned off auto-renew for ${p.brokerageName}.`", "`Keepr turned off auto-renew for ${p.brokerageName}.`", B, '__tests__/lib/email/auto-renew-off.test.ts'),
  ('C9m on template reverted to the old line', TON, "`As you requested, Keepr turned auto-renew back on for ${p.brokerageName}.`", "`Keepr turned auto-renew back on for ${p.brokerageName}.`", B, '__tests__/lib/email/auto-renew-on.test.ts'),
  # BACKLOG-4209 broker
  ('J3m reinstated handler: no status check', RE, "  if (d?.status !== 'active' && d?.status !== 'canceling') {", "  if (!d) {", B, RET),
  ('J4m reinstated handler: no superseded check', RE, "  if (!(await isLatestReinstatement(service, org, epoch))) {", "  if (false) {", B, RET),
  ('J5m equal created_at counts as later', RE, "Date.parse(r.created_at ?? '') > at", "Date.parse(r.created_at ?? '') >= at", B, RET),
  ('J7m always the renew line', RE, "  } else if (d.status === 'active') {", "  } else if (true) {", B, RET),
  ('J8m always formats the period end (RC1)', OFF, "  if (!Number.isFinite(t) || t <= now) return null;", "  if (!Number.isFinite(t)) return null;", B, RET),
  ('J9m1 canceled subscription sends nothing (pre-D1)', RE, "    billing = { kind: 'none' };", "    return;", B, RET),
  ('J9m2 subscription status not read', RE, "  if (!s || s.status === 'canceled') {", "  if (!s) {", B, RET),
  ('J2m always the staff template', RE, "via === 'auto' ? await sendOrgAutoReinstatedEmail(params) : await sendOrgReinstatedEmail(params)", "await sendOrgReinstatedEmail(params)", B, RET),
  ('J11m reinstated handler: alreadySent never true', RE, "  if (await alreadySent(service, row.dedupe_key)) return;", "  if (false) return;", B, RET),
  ('J12m reinstated handler: throws on no contact', RE, "    console.info(`[billing/org-reinstated] ${row.id}: no billing contact email; nothing to send`);\n    return;", "    throw new Error('no contact');", B, RET),
  ('S1m staff template drops "As you requested,"', TRE, "`As you requested, Keepr reinstated the account", "`Keepr reinstated the account", B, '__tests__/lib/email/org-reinstated.test.ts'),
  ('U1m automatic template word changed', TAU, "`We received your payment, so Keepr", "`We got your payment, so Keepr", B, '__tests__/lib/email/org-reinstated.test.ts'),
  ('BLm billing line: fallback formats a date', TBL, "    return b.endsOn ? `Auto-renew is off. Your plan ends on ${b.endsOn}.` : 'Auto-renew is off. Your plan ends at the end of the billing period.';", "    return `Auto-renew is off. Your plan ends on ${b.endsOn}.`;", B, '__tests__/lib/email/org-reinstated.test.ts'),
  ('W1m webhook also sends the email (TS double send)', BRK, "  log(ctx, `auto-reinstate: ${res?.success ? 'reinstated' : `refused (${res?.error ?? 'unknown'})`}`);", "  await (await import('@/lib/email')).sendOrgAutoReinstatedEmail({} as never);\n  log(ctx, `auto-reinstate: ${res?.success ? 'reinstated' : `refused (${res?.error ?? 'unknown'})`}`);", B, '__tests__/app/api/payments/webhook-brokerage.test.ts'),
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
    global names
    t3 = re.sub(r'\x1b\[[0-9;]*m', '', t)
    names = sorted(set(re.findall(r'^\s+● (.+?)$', t3, re.M) + re.findall(r'^\s+× (.+?)(?: \d+ms)?$', t3, re.M)))[:8]
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
    res.append({'mutation': name, 'file': f, 'suite': target, 'failed': failed, 'total': total, 'red': failed > 0, 'reds': names})
    print(json.dumps(res[-1]), flush=True)
print('SUMMARY', sum(r['red'] for r in res), 'of', len(res), 'red')
