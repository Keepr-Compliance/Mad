#!/usr/bin/env python3
"""Offline check of the erase two-session script (BACKLOG-4263). NO DATABASE: run.sh is copied to a temporary folder
with its transport line pointed at a local stub that records every SQL text it is handed and answers canned rows.

usage: python3 -I offline_check.py [<folder>]   (default: this folder; exit 0 only when every check holds)

Checks (each prints ok/BAD):
  bash      every *.sh parses under /bin/bash (macOS ships 3.2) -- bash -n
  transport run.sh reaches the database only through K=~/.claude/bin/kt-sql
  marker    every case: exactly one call carries this run's hold marker, it ends at or before byte MARKER_MAX of that
            call's text (pg_stat_activity.query keeps only the first 1 kB on the test project), and the gate is sent
  copies    the live cloud_blob_erase_claim / cloud_blob_erase_scrub are never created or replaced: every CREATE
            FUNCTION is a public.*_m4263 name, and only in its own call, never inside a session
  locks     every call that writes (setup, copy, drop, delete) sets lock_timeout 3 s; no LOCK TABLE; the last call is
            pg_stat_statements_reset(); the switch is written only inside a DO that ends in RAISE
  absent    the first call is the read-only precheck; when it reports anything left, nothing else is sent
  bykey     the delete names the fixture user id and this run's exact email, never an email pattern
  counts    the per-table counts are read before the delete and again after it
  notclean  auth.users total changed, or the copy was not dropped: TEARDOWN NOT CLEAN names the user id and the run
            id, and (copy not dropped) no delete is sent
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FOLDER = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else HERE
MARKER_MAX = 900
K_LINE = 'K=~/.claude/bin/kt-sql'
RUN = '0123456789abcdef'
USER = '00000000-0000-0000-0000-000000000000'  # nil id: fixture placeholder for the offline run only
ROOT = subprocess.run(['git', '-C', HERE, 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip()
ROOT_LINE = 'root="$(git -C "$here" rev-parse --show-toplevel)"'
STUB = r'''import json, os, re, sys
out = os.environ['STUB_OUT']
sql = sys.argv[2] if sys.argv[1] == '-c' else open(sys.argv[1]).read()
n = len(os.listdir(out)) + 1
open(os.path.join(out, '%03d.sql' % n), 'w').write(sql)
cfg = json.loads(os.environ.get('STUB_CFG', '{}'))
Z = '00000000-0000-0000-0000-000000000000'
def p(x): print(json.dumps(x))
if '/*t:precheck*/' in sql:
    r = {'by_id': 0, 'by_pattern': 0, 'mutants': 0, 'marked_runs': 0, 'auth_users': 25, 'orphans': 0, 'one_computer': True}
    r.update(cfg.get('pre', {})); p([r])
elif '/*t:fkcount*/' in sql: p([{'tbl': 'cloud_deals', 'col': 'owner_user_id', 'n': cfg.get('fk', 0)}])
elif '/*t:authcount*/' in sql: p([{'n': cfg.get('auth_after', 25)}])
elif '/*t:verify*/' in sql: p([{'verdict': 'clean'}])
elif '/*t:residue*/' in sql: p([{'n': 0, 'auth_users': cfg.get('auth_after', 25)}])
elif '/*t:setup*/' in sql: p([{'blob': Z, 'one_computer': True, 'x': Z, 'd1': Z}])
elif re.search(r'\bAS left\b', sql): p([{'left': cfg.get('left', 0)}])
elif re.search(r'\bAS m\b', sql): p([{'m': '0' * 32}])
elif 'AS j' in sql: p([{'j': {}}])
elif 'AS mine' in sql: p([{'n': 0, 'mine': 1, 'total': 26}])
else: p([{'r': {}}])
'''
results = []


def check(name, ok, detail=''):
    results.append(ok)
    print(('ok   ' if ok else 'BAD  ') + name + (': ' + detail if detail else ''))


def drive(args, cfg=None):
    """Run a stubbed copy of run.sh; returns (rc, output, [texts in order])."""
    with tempfile.TemporaryDirectory() as d:
        dst = os.path.join(d, 'f')
        shutil.copytree(FOLDER, dst)
        run = open(os.path.join(dst, 'run.sh')).read()
        stub = os.path.join(d, 'stub.py')
        open(stub, 'w').write(STUB)
        wrapper = os.path.join(d, 'stub-kt')
        open(wrapper, 'w').write(f'#!/bin/bash\nexec /usr/bin/python3 -I {stub} "$@"\n')
        os.chmod(wrapper, 0o700)
        assert run.count(K_LINE + '\n') == 1 and run.count(ROOT_LINE + '\n') == 1
        run = run.replace(K_LINE + '\n', f'K={wrapper}\n').replace(ROOT_LINE + '\n', f'root={ROOT}\n')
        open(os.path.join(dst, 'run.sh'), 'w').write(run)
        outdir = os.path.join(d, 'sent')
        os.mkdir(outdir)
        env = dict(os.environ, STUB_OUT=outdir, STUB_CFG=json.dumps(cfg or {}))
        r = subprocess.run(['/bin/bash', os.path.join(dst, 'run.sh')] + args, capture_output=True, text=True, env=env, timeout=120)
        texts = [open(os.path.join(outdir, f)).read() for f in sorted(os.listdir(outdir))]
        return r.returncode, r.stdout + r.stderr, texts


ver = subprocess.run(['/bin/bash', '--version'], capture_output=True, text=True).stdout.splitlines()[0]
for f in sorted(x for x in os.listdir(FOLDER) if x.endswith('.sh')):
    r = subprocess.run(['/bin/bash', '-n', os.path.join(FOLDER, f)], capture_output=True, text=True)
    check(f'bash -n {f} ({ver})', r.returncode == 0, r.stderr.strip()[:200])

src = open(os.path.join(FOLDER, 'run.sh')).read()
code = '\n'.join(l for l in src.splitlines() if not l.lstrip().startswith('#'))
check('transport: one K= line, kt-sql only through $K, no psql/curl',
      code.count(K_LINE) == 1 and code.count('kt-sql') == 1 and not re.search(r'\b(psql|curl)\b', code))

CASES = [('attach', ''), ('attach', 'single_statement_fence'), ('c6g_skip', ''), ('c6g_skip', 'no_skip_locked'),
         ('c6g_wait', ''), ('c6g_wait', 'read_before_lock')]
LIVE = re.compile(r'FUNCTION public\.cloud_blob_erase_(claim|scrub)\(')
WRITES = re.compile(r'/\*t:(setup|copy|drop|delete)\*/')
for case, mut in CASES:
    rc, out, texts = drive([case, USER] + ([mut] if mut else []))
    label = f'{case} {mut or "pristine"}'
    m = re.search(r'RUN ([0-9a-f]{16})', out)
    run_id = m.group(1) if m else 'none'
    mark = f'p_hold:{run_id}*/'
    holders = [t for t in texts if mark in t]
    ends = [len(t.encode()[:t.encode().index(mark.encode()) + len(mark)]) for t in holders]
    check(f'marker {label}: one holder call, marker ends at byte {ends} <= {MARKER_MAX}, gate sent',
          len(holders) == 1 and all(e <= MARKER_MAX for e in ends) and any("'%p_hold:' ||" in t for t in texts))
    created = [n for t in texts for n in re.findall(r'CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(', t)]
    in_session = [t for t in texts if 'CREATE' in t and 'FUNCTION' in t and ('P_A' in t or 'P_B' in t)]
    want = bool(mut) or case == 'c6g_wait'
    check(f'copies {label}: created {created or "none"}', not any(LIVE.search(t) for t in texts)
          and all(n.endswith('_m4263') for n in created) and not in_session and bool(created) == want)
    w = [t for t in texts if WRITES.search(t)]
    sw = [t for t in texts if 'cloud_release_switches SET' in t]
    check(f'locks {label}: {len(w)} writing calls carry lock_timeout 3 s; switch written only inside a raising DO; '
          'no LOCK TABLE; last call resets stats',
          len(w) >= 2 and all("SET LOCAL lock_timeout = '3s';" in t for t in w)
          and all(re.search(r"DO \$\w\$.*UPDATE public\.cloud_release_switches SET one_computer = true WHERE id AND NOT one_computer;.*RAISE EXCEPTION", t, re.S) for t in sw)
          and not any(re.search(r'\bLOCK\s+TABLE\b', t, re.I) for t in texts) and 'pg_stat_statements_reset' in texts[-1])
    check(f'absent {label}: first call is the precheck', bool(texts) and '/*t:precheck*/' in texts[0])
    dels = [t for t in texts if re.search(r'\bDELETE\s+FROM\s+auth\.users', t)]
    check(f'bykey {label}: the delete names the user id and this run\'s exact email',
          len(dels) == 1 and USER in dels[0] and f"email = 'p4263c-{run_id}@example.test'" in dels[0] and 'LIKE' not in dels[0])
    tags = [re.search(r'/\*t:(\w+)\*/', t).group(1) if re.search(r'/\*t:(\w+)\*/', t) else '' for t in texts]
    ok = 'delete' in tags and 'fkcount' in tags[:tags.index('delete')] and 'fkcount' in tags[tags.index('delete'):]
    check(f'counts {label}: per-table counts before and after the delete', ok)

for what, cfg in (('fixture id', {'by_id': 1}), ('fixture address', {'by_pattern': 1}), ('copy left', {'mutants': 1}),
                  ('marked run row', {'marked_runs': 1}), ('900 orphans (attach)', {'orphans': 900})):
    rc, out, texts = drive(['attach', USER, 'single_statement_fence'], {'pre': cfg})
    check(f'absent: precheck reports {what} -> {len(texts)} call(s) sent, refused', rc != 0 and len(texts) == 1
          and 'nothing was created' in out)
rc, out, texts = drive(['c6g_wait', USER], {'auth_after': 24})
m = re.search(r'RUN ([0-9a-f]{16})', out)
check('notclean: auth.users total changed -> TEARDOWN NOT CLEAN with user and run id', rc != 0 and 'TEARDOWN NOT CLEAN' in out
      and USER in out and bool(m) and m.group(1) in out.split('TEARDOWN NOT CLEAN', 1)[1])
rc, out, texts = drive(['c6g_wait', USER, 'read_before_lock'], {'left': 1})
check('notclean: copy not dropped -> TEARDOWN NOT CLEAN, no delete sent', rc != 0 and 'TEARDOWN NOT CLEAN' in out
      and not any('/*t:delete*/' in t for t in texts) and USER in out)
rc, out, texts = drive(['attach', USER], {'fk': 1})
check('notclean: rows left after the delete -> TEARDOWN NOT CLEAN', rc != 0 and 'TEARDOWN NOT CLEAN' in out)
rc, out, texts = drive(['cleanup', USER, '0123456789abcdef'])
check('bykey: cleanup deletes only by id and that run\'s exact email', rc == 0 and any(
      "email = 'p4263c-0123456789abcdef@example.test'" in t and 'DELETE' in t for t in texts))
print(f'{len(results)} checks, {results.count(False)} failed')
sys.exit(0 if results and all(results) else 1)
