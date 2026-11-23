#!/usr/bin/env python3
"""Offline check of the erase two-session script (BACKLOG-4263). NO DATABASE: run.sh is copied to a temporary folder
with its transport line pointed at a local stub that records every SQL text it is handed and answers canned rows.

usage: python3 -I offline_check.py [<folder>]   (default: this folder; exit 0 only when every check holds)

Checks (each prints ok/BAD): bash -n under /bin/bash 3.2; transport only through $K; every argument shape that is not
exactly a lowercase uuid / 16 hex characters, and the nil or one-repeated-digit id, sends 0 calls in every mode; the
first call is the probe and the run refuses unless it proves one call = one transaction; hold marker within the first
900 bytes; the live claim / scrub are never created or replaced, every copy is REVOKEd from all four roles in the same
call and granted to none, never created inside a session; lock_timeout on every writing call and both sessions
(3 s / 8 s); every DO that writes cloud_release_switches has no EXCEPTION clause and no RETURN and ends in RAISE; every
auth.users DELETE is keyed on the id; counts right before the delete and after it; the copy is dropped even when its
md5 proof fails; a session error's row values never reach the output; SET NULL rows, a changed auth.users total or an
undropped copy give TEARDOWN NOT CLEAN; INT/TERM/HUP wait for the sessions and 8 s before the trap's first call.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
FOLDER = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else HERE
MARKER_MAX = 900
K_LINE = 'K=~/.claude/bin/kt-sql'
RUN = '0123456789abcdef'
USER = str(uuid.uuid4())  # a fresh invented id per offline run; never the nil id (run.sh refuses that)
FAKE_ROW = 'fakerowvalue4263'  # planted in a stubbed error body; must never reach the output
STUB = r"""import json, os, re, sys, time
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
def p(x): print(json.dumps(x), flush=True)
def fail(msg):
    p({'message': 'Failed to run sql query: ' + msg}); sys.stderr.write('kt-sql: HTTP 400\n'); sys.exit(1)
if 'p_hold:' in sql and cfg.get('hold_s'):
    time.sleep(cfg['hold_s'])
if sql.startswith('/*p_hold:') and 'answer_a' in cfg:
    sys.stdout.write(cfg['answer_a'] + '\n'); sys.exit(0)
if 'P_B' in sql and 'answer_b' in cfg:
    sys.stdout.write(cfg['answer_b'] + '\n'); sys.stdout.flush(); sys.stderr.write('kt-sql: HTTP 400\n'); sys.exit(1)
if '/*t:precheck*/' in sql:
    if 'probe_rows' in cfg:
        p(cfg['probe_rows'])
    else:
        r = {'txn': 'one', 'iso': 'read committed', 'track_size': '1kB', 'bypassrls': True, 'by_id': 0, 'by_pattern': 0,
             'pattern_emails': None, 'mutants': 0, 'mutant_names': None, 'marked_runs': 0, 'auth_users': 25, 'orphans': 0,
             'one_computer': True, 'fk': [{'tbl': 'cloud_deals', 'col': 'owner_user_id', 'del': 'c', 'n': cfg.get('fk_pre', 0)}]}
        r.update(cfg.get('pre', {})); p([r])
elif '/*t:fkcount*/' in sql:
    done = any(re.search(r'/\*t:(teardown|delete)\*/', open(os.path.join(out, f)).read()) for f in os.listdir(out))
    p([{'tbl': 'cloud_deals', 'col': 'owner_user_id', 'del': 'c', 'n': cfg.get('fk', 0) if done else 0},
       {'tbl': 'app_lifecycle_events', 'col': 'user_id', 'del': 'n', 'n': 0 if done else cfg.get('setnull', 0)}])
