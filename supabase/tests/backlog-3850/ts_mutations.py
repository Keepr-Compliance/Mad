#!/usr/bin/env python3
"""BACKLOG-3850: TypeScript mutation controls. Run from the repo root of a worktree whose fix is
COMMITTED (each mutant is restored with `git checkout -- <file>`).

Each mutant: exact once-only replacement (else INVALID), MUTATION APPLIED + git diff --numstat,
then the target jest suite; a run with 0 tests is an ERROR, not a pass.
"""
import json, os, re, subprocess, sys

BP = 'broker-portal'
CONV = '__tests__/lib/billing/outboxKinds/cancel_agent_on_brokerage_join.convergence.test.ts'
REC = '__tests__/lib/billing/reconcile.test.ts'
J = 'lib/billing/joinCancel.ts'
R = 'lib/billing/reconcile.ts'
MUTANTS = [
    ('T1a prorate true', J, '{ prorate: false, invoice_now: false },', '{ prorate: true, invoice_now: false },', CONV),
    ('T1b cancel_at_period_end instead of cancel', J,
     'const ended: Stripe.Subscription = await ctx.stripe.subscriptions.cancel(\n      sub.id,\n      { prorate: false, invoice_now: false },',
     'const ended: Stripe.Subscription = await ctx.stripe.subscriptions.update(\n      sub.id,\n      { cancel_at_period_end: true } as never,', CONV),
    ('T2 owner check removed (F3)', J, 'if (!current || current.stripe_customer_id !== customerId) throw', 'if (false) throw', CONV),
    ('T3a deactivated not superseded', J, "  if (DEACTIVATED.has(member.license_status ?? '')) return null;\n", '', CONV),
    ('T3b reverted-to-personal not superseded', J, '    if (Array.isArray(pm) && pm.length > 0) return null; // reverted to pay-as-you-go\n', '', CONV),
    ('T4 brokerage-kind not filtered', 'lib/billing/suspension.ts', '  return subs.filter(isAgent);\n', '  return subs;\n', CONV),
    ('T5 email dedupe removed', J, '  if (await alreadySent(ctx.service, row.dedupe_key)) return;\n', '', CONV),
    ('T6 retry after cancel sends nothing', J, '        endedEarlier = true;\n', '', CONV),
    ('T7 closed plans not skipped', J, '    if (CLOSED.has(sub.status)) {\n', '    if (false) {\n', CONV),
    ('T8 copy not by license_status', J, "    licensed: join.member.license_status === 'active',\n", '    licensed: true,\n', CONV),
    ('T9 template ignores licensed', 'lib/email/templates/agent-plan-ended.ts', '  const joined = p.licensed\n', '  const joined = true\n', CONV),
    ('T10 paid-meanwhile throws instead of alert+cancel', J, "      if (now.status === 'paid') {\n", '      if (false) {\n', CONV),
    ('T11 incomplete cancelled', J, "    if (sub.status === 'incomplete') continue; // the void ends it\n", '', CONV),
    ('R1 fresh waiting row alerts (F1)', R, '        if (paying.length === 0 || (pending.length > 0 && !stuck)) continue;\n', '        if (paying.length === 0) continue;\n', REC),
    ('R2 parked row not stuck', R, '          if (parseRunAfter(p.run_after) === null) return true; // parked\n', '', REC),
    ('R3 one hour never reached', R, 'now.getTime() - created >= JOIN_CANCEL_ALERT_AFTER_MS;', 'now.getTime() - created >= 1e12;', REC),
    ('R4 paused not enqueued (F2)', R, '        const open = agent.filter((s) => !JOIN_CANCEL_CLOSED.has(s.status));\n', '        const open = agent.filter((s) => BROKERAGE_ALERT_SUB_STATUSES.has(s.status) && !s.pause_collection);\n', REC),
    ('R5 enqueue despite a waiting row', R, '        if (pending.length === 0) {\n', '        if (true) {\n', REC),
    ('R6 reconcile enqueue removed', R, '          if (added === \'enqueued\') result.joinCancelEnqueued++;\n', '          void added;\n', REC),
]
R6_EXTRA = ('          const added = await enqueueOutbox(deps.service, {', '          const added = false && await enqueueOutbox(deps.service, {')

def sh(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True)

root = os.getcwd()
assert sh('git status --porcelain -- broker-portal', root).stdout.strip() == '', 'commit the fix first'
only = sys.argv[1:]
summary = []
for name, rel, old, new, suite in MUTANTS:
    if only and not any(name.startswith(o) for o in only):
        continue
    path = os.path.join(root, BP, rel)
    src = open(path).read()
    reps = [(old, new)] + ([R6_EXTRA] if name.startswith('R6') else [])
    ok = True
    for o, n in reps:
        if src.count(o) != 1:
            ok = False; break
        src = src.replace(o, n)
    if not ok:
        print(f'INVALID|{name}|pattern count != 1'); summary.append((name, 'INVALID', '')); continue
    open(path, 'w').write(src)
    numstat = sh(f'git diff --numstat -- {BP}/{rel}', root).stdout.strip()
    if not numstat:
        print(f'INVALID|{name}|no diff'); summary.append((name, 'INVALID', '')); continue
    print(f'MUTATION APPLIED|{name}|{numstat}')
    out = sh(f'npx jest {suite} --json --outputFile=/dev/stdout 2>/dev/null', os.path.join(root, BP)).stdout
    sh(f'git checkout -- {BP}/{rel}', root)
    m = re.search(r'\{"numFailedTestSuites".*', out, re.S)
    try:
        res = json.loads(m.group(0)) if m else None
    except Exception:
        res = None
    if not res or res.get('numTotalTests', 0) == 0:
        verdict = 'ERROR 0 tests or unparsable'; reds = ''
    else:
        failed = [a['fullName'] for tr in res['testResults'] for a in tr['assertionResults'] if a['status'] == 'failed']
        verdict = f"{'KILLED' if res['numFailedTests'] > 0 or res['numFailedTestSuites'] > 0 else 'SURVIVED'} failed={res['numFailedTests']}/{res['numTotalTests']}"
        reds = '; '.join(f[:90] for f in failed[:4]) or ('suite failed to run' if res['numFailedTestSuites'] else '')
    print(f'{verdict}|{name}|{reds}')
    summary.append((name, verdict, reds))
assert sh('git status --porcelain -- broker-portal', root).stdout.strip() == '', 'tree not restored'
print('RESTORED: broker-portal clean')
k = sum(1 for s in summary if s[1].startswith('KILLED'))
print(f'TS MUTANTS: killed={k} total={len(summary)}')
