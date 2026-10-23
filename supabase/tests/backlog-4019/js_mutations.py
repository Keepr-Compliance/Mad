#!/usr/bin/env python3
"""BACKLOG-4019 auto-renew JS controls. Each mutation: exact-once replace (raises on 0 or 2+),
MUTATION APPLIED + md5 before/after printed, the named suite run with bail off, the test count
asserted non-zero, failures recorded, the file restored with `git checkout --` (the fix is
committed first). Usage: js_mutations.py <repo root> [K1,K2,...]  (optional id filter)
(Runner copied from supabase/tests/backlog-4007-people-v2/js_mutations.py.)"""
import hashlib, json, re, subprocess, sys
root = sys.argv[1]
B, A = 'broker-portal', 'admin-portal'
SYNC = '__tests__/lib/billing/outboxKinds/sync_org_subscription.convergence.test.ts'
HOOK = '__tests__/app/api/payments/webhook-brokerage.test.ts'
M = [
  ('K1 W2 sync ignores cancel', 'broker-portal/lib/billing/brokerageSync.ts', "const cancelDiffers = (sub.cancel_at_period_end === true) !== cancel;", "const cancelDiffers = false;", B, SYNC),
  ('K2 W3 wantsCancel reads status only', 'broker-portal/lib/billing/brokerageSync.ts', "return deal.status === 'canceling' || (deal.status === 'suspended' && deal.status_before_suspension === 'canceling');", "return deal.status === 'canceling';", B, SYNC),
  ('K3 W5 ended sub while canceling re-created', 'broker-portal/lib/billing/brokerageSync.ts', "      if (ENDED.has(sub.status)) {\n        if (cancel) {", "      if (ENDED.has(sub.status)) {\n        if (false) {", B, SYNC),
  ('K4 W5 canceling with no live sub creates one', 'broker-portal/lib/billing/brokerageSync.ts', "    if (!sub && cancel) {", "    if (false) {", B, SYNC),
  ('K5 W4 webhook never ends the deal', 'broker-portal/lib/billing/brokerage.ts', "      if (target.sub.status === 'canceled') await endedSubscription(ctx, org, target.sub.id);\n      else if", "      if", B, HOOK),
  ('K6 W4 unexpected end not alerted', 'broker-portal/lib/billing/brokerage.ts', "  if (res.outcome === 'not_canceling') {", "  if (false) {", B, HOOK),
  ('K7 backstop ends a sub Stripe still has open', 'broker-portal/lib/billing/brokerageEndBackstop.ts', "    if (sub.status !== 'canceled') {", "    if (false) {", B, '__tests__/lib/billing/brokerageEndBackstop.test.ts'),
  ('K8 backstop has no grace', 'broker-portal/lib/billing/brokerageEndBackstop.ts', "end > now - END_BACKSTOP_GRACE_MS", "end > now", B, '__tests__/lib/billing/brokerageEndBackstop.test.ts'),
  ('K9 W10 action uses the service client', 'broker-portal/lib/actions/autoRenew.ts', "import { createClient } from '@/lib/supabase/server';", "import { createServiceClient as createClient } from '@/lib/supabase/service';", B, '__tests__/auto-renew-4019/autoRenewAction.test.ts'),
  ('K10 buttons from role, not can_change', 'broker-portal/components/billing/AutoRenewBlock.tsx', "const showOff = planEnd.canChange && planEnd.state === 'renewing';", "const showOff = planEnd.state === 'renewing';", B, '__tests__/auto-renew-4019/autoRenewUi.test.tsx'),
  ('K11 no confirm dialog', 'broker-portal/components/billing/AutoRenewBlock.tsx', "onClick={() => setConfirming(true)}", "onClick={() => run(false)}", B, '__tests__/auto-renew-4019/autoRenewUi.test.tsx'),
  ('K12 broker line ignores can_change', 'broker-portal/lib/billing/planEnd.ts', "return p.canChange ? `Your plan ends ${on}. Turn auto-renew back on in Billing.` : `Your plan ends ${on}. Contact support to keep it.`;", "return `Your plan ends ${on}. Turn auto-renew back on in Billing.`;", B, '__tests__/auto-renew-4019/autoRenewUi.test.tsx'),
  ('K13 staff buttons without billing.manage', 'admin-portal/lib/billing/dealRules.ts', "  if (!b.can_manage) return null;\n", "", A, '__tests__/auto-renew-4019'),
  ('K14 badge keeps Cancel pending', 'admin-portal/lib/billing/dealRules.ts', "  if (deal.status === 'canceling') {\n    const date", "  if (false) {\n    const date", A, '__tests__/auto-renew-4019'),
  ('K16 IT admin reads the plan end', 'broker-portal/app/dashboard/billing/page.tsx', "const planEnd = role === 'broker' || role === 'admin' || billingContact ? await readPlanEnd(portal.supabase, organizationId) : null;", "const planEnd = await readPlanEnd(portal.supabase, organizationId);", B, '__tests__/app/dashboard/billing/billing-page.test.tsx'),
  ('K15 card field reads status only', 'admin-portal/lib/billing/dealRules.ts', "  const eff = deal.status === 'suspended' ? deal.status_before_suspension : deal.status;", "  const eff = deal.status;", A, '__tests__/auto-renew-4019'),
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
