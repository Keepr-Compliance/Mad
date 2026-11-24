#!/usr/bin/env python3
"""Offline check of the S1 two-session scripts (BACKLOG-4263). NO DATABASE: run.sh is copied to a temporary folder with
its transport line pointed at a local stub that records every SQL text it is handed and answers canned rows.

usage: python3 -I offline_check.py [<folder>]   (default: this folder; exit 0 only when every check holds)

Checks (each prints ok/BAD): bash -n under /bin/bash 3.2; transport only through $K; every argument shape that is not
exactly a lowercase uuid / 16 hex characters, and the nil or one-repeated-digit id, sends 0 calls in every mode; the
first call is the probe and the run refuses unless it proves one call = one transaction; hold marker within the first
900 bytes; mutant copies REVOKEd from all four roles and granted to none; lock_timeout on every writing call including
both sessions (3 s / 8 s); no LOCK TABLE; the switch is never written; every auth.users DELETE is keyed on the id; the
per-table counts are read right before the teardown and after it; the mutant is dropped even when its md5 proof
fails; SET NULL rows, a changed auth.users total or an undropped mutant give TEARDOWN NOT CLEAN; INT/TERM/HUP wait for
the sessions and 8 s before the trap's first call.
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
K_LINE = 'K="${SQL_TRANSPORT:-$HOME/.claude/bin/kt-sql}"'
RUN = '0123456789abcdef'
USER = str(uuid.uuid4())  # a fresh invented id per offline run; never the nil id (run.sh refuses that)
FAKE_ROW = 'fakerowvalue4263'
HOSTED = '53a385187695375e2e8695625a20a77a'
GUARD_HEAD = '-- guard.sql'
NOEXEC = os.path.join(tempfile.mkdtemp(), 'noexec')
open(NOEXEC, 'w').write('#!/bin/bash\n')  # planted in a stubbed error body; must never reach the output
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
def ans(obj):
    # the call's tagged answer in the configured transport shape
    if cfg.get('shape') == 'dry':
        p([{'line': 'SET'}, {'line': '{"sub" : "x", "role" : "authenticated"}'}, {'line': 'DO'},
           {'line': json.dumps(obj, separators=(', ', ' : '))}])
        print('kt-sql: HTTP 200', flush=True)
    else:
        p([{'a': obj}])
tags = re.findall(r"'tag', '(\w+)'", sql)
tag = tags[-1] if tags else None
if tag == 'probe':
    if 'probe_raw' in cfg:
        p(cfg['probe_raw'])
    else:
        r = {'tag': 'probe', 'txn': 'one', 'iso': 'read committed', 'track_size': '1kB', 'bypassrls': True, 'by_id': 0, 'by_pattern': 0,
             'pattern_emails': None, 'mutants': 0, 'mutant_names': None, 'marked_runs': 0, 'auth_users': 25, 'orphans': 0,
             'one_computer': True, 'fk': [{'tbl': 'cloud_deals', 'col': 'owner_user_id', 'del': 'c', 'n': cfg.get('fk_pre', 0)}]}
        r.update(cfg.get('pre', {})); ans(r)
elif tag == 'fkcount':
    done = any(re.search(r'/\*t:(teardown|delete)\*/', open(os.path.join(out, f)).read()) for f in os.listdir(out))
    ans({'tag': 'fkcount', 'fk': [{'tbl': 'cloud_deals', 'col': 'owner_user_id', 'del': 'c', 'n': cfg.get('fk', 0) if done else 0},
                                  {'tbl': 'app_lifecycle_events', 'col': 'user_id', 'del': 'n', 'n': 0 if done else cfg.get('setnull', 0)}]})
elif tag == 'authcount': ans({'tag': tag, 'n': cfg.get('auth_after', 25)})
elif tag == 'verify': ans({'tag': tag, 'verdict': 'clean'})
elif tag == 'residue': ans({'tag': tag, 'n': 0, 'auth_users': cfg.get('auth_after', 25)})
elif tag == 'setup': ans({'tag': tag, 'blob': Z, 'one_computer': True, 'x': Z, 'd1': Z})
elif tag == 'left': ans({'tag': tag, 'left': cfg.get('left', 0)})
elif tag == 'md5': ans({'tag': tag, 'm': None if cfg.get('md5_none') else '0' * 32})
elif 'P_B' in sql and cfg.get('b_error'):
    fail('ERROR:  23505: duplicate key value violates unique constraint "x_key"\nDETAIL:  Failing row contains (' + cfg['b_error'] + ').\nCONTEXT:  PL/pgSQL function inline_code_block line 7 at assignment\n')
elif tag == 'state': ans({'tag': tag, 'j': {}})
elif tag == 'own': ans({'tag': tag, 'n': 0, 'mine': 1, 'total': 26})
elif tag in ('session', 'attach_a', 'reset'): ans({'tag': tag, 'r': {}})
else: p([{'r': {}}])
"""
results = []


