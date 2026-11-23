#!/usr/bin/env python3
"""Verdict of one two-session case, from the kt-sql outputs (BACKLOG-4263 S1).

usage: verdict.py <case> <pristine|mutant> <first.out> <second.out> <state.out> <IA> <IB>
       verdict.py applied <name> <md5.out>   -> 'MUTATION APPLIED <name> md5 <x>' or ERROR (the create left no body)
Prints one line and exits 0 only for the expected outcome:
  pristine run: PASS (the case's passing shape) or ERROR: <why>
  mutant run:   RED  (the case's own red shape)  or ERROR: <why>
A kt-sql output is the HTTP body (a JSON array of rows on success, a JSON object with "message" on an error) followed,
on an error, by a line 'kt-sql: HTTP <code>' (stderr is captured with stdout). Anything that is not a row with the
expected columns is ERROR, never a pass and never a red.
"""
import json
import re
import sys
from datetime import datetime, timezone


def rows(path):
    t = open(path, encoding='utf-8').read()
    body = t.split('\nkt-sql:')[0].strip()
    try:
        v = json.loads(body)
    except Exception:
        return None, 'not JSON: ' + body[:200]
    if isinstance(v, dict):
        return None, 'error: ' + str(v.get('message', v))[:300]
    if not isinstance(v, list) or not v:
        return None, 'no result row'
    return v, None


def ts(x):
    """'2026-11-23 10:00:00.12+00' (PostgreSQL text) or ISO -> aware datetime; None when unreadable."""
    m = re.fullmatch(r'(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?', str(x or ''))
    if not m:
        return None
    frac = (m.group(3) or '0').ljust(6, '0')
    tz = m.group(4) or '+00'
    tz = '+00:00' if tz == 'Z' else (tz if ':' in tz else (tz + ':00' if len(tz) == 3 else tz[:3] + ':' + tz[3:]))
    try:
        return datetime.fromisoformat(f'{m.group(1)}T{m.group(2)}.{frac}{tz}')
    except ValueError:
        return None


def main(argv):
    case, mode, f1, f2, fs, ia, ib = argv
    a, e1 = rows(f1)
    b, e2 = rows(f2)
    s, e3 = rows(fs)
    for name, e in (('session 1', e1), ('session 2', e2), ('state', e3)):
        if e:
            return f'ERROR: {name} {e}'
    a, b, st = a[-1], b[-1], s[-1].get('j')
    if not isinstance(a.get('r'), dict) or not isinstance(b.get('r'), dict) or not isinstance(st, dict):
        return 'ERROR: a result row lacks its r / j column'
    ra, rb = a['r'], b['r']
    t0, t1 = ts(a.get('t_write')), ts(b.get('t_end'))
    waited = None if (t0 is None or t1 is None) else (t1 - t0).total_seconds() >= 3.5
    status = lambda r: ((r.get('results') or [{}])[0] or {}).get('status')
    shapes = {  # case -> (passing shape, the mutant's own red shape or None)
        'R1': (status(ra) == 'applied' and rb.get('ok') is True and waited is True and st.get('active') == ib and st.get('deal_r1') == 1,
               None),
        'R2': (ra.get('error') == 'object_missing' and rb.get('ok') is True and waited is True and st.get('active') == ib,
               ra.get('error') == 'object_missing' and rb.get('ok') is True and waited is False),
        'R3': (ra.get('ok') is True and rb.get('error') == 'computer_not_active' and st.get('active') == ia and st.get('moves') == 0,
               ra.get('ok') is True and rb.get('ok') is True),
        'R4': (ra.get('ok') is True and rb.get('error') == 'computer_not_active' and st.get('deals') == 2 and st.get('enabled') is True
               and st.get('active') == ib,
               ra.get('ok') is True and rb.get('success') is True and st.get('deals') == 0),
        'R5': (ra.get('success') is True and rb.get('error') == 'not_entitled' and st.get('moves') == 0 and st.get('deals') == 0, None),
        'R6': (ra.get('ok') is True and rb.get('error') == 'computer_not_active' and st.get('deal_r6') == 0 and st.get('active') == ib,
               status(rb) == 'applied' and st.get('deal_r6') == 1),
    }
    if case not in shapes:
        return f'ERROR: unknown case {case}'
    passing, red = shapes[case]
    detail = json.dumps({'first': ra, 'second': rb, 'state': st, 'waited': waited})[:600]
    if mode == 'pristine':
        return 'PASS' if passing else 'ERROR: not the passing shape ' + detail
    if mode == 'mutant':
        if red is None:
            return f'ERROR: {case} has no mutant'
        return 'RED' if red else 'ERROR: not the mutant red shape ' + detail
    return f'ERROR: unknown mode {mode}'


def applied(name, path):
    r, e = rows(path)
    if e:
        return f'ERROR: mutant {name} not proven applied: {e}'
    m = r[-1].get('m')
    if not (isinstance(m, str) and re.fullmatch(r'[0-9a-f]{32}', m)):
        return f'ERROR: mutant {name} not proven applied: no body (md5 {m!r})'
    return f'MUTATION APPLIED {name} md5 {m}'


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == 'applied':
        out = applied(sys.argv[2], sys.argv[3]).replace('\n', ' ')
        print(out)
        sys.exit(0 if out.startswith('MUTATION APPLIED ') else 1)
    out = (main(sys.argv[1:8]) if len(sys.argv) == 8 else 'ERROR: usage').replace('\n', ' ')
    print(out)
    sys.exit(0 if out in ('PASS', 'RED') else 1)
