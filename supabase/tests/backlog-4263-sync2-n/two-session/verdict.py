#!/usr/bin/env python3
"""BACKLOG-4263 P11 two-session control: reads the calls' outputs (the transport prints the kt-sql envelope: a RAISE is
{"message": "...ERROR:  P0001: <MARKER> {json}\\nCONTEXT..."} then 'kt-sql: HTTP 400'; a commit is a JSON list of
{"line": <row text>} then 'kt-sql: HTTP 200').

  verdict.py raise <MARKER> <file>             prints the JSON after the marker (exit 1 when it is not a P0001 RAISE)
  verdict.py commit <file>                     prints each row that is a JSON object, one per line (exit 1 unless HTTP 200)
  verdict.py precheck <file> <run-id>          'ok enabled=<b> updated_at=<t>' or the refusal (exit 1)
  verdict.py case <mode> <s1> <s2> <state>     PASS (pristine) / RED (mutant) / INCONCLUSIVE / ERROR, with the reasons
  verdict.py baseline <precheck> <verify>      'clean' or the differences (exit 1)
  verdict.py selftest                          the case verdict on canned outputs (its own control: --control-green-ok)
"""
import json
import re
import sys
from datetime import datetime


def http(raw):
    return [l.strip() for l in raw.replace('\r\n', '\n').split('\n') if l.startswith('kt-sql: HTTP')]


def raised(raw, marker):
    if http(raw) != ['kt-sql: HTTP 400']:
        return None, f'expected one "kt-sql: HTTP 400", got {http(raw)}'
    body = '\n'.join(l for l in raw.split('\n') if not l.startswith('kt-sql: '))
    try:
        msg = json.loads(body)['message']
    except (ValueError, KeyError, TypeError):
        return None, 'unreadable output'
    m = re.search(r'ERROR:  ([0-9A-Z]{5}): ', msg)
    if not m or m.group(1) != 'P0001':
        return None, 'not the RAISE: ' + msg[:300].replace('\n', ' ')
    i = msg.find(marker + ' ')
    if i < 0:
        return None, 'not ' + marker + ': ' + msg[:300].replace('\n', ' ')
    try:
        v, _ = json.JSONDecoder().raw_decode(msg[i + len(marker) + 1:])
    except ValueError as e:
        return None, f'{marker} is not JSON ({e})'
    return v, None


def committed(raw):
    if http(raw) != ['kt-sql: HTTP 200']:
        return None, f'expected one "kt-sql: HTTP 200" (the call commits), got {http(raw)}'
    body = '\n'.join(l for l in raw.split('\n') if not l.startswith('kt-sql: '))
    try:
        lines = json.loads(body)
    except ValueError:
        return None, 'unreadable output'
    rows = []
    for x in lines:
        t = x.get('line') if isinstance(x, dict) else None
        if isinstance(t, str) and t.startswith('{'):
            try:
                rows.append(json.loads(t))
            except ValueError:
                pass
    return rows, None


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def precheck(raw, run):
    v, err = raised(raw, 'T4263N_PRE')
    if err:
        return None, 'precheck: ' + err
    bad = []
    if v.get('txn') != 'one':
        bad.append('one call is not one transaction')
    if v.get('iso') != 'read committed':
        bad.append(f"isolation {v.get('iso')}")
    for k in ('fixture_by_id', 'fixture_by_pattern', 'fixture_fk_rows', 'client_exists', 'pending_requests', 'connections_v2'):
        if v.get(k) != 0:
            bad.append(f'{k}={v.get(k)}')
    b = v.get('baseline') or {}
    if b.get('ledger_head') != '20261123140000':
        bad.append(f"ledger head {b.get('ledger_head')} (needs 20261123140000)")
    if b.get('notice_version') != 1 or b.get('tn_objects') != 0:
        bad.append(f"notice_version {b.get('notice_version')}, T-N objects {b.get('tn_objects')}")
    if not isinstance(v.get('enabled'), bool) or not isinstance(v.get('updated_at'), str):
        bad.append('mcp_settings unreadable')
    if bad:
        return None, 'refusing to start: ' + '; '.join(bad)
    return v, None


