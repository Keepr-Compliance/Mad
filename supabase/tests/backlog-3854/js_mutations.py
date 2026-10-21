#!/usr/bin/env python3
"""BACKLOG-3854 seats + Manage billing JS controls. Each mutation: exact-once replace (raises on 0 or 2+),
MUTATION APPLIED + md5 before/after printed, the named suite run with bail off, the test count
asserted non-zero, failures recorded, the file restored with `git checkout --` (the fix is
committed first). Usage: js_mutations.py <repo root> [K1,K2,...]  (optional id filter)
(Runner copied from supabase/tests/backlog-4019/js_mutations.py; mutations in backlog-3854/js_mutation_list.py.)"""
import hashlib, json, re, subprocess, sys
root = sys.argv[1]
B, A = 'broker-portal', 'admin-portal'
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from js_mutation_list import M
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