import importlib.util as _ilu
_cs = _ilu.spec_from_file_location('call_shape4263', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'backlog-4263-sync2-t', 'call_shape.py'))
call_shape = _ilu.module_from_spec(_cs); _cs.loader.exec_module(call_shape)
ALL_TEXTS = []   # every call text recorded in this offline run (for the call-class checks)


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
        for a, b in REPLACE.items():
            assert run.count(a) == 1
            run = run.replace(a, b)
        open(os.path.join(dst, 'run.sh'), 'w').write(run)
        outdir = os.path.join(d, 'sent')
        os.mkdir(outdir)
        env = dict(os.environ, STUB_OUT=outdir, STUB_CFG=json.dumps(cfg or {}), SQL_TRANSPORT=wrapper)
        env.pop('GUARD_MARKER_MD5', None)
        env.update((cfg or {}).get('env', {}))
        if (cfg or {}).get('fake_default'):
            dflt = os.path.join(env['HOME'], '.claude', 'bin', 'kt-sql')
            shutil.copy(wrapper, dflt)
            os.chmod(dflt, 0o700)
        for k in [k for k, v in env.items() if v is None]:
            env.pop(k)
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
        ALL_TEXTS.extend(texts)
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
    check('transport: one K= line (SQL_TRANSPORT, default kt-sql), every call through $K, no psql/curl',
          code.count(K_LINE) == 1 and code.count('.claude/bin/kt-sql') == 2 and not re.search(r'\b(psql|curl)\b', code)
          and not re.search(r'kt-sql\s+-c|\bkt-sql\s+"', code))
    for what, env in (('missing', {'SQL_TRANSPORT': '/nonexistent/transport'}), ('not executable', {'SQL_TRANSPORT': NOEXEC})):
        rc, out, texts, _ = drive(GOOD_ARGS, {'env': env})
        check(f'transport: {what} -> refused with {len(texts)} calls', rc != 0 and len(texts) == 0 and 'transport' in out)
    rc, out, texts, _ = drive(GOOD_ARGS, {'env': {'GUARD_MARKER_MD5': 'f' * 32}})
    g = [x for x in texts if 'refuses to run: TEST DATABASE ONLY (test database marker absent)' in x]
    check(f'guard: GUARD_MARKER_MD5 with a non-default transport -> substituted in all {len(g)} guarded texts, hosted literal gone',
          len(g) == len(texts) > 3 and all("md5(u.id::text) = '" + 'f' * 32 + "'" in x and HOSTED not in x for x in g))
    rc, out, texts, _ = drive(GOOD_ARGS)
    check('guard: every call starts with the guard (after the hold marker in session A), hosted marker by default',
          len(texts) > 3 and all(re.sub(r'^/\*p_hold:[0-9a-f]{16}\*/\n(-- (?!guard\.sql)[^\n]*\n)*', '', x).startswith(GUARD_HEAD) and HOSTED in x for x in texts))
    with tempfile.TemporaryDirectory() as home:
        os.makedirs(os.path.join(home, '.claude', 'bin'))
        rc, out, texts, _ = drive(GOOD_ARGS, {'env': {'SQL_TRANSPORT': None, 'GUARD_MARKER_MD5': 'f' * 32, 'HOME': home}, 'fake_default': True})
        check(f'guard: GUARD_MARKER_MD5 with the default transport -> refused with {len(texts)} calls', rc != 0 and len(texts) == 0
              and 'only for a non-default SQL_TRANSPORT' in out)