def case(mode, s1_raw, s2_raw, state_raw):
    s1, e1 = committed(s1_raw)
    s2, e2 = raised(s2_raw, 'T4263N_S2')
    st, e3 = raised(state_raw, 'T4263N_STATE')
    if e1 or e2 or e3:
        return 'ERROR', [x for x in (e1 and 'session 1: ' + e1, e2 and 'session 2: ' + e2, e3 and 'state: ' + e3) if x]
    k = {r.get('k'): r for r in s1}
    if not all(x in k for x in ('s1_start', 's1_hold', 's1_end')):
        return 'ERROR', ['session 1 rows missing: ' + ', '.join(sorted(k))]
    why = []
    order_ok = ts(s2['txn_start']) < ts(k['s1_start']['txn_start'])
    why.append(f"session 2's transaction started {'before' if order_ok else 'NOT before'} session 1's "
               f"({s2['txn_start']} vs {k['s1_start']['txn_start']})")
    held = k['s1_hold'].get('holds_lock') is True and ts(k['s1_hold']['clock']) <= ts(s2['gate_passed'])
    why.append(f"session 1 held the lock when session 2 passed its gate: {held}")
    waited = ts(s2['approve_done']) >= ts(k['s1_end']['clock'])
    why.append(f"approve ended after session 1's hold ended: {waited}")
    applied = st.get('ledger_tn') == 1 and st.get('notice_version') == 2
    why.append(f"T-N committed (ledger row, version 2): {applied}")
    if not (order_ok and held and waited and applied):
        return 'INCONCLUSIVE', why
    ap = s2.get('approve')
    if mode == 'pristine':
        ok = (ap == {'ok': False, 'error': 'request_invalid'} and s2.get('stamped') is None and s2.get('v2_connections_of_user') == 0
              and st.get('request_expires') == '-infinity' and st.get('connections_of_user') == 0)
        why.append(f"approve answered {ap}; stamped {s2.get('stamped')}; request expires_at {st.get('request_expires')}")
        return ('PASS' if ok else 'FAIL'), why
    hole = isinstance(ap, dict) and ap.get('ok') is True and s2.get('stamped') == 2 and s2.get('v2_connections_of_user') == 1
    why.append(f"approve answered {ap}; stamped {s2.get('stamped')} (the hole when 2)")
    return ('RED' if hole else 'NOT RED'), why


def baseline(pre_raw, ver_raw):
    p, e1 = raised(pre_raw, 'T4263N_PRE')
    v, e2 = raised(ver_raw, 'T4263N_VERIFY')
    if e1 or e2:
        return False, [e1 or e2]
    diffs = [f"{k}: before {p['baseline'].get(k)}, after {v['baseline'].get(k)}"
             for k in sorted(set(p['baseline']) | set(v['baseline'])) if p['baseline'].get(k) != v['baseline'].get(k)]
    for k in ('fixture_by_id', 'fixture_fk_rows', 'client_exists'):
        if v.get(k) != 0:
            diffs.append(f'{k} after: {v.get(k)}')
    return not diffs, diffs


def env400(marker, obj):
    return json.dumps({'message': f'Failed to run sql query: ERROR:  P0001: {marker} ' + json.dumps(obj) + '\nCONTEXT:  x'}) + '\nkt-sql: HTTP 400\n'


def env200(rows):
    return json.dumps([{'line': json.dumps(r)} for r in rows] + [{'line': 'p_hold:x|'}]) + '\nkt-sql: HTTP 200\n'


def canned(mode_out, order=True):
    s1 = env200([{'k': 's1_start', 'txn_start': '2026-11-24T10:00:01.000+00:00', 'clock': '2026-11-24T10:00:01.001+00:00'},
                 {'k': 's1_hold', 'clock': '2026-11-24T10:00:01.050+00:00', 'holds_lock': True},
                 {'k': 's1_end', 'clock': '2026-11-24T10:00:07.050+00:00'}])
    s2 = {'txn_start': '2026-11-24T10:00:00.%s+00:00' % ('500' if order else '999'), 'clock_start': '2026-11-24T10:00:00.501+00:00',
          'gate_passed': '2026-11-24T10:00:01.100+00:00', 'approve_done': '2026-11-24T10:00:07.060+00:00', 'holder_pid': 1}
    if not order:
        s2['txn_start'] = '2026-11-24T10:00:01.500+00:00'
    if mode_out == 'closed':
        s2.update(approve={'ok': False, 'error': 'request_invalid'}, stamped=None, v2_connections_of_user=0)
        st = {'ledger_tn': 1, 'notice_version': 2, 'request_status': 'pending', 'request_expires': '-infinity', 'connections_of_user': 0, 'codes_of_request': 0}
    else:
        s2.update(approve={'ok': True, 'redirect_uri': 'https://claude.ai/api/mcp/auth_callback', 'state': None}, stamped=2, v2_connections_of_user=1)
        st = {'ledger_tn': 1, 'notice_version': 2, 'request_status': 'pending', 'request_expires': '2026-11-24 10:00:01+00', 'connections_of_user': 0, 'codes_of_request': 0}
    return s1, env400('T4263N_S2', s2), env400('T4263N_STATE', st)


