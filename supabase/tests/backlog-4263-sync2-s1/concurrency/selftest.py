#!/usr/bin/env python3
"""Offline self-test of verdict.py against canned kt-sql outputs in the transport's real shape (BACKLOG-4263 S1).
No database. usage: python3 -I selftest.py   (exit 0 when every canned case gives its expected verdict)
Success body: the Management API's JSON array of rows (jsonb columns as objects, timestamptz as PostgreSQL text, void as
""); error body: {"message": "..."} followed by the 'kt-sql: HTTP 400' line kt-sql writes to stderr.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
IA, IB = '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1'
# Times as the transport returns them: timestamptz columns and timestamptz::text are PostgreSQL text
# ('2026-11-23 17:27:21.021326+00', transcribed from a kt-sql answer of the test project, window-flip step2).
T0 = '2026-11-23 10:00:00.104512+00'      # session 1 start
TH = '2026-11-23 10:00:00.211+00'         # session 1 after its call, hold begins
TE = '2026-11-23 10:00:04.215+00'         # session 1 hold ends
B0 = '2026-11-23 10:00:01.32+00'          # session 2 start after the gate: 2.895 s of the hold left
LATE = '2026-11-23 10:00:04.233+00'       # session 2 end after the hold ended: waited
EARLY = '2026-11-23 10:00:01.35+00'       # session 2 end while the hold is still on: did not wait
B0_LATE = '2026-11-23 10:00:03.1+00'      # session 2 start with only 1.115 s of the hold left: no measured overlap
B0_BEFORE = '2026-11-23 10:00:00.15+00'   # session 2 start before session 1's call ended


def ok(rows):
    return json.dumps(rows)


def err(msg):
    # the Management API's error body and kt-sql's status line, transcribed from scratchpad/4263/notice/run1.txt
    return json.dumps({'message': 'Failed to run sql query: ' + msg}) + '\nkt-sql: HTTP 400\n'


GATE_TIMEOUT = err('ERROR:  P0001: P_GATE_TIMEOUT: holder not seen within 20 s\nCONTEXT:  PL/pgSQL function inline_code_block line 8 at RAISE\n')
NO_FN = err('ERROR:  42883: function public.cloud_claim_install_m4263(uuid, uuid, boolean) does not exist\nLINE 1: SELECT public.cloud_claim_install_m4263(...)\n')
DEADLOCK = err('ERROR:  40P01: deadlock detected\n')
LOCK_TIMEOUT = err('ERROR:  55P03: canceling statement due to lock timeout\n')


def first(r, t_hold=TH, t_end=TE, **kw):
    row = {'r': r, 't_start': T0, 't_hold': t_hold, 't_end': t_end}
    row.update(kw)
    return ok([row])


def second(r, t_start=B0, t_end=LATE):
    return ok([{'r': r, 't_start': t_start, 't_end': t_end}])


def state(**kw):
    j = {'active': IB, 'enabled': True, 'deals': 2, 'deal_r1': 0, 'deal_r6': 0, 'moves': 0, 'live_blobs': 1}
    j.update(kw)
    return ok([{'j': j}])


applied_deal = {'ok': True, 'results': [{'local_id': 'x', 'cloud_id': IA, 'status': 'applied'}]}
OM = {'ok': False, 'error': 'object_missing'}
CNA = {'ok': False, 'error': 'computer_not_active'}
CASES = [  # (label, case, mode, first, second, state, expected first word)
    ('R1 pass', 'R1', 'pristine', first(applied_deal), second({'ok': True, 'active': True, 'replaced': IA}), state(deal_r1=1, deals=3), 'PASS'),
    ('R1 no wait', 'R1', 'pristine', first(applied_deal), second({'ok': True}, t_end=EARLY), state(deal_r1=1, deals=3), 'ERROR'),
    ('R1 gate timeout (session 2 error)', 'R1', 'pristine', first(applied_deal), GATE_TIMEOUT, state(), 'ERROR'),
    ('R1 session 1 error', 'R1', 'pristine', LOCK_TIMEOUT, second({'ok': True}), state(deal_r1=1), 'ERROR'),
    ('R1 asked as mutant', 'R1', 'mutant', first(applied_deal), second({'ok': True}), state(deal_r1=1), 'ERROR'),
    ('R1 both ok, no overlap (session 2 started late)', 'R1', 'pristine', first(applied_deal), second({'ok': True}, t_start=B0_LATE),
     state(deal_r1=1, deals=3), 'INCONCLUSIVE'),
    ('R1 both ok, session 2 started before session 1 call ended', 'R1', 'pristine', first(applied_deal),
     second({'ok': True}, t_start=B0_BEFORE), state(deal_r1=1, deals=3), 'INCONCLUSIVE'),
    ('R1 session 1 time unreadable', 'R1', 'pristine', first(applied_deal, t_end='soon'), second({'ok': True}), state(deal_r1=1, deals=3),
     'INCONCLUSIVE'),
    ('R1 session 2 time missing', 'R1', 'pristine', first(applied_deal), ok([{'r': {'ok': True}, 't_end': LATE}]), state(deal_r1=1, deals=3),
     'INCONCLUSIVE'),
    ('R2 pass', 'R2', 'pristine', first(OM), second({'ok': True, 'active': True}), state(), 'PASS'),
    ('R2 mutant red', 'R2', 'mutant', first(OM), second({'ok': True, 'active': True}, t_end=EARLY), state(), 'RED'),
    ('R2 mutant but waited', 'R2', 'mutant', first(OM), second({'ok': True}), state(), 'ERROR'),
    ('R2 mutant no overlap', 'R2', 'mutant', first(OM), second({'ok': True}, t_start=B0_LATE, t_end='2026-11-23 10:00:03.12+00'), state(),
     'INCONCLUSIVE'),
    ('R2 mutant fn missing', 'R2', 'mutant', err('ERROR:  42883: function public.cloud_confirm_blob_m4263(uuid, uuid, uuid) does not exist\n'),
     second({'ok': True}, t_end=EARLY), state(), 'ERROR'),
    ('R3 pass', 'R3', 'pristine', first({'ok': True, 'active': True}), second({'ok': False, 'error': 'computer_not_active', 'active_since': T0}),
     state(active=IA), 'PASS'),
    ('R3 pristine without wait', 'R3', 'pristine', first({'ok': True, 'active': True}), second(CNA, t_end=EARLY), state(active=IA), 'ERROR'),
    ('R3 pristine serial (no overlap)', 'R3', 'pristine', first({'ok': True, 'active': True}), second(CNA, t_start=B0_LATE),
     state(active=IA), 'INCONCLUSIVE'),
    ('R3 mutant red', 'R3', 'mutant', first({'ok': True, 'active': True}), second({'ok': True, 'active': True}), state(active=IB), 'RED'),
    ('R3 mutant fn missing', 'R3', 'mutant', NO_FN, NO_FN, state(active=None), 'ERROR'),
    ('R3 pristine both ok', 'R3', 'pristine', first({'ok': True}), second({'ok': True}), state(active=IB), 'ERROR'),
    ('R4 pass', 'R4', 'pristine', first({'ok': True, 'active': True, 'replaced': IA}), second({'success': False, 'error': 'computer_not_active'}),
     state(), 'PASS'),
    ('R4 mutant red', 'R4', 'mutant', first({'ok': True, 'replaced': IA}), second({'success': True, 'enabled': False}),
     state(deals=0, enabled=False, active=None), 'RED'),
    ('R4 mutant red shape but serial (no overlap)', 'R4', 'mutant', first({'ok': True, 'replaced': IA}),
     second({'success': True, 'enabled': False}, t_start=B0_LATE), state(deals=0, enabled=False, active=None), 'INCONCLUSIVE'),
    ('R4 mutant refused anyway', 'R4', 'mutant', first({'ok': True}), second({'success': False, 'error': 'computer_not_active'}), state(), 'ERROR'),
    ('R4 deadlock', 'R4', 'pristine', first({'ok': True}), DEADLOCK, state(), 'ERROR'),
    ('R5 pass', 'R5', 'pristine', first({'success': True, 'enabled': False}), second({'ok': False, 'error': 'not_entitled'}),
     state(deals=0, enabled=False, active=None), 'PASS'),
    ('R5 asked as mutant', 'R5', 'mutant', first({'success': True}), second({'ok': False, 'error': 'not_entitled'}), state(deals=0), 'ERROR'),
    ('R6 pass', 'R6', 'pristine', first({'ok': True, 'replaced': IA}), second(CNA), state(), 'PASS'),
    ('R6 mutant red', 'R6', 'mutant', first({'ok': True, 'replaced': IA}), second(applied_deal), state(deal_r6=1, deals=3), 'RED'),
    ('R6 mutant gate timeout', 'R6', 'mutant', first({'ok': True}), GATE_TIMEOUT, state(), 'ERROR'),
    ('R6 state missing', 'R6', 'pristine', first({'ok': True}), second(CNA), err('ERROR:  57014: canceling statement due to statement timeout\n'),
     'ERROR'),
    ('empty body', 'R1', 'pristine', '', '', '', 'ERROR'),
]
APPLIED = [  # (label, md5 query output, expected first word)
    ('create ok', ok([{'m': '0123456789abcdef0123456789abcdef'}]), 'MUTATION'),
    ('create failed (no body)', ok([{'m': None}]), 'ERROR'),
    ('create query failed', err('ERROR:  42501: permission denied\n'), 'ERROR'),
]
PRE = {'by_id': 0, 'by_pattern': 0, 'mutants': 0, 'auth_users': 25, 'one_computer': True}
PRECHECK = [  # (label, output, need_on, expected exit)
    ('clean', ok([PRE]), '1', 0),
    ('fixture id exists', ok([dict(PRE, by_id=1)]), '0', 1),
    ('fixture pattern exists', ok([dict(PRE, by_pattern=1)]), '0', 1),
    ('mutant left', ok([dict(PRE, mutants=1)]), '0', 1),
    ('switch off, case needs it', ok([dict(PRE, one_computer=False)]), '1', 1),
    ('switch off, case does not need it', ok([dict(PRE, one_computer=False)]), '0', 0),
    ('precheck error', LOCK_TIMEOUT, '0', 1),
    ('precheck row unreadable', ok([{'by_id': 0}]), '0', 1),
]
FK = [  # (label, output, expected last line)
    ('all zero', ok([{'tbl': 'cloud_deals', 'col': 'owner_user_id', 'n': 0}, {'tbl': 'cloud_blobs', 'col': 'owner_user_id', 'n': 0}]), '0'),
    ('rows left', ok([{'tbl': 'cloud_deals', 'col': 'owner_user_id', 'n': 2}, {'tbl': 'cloud_blobs', 'col': 'owner_user_id', 'n': 1}]), '3'),
    ('query failed', LOCK_TIMEOUT, 'unreadable'),
]


def run(args):
    r = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'verdict.py')] + args, capture_output=True, text=True)
    return r.returncode, r.stdout.strip()


bad = 0
with tempfile.TemporaryDirectory() as d:
    for label, case, mode, f1, f2, fs, want in CASES:
        paths = []
        for n, txt in (('1', f1), ('2', f2), ('s', fs)):
            p = os.path.join(d, n)
            open(p, 'w').write(txt)
            paths.append(p)
        rc, out = run([case, mode] + paths + [IA, IB])
        good = out.split(':')[0].split(' ')[0] == want and (rc == 0) == (want in ('PASS', 'RED'))
        bad += not good
        print(('ok   ' if good else 'BAD  ') + f'{label}: {out[:110]} (rc {rc})')
    for label, txt, want in APPLIED:
        p = os.path.join(d, 'm')
        open(p, 'w').write(txt)
        rc, out = run(['applied', 'cloud_claim_install_m4263', p])
        good = out.split(' ')[0].rstrip(':') == want and (rc == 0) == (want == 'MUTATION')
        bad += not good
        print(('ok   ' if good else 'BAD  ') + f'applied/{label}: {out[:110]} (rc {rc})')
    for label, txt, need, want in PRECHECK:
        p = os.path.join(d, 'p')
        open(p, 'w').write(txt)
        rc, out = run(['precheck', p, need])
        good = rc == want and out.startswith('ok ') == (want == 0)
        bad += not good
        print(('ok   ' if good else 'BAD  ') + f'precheck/{label}: {out[:110]} (rc {rc})')
    for label, txt, want in FK:
        p = os.path.join(d, 'f')
        open(p, 'w').write(txt)
        rc, out = run(['fkcounts', 'x', p])
        good = out.splitlines()[-1] == want and (rc == 0) == (want != 'unreadable')
        bad += not good
        print(('ok   ' if good else 'BAD  ') + f'fkcounts/{label}: last line {out.splitlines()[-1]} (rc {rc})')
print(f'{len(CASES) + len(APPLIED) + len(PRECHECK) + len(FK)} canned outputs, {bad} wrong')
sys.exit(1 if bad else 0)