def tags_of(texts):
    return [re.search(r'/\*t:(\w+)\*/', t).group(1) if re.search(r'/\*t:(\w+)\*/', t) else '' for t in texts]


def probe_checks(args):
    rc, out, texts, _ = drive(args, {'probe_raw': [{'a': {'txn': 'one', 'iso': 'read committed'}}]})
    check(f'probe: answer without its tag -> {len(texts)} call(s), refused', rc != 0 and len(texts) == 1)
    rc, out, texts, _ = drive(args, {'shape': 'dry'})
    check('probe: every statement\'s lines returned (statement-by-statement transport) -> the run goes on', len(texts) > 3 and 'probe: ok' in out)
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
def statements(text):
    """Split a call into statements the way a client that submits statement by statement does: at ';' outside
    quotes, dollar quotes and comments; each statement's text starts after the previous ';' with leading whitespace
    removed, comments kept (observed on the dry-run database: '/*m*/ SELECT pg_sleep(3);' and, for a first statement,
    '/*m*/\n-- c\nDO $a$ ... $a$;')."""
    out, i, start, n = [], 0, 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith('--', i):
            j = text.find('\n', i); i = n if j < 0 else j + 1; continue
        if text.startswith('/*', i):
            j = text.find('*/', i + 2); i = n if j < 0 else j + 2; continue
        if c == "'":
            j = i + 1
            while j < n:
                if text[j] == "'" and text[j + 1:j + 2] == "'":
                    j += 2; continue
                if text[j] == "'":
                    break
                j += 1
            i = j + 1; continue
        m = re.match(r'\$(\w*)\$', text[i:])
        if m and (i == 0 or not re.match(r'\w', text[i - 1])):
            tag = m.group(0)
            j = text.find(tag, i + len(tag)); i = n if j < 0 else j + len(tag); continue
        if c == ';':
            out.append(text[start:i + 1].lstrip()); start = i + 1
        i += 1
    rest = text[start:].strip()
    if rest:
        out.append(rest)
    return out


def like(pattern_body, s):
    """pg LIKE '%<body>%' (no wildcards inside the body)."""
    return pattern_body in s


def activity_views(call, holding):
    """What pg_stat_activity.query shows while the holding statement runs: (whole call, first 1024 bytes) for a
    transport that submits the call as one text, (the holding statement) for one that submits statement by statement."""
    hosted = call.encode()[:1024].decode(errors='ignore')
    dry = [s for s in statements(call) if holding(s)]
    return hosted, dry


REPLACE = {}
GOOD_ARGS = ['R1', RUN, USER]
common_checks()
for mode in (['R1', RUN], ['R2', RUN], ['cleanup', RUN]):
    for what, bad in BAD_IDS:
        rc, out, texts, _ = drive(mode + [bad] + (['--mutant'] if mode[0] == 'R2' else []))
        check(f'args: {mode[0]} fixture id {what} -> {len(texts)} calls', rc != 0 and len(texts) == 0)
    for what, bad in BAD_RUNS:
        rc, out, texts, _ = drive([mode[0], bad, USER])
        check(f'args: {mode[0]} run id {what} -> {len(texts)} calls', rc != 0 and len(texts) == 0)
probe_checks(['R1', RUN, USER])

