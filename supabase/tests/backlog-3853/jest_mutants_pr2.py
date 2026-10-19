#!/usr/bin/env python3
"""BACKLOG-3853 PR-2 jest mutant runner. Exact-once replace (raise on 0 / 2+), numstat, jest --bail=0 --json,
non-zero test count asserted, failed test names recorded, file restored with git checkout --."""
import json, os, subprocess, sys
ROOT = os.environ.get('REPO_ROOT', os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..')))
TMP = os.environ.get('TMPDIR', '/tmp')
BP = 'broker-portal/'
WH = BP + '__tests__/app/api/payments/webhook-brokerage.test.ts'
PAY = BP + '__tests__/app/api/payments/payments.test.ts'
SYNC = BP + '__tests__/lib/billing/outboxKinds/sync_org_subscription.convergence.test.ts'
NOS = BP + '__tests__/lib/billing/outboxKinds/notify_org_suspended.convergence.test.ts'
NAM = BP + '__tests__/lib/billing/outboxKinds/notify_account_manager.convergence.test.ts'
B = BP + 'lib/billing/brokerage.ts'; SY = BP + 'lib/billing/brokerageSync.ts'; NO = BP + 'lib/billing/brokerageNotify.ts'
R = BP + 'app/api/payments/webhook/route.ts'; CO = BP + 'app/api/payments/checkout-session/route.ts'; CH = BP + 'app/api/payments/charge/route.ts'
EN = BP + 'lib/billing/outboxEnqueue.ts'
M = [
 ('M-C5 dispatch skipped before the switch (brokerage events reach the Agent / dispute path)', [(R, "if (await dispatchBrokerageEvent(ctx, objectId)) {", "if (false && (await dispatchBrokerageEvent(ctx, objectId))) {")], [WH]),
 ('M-C5b orphan falls through to the Agent path', [(B, "object_id: objectId });\n      return true;", "object_id: objectId });\n      return false;")], [WH]),
 ('M-C5c-gate type gate removed only (resolveTarget still knows 7 types)', [(B, "  if (!BROKERAGE_EVENT_TYPES.has(ctx.event.type)) return false;\n", "")], [WH]),
 ('M-C5c unrestricted dispatch (gate removed + PaymentIntent events resolved)', [(B, "  if (!BROKERAGE_EVENT_TYPES.has(ctx.event.type)) return false;\n", ""), (B, "  if (type === 'charge.refunded') {", "  if (type.startsWith('payment_intent.')) {\n    const pi = await ctx.stripe.paymentIntents.retrieve(objectId);\n    const customerId = stripeId(pi.customer);\n    return customerId ? { kind: 'charge', customerId, brokerageMeta: false, charge: pi as never } : null;\n  }\n  if (type === 'charge.refunded') {")], [WH]),
 ('M-C1 suspend on past_due', [(B, "      if (target.sub.status === 'past_due') await maybeNotifyOverdue(ctx, org, target.customerId);", "      if (target.sub.status === 'past_due') { await rpc(ctx, '_billing_suspend_org', { p_org: org, p_reason: 'non_payment', p_note: 'auto', p_actor: null }); await maybeNotifyOverdue(ctx, org, target.customerId); }")], [WH]),
 ('M-OD pending-payment skip removed', [(B, "    if (PENDING_PAYMENT.has(pi.status)) {", "    if (false) {")], [WH]),
 ('M-OD dedupe per subscription, not per invoice', [(B, "await notifyAccountManager(ctx, org, 'overdue', oldest.id, oldest.id);", "await notifyAccountManager(ctx, org, 'overdue', oldest.id, 'subscription');")], [WH]),
 ('M-OD2 wall clock instead of the test clock', [(B, "  if (clockId) {", "  if (false && clockId) {")], [WH]),
 ('M-12 reinstate while an invoice is still past due', [(B, "  if ((await overdueInvoices(ctx, customerId, now)).length > 0) {", "  if (false) {")], [WH]),
 ('M-12b reinstate from invoice.paid only', [(B, "      else if (target.sub.status === 'active') await tryAutoReinstate(ctx, org, target.sub, target.customerId);\n", "")], [WH]),
 ('M-12c TS reason check removed (SQL still holds it)', [(B, "if (deal?.status !== 'suspended' || deal.suspended_reason !== 'non_payment') return;", "if (deal?.status !== 'suspended') return;")], [WH]),
 ('M-PF email on every payment_failed', [(B, "        if (pi.status === 'requires_action') {", "        if (false) {")], [WH]),
 ('M-ENQ organization rows written as user rows', [(EN, "...(job.organizationId ? { organization_id: job.organizationId } : { user_id: job.userId }),", "user_id: job.userId,")], [WH]),
 ('M-6 lease not enforced', [(SY, "  if (!leased) throw new Error('brokerage sync lease busy');\n", "")], [SYNC]),
 ('M-6c find by stored id only (no list adopt)', [(SY, "      const list = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 100 });\n      sub = list.data.find((s) => s.metadata?.kind === 'brokerage' && !ENDED.has(s.status)) ?? null;", "      sub = null;")], [SYNC]),
 ('M-K no superseded check, key from the payload version', [(SY, "  if (deal.version !== wantVersion) {", "  if (false) {"), (SY, "brokerageKey(org, mode, `subscription:v${deal.version}`)", "brokerageKey(org, mode, `subscription:v${wantVersion}`)")], [SYNC]),
 ('M-M billing_not_live check removed', [(SY, "  if (deal.stripe_mode === 'live' && !(await rpc<boolean>(service, '_billing_brokerage_live', {}))) {", "  if (false) {")], [SYNC]),
 ('M-S create_prorations on a seat change', [(SY, "{ items: [itemPatch], proration_behavior: 'none' }", "{ items: [itemPatch], proration_behavior: 'create_prorations' }")], [SYNC]),
 ('M-7a customer created with the (changeable) name', [(SY, "        { metadata: { kind: 'brokerage', organization_id: org } },", "        { name: orgName ?? undefined, metadata: { kind: 'brokerage', organization_id: org } },")], [SYNC]),
 ('M-9s drain writes status to the mirror', [(SY, "p_fields: { stripe_customer_id: customer.id, stripe_subscription_id: sub.id },", "p_fields: { stripe_customer_id: customer.id, stripe_subscription_id: sub.id, status: sub.status },")], [SYNC]),
 ('M-N email after a reinstate', [(NO, "  if (!deal || deal.status !== 'suspended') {", "  if (!deal) {")], [NOS]),
 ('M-N2 old suspension row sends for a newer suspension', [(NO, "  if (wantEpoch !== null && epochSeconds(deal.suspended_at) !== wantEpoch) {", "  if (false) {")], [NOS]),
 ('M-N3 no already-sent check (account manager)', [(NO, "  if (await alreadySent(ctx.service, 'brokerage_account_manager_alert', row.dedupe_key)) return;", "")], [NAM]),
 ('M-3 checkout-session ignores the brokerage block', [(CO, "  if (brokerageBlocked) {", "  if (false) {")], [PAY]),
 ('M-3c charge ignores the brokerage block', [(CH, "  if (brokerageBlocked) {", "  if (false) {")], [PAY]),
 ('M-3b charge fails open on a check error', [(CH, "  if (brokerageBlocked === null) {", "  if (false) {")], [PAY]),
]
only = sys.argv[1:] 
out = []
for name, reps, tests in M:
    if only and not any(name.startswith(o) for o in only): continue
    files = sorted({f for f, _, _ in reps})
    for f, a, b in reps:
        p = os.path.join(ROOT, f); t = open(p).read(); n = t.count(a)
        if n != 1: raise SystemExit(f'MUTATION NOT APPLIED: {n} matches for {name} in {f}')
        open(p, 'w').write(t.replace(a, b))
    ns = subprocess.run(['git', '-C', ROOT, 'diff', '--numstat', '--'] + files, capture_output=True, text=True).stdout.strip().replace('\n', '; ')
    print(f'MUTATION APPLIED {name} :: {ns}', flush=True)
    jf = os.path.join(TMP, 'jest-3853-pr2.json')
    subprocess.run(['npx', 'jest', '--config', 'broker-portal/jest.config.js', '--bail=0', '--silent', '--json', '--outputFile', jf] + tests, cwd=ROOT, capture_output=True, text=True)
    subprocess.run(['git', '-C', ROOT, 'checkout', '--'] + files, check=True)
    left = subprocess.run(['git', '-C', ROOT, 'diff', '--numstat'], capture_output=True, text=True).stdout.strip()
    if left: raise SystemExit('restore failed: ' + left)
    r = json.load(open(jf))
    total, failed = r['numTotalTests'], r['numFailedTests']
    if total == 0: raise SystemExit(f'Tests: 0 total for {name}')
    reds = [a['title'] for s in r['testResults'] for a in s['assertionResults'] if a['status'] == 'failed']
    line = f'{name} | numstat {ns} | tests {total}, failed {failed} | reds: {reds if reds else "NONE"}'
    print(line, flush=True); out.append(line)
open(os.path.join(TMP, 'jest-mutants-3853-pr2.txt'), 'a').write('\n'.join(out) + '\n')
