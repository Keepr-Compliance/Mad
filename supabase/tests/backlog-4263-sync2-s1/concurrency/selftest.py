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
T0 = '2026-11-23 10:00:00.104512+00'
LATE = '2026-11-23 10:00:04.21+00'    # 4.1 s after T0: waited
EARLY = '2026-11-23 10:00:01.3+00'    # 1.2 s after T0: did not wait


def ok(rows):
    return json.dumps(rows)


def err(msg):
    return json.dumps({'message': msg}) + '\nkt-sql: HTTP 400\n'


GATE_TIMEOUT = err('ERROR:  P0001: P_GATE_TIMEOUT: holder not seen within 20 s\nCONTEXT:  PL/pgSQL function inline_code_block line 8 at RAISE\n')
NO_FN = err('ERROR:  42883: function public.cloud_claim_install_m4263(uuid, uuid, boolean) does not exist\nLINE 1: SELECT public.cloud_claim_install_m4263(...)\n')
DEADLOCK = err('ERROR:  40P01: deadlock detected\n')


def state(**kw):
    j = {'active': IB, 'enabled': True, 'deals': 2, 'deal_r1': 0, 'deal_r6': 0, 'moves': 0, 'live_blobs': 1}
    j.update(kw)
    return ok([{'j': j}])


applied_deal = {'ok': True, 'results': [{'local_id': 'x', 'cloud_id': IA, 'status': 'applied'}]}
CASES = [  # (label, case, mode, first, second, state, expected first word)
    ('R1 pass', 'R1', 'pristine', ok([{'r': applied_deal, 't_write': T0, 'hold': ''}]), ok([{'r': {'ok': True, 'active': True, 'replaced': IA}, 't_end': LATE}]),
     state(deal_r1=1, deals=3), 'PASS'),
    ('R1 no wait', 'R1', 'pristine', ok([{'r': applied_deal, 't_write': T0, 'hold': ''}]), ok([{'r': {'ok': True}, 't_end': EARLY}]),
     state(deal_r1=1, deals=3), 'ERROR'),
    ('R1 gate timeout', 'R1', 'pristine', ok([{'r': applied_deal, 't_write': T0, 'hold': ''}]), GATE_TIMEOUT, state(), 'ERROR'),
    ('R1 asked as mutant', 'R1', 'mutant', ok([{'r': applied_deal, 't_write': T0, 'hold': ''}]), ok([{'r': {'ok': True}, 't_end': LATE}]),
     state(deal_r1=1), 'ERROR'),
    ('R2 pass', 'R2', 'pristine', ok([{'r': {'ok': False, 'error': 'object_missing'}, 't_write': T0, 'hold': ''}]),
     ok([{'r': {'ok': True, 'active': True}, 't_end': LATE}]), state(), 'PASS'),
    ('R2 mutant red', 'R2', 'mutant', ok([{'r': {'ok': False, 'error': 'object_missing'}, 't_write': T0, 'hold': ''}]),
     ok([{'r': {'ok': True, 'active': True}, 't_end': EARLY}]), state(), 'RED'),
    ('R2 mutant but waited', 'R2', 'mutant', ok([{'r': {'ok': False, 'error': 'object_missing'}, 't_write': T0, 'hold': ''}]),
     ok([{'r': {'ok': True}, 't_end': LATE}]), state(), 'ERROR'),
    ('R2 mutant fn missing', 'R2', 'mutant', err('ERROR:  42883: function public.cloud_confirm_blob_m4263(uuid, uuid, uuid) does not exist\n'),
     ok([{'r': {'ok': True}, 't_end': EARLY}]), state(), 'ERROR'),
    ('R3 pass', 'R3', 'pristine', ok([{'r': {'ok': True, 'active': True}, 'hold': ''}]), ok([{'r': {'ok': False, 'error': 'computer_not_active', 'active_since': T0}}]),
     state(active=IA), 'PASS'),
    ('R3 mutant red', 'R3', 'mutant', ok([{'r': {'ok': True, 'active': True}, 'hold': ''}]), ok([{'r': {'ok': True, 'active': True}}]), state(active=IB), 'RED'),
    ('R3 mutant fn missing', 'R3', 'mutant', NO_FN, NO_FN, state(active=None), 'ERROR'),
    ('R3 pristine both ok', 'R3', 'pristine', ok([{'r': {'ok': True}, 'hold': ''}]), ok([{'r': {'ok': True}}]), state(active=IB), 'ERROR'),
    ('R4 pass', 'R4', 'pristine', ok([{'r': {'ok': True, 'active': True, 'replaced': IA}, 'hold': ''}]),
     ok([{'r': {'success': False, 'error': 'computer_not_active'}}]), state(), 'PASS'),
    ('R4 mutant red', 'R4', 'mutant', ok([{'r': {'ok': True, 'replaced': IA}, 'hold': ''}]), ok([{'r': {'success': True, 'enabled': False}}]),
     state(deals=0, enabled=False, active=None), 'RED'),
    ('R4 mutant refused anyway', 'R4', 'mutant', ok([{'r': {'ok': True}, 'hold': ''}]), ok([{'r': {'success': False, 'error': 'computer_not_active'}}]),
     state(), 'ERROR'),
    ('R4 deadlock', 'R4', 'pristine', ok([{'r': {'ok': True}, 'hold': ''}]), DEADLOCK, state(), 'ERROR'),
    ('R5 pass', 'R5', 'pristine', ok([{'r': {'success': True, 'enabled': False}, 'hold': ''}]), ok([{'r': {'ok': False, 'error': 'not_entitled'}}]),
     state(deals=0, enabled=False, active=None), 'PASS'),
    ('R5 asked as mutant', 'R5', 'mutant', ok([{'r': {'success': True}, 'hold': ''}]), ok([{'r': {'ok': False, 'error': 'not_entitled'}}]),
     state(deals=0), 'ERROR'),
    ('R6 pass', 'R6', 'pristine', ok([{'r': {'ok': True, 'replaced': IA}, 'hold': ''}]), ok([{'r': {'ok': False, 'error': 'computer_not_active'}}]),
     state(), 'PASS'),
    ('R6 mutant red', 'R6', 'mutant', ok([{'r': {'ok': True, 'replaced': IA}, 'hold': ''}]), ok([{'r': applied_deal}]), state(deal_r6=1, deals=3), 'RED'),
    ('R6 mutant gate timeout', 'R6', 'mutant', ok([{'r': {'ok': True}, 'hold': ''}]), GATE_TIMEOUT, state(), 'ERROR'),
    ('R6 state missing', 'R6', 'pristine', ok([{'r': {'ok': True}, 'hold': ''}]), ok([{'r': {'ok': False, 'error': 'computer_not_active'}}]),
     err('ERROR:  57014: canceling statement due to statement timeout\n'), 'ERROR'),
    ('empty body', 'R1', 'pristine', '', '', '', 'ERROR'),
]
APPLIED = [  # (label, md5 query output, expected first word)
    ('create ok', ok([{'m': '0123456789abcdef0123456789abcdef'}]), 'MUTATION'),
    ('create failed (no body)', ok([{'m': None}]), 'ERROR'),
    ('create query failed', err('ERROR:  42501: permission denied\n'), 'ERROR'),
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
print(f'{len(CASES) + len(APPLIED)} canned outputs, {bad} wrong')
sys.exit(1 if bad else 0)
