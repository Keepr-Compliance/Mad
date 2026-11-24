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
if shape == 'hosted' and "md5(u.id::text) = ('53a38518' || '7695375e2e8695625a20a77a')" in f:
    out = json.dumps({'message': 'Failed to run sql query: ERROR:  P0001: refuses to run: the hosted test database (its marker is present); '
                                 'this control commits T-N\nCONTEXT:  x'}) + '\nkt-sql: HTTP 400\n'
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
                        '31111111-2222-4333-8444-555555555555', 'kpr_c_p4263n2s0123456789abcd', 'p4263n2sreq0123456789a', show=(mode == 'mutant'),
                        marker=compose.md5('offline-check-marker'))
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
    os.makedirs(os.path.join(d, 'hosted'), exist_ok=True)
    kt = os.path.join(d, 'hosted', 'kt-sql')
    open(kt, 'w').write(open(stub).read())
    os.chmod(kt, 0o700)
    alias = os.path.join(d, 'runner-alias')
    os.symlink(kt, alias)
    marker = compose.md5('offline-check-marker')

    def run_case(folder, shape, args, env_over):
        log = os.path.join(d, f'log-{shape}-{len(os.listdir(d))}')
        env = dict(os.environ, T4263N_RUNNER=stub, T4263N_MARKER_MD5=marker, T4263N_REPO=compose.REPO, STUB_HERE=HERE,
                   STUB_SHAPE=shape, STUB_LOG=log, STUB_MD5=md5s['mutant' if '--mutant' in args else 'pristine'])
        for k, v in env_over.items():
            if v is None:
                env.pop(k, None)
            else:
                env[k] = v
        r = subprocess.run(['/bin/bash', os.path.join(folder, 'run.sh'), 'fedcba9876543210', '41111111-2222-4333-8444-555555555555'] + args,
                           capture_output=True, text=True, env=env, timeout=60)
        calls = open(log).read().split() if os.path.exists(log) else []
        return r.returncode, r.stdout + r.stderr, calls

    full = ['precheck', 'setup', 'session2', 'session1', 'state', 'probe', 'rollback', 'teardown', 'verify', 'pg_stat_statements_reset']
    hosted = '53a38518' + '7695375e2e8695625a20a77a'
    CASES = {  # name: (shape, args, env, want exit, want text, want calls)
        'closed': ('closed', [], {}, 0, 'pristine: PASS', full),
        'hole': ('hole', ['--mutant'], {}, 0, 'mutant: RED', full),
        'pristine_hole': ('pristine_hole', [], {}, 1, 'pristine: FAIL', full),
        'dirty': ('dirty', [], {}, 1, 'TEARDOWN NOT CLEAN', full),
        'refused': ('refused', [], {}, 1, 'refusing to start', ['precheck']),
        'late': ('late', [], {}, 1, 'pristine: INCONCLUSIVE', full),
        'hosted marker present': ('hosted', [], {}, 1, 'refuses to run: the hosted test database', ['precheck']),
        'transport unset': ('closed', [], {'T4263N_RUNNER': None}, 2, 'refusing: T4263N_RUNNER must name', []),
        'transport kt-sql': ('closed', [], {'T4263N_RUNNER': kt}, 2, 'refusing: T4263N_RUNNER is the hosted transport', []),
        'transport through a symlink to kt-sql': ('closed', [], {'T4263N_RUNNER': alias}, 2, 'resolves to the hosted transport', []),
        'marker missing': ('closed', [], {'T4263N_MARKER_MD5': None}, 2, 'T4263N_MARKER_MD5 (the dry-run database marker md5) is required', []),
        'marker is the hosted one': ('closed', [], {'T4263N_MARKER_MD5': hosted}, 2, 'T4263N_MARKER_MD5 is the hosted test database marker', []),
    }

    def check_case(folder, name):
        shape, args, env, want_rc, want_text, want_calls = CASES[name]
        rc, out, calls = run_case(folder, shape, args, env)
        return rc == want_rc and want_text in out and calls == want_calls, rc, calls, out

    for name in CASES:
        ok, rc, calls, out = check_case(HERE, name)
        print(f"{'ok  ' if ok else 'FAIL'} stub run {name}: exit {rc}, calls {' '.join(calls) or '(none)'}")
        if not ok:
            print('     ' + out[-800:].replace('\n', '\n     '))
        bad += not ok
    # compose.py refuses on its own too (the second layer behind run.sh)
    for name, mk, want in [('compose without a marker', '', 'T4263N_MARKER_MD5 must be'), ('compose with the hosted marker', hosted, 'hosted test database marker')]:
        r = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'compose.py'), os.path.join(d, 'x'), 'pristine', '0123456789abcdef',
                            '11111111-2222-4333-8444-555555555555', '21111111-2222-4333-8444-555555555555', '31111111-2222-4333-8444-555555555555',
                            'kpr_c_' + 'A' * 22, 'B' * 22], capture_output=True, text=True, env=dict(os.environ, T4263N_MARKER_MD5=mk))
        ok = r.returncode != 0 and want in r.stdout + r.stderr and not os.path.exists(os.path.join(d, 'x'))
        print(f"{'ok  ' if ok else 'FAIL'} {name}: refused, nothing written")
        bad += not ok
    # no text of this folder holds the hosted marker whole (a one-match substitution can neither find nor satisfy it)
    whole = [f for f in os.listdir(HERE) if os.path.isfile(os.path.join(HERE, f)) and hosted in open(os.path.join(HERE, f), errors='replace').read()]
    print(f"{'ok  ' if not whole else 'FAIL'} the hosted marker appears whole in no file of this folder {whole}")
    bad += bool(whole)

    # mutations: each refusal removed (exact replace, must match once) -> its case must stop passing
    RB_HOSTED = ("  IF EXISTS (SELECT 1 FROM auth.users u WHERE md5(u.id::text) = ('53a38518' || '7695375e2e8695625a20a77a')) THEN   /*REFUSE:hosted*/\n"
                 "    RAISE EXCEPTION 'refuses to run: the hosted test database (its marker is present); this control commits T-N';\n  END IF;\n")
    AS_HOSTED = ("        assert out.count(\"md5(u.id::text) = ('53a38518' || '7695375e2e8695625a20a77a')\") == 1 and HOSTED_MARKER not in out, name\n")
    T_UNSET = '[ -n "$K" ] && [ -x "$K" ] || { echo "refusing: T4263N_RUNNER must name the dry-run transport wrapper (an executable)" >&2; usage; }\n'
    T_BASE = 'case "$(basename "$K")" in kt-sql|kt-sql.*) echo "refusing: T4263N_RUNNER is the hosted transport (${K}); this control commits T-N" >&2; exit 2 ;; esac\n'
    T_REAL = 'case "$(basename "$K_REAL")" in kt-sql|kt-sql.*) echo "refusing: T4263N_RUNNER resolves to the hosted transport (${K_REAL}); this control commits T-N" >&2; exit 2 ;; esac\n'
    M_REQ = '[[ "$MARKER" =~ ^[0-9a-f]{32}$ ]] || { echo "refusing: T4263N_MARKER_MD5 (the dry-run database marker md5) is required; there is no default" >&2; usage; }\n'
    M_HOST = '[ "$MARKER" = "53a38518""7695375e2e8695625a20a77a" ] && { echo "refusing: T4263N_MARKER_MD5 is the hosted test database marker" >&2; exit 2; }\n'
    C_REQ = ("    if not MARKER_RE.fullmatch(marker):\n"
             "        raise SystemExit('T4263N_MARKER_MD5 must be the md5 (32 lowercase hex) of the dry-run database marker id; there is no default')\n")
    C_HOST = ("    if marker == HOSTED_MARKER:\n"
              "        raise SystemExit('refusing: T4263N_MARKER_MD5 is the hosted test database marker; this control commits T-N')\n")
    C_COUNT = "        assert out.count(marker) == 1, name\n"
    # (what, [(file, old, new)], case, want calls after the mutation: 'full' = the run went ahead, 'none' = still stopped
    # by another layer before any call)
    MUTS = [
        ('the hosted-marker refusal in the guard (and its composer assertion)', [('compose.py', RB_HOSTED, ''), ('compose.py', AS_HOSTED, '')],
         'hosted marker present', 'full'),
        ('the unset-transport refusal', [('run.sh', T_UNSET, '')], 'transport unset', 'none'),
        ('the kt-sql basename refusal (the resolved-path one still stops it)', [('run.sh', T_BASE, '')], 'transport kt-sql', 'none'),
        ('both kt-sql refusals', [('run.sh', T_BASE, ''), ('run.sh', T_REAL, '')], 'transport kt-sql', 'full'),
        ('the kt-sql resolved-path refusal', [('run.sh', T_REAL, '')], 'transport through a symlink to kt-sql', 'full'),
        ('the marker-required refusal in run.sh (compose.py still stops it)', [('run.sh', M_REQ, '')], 'marker missing', 'none'),
        ('both marker-required refusals', [('run.sh', M_REQ, ''), ('compose.py', C_REQ, ''), ('compose.py', C_COUNT, '')], 'marker missing', 'full'),
        ('the hosted-marker argument refusal in run.sh (compose.py still stops it)', [('run.sh', M_HOST, '')], 'marker is the hosted one', 'none'),
        ('both hosted-marker argument refusals (the composer assertion still stops it)', [('run.sh', M_HOST, ''), ('compose.py', C_HOST, '')],
         'marker is the hosted one', 'none'),
        ('both hosted-marker argument refusals and the composer assertion (the SQL guard is then the last layer)',
         [('run.sh', M_HOST, ''), ('compose.py', C_HOST, ''), ('compose.py', AS_HOSTED, '')], 'marker is the hosted one', 'full'),
    ]
    import shutil
    for k, (what, reps, case_name, want_after) in enumerate(MUTS):
        md = os.path.join(d, f'mut{k}')
        shutil.copytree(HERE, md, ignore=shutil.ignore_patterns('__pycache__'))
        applied = True
        for fname, old, new in reps:
            p = os.path.join(md, fname)
            t = open(p).read()
            n = t.count(old)
            if n != 1:
                print(f'FAIL MUTATION NOT APPLIED {what}: {fname} matched {n} times')
                applied = False
                break
            open(p, 'w').write(t.replace(old, new))
        if not applied:
            bad += 1
            continue
        print(f'MUTATION APPLIED {what} ({", ".join(f for f, _, _ in reps)})')
        ok, rc, calls, _ = check_case(md, case_name)
        shape_ok = (calls == full) if want_after == 'full' else (calls == [] or calls == ['precheck'])
        good = (not ok) and shape_ok
        print(f"{'ok  ' if good else 'FAIL'}   -> case '{case_name}' {'goes red' if not ok else 'STILL PASSES'}; "
              f"calls after the mutation: {' '.join(calls) or '(none)'} (expected {want_after})")
        bad += not good
    print(f'offline check: {"OK" if not bad else "FAILED"} ({bad} problem(s))')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
