#!/usr/bin/env python3
"""BACKLOG-4263 P11 two-session control, offline only (no database):

  1. run.sh parses under /bin/bash (bash -n);
  2. compose.py writes both modes, every mutant replacement matching exactly once (MUTATION APPLIED), and every
     composed text (placeholders filled) parses as PostgreSQL (pglast, given as the first argument: a python that has it);
  3. run.sh runs end to end against a stub transport in six shapes: pristine closed -> PASS, mutant hole -> RED,
     pristine hole -> exit 1, a dirty verify -> TEARDOWN NOT CLEAN, a refused precheck -> stop before setup, a
     session 2 that started after session 1 -> INCONCLUSIVE.

`python3 -I offline_check.py <python-with-pglast>`  exit 0 only when every step holds
"""
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import compose  # noqa: E402
import verdict  # noqa: E402

STUB = r'''#!/usr/bin/env python3
import json, os, re, sys
sys.path.insert(0, os.environ['STUB_HERE'])
import verdict
f = open(sys.argv[1]).read()
shape = os.environ['STUB_SHAPE']
log = open(os.environ['STUB_LOG'], 'a')
tag = (re.search(r'/\*t:(\w+)\*/', f) or re.search(r'(pg_stat_statements_reset)', f)).group(1)
log.write(tag + '\n')
base = {'ledger_head': '20261123140000', 'notice_version': 1, 'tn_objects': 0, 'auth_users': 7}
pre = {'txn': 'one', 'iso': 'read committed', 'fixture_by_id': 0, 'fixture_by_pattern': 0, 'fixture_fk_rows': 0, 'client_exists': 0,
       'pending_requests': 1 if shape == 'refused' else 0, 'connections_v2': 0, 'enabled': False,
       'updated_at': '2026-11-12 17:00:00.123456+00', 'baseline': base}
s1, s2, st = verdict.canned('hole' if shape in ('hole', 'pristine_hole') else 'closed', order=(shape != 'late'))
out = {
  'precheck': verdict.env400('T4263N_PRE', pre),
  'setup': json.dumps([{'line': json.dumps({'k': 'setup', 'view': {'ok': True, 'notice_version': 1, 'nonce': 'N' * 43}})}]) + '\nkt-sql: HTTP 200\n',
  'session2': s2, 'session1': s1, 'state': st,
  'probe': verdict.env400('T4263N_PROBE', {'ledger_tn': 1, 'expire_md5': os.environ['STUB_MD5']}),
  'rollback': '[]\nkt-sql: HTTP 200\n', 'teardown': '[]\nkt-sql: HTTP 200\n',
  'verify': verdict.env400('T4263N_VERIFY', {'fixture_by_id': 0, 'fixture_fk_rows': 0, 'client_exists': 0,
                                             'baseline': dict(base, auth_users=8) if shape == 'dirty' else base}),
  'pg_stat_statements_reset': '[]\nkt-sql: HTTP 200\n'}[tag]
sys.stdout.write(out)
'''


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    pyg = argv[0]
    bad = 0
    r = subprocess.run(['/bin/bash', '-n', os.path.join(HERE, 'run.sh')], capture_output=True, text=True)
    print(f"{'ok  ' if r.returncode == 0 else 'FAIL'} bash -n run.sh (/bin/bash) {r.stderr.strip()}")
    bad += r.returncode != 0
    d = tempfile.mkdtemp()
    md5s = {}
    for mode in ('pristine', 'mutant'):
        out = os.path.join(d, mode)
        compose.compose(out, mode, '0123456789abcdef', '11111111-2222-4333-8444-555555555555', '21111111-2222-4333-8444-555555555555',
                        '31111111-2222-4333-8444-555555555555', 'kpr_c_p4263n2s0123456789abcd', 'p4263n2sreq0123456789a', show=(mode == 'mutant'))
        md5s[mode] = open(os.path.join(out, 'md5s.txt')).read().split('expire_md5_this ')[1].split('\n')[0]
        for f in sorted(os.listdir(out)):
            if not f.endswith(('.sql', '.tpl')):
                continue
            t = open(os.path.join(out, f)).read().replace('__NONCE__', 'N' * 43).replace('__ENABLED__', 'false') \
                .replace('__UPDATED_AT__', '2026-11-12 17:00:00+00')
            left = re.findall(r'__[A-Z_]+__', t)
            p = subprocess.run([pyg, '-c', 'import sys, pglast; t = sys.stdin.read(); print(len(pglast.parse_sql(t)))'],
                               input=t, capture_output=True, text=True)
            ok = p.returncode == 0 and not left
            print(f"{'ok  ' if ok else 'FAIL'} pglast parse {mode}/{f}{' placeholders left: ' + str(left) if left else ''} {p.stderr.strip()[-200:]}")
            bad += not ok
    # the role check of backlog-4263-sync2-t over every composed text (owners from the migrations through T-N)
    import importlib.util
    spec = importlib.util.spec_from_file_location('roles4263n2s', os.path.join(HERE, '..', '..', 'backlog-4263-sync2-t', 'roles.py'))
    roles = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(roles)
    texts = {f'{m}/{f}': open(os.path.join(d, m, f)).read() for m in ('pristine', 'mutant') for f in os.listdir(os.path.join(d, m))
             if f.endswith(('.sql', '.tpl'))}
    per = roles.check([], texts)
    wrong = sum(1 for ops in per.values() for o in ops if o[4] != o[5])
    print(f"{'ok  ' if wrong == 0 else 'FAIL'} role check: {len(per)} composed texts, {sum(len(v) for v in per.values())} statements on objects "
          f"another role owns, {wrong} under the wrong role")
    bad += wrong != 0
    cspec = importlib.util.spec_from_file_location('casts4263n2s', os.path.join(HERE, '..', '..', 'backlog-4263-sync2-t', 'casts.py'))
    casts = importlib.util.module_from_spec(cspec)
    cspec.loader.exec_module(casts)
    cf = [f'{k}: {x}' for k, t in texts.items() for x in casts.findings(t)]
    print(f"{'ok  ' if not cf else 'FAIL'} cast check: {len(texts)} composed texts, {len(cf)} findings {cf[:2]}")
    bad += len(cf)
    stub = os.path.join(d, 'stub')
    open(stub, 'w').write('#!' + sys.executable + '\n' + STUB.split('\n', 1)[1])
    os.chmod(stub, 0o700)
    for shape, args, want_rc, want_text in [
            ('closed', [], 0, 'pristine: PASS'), ('hole', ['--mutant'], 0, 'mutant: RED'), ('pristine_hole', [], 1, 'pristine: FAIL'),
            ('dirty', [], 1, 'TEARDOWN NOT CLEAN'), ('refused', [], 1, 'refusing to start'), ('late', [], 1, 'pristine: INCONCLUSIVE')]:
        log = os.path.join(d, f'log-{shape}')
        env = dict(os.environ, T4263N_RUNNER=stub, STUB_HERE=HERE, STUB_SHAPE=shape, STUB_LOG=log,
                   STUB_MD5=md5s['mutant' if '--mutant' in args else 'pristine'])
        r = subprocess.run(['/bin/bash', os.path.join(HERE, 'run.sh'), 'fedcba9876543210', '41111111-2222-4333-8444-555555555555'] + args,
                           capture_output=True, text=True, env=env, timeout=60)
        calls = open(log).read().split() if os.path.exists(log) else []
        ok = r.returncode == want_rc and want_text in (r.stdout + r.stderr)
        if shape == 'refused':
            ok = ok and calls == ['precheck']
        else:
            ok = ok and calls[:2] == ['precheck', 'setup'] and 'teardown' in calls and calls[-2:] == ['verify', 'pg_stat_statements_reset']
        print(f"{'ok  ' if ok else 'FAIL'} stub run {shape}: exit {r.returncode} (want {want_rc}), calls {' '.join(calls)}")
        if not ok:
            print('     ' + (r.stdout + r.stderr)[-800:].replace('\n', '\n     '))
        bad += not ok
    print(f'offline check: {"OK" if not bad else "FAILED"} ({bad} problem(s))')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