CASES = [(c, m) for c in ('R1', 'R2', 'R3', 'R4', 'R5', 'R6') for m in ('', '--mutant') if not (m and c in ('R1', 'R5'))]
WRITES = re.compile(r'/\*t:(setup|teardown|sessA|sessB)\*/|^CREATE FUNCTION|^DROP FUNCTION', re.M)
mark = f'p_hold:{RUN}*/'
for (case, mut), shape in [(c, s) for c in CASES for s in ('hosted', 'dry')]:
    rc, out, texts, _ = drive([case, RUN, USER] + ([mut] if mut else []), {'shape': shape})
    label = f'{case}{" " + mut if mut else ""} [{shape}]'
    run_id = RUN
    holders = [t for t in texts if mark in t]
    ends = [len(t.encode()[:t.encode().index(mark.encode()) + len(mark)]) for t in holders]
    check(f'marker {label}: one holder call, marker ends at byte {ends} <= {MARKER_MAX}, gate sent',
          len(holders) == 1 and all(e <= MARKER_MAX for e in ends) and any("'%p_hold:' ||" in t for t in texts))
    holding = lambda s: 'pg_sleep(4)' in s or 'cloud_blob_erase_scrub_m4263(run' in s
    if holders:
        hosted, dry = activity_views(holders[0], holding)
        check(f'gate {label}: the activity text shows the marker on both transports (whole call: first 1 kB; per statement: '
              f'{len(dry)} holding statement(s) start with it)', like(mark, hosted) and dry and all(s.startswith('/*' + mark) for s in dry))
    gates = [t for t in texts if "'%p_hold:' ||" in t]
    gw = [re.sub(r'\s+', ' ', w) for g in gates for w in re.findall(r'WHILE NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_stat_activity\s+WHERE(.*?)\)\s*LOOP', g, re.S)]
    check(f'gate {label}: the gate waits for ANOTHER backend that is SLEEPING with the marker (pid, PgSleep and marker in one WHERE)',
          len(gw) == 1 and 'pid <> pg_backend_pid()' in gw[0] and "wait_event = 'PgSleep'" in gw[0]
          and "query LIKE '%p_hold:' || '" + run_id + "' || '*/%'" in gw[0]
          and re.fullmatch(r"\s*pid <> pg_backend_pid\(\) AND wait_event = 'PgSleep' AND query LIKE '%p_hold:' \|\| '[0-9a-f]{16}' \|\| '\*/%'\s*", gw[0]) is not None)
    check(f'gate {label}: session 2 never matches its own gate (whole call and every statement)',
          len(gates) == 1 and not like(mark, gates[0]) and not any(like(mark, s) for s in statements(gates[0])))
    created = [m for t in texts for m in re.findall(r'CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(', t)]
    lock = copies_locked_down(texts)
    check(f'copies {label}: created {created or "none"}; revoked from all four roles, no GRANT {lock or ""}',
          all(n.endswith('_m4263') for n in created) and not lock
          and not any('CREATE OR REPLACE FUNCTION' in t for t in texts) and (bool(created) == bool(mut)))
    check(f'copies {label}: no session switches role', not any(re.search(r'\bSET\s+(LOCAL\s+)?ROLE\b', t, re.I) for t in texts))
    w = [t for t in texts if WRITES.search(t)]
    sa = [t for t in texts if '/*t:sessA*/' in t]
    sb = [t for t in texts if '/*t:sessB*/' in t]
    check(f'locks {label}: {len(w)} writing calls carry lock_timeout (3 s; session 2 8 s); no LOCK TABLE; last call resets stats',
          len(w) >= 4 and len(sa) == 1 and len(sb) == 1 and "SET LOCAL lock_timeout = '8s';" in sb[0]
          and all("SET LOCAL lock_timeout = '3s';" in t for t in w if t not in sb)
          and not any(re.search(r'\bLOCK\s+TABLE\b', t, re.I) for t in texts) and 'pg_stat_statements_reset' in texts[-1])
    check(f'absent {label}: first call is the probe', bool(texts) and '/*t:precheck*/' in texts[0])
    check(f'switch {label}: no call writes cloud_release_switches', not any(re.search(r'\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+public\.cloud_release_switches', t) for t in texts))
    dels = [t for t in texts if re.search(r'\bDELETE\b', t) and 'CREATE FUNCTION' not in t]
    au = [s for t in dels for s in re.findall(r'DELETE\s+FROM\s+auth\.users\b[^;]*;', t)]
    check(f'bykey {label}: no DELETE keyed on an email pattern; every auth.users DELETE is keyed on the id',
          dels and au and not any(re.search(r"DELETE[^;]*LIKE\s+'p4263", t) for t in dels) and all(USER in t for t in dels)
          and all(re.search(r'\bWHERE\s+id\s*=\s*(A|\'' + USER + r'\'(::uuid)?)(\s+AND\b|\s*;)', s) for s in au))
    tags = tags_of(texts)
    ok = 'teardown' in tags and tags[tags.index('teardown') - 1] == 'fkcount' and 'fkcount' in tags[tags.index('teardown'):]
    check(f'counts {label}: per-table counts right before and after the teardown', ok)