def selftest(green_ok):
    cases = [('pristine, closed', 'pristine', canned('closed'), 'PASS'),
             ('pristine, hole', 'pristine', canned('hole'), 'FAIL'),
             ('mutant, hole', 'mutant', canned('hole'), 'RED'),
             ('mutant, closed', 'mutant', canned('closed'), 'NOT RED'),
             ('session 2 started after session 1', 'pristine', canned('closed', order=False), 'INCONCLUSIVE'),
             ('session 1 did not commit', 'pristine', (canned('closed')[0].replace('HTTP 200', 'HTTP 400'),) + canned('closed')[1:], 'ERROR')]
    wrong = 0
    for name, mode, (a, b, c), want in cases:
        got, _ = case(mode, a, b, c)
        if green_ok and name == 'pristine, hole':
            want = 'PASS'
        print(f"{'ok   ' if got == want else 'WRONG'} {name}: {got} (want {want})")
        wrong += got != want
    pre_obj = {'txn': 'one', 'iso': 'read committed', 'fixture_by_id': 0, 'fixture_by_pattern': 0, 'fixture_fk_rows': 0,
               'client_exists': 0, 'pending_requests': 0, 'connections_v2': 0, 'enabled': False, 'updated_at': 'x',
               'baseline': {'ledger_head': '20261123140000', 'notice_version': 1, 'tn_objects': 0, 'auth_users': 5}}
    def pre_with(**kw):
        o = json.loads(json.dumps(pre_obj))
        for k, v in kw.items():
            (o['baseline'] if k in o['baseline'] else o)[k] = v
        return o
    pre = env400('T4263N_PRE', pre_obj)
    for name, obj, want in [('precheck clean', pre_obj, True), ('precheck pending request', pre_with(pending_requests=1), False),
                            ('precheck T-N applied', pre_with(ledger_head='20261123150000'), False),
                            ('precheck fixture present', pre_with(fixture_by_pattern=1), False)]:
        got = precheck(env400('T4263N_PRE', obj), 'x')[0] is not None
        print(f"{'ok   ' if got == want else 'WRONG'} {name}: {got} (want {want})")
        wrong += got != want
    for name, obj, want in [('baseline equal', pre_obj, True), ('baseline differs', pre_with(auth_users=6), False)]:
        got = baseline(pre, env400('T4263N_VERIFY', obj))[0]
        print(f"{'ok   ' if got == want else 'WRONG'} {name}: {got} (want {want})")
        wrong += got != want
    print(f'selftest: {len(cases) + 6} cases, {wrong} wrong')
    return 1 if wrong else 0


def main(a):
    if a[:1] == ['raise']:
        v, err = raised(open(a[2]).read(), a[1])
        if err:
            print(err)
            return 1
        print(json.dumps(v))
        return 0
    if a[:1] == ['commit']:
        rows, err = committed(open(a[1]).read())
        if err:
            print(err)
            return 1
        for r in rows:
            print(json.dumps(r))
        return 0
    if a[:1] == ['precheck']:
        v, err = precheck(open(a[1]).read(), a[2])
        if err:
            print(err)
            return 1
        print(f"ok enabled={'true' if v['enabled'] else 'false'} updated_at={v['updated_at']}")
        return 0
    if a[:1] == ['case']:
        got, why = case(a[1], open(a[2]).read(), open(a[3]).read(), open(a[4]).read())
        for w in why:
            print('  ' + w)
        print(got)
        return 0 if (a[1], got) in (('pristine', 'PASS'), ('mutant', 'RED')) else 1
    if a[:1] == ['baseline']:
        ok, diffs = baseline(open(a[1]).read(), open(a[2]).read())
        print('clean' if ok else 'DIFFERS: ' + ' | '.join(diffs))
        return 0 if ok else 1
    if a[:1] == ['selftest']:
        return selftest('--control-green-ok' in a)
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
