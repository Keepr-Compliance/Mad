#!/usr/bin/env python3
"""Offline self-test of verdict.py (erase two-session controls, BACKLOG-4263). No database.
usage: python3 -I selftest.py   (exit 0 when every canned output gives its expected verdict)

Shapes transcribed from kt-sql answers of the test project, not invented:
- an expected RAISE: {"message":"Failed to run sql query: ERROR:  P0001: <text>\nCONTEXT:  PL/pgSQL function
  inline_code_block line N at RAISE\n"} then the line 'kt-sql: HTTP 400' (scratchpad/4263/notice/run1.txt);
- jsonb timestamps inside a RAISE: "2026-11-19T00:22:25.109459+00:00" (same file);
- a success: a JSON array of rows, timestamptz as '2026-11-23 17:27:21.021326+00' (window-flip/step2-state.txt).
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def raised(name, obj, line=9):
    msg = f'ERROR:  P0001: {name} {json.dumps(obj)}\nCONTEXT:  PL/pgSQL function inline_code_block line {line} at RAISE\n'
    return json.dumps({'message': 'Failed to run sql query: ' + msg}) + '\nkt-sql: HTTP 400\n'


def err(text):
    return json.dumps({'message': 'Failed to run sql query: ' + text}) + '\nkt-sql: HTTP 400\n'


def rows(r):
    return json.dumps(r)


A0 = '2026-11-23T10:00:00.100000+00:00'   # A start
AH = '2026-11-23T10:00:00.140000+00:00'   # A holds from here
AE = '2026-11-23T10:00:04.150000+00:00'   # A hold ends (locks released right after)
B0 = '2026-11-23T10:00:01.230000+00:00'   # B start after the gate: 2.92 s of A's hold left
BW = '2026-11-23T10:00:04.170000+00:00'   # B end after A's hold: waited
BN = '2026-11-23T10:00:01.260000+00:00'   # B end during A's hold: did not wait
B0_LATE = '2026-11-23T10:00:03.200000+00:00'  # only 0.95 s of A's hold left: no measured overlap

ATTACH_A = rows([{'txn': 'one', 't_start': '2026-11-23 10:00:00.1+00', 't_hold': '2026-11-23 10:00:00.14+00', 't_end': '2026-11-23 10:00:04.15+00'}])
ATTACH_A_SPLIT = rows([{'txn': '', 't_start': '', 't_hold': '', 't_end': '2026-11-23 10:00:04.15+00'}])  # not one transaction
SKIP_A = raised('P_A', {'t_start': A0, 't_hold': AH, 't_end': AE}, 7)
WAIT_A = raised('P_A', {'t_start': AH, 't_end': AE, 'answer': {'state': 'scrubbed'}}, 8)
GATE_TIMEOUT = err('ERROR:  P0001: P_GATE_TIMEOUT\nCONTEXT:  PL/pgSQL function inline_code_block line 6 at RAISE\n')
LOCK_TIMEOUT = err('ERROR:  55P03: canceling statement due to lock timeout\nCONTEXT:  PL/pgSQL function inline_code_block line 4 at SQL statement\n')
NO_FN = err('ERROR:  42883: function public.cloud_blob_erase_scrub_m4263(uuid, uuid, boolean, integer) does not exist\n')


def b(**kw):
    o = {'t_start': B0, 't_end': BW}
    o.update(kw)
    return raised('P_B', o, 6)


CASES = [  # (label, case, mutant, a.out, b.out, expected first word)
    ('attach pass', 'attach', '', ATTACH_A, b(fenced=False), 'PASS'),
    ('attach no wait', 'attach', '', ATTACH_A, b(fenced=False, t_end=BN), 'FAIL'),
    ('attach fenced', 'attach', '', ATTACH_A, b(fenced=True), 'FAIL'),
    ('attach mutant caught', 'attach', 'single_statement_fence', ATTACH_A, b(fenced=True), 'CAUGHT'),
    ('attach mutant not caught', 'attach', 'single_statement_fence', ATTACH_A, b(fenced=False), 'NOT_CAUGHT'),
    ('attach session A error', 'attach', '', LOCK_TIMEOUT, b(fenced=False), 'INCONCLUSIVE'),
    ('attach session A not one transaction', 'attach', '', ATTACH_A_SPLIT, b(fenced=False), 'INCONCLUSIVE'),
    ('attach A times present but txn marker missing (constructed)', 'attach', '', rows([{'txn': None, 't_start': '2026-11-23 10:00:00.1+00',
     't_hold': '2026-11-23 10:00:00.14+00', 't_end': '2026-11-23 10:00:04.15+00'}]), b(fenced=False), 'INCONCLUSIVE'),
    ('attach B started before A held', 'attach', '', ATTACH_A, b(fenced=False, t_start='2026-11-23T10:00:00.120000+00:00'), 'INCONCLUSIVE'),
    ('attach session B error (lock timeout)', 'attach', '', ATTACH_A, LOCK_TIMEOUT, 'INCONCLUSIVE'),
    ('attach gate timeout', 'attach', 'single_statement_fence', ATTACH_A, GATE_TIMEOUT, 'INCONCLUSIVE'),
    ('attach both ok, no overlap', 'attach', '', ATTACH_A, b(fenced=False, t_start=B0_LATE), 'INCONCLUSIVE'),
    ('attach fenced missing', 'attach', '', ATTACH_A, b(), 'INCONCLUSIVE'),
    ('c6g_skip pass', 'c6g_skip', '', SKIP_A, b(t_end=BN, answer={'state': 'skipped'}), 'PASS'),
    ('c6g_skip waited', 'c6g_skip', '', SKIP_A, b(answer={'state': 'scrubbed'}), 'FAIL'),
    ('c6g_skip mutant caught', 'c6g_skip', 'no_skip_locked', SKIP_A, b(answer={'state': 'scrubbed'}), 'CAUGHT'),
    ('c6g_skip mutant not caught', 'c6g_skip', 'no_skip_locked', SKIP_A, b(t_end=BN, answer={'state': 'skipped'}), 'NOT_CAUGHT'),
    ('c6g_skip mutant, no overlap', 'c6g_skip', 'no_skip_locked', SKIP_A,
     b(t_start=B0_LATE, answer={'state': 'scrubbed'}), 'INCONCLUSIVE'),
    ('c6g_skip session A error', 'c6g_skip', '', LOCK_TIMEOUT, b(t_end=BN, answer={'state': 'skipped'}), 'INCONCLUSIVE'),
    ('c6g_skip session A answered no marker', 'c6g_skip', '', rows([{'r': 'x'}]), b(t_end=BN, answer={'state': 'skipped'}), 'INCONCLUSIVE'),
    ('c6g_skip answer missing', 'c6g_skip', '', SKIP_A, b(t_end=BN), 'INCONCLUSIVE'),
    ('c6g_wait pass', 'c6g_wait', '', WAIT_A, b(), 'PASS'),
    ('c6g_wait no wait', 'c6g_wait', '', WAIT_A, b(t_end=BN), 'FAIL'),
    ('c6g_wait mutant caught', 'c6g_wait', 'read_before_lock', WAIT_A, b(t_end=BN), 'CAUGHT'),
    ('c6g_wait mutant not caught', 'c6g_wait', 'read_before_lock', WAIT_A, b(), 'NOT_CAUGHT'),
    ('c6g_wait copy missing (session A error)', 'c6g_wait', '', NO_FN, b(), 'INCONCLUSIVE'),
    ('c6g_wait session B error', 'c6g_wait', '', WAIT_A, LOCK_TIMEOUT, 'INCONCLUSIVE'),
    ('c6g_wait gate timeout', 'c6g_wait', 'read_before_lock', WAIT_A, GATE_TIMEOUT, 'INCONCLUSIVE'),
    ('c6g_wait mutant both ok, no overlap', 'c6g_wait', 'read_before_lock', WAIT_A, b(t_start=B0_LATE, t_end='2026-11-23T10:00:03.21+00:00'),
     'INCONCLUSIVE'),
    ('c6g_wait time unreadable', 'c6g_wait', '', WAIT_A, b(t_end='later'), 'INCONCLUSIVE'),
    ('wrong mutant for case', 'c6g_wait', 'no_skip_locked', WAIT_A, b(), 'INCONCLUSIVE'),
    ('empty outputs', 'attach', '', '', '', 'INCONCLUSIVE'),
]
PRE = {'by_id': 0, 'by_pattern': 0, 'mutants': 0, 'marked_runs': 0, 'auth_users': 25, 'orphans': 3}
PRECHECK = [  # (label, output, case, expected exit)
    ('clean', rows([PRE]), 'attach', 0),
    ('fixture id exists', rows([dict(PRE, by_id=1)]), 'c6g_skip', 1),
    ('fixture pattern exists', rows([dict(PRE, by_pattern=2)]), 'c6g_skip', 1),
    ('copy left', rows([dict(PRE, mutants=1)]), 'c6g_wait', 1),
    ('marked run row left', rows([dict(PRE, marked_runs=1)]), 'c6g_wait', 1),
    ('attach with 900 orphans', rows([dict(PRE, orphans=900)]), 'attach', 1),
    ('c6g with 900 orphans', rows([dict(PRE, orphans=900)]), 'c6g_skip', 0),
    ('precheck error', LOCK_TIMEOUT, 'attach', 1),
]
APPLIED = [
    ('copy ok', rows([{'m': '0123456789abcdef0123456789abcdef'}]), 0),
    ('copy missing', rows([{'m': None}]), 1),
    ('md5 query failed', LOCK_TIMEOUT, 1),
]
FK = [
    ('all zero', rows([{'tbl': 'cloud_deals', 'col': 'owner_user_id', 'n': 0}]), '0'),
    ('rows left', rows([{'tbl': 'cloud_deals', 'col': 'owner_user_id', 'n': 2}, {'tbl': 'cloud_blobs', 'col': 'owner_user_id', 'n': 1}]), '3'),
    ('query failed', LOCK_TIMEOUT, 'unreadable'),
]


def run(args):
    r = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'verdict.py')] + args, capture_output=True, text=True)
    return r.returncode, r.stdout.strip()


bad = 0
with tempfile.TemporaryDirectory() as d:
    def put(name, txt):
        p = os.path.join(d, name)
        open(p, 'w').write(txt)
        return p
    for label, case, mut, fa, fb, want in CASES:
        rc, out = run([case, mut, put('a', fa), put('b', fb)])
        good = out.split(':')[0] == want and (rc == 0) == (want in ('PASS', 'CAUGHT'))
        bad += not good
        print(('ok   ' if good else 'BAD  ') + f'{label}: {out[:110]} (rc {rc})')
    for label, txt, case, want in PRECHECK:
        rc, out = run(['precheck', put('p', txt), case])
        good = rc == want and out.startswith('ok ') == (want == 0)
        bad += not good
        print(('ok   ' if good else 'BAD  ') + f'precheck/{label}: {out[:110]} (rc {rc})')
    for label, txt, want in APPLIED:
        rc, out = run(['applied', 'cloud_blob_erase_scrub_m4263', put('m', txt)])
        good = rc == want and out.startswith('MUTATION APPLIED ') == (want == 0)
        bad += not good
        print(('ok   ' if good else 'BAD  ') + f'applied/{label}: {out[:110]} (rc {rc})')
    for label, txt, want in FK:
        rc, out = run(['fkcounts', 'x', put('f', txt)])
        good = out.splitlines()[-1] == want and (rc == 0) == (want != 'unreadable')
        bad += not good
        print(('ok   ' if good else 'BAD  ') + f'fkcounts/{label}: last line {out.splitlines()[-1]} (rc {rc})')
n = len(CASES) + len(PRECHECK) + len(APPLIED) + len(FK)
print(f'{n} canned outputs, {bad} wrong')
sys.exit(1 if bad or n == 0 else 0)
