#!/usr/bin/env python3
"""Offline check of the S1 two-session scripts (BACKLOG-4263). NO DATABASE: run.sh is copied to a temporary folder with
its transport line pointed at a local stub that records every SQL text it is handed and answers canned rows.

usage: python3 -I offline_check.py [<folder>]   (default: this folder; exit 0 only when every check holds)

Checks (each prints ok/BAD):
  bash      every *.sh parses under /bin/bash (macOS ships 3.2) -- bash -n
  transport run.sh reaches the database only through K=~/.claude/bin/kt-sql
  marker    every case: exactly one call carries this run's hold marker, it ends at or before byte MARKER_MAX of that
            call's text (pg_stat_activity.query keeps only the first 1 kB on the test project), and the gate is sent
  copies    no call creates or replaces a live function: every CREATE FUNCTION is a public.*_m4263 name
  locks     every call that writes (setup, mutant create/drop, teardown) sets lock_timeout 3 s; no LOCK TABLE; the
            last call is pg_stat_statements_reset()
  absent    the first call is the read-only precheck; when it reports a fixture user, a fixture address or a *_m4263
            function, nothing else is sent
  switch    R3-R6 with the switch off: nothing but the precheck is sent
  bykey     no DELETE is keyed on an email pattern; the teardown names the fixture user id
  counts    the per-table counts are read before the teardown and again after it
  notclean  auth.users total changed, or the mutant was not dropped: TEARDOWN NOT CLEAN names the user id and the run
            id, and (mutant not dropped) no teardown is sent
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
STUB = r'''import json, os, re, sys
out = os.environ['STUB_OUT']
sql = sys.argv[2] if sys.argv[1] == '-c' else open(sys.argv[1]).read()
n = len(os.listdir(out)) + 1
while True:  # the two sessions run at once: claim a sequence number atomically, never overwrite
    try:
        fd = os.open(os.path.join(out, '%03d.sql' % n), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        break
    except FileExistsError:
        n += 1
with os.fdopen(fd, 'w') as fh:
    fh.write(sql)
cfg = json.loads(os.environ.get('STUB_CFG', '{}'))
Z = '00000000-0000-0000-0000-000000000000'
def p(x): print(json.dumps(x))
if '/*t:precheck*/' in sql:
    r = {'by_id': 0, 'by_pattern': 0, 'mutants': 0, 'marked_runs': 0, 'auth_users': 25, 'orphans': 0, 'one_computer': True}
    r.update(cfg.get('pre', {})); p([r])
elif '/*t:fkcount*/' in sql:
    done = any(re.search(r'/\*t:(teardown|delete)\*/', open(os.path.join(out, f)).read()) for f in os.listdir(out))
    p([{'tbl': 'cloud_deals', 'col': 'owner_user_id', 'n': cfg.get('fk', 0) if done else cfg.get('fk_pre', 0)}])
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
        assert run.count(K_LINE + '\n') == 1
        open(os.path.join(dst, 'run.sh'), 'w').write(run.replace(K_LINE + '\n', f'K={wrapper}\n'))
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

CASES = [(c, m) for c in ('R1', 'R2', 'R3', 'R4', 'R5', 'R6') for m in ('', '--mutant') if not (m and c in ('R1', 'R5'))]
WRITES = re.compile(r'/\*t:(setup|teardown)\*/|^CREATE FUNCTION|^DROP FUNCTION', re.M)
mark = f'p_hold:{RUN}*/'
for case, mut in CASES:
    rc, out, texts = drive([case, RUN, USER] + ([mut] if mut else []))
    label = f'{case}{" " + mut if mut else ""}'
    holders = [t for t in texts if mark in t]
    ends = [len(t.encode()[:t.encode().index(mark.encode()) + len(mark)]) for t in holders]
    check(f'marker {label}: one holder call, marker ends at byte {ends} <= {MARKER_MAX}, gate sent',
          len(holders) == 1 and all(e <= MARKER_MAX for e in ends) and any("'%p_hold:' ||" in t for t in texts))
    created = [m for t in texts for m in re.findall(r'CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(', t)]
    check(f'copies {label}: created {created or "none"}', all(n.endswith('_m4263') for n in created)
          and not any('CREATE OR REPLACE FUNCTION' in t for t in texts) and (bool(created) == bool(mut)))
    w = [t for t in texts if WRITES.search(t)]
    check(f'locks {label}: {len(w)} writing calls carry lock_timeout 3 s; no LOCK TABLE; last call resets stats',
          len(w) >= 2 and all("SET LOCAL lock_timeout = '3s';" in t for t in w)
          and not any(re.search(r'\bLOCK\s+TABLE\b', t, re.I) for t in texts) and 'pg_stat_statements_reset' in texts[-1])
    check(f'absent {label}: first call is the precheck', bool(texts) and '/*t:precheck*/' in texts[0])
    check(f'switch {label}: no call writes cloud_release_switches', not any(re.search(r'\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+public\.cloud_release_switches', t) for t in texts))
    dels = [t for t in texts if re.search(r'\bDELETE\b', t) and 'CREATE FUNCTION' not in t]
    check(f'bykey {label}: no DELETE keyed on an email pattern; teardown names the user id',
          dels and not any(re.search(r"DELETE[^;]*LIKE\s+'p4263", t) for t in dels) and all(USER in t for t in dels))
    tags = [re.search(r'/\*t:(\w+)\*/', t).group(1) if re.search(r'/\*t:(\w+)\*/', t) else '' for t in texts]
    ok = 'teardown' in tags and tags[tags.index('teardown') - 1] == 'fkcount' and 'fkcount' in tags[tags.index('teardown'):]
    check(f'counts {label}: per-table counts before and after the teardown', ok)

for what, cfg in (('fixture id', {'by_id': 1}), ('fixture address', {'by_pattern': 1}), ('mutant left', {'mutants': 1})):
    rc, out, texts = drive(['R2', RUN, USER, '--mutant'], {'pre': cfg})
    check(f'absent: precheck reports {what} -> {len(texts)} call(s) sent, refused', rc != 0 and len(texts) == 1
          and 'nothing was created' in out)
rc, out, texts = drive(['R1', RUN, USER], {'fk_pre': 1})
check(f'absent: per-table count query not 0 before setup -> {len(texts)} call(s) sent, refused', rc != 0 and len(texts) == 2
      and 'nothing was created' in out)
for case in ('R3', 'R4', 'R5', 'R6'):
    rc, out, texts = drive([case, RUN, USER], {'pre': {'one_computer': False}})
    check(f'switch: {case} with the switch off -> {len(texts)} call(s) sent', rc != 0 and len(texts) == 1 and 'one_computer' in out)
rc, out, texts = drive(['R1', RUN, USER], {'pre': {'one_computer': False}})
check('switch: R1 runs with the switch off', any('/*t:setup*/' in t for t in texts))
check('bykey: no pattern sweep file, no cleanup-all mode', not os.path.exists(os.path.join(FOLDER, 'sweep.sql'))
      and drive(['cleanup', 'all', USER])[0] != 0)
rc, out, texts = drive(['cleanup', RUN, USER])
check('bykey: cleanup deletes only by the fixture user id', rc == 0 and any('/*t:teardown*/' in t for t in texts)
      and not any(re.search(r"DELETE[^;]*LIKE\s+'p4263", t) for t in texts))
rc, out, texts = drive(['R1', RUN, USER], {'auth_after': 24})
check('notclean: auth.users total changed -> TEARDOWN NOT CLEAN with user and run id', rc != 0 and 'TEARDOWN NOT CLEAN' in out
      and USER in out and RUN in out)
rc, out, texts = drive(['R2', RUN, USER, '--mutant'], {'left': 1})
check('notclean: mutant not dropped -> TEARDOWN NOT CLEAN, no teardown sent', rc != 0 and 'TEARDOWN NOT CLEAN' in out
      and not any('/*t:teardown*/' in t for t in texts) and USER in out and RUN in out)
rc, out, texts = drive(['R1', RUN, USER], {'fk': 1})
check('notclean: rows left after the delete -> TEARDOWN NOT CLEAN', rc != 0 and 'TEARDOWN NOT CLEAN' in out)
print(f'{len(results)} checks, {results.count(False)} failed')
sys.exit(0 if results and all(results) else 1)