elif '/*t:authcount*/' in sql: p([{'n': cfg.get('auth_after', 25)}])
elif '/*t:verify*/' in sql: p([{'verdict': 'clean'}])
elif '/*t:residue*/' in sql: p([{'n': 0, 'auth_users': cfg.get('auth_after', 25)}])
elif '/*t:setup*/' in sql: p([{'blob': Z, 'one_computer': True, 'x': Z, 'd1': Z}])
elif re.search(r'\bAS left\b', sql): p([{'left': cfg.get('left', 0)}])
elif re.search(r'\bAS m\b', sql): p([{'m': None if cfg.get('md5_none') else '0' * 32}])
elif 'P_B' in sql and cfg.get('b_error'):
    fail('ERROR:  23505: duplicate key value violates unique constraint "x_key"\nDETAIL:  Failing row contains (' + cfg['b_error'] + ').\nCONTEXT:  PL/pgSQL function inline_code_block line 7 at assignment\n')
elif 'AS j' in sql: p([{'j': {}}])
elif 'AS mine' in sql: p([{'n': 0, 'mine': 1, 'total': 26}])
else: p([{'r': {}}])
"""
results = []


def check(name, ok, detail=''):
    results.append(bool(ok))
    print(('ok   ' if ok else 'BAD  ') + name + (': ' + detail if detail else ''))


def drive(args, cfg=None, sig=None):
    """Run a stubbed copy of run.sh; returns (rc, output, [texts in order], seconds from the signal to the trap's first
    call or None). sig: send that signal to run.sh once session 1's call has been sent."""
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
        run = run.replace(K_LINE + '\n', f'K={wrapper}\n')
        for a, b in REPLACE.items():
            assert run.count(a) == 1
            run = run.replace(a, b)
        open(os.path.join(dst, 'run.sh'), 'w').write(run)
        outdir = os.path.join(d, 'sent')
        os.mkdir(outdir)
        env = dict(os.environ, STUB_OUT=outdir, STUB_CFG=json.dumps(cfg or {}))
        pr = subprocess.Popen(['/bin/bash', os.path.join(dst, 'run.sh')] + args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, env=env)
        delay = None
        if sig:
            t_end = time.time() + 60
            while time.time() < t_end and not any('p_hold:' in open(os.path.join(outdir, f)).read() for f in os.listdir(outdir)):
                time.sleep(0.05)
            time.sleep(0.3)
            n_before = len(os.listdir(outdir))
            t_sig = time.time()
            pr.send_signal(sig)
        out, _ = pr.communicate(timeout=180)
        names = sorted(os.listdir(outdir))
        texts = [open(os.path.join(outdir, f)).read() for f in names]
        if sig:
            later = [os.path.getmtime(os.path.join(outdir, f)) for f in names[n_before:] if 'p_hold:' not in open(os.path.join(outdir, f)).read()]
            delay = (min(later) - t_sig) if later else None
        return pr.returncode, out, texts, delay


def do_blocks(text):
    """[(body)] of every DO $tag$ ... $tag$ in a text."""
    return [m.group(2) for m in re.finditer(r'\bDO\s+\$(\w*)\$(.*?)\$\1\$', text, re.S)]


def raising_do_ok(body):
    """A DO that writes a shared row must end in RAISE EXCEPTION and have no EXCEPTION clause and no RETURN."""
    code = re.sub(r'--[^\n]*', '', body)
    code = re.sub(r"'(?:[^']|'')*'", "''", code)
    last = [s.strip() for s in code.split(';') if s.strip()]
    return (not re.search(r'\bEXCEPTION\s+WHEN\b', code, re.I) and not re.search(r'\bRETURN\b', code, re.I)
            and len(last) >= 2 and re.match(r'END\b', last[-1], re.I) is not None and re.match(r'RAISE\s+EXCEPTION\b', last[-2], re.I) is not None)


def copies_locked_down(texts):
    """Every CREATE FUNCTION public.X_m4263 call also REVOKEs X_m4263 from all four roles and GRANTs nothing."""
    bad = []
    for t in texts:
        for name in re.findall(r'CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(', t):
            if not re.search(r'REVOKE ALL ON FUNCTION public\.' + name + r'\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;', t):
                bad.append(name + ' not revoked from all four roles')
        if re.search(r'^\s*GRANT\b', t, re.M | re.I):
            bad.append('a GRANT is sent')
    return bad