for case in ('R3', 'R4', 'R5', 'R6'):
    rc, out, texts, _ = drive([case, RUN, USER], {'pre': {'one_computer': False}})
    check(f'switch: {case} with the switch off -> {len(texts)} call(s) sent', rc != 0 and len(texts) == 1 and 'one_computer' in out)
rc, out, texts, _ = drive(['R1', RUN, USER], {'pre': {'one_computer': False}})
check('switch: R1 runs with the switch off', any('/*t:setup*/' in t for t in texts))
check('bykey: no pattern sweep file, no cleanup-all mode', not os.path.exists(os.path.join(FOLDER, 'sweep.sql'))
      and drive(['cleanup', 'all', USER])[0] != 0)
rc, out, texts, _ = drive(['cleanup', RUN, USER])
check('bykey: cleanup deletes only by the fixture user id', rc == 0 and any('/*t:teardown*/' in t for t in texts)
      and not any(re.search(r"DELETE[^;]*LIKE\s+'p4263", t) for t in texts))
rc, out, texts, _ = drive(['R2', RUN, USER, '--mutant'], {'md5_none': True})
tags = tags_of(texts)
check('made-flag: md5 proof fails -> the mutant is still dropped, setup never sent',
      rc != 0 and any(re.search(r'DROP FUNCTION IF EXISTS public\.\w+_m4263', t) for t in texts[2:]) and 'setup' not in tags)
rc, out, texts, _ = drive(['R1', RUN, USER], {'auth_after': 24})
check('notclean: auth.users total changed -> TEARDOWN NOT CLEAN with user and run id', rc != 0 and 'TEARDOWN NOT CLEAN' in out
      and USER in out and RUN in out)
rc, out, texts, _ = drive(['R2', RUN, USER, '--mutant'], {'left': 1})
check('notclean: mutant not dropped -> TEARDOWN NOT CLEAN, no teardown sent', rc != 0 and 'TEARDOWN NOT CLEAN' in out
      and not any('/*t:teardown*/' in t for t in texts) and USER in out and RUN in out)
rc, out, texts, _ = drive(['R1', RUN, USER], {'fk': 1})
check('notclean: rows left after the delete -> TEARDOWN NOT CLEAN', rc != 0 and 'TEARDOWN NOT CLEAN' in out)
rc, out, texts, _ = drive(['R1', RUN, USER], {'setnull': 2})
check('notclean: rows in an ON DELETE SET NULL column before the delete -> TEARDOWN NOT CLEAN', rc != 0 and 'TEARDOWN NOT CLEAN' in out
      and 'stays behind with the id cleared' in out)
for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    rc, out, texts, delay = drive(['R1', RUN, USER], {'hold_s': 2}, sig=sig)
    check(f'signal {sig.name}: trap waits for the sessions and 8 s, then tears down (first trap call {delay and round(delay, 1)} s after)',
          delay is not None and delay >= 7.5 and any('/*t:teardown*/' in t for t in texts) and 'interrupted: waiting 8 s' in out)
for _n, _ok, _d in call_shape.concurrency_checks(FOLDER, open(os.path.join(FOLDER, 'README.md'), encoding='utf-8').read(), ALL_TEXTS):
    check(_n, _ok, _d)
print(f'{len(results)} checks, {results.count(False)} failed')
sys.exit(0 if results and all(results) else 1)
