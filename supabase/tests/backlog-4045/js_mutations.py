#!/usr/bin/env python3
"""BACKLOG-4045 JS controls. Each mutation: exact-once replace (raises on 0 or 2+),
MUTATION APPLIED + md5 before/after printed, the named suite run with bail off, the test count
asserted non-zero, failures recorded, the file restored with `git checkout --` (the fix is
committed first). Usage: js_mutations.py <repo root> [J1,J2,...]  (optional id filter)
(Runner copied from supabase/tests/backlog-4019/js_mutations.py.)"""
import hashlib, json, re, subprocess, sys
root = sys.argv[1]
B, A = 'broker-portal', 'admin-portal'
H = 'broker-portal/lib/billing/autoRenewOnNotify.ts'
CONV = '__tests__/lib/billing/outboxKinds/notify_auto_renew_on.convergence.test.ts'
TPL = '__tests__/lib/email/auto-renew-on.test.ts'
CONTRACT = '__tests__/lib/billing/outboxKinds.contract.test.ts'
M = [
  ('J1 C8b no status check', H, "  if (d?.status !== 'active') {", "  if (false) {", B, CONV),
  ('J2 C8c no superseded check', H, "  if ((await newestAutoRenewVersion(service, org)) !== version) {", "  if (false) {", B, CONV),
  ('J3 C8d deal version instead of newest auto-renew change', H, "  if ((await newestAutoRenewVersion(service, org)) !== version) {", "  if ((deal as { version?: number } | null)?.version !== version) {", B, CONV),
  # J4 first draft ("return newest ?? 0") stayed green: no payload carries version 0, so the row
  # was still skipped. That mutation could not express "no row -> send"; this one does.
  ('J4 C8e no auto-renew row still sends', H, "  if ((await newestAutoRenewVersion(service, org)) !== version) {", "  const nv = await newestAutoRenewVersion(service, org);\n  if (nv !== null && nv !== version) {", B, CONV),
  ('J5 C8f no alreadySent', H, "  if (await alreadySent(service, row.dedupe_key)) return;", "", B, CONV),
  ('J6 C8g throw on no contact', H, "    console.info(`[billing/auto-renew-on] ${row.id}: no billing contact email; nothing to send`);\n    return;", "    throw new Error('no contact');", B, CONV),
  ('J7 C8 newest by first row, not by version', H, "    if (v !== null && (newest === null || v > newest)) newest = v;", "    if (v !== null && newest === null) newest = v;", B, CONV),
  ('J8 C9 template word changed', 'broker-portal/lib/email/templates/auto-renew-on.ts', "'Your plan renews each month and is billed as before.'", "'Your plan renews monthly and is billed as before.'", B, TPL),
  ('J9 C10 kind not registered', 'broker-portal/lib/billing/outboxKinds.ts', "  notify_auto_renew_on: async (row: OutboxRow, ctx: OutboxHandlerContext) =>\n    (await import('./autoRenewOnNotify')).handleNotifyAutoRenewOnRow(row, ctx),\n", "", B, CONTRACT),
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