BAD_IDS = [('missing', ''), ('uppercase', USER.upper()), ('35 chars', USER[:-1]), ('37 chars', USER + 'a'),
           ('trailing space', USER + ' '), ("';", USER + "';"), ('quote inside', USER[:8] + "'" + USER[9:]),
           ('embedded newline', USER + "\n' OR true; DELETE FROM auth.users; --"), ('nil', '0' * 8 + '-0000-0000-0000-' + '0' * 12),
           ('one repeated digit', '1' * 8 + '-1111-1111-1111-' + '1' * 12)]
BAD_RUNS = [('missing', ''), ('uppercase', RUN.upper()), ('15 chars', RUN[:-1]), ('trailing space', RUN + ' '),
            ("';", RUN[:14] + "';"), ('embedded newline', RUN + "\n'; --")]


def common_checks():
    ver = subprocess.run(['/bin/bash', '--version'], capture_output=True, text=True).stdout.splitlines()[0]
    for f in sorted(x for x in os.listdir(FOLDER) if x.endswith('.sh')):
        r = subprocess.run(['/bin/bash', '-n', os.path.join(FOLDER, f)], capture_output=True, text=True)
        check(f'bash -n {f} ({ver})', r.returncode == 0, r.stderr.strip()[:200])
    src = open(os.path.join(FOLDER, 'run.sh')).read()
    code = '\n'.join(l for l in src.splitlines() if not l.lstrip().startswith('#'))
    check('transport: one K= line, kt-sql only through $K, no psql/curl',
          code.count(K_LINE) == 1 and code.count('kt-sql') == 1 and not re.search(r'\b(psql|curl)\b', code))


def tags_of(texts):
    return [re.search(r'/\*t:(\w+)\*/', t).group(1) if re.search(r'/\*t:(\w+)\*/', t) else '' for t in texts]


def probe_checks(args):
    rc, out, texts, _ = drive(args, {'probe_rows': [{'probe_set': 'one'}, {'txn': 'one', 'iso': 'read committed'}]})
    check(f'probe: two rows returned (not last-statement-only) -> {len(texts)} call(s), refused', rc != 0 and len(texts) == 1 and 'not proven' in out)
    rc, out, texts, _ = drive(args, {'pre': {'txn': None}})
    check(f'probe: local setting lost (not one transaction) -> {len(texts)} call(s), refused', rc != 0 and len(texts) == 1 and 'NOT proven' in out)
    rc, out, texts, _ = drive(args, {'pre': {'iso': 'repeatable read'}})
    check(f'probe: isolation not read committed -> {len(texts)} call(s), refused', rc != 0 and len(texts) == 1)
    rc, out, texts, _ = drive(args, {'pre': {'fk': None}})
    check(f'probe: per-table counts unreadable -> {len(texts)} call(s), refused', rc != 0 and len(texts) == 1)
    rc, out, texts, _ = drive(args, {'fk_pre': 1})
    check(f'probe: a row already references the id -> {len(texts)} call(s), refused', rc != 0 and len(texts) == 1 and 'nothing was created' in out)
    rc, out, texts, _ = drive(args, {'pre': {'by_pattern': 1, 'pattern_emails': 'p4263-left@example.test', 'mutants': 1, 'mutant_names': 'x_m4263'}})
    check('probe: leftovers are named, not only counted', rc != 0 and 'p4263-left@example.test' in out and 'x_m4263' in out)
    rc, out, texts, _ = drive(args)
    check('probe: one transaction proven -> the run goes on and prints the probe line', len(texts) > 3
          and 'probe: ok' in out and 'txn=one' in out and 'track_activity_query_size=' in out and 'bypassrls=' in out)

ROOT = subprocess.run(['git', '-C', HERE, 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip()
REPLACE = {'root="$(git -C "$here" rev-parse --show-toplevel)"\n': f'root={ROOT}\n'}
common_checks()
for mode in (['attach'], ['attach', 'single_statement_fence'], ['cleanup']):
    for what, bad in BAD_IDS:
        rc, out, texts, _ = drive([mode[0], bad] + (mode[1:] or (['0123456789abcdef'] if mode[0] == 'cleanup' else [])))
        check(f'args: {" ".join(mode)} fixture id {what} -> {len(texts)} calls', rc != 0 and len(texts) == 0)
for what, bad in BAD_RUNS:
    rc, out, texts, _ = drive(['cleanup', USER, bad])
    check(f'args: cleanup run id {what} -> {len(texts)} calls', rc != 0 and len(texts) == 0)
probe_checks(['attach', USER])

CASES = [('attach', ''), ('attach', 'single_statement_fence'), ('c6g_skip', ''), ('c6g_skip', 'no_skip_locked'),
         ('c6g_wait', ''), ('c6g_wait', 'read_before_lock')]
LIVE = re.compile(r'FUNCTION public\.cloud_blob_erase_(claim|scrub)\(')
WRITES = re.compile(r'/\*t:(setup|copy|drop|delete)\*/')
for case, mut in CASES:
    rc, out, texts, _ = drive([case, USER] + ([mut] if mut else []))
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
    lock = copies_locked_down(texts)
    check(f'copies {label}: created {created or "none"}; revoked from all four roles, no GRANT {lock or ""}',
          not any(LIVE.search(t) for t in texts) and not any('CREATE OR REPLACE FUNCTION' in t for t in texts)
          and all(n.endswith('_m4263') for n in created) and not in_session and bool(created) == want and not lock)
    w = [t for t in texts if WRITES.search(t)]
    sess = [t for t in texts if 'P_A' in t or 'P_B' in t or mark in t]
    a_s = [t for t in sess if mark in t]
    b_s = [t for t in sess if mark not in t]
    check(f'locks {label}: {len(w)} writing calls carry lock_timeout 3 s; session A 3 s, session B 8 s; no LOCK TABLE; last call resets stats',
          len(w) >= 2 and all("SET LOCAL lock_timeout = '3s';" in t for t in w) and len(a_s) == 1 and len(b_s) == 1
          and re.search(r"lock_timeout(', | = )'3s'", a_s[0]) and "set_config('lock_timeout', '8s', true)" in b_s[0]
          and not any(re.search(r'\bLOCK\s+TABLE\b', t, re.I) for t in texts) and 'pg_stat_statements_reset' in texts[-1])
    sw = [blk for t in texts for blk in do_blocks(t) if re.search(r'\bcloud_release_switches\b', blk)
          and re.search(r'\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+public\.cloud_release_switches', blk)]
    top = [t for t in texts if re.search(r'\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+public\.cloud_release_switches', re.sub(r'\bDO\s+\$(\w*)\$.*?\$\1\$', '', t, flags=re.S))]
    check(f'switch {label}: {len(sw)} DO block(s) write the switch; each has no EXCEPTION clause, no RETURN, ends in RAISE; none outside a DO',
          not top and all(raising_do_ok(blk) for blk in sw) and (len(sw) == 1) == (case != 'attach'))
    check(f'absent {label}: first call is the probe', bool(texts) and '/*t:precheck*/' in texts[0])
    au = [s for t in texts if 'CREATE FUNCTION' not in t for s in re.findall(r'DELETE\s+FROM\s+auth\.users\b[^;]*;', t)]
    check(f'bykey {label}: every auth.users DELETE names the user id (and this run\'s exact email)',
          len(au) == 1 and all(re.search(r"\bWHERE\s+id\s*=\s*'" + USER + r"'(::uuid)?(\s+AND\b|\s*;)", s) for s in au)
          and f"email = 'p4263c-{run_id}@example.test'" in au[0] and 'LIKE' not in au[0])
    tags = tags_of(texts)
    ok = 'delete' in tags and tags[tags.index('delete') - 1] == 'fkcount' and 'fkcount' in tags[tags.index('delete'):]
    check(f'counts {label}: per-table counts right before and after the delete', ok)

for what, cfg in (('marked run row', {'marked_runs': 1}), ('900 orphans (attach)', {'orphans': 900})):
    rc, out, texts, _ = drive(['attach', USER, 'single_statement_fence'], {'pre': cfg})
    check(f'absent: probe reports {what} -> {len(texts)} call(s) sent, refused', rc != 0 and len(texts) == 1 and 'nothing was created' in out)
for case, mut in (('attach', 'single_statement_fence'), ('c6g_wait', '')):
    rc, out, texts, _ = drive([case, USER] + ([mut] if mut else []), {'md5_none': True})
    tags = tags_of(texts)
    check(f'made-flag {case} {mut or "pristine"}: md5 proof fails -> the copy is still dropped, setup never sent',
          rc != 0 and 'drop' in tags[tags.index('copy'):] and 'setup' not in tags)
rc, out, texts, _ = drive(['attach', USER], {'b_error': FAKE_ROW})
check('rowvalues: a session B error carrying a row value prints only its SQLSTATE', 'SQLSTATE 23505' in out and FAKE_ROW not in out)
A_ROW = json.dumps([{'txn': 'one', 't_start': '2026-11-23 10:00:00.1+00', 't_hold': '2026-11-23 10:00:00.14+00', 't_end': '2026-11-23 10:00:04.15+00'}])
B_RAISE = json.dumps({'message': 'Failed to run sql query: ERROR:  P0001: P_B ' + json.dumps(
    {'t_start': '2026-11-23T10:00:01.23+00:00', 't_end': '2026-11-23T10:00:04.17+00:00', 'fenced': False})
    + '\nCONTEXT:  PL/pgSQL function inline_code_block line 6 at RAISE\n'})
rc, out, texts, _ = drive(['attach', USER], {'answer_a': A_ROW, 'answer_b': B_RAISE})
check('attach pristine PASS line says it counts only with its mutant CAUGHT',
      'attach pristine: PASS (evidence only together with attach single_statement_fence: CAUGHT in the same window)' in out)
rc, out, texts, _ = drive(['c6g_wait', USER], {'auth_after': 24})
m = re.search(r'RUN ([0-9a-f]{16})', out)
check('notclean: auth.users total changed -> TEARDOWN NOT CLEAN with user and run id', rc != 0 and 'TEARDOWN NOT CLEAN' in out
      and USER in out and bool(m) and m.group(1) in out.split('TEARDOWN NOT CLEAN', 1)[1])
rc, out, texts, _ = drive(['c6g_wait', USER, 'read_before_lock'], {'left': 1})
check('notclean: copy not dropped -> TEARDOWN NOT CLEAN, no delete sent', rc != 0 and 'TEARDOWN NOT CLEAN' in out
      and not any('/*t:delete*/' in t for t in texts) and USER in out)
rc, out, texts, _ = drive(['attach', USER], {'fk': 1})
check('notclean: rows left after the delete -> TEARDOWN NOT CLEAN', rc != 0 and 'TEARDOWN NOT CLEAN' in out)
rc, out, texts, _ = drive(['attach', USER], {'setnull': 2})
check('notclean: rows in an ON DELETE SET NULL column before the delete -> TEARDOWN NOT CLEAN', rc != 0 and 'TEARDOWN NOT CLEAN' in out
      and 'stays behind with the id cleared' in out)
rc, out, texts, _ = drive(['cleanup', USER, '0123456789abcdef'])
check('bykey: cleanup deletes only by id and that run\'s exact email', rc == 0 and any(
      "email = 'p4263c-0123456789abcdef@example.test'" in t and 'DELETE' in t for t in texts))
for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    rc, out, texts, delay = drive(['c6g_skip', USER], {'hold_s': 2}, sig=sig)
    check(f'signal {sig.name}: trap waits for the sessions and 8 s, then deletes (first trap call {delay and round(delay, 1)} s after)',
          delay is not None and delay >= 7.5 and any('/*t:delete*/' in t for t in texts) and 'interrupted: waiting 8 s' in out)
print(f'{len(results)} checks, {results.count(False)} failed')
sys.exit(0 if results and all(results) else 1)
