#!/usr/bin/env python3
"""Verdict of one two-session case, from the kt-sql outputs (BACKLOG-4263 S1).

usage: verdict.py <case> <pristine|mutant> <first.out> <second.out> <state.out> <IA> <IB>
       verdict.py applied <name> <md5.out>    -> 'MUTATION APPLIED <name> md5 <x>' or ERROR (the create left no body)
       verdict.py precheck <pre.out> <need_on> -> 'ok auth_users=<n> one_computer=<b>' (exit 0) or the refusal (exit 1)
       verdict.py fkcounts <label> <fk.out>   -> one line per table holding rows of the fixture user, then the total
Prints one line and exits 0 only for the expected outcome:
  pristine run: PASS (the case's passing shape) or ERROR: <why> / INCONCLUSIVE: <why>
  mutant run:   RED  (the case's own red shape)  or ERROR: <why> / INCONCLUSIVE: <why>
A kt-sql output is the HTTP body (a JSON array of rows on success, a JSON object with "message" on an error) followed,
on an error, by a line 'kt-sql: HTTP <code>' (stderr is captured with stdout). Anything that is not a row with the
expected columns is ERROR, never a pass and never a red. Session 1 answers r, t_start, t_hold (after its call, before
its hold) and t_end (after its hold, before its locks are released); session 2 answers r, t_start (after the gate) and
t_end. A missing or unreadable time, or session 2 not starting inside session 1's hold with at least OVERLAP_S seconds
of it left, is INCONCLUSIVE: no PASS and no RED without measured overlap. Waited = session 2 ended after t_end.
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


OVERLAP_S = 1.5  # session 2 must start at least this long before session 1's hold ends (hold 4 s, offset 1 s)


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
    if case not in SHAPES:
        return f'ERROR: unknown case {case}'
    if mode not in ('pristine', 'mutant'):
        return f'ERROR: unknown mode {mode}'
    if mode == 'mutant' and case not in RED_CASES:
        return f'ERROR: {case} has no mutant'
    a_hold, a_end, b_start, b_end = ts(a.get('t_hold')), ts(a.get('t_end')), ts(b.get('t_start')), ts(b.get('t_end'))
    if None in (a_hold, a_end, b_start, b_end):
        return 'INCONCLUSIVE: a session start or end time is missing or unreadable ' + json.dumps(
            {k: (a if k[0] == 'a' else b).get(k[2:]) for k in ('a_t_hold', 'a_t_end', 'b_t_start', 'b_t_end')})[:300]
    left = (a_end - b_start).total_seconds()
    if not (a_hold <= b_start and left >= OVERLAP_S):
        return f'INCONCLUSIVE: no measured overlap (session 2 started {left:.3f} s before session 1 hold end; needs {OVERLAP_S})'
    waited = b_end > a_end
    passing, red = SHAPES[case](ra, rb, st, waited, ia, ib)
    detail = json.dumps({'first': ra, 'second': rb, 'state': st, 'waited': waited, 'overlap_left_s': round(left, 3)})[:600]
    if mode == 'pristine':
        return 'PASS' if passing else 'ERROR: not the passing shape ' + detail
    return 'RED' if red else 'ERROR: not the mutant red shape ' + detail


def status(r):
    return ((r.get('results') or [{}])[0] or {}).get('status')


SHAPES = {  # case -> fn returning (passing shape, the mutant's own red shape); both already need measured overlap
    'R1': lambda ra, rb, st, w, ia, ib: (status(ra) == 'applied' and rb.get('ok') is True and w and st.get('active') == ib
                                         and st.get('deal_r1') == 1, False),
    'R2': lambda ra, rb, st, w, ia, ib: (ra.get('error') == 'object_missing' and rb.get('ok') is True and w and st.get('active') == ib,
                                         ra.get('error') == 'object_missing' and rb.get('ok') is True and not w),
    'R3': lambda ra, rb, st, w, ia, ib: (ra.get('ok') is True and rb.get('error') == 'computer_not_active' and w and st.get('active') == ia
                                         and st.get('moves') == 0, ra.get('ok') is True and rb.get('ok') is True),
    'R4': lambda ra, rb, st, w, ia, ib: (ra.get('ok') is True and rb.get('error') == 'computer_not_active' and w and st.get('deals') == 2
                                         and st.get('enabled') is True and st.get('active') == ib,
                                         ra.get('ok') is True and rb.get('success') is True and st.get('deals') == 0),
    'R5': lambda ra, rb, st, w, ia, ib: (ra.get('success') is True and rb.get('error') == 'not_entitled' and w and st.get('moves') == 0
                                         and st.get('deals') == 0, False),
    'R6': lambda ra, rb, st, w, ia, ib: (ra.get('ok') is True and rb.get('error') == 'computer_not_active' and w and st.get('deal_r6') == 0
                                         and st.get('active') == ib, status(rb) == 'applied' and st.get('deal_r6') == 1),
}
RED_CASES = ('R2', 'R3', 'R4', 'R6')


def precheck(path, need_on):
    r, e = rows(path)
    if e:
        return False, f'precheck {e}'
    r = r[-1]
    try:
        by_id, by_pat, mut, total = (int(r[k]) for k in ('by_id', 'by_pattern', 'mutants', 'auth_users'))
    except (KeyError, TypeError, ValueError):
        return False, 'precheck row unreadable: ' + json.dumps(r)[:200]
    on = r.get('one_computer') is True
    why = [w for w, bad in ((f'{by_id} auth user(s) already have the fixture id', by_id),
                            (f'{by_pat} p4263s1cc-*@example.test fixture user(s) exist (a run in progress, or leftovers: run.sh cleanup <run-id> <user-id>)', by_pat),
                            (f'{mut} public.*_m4263 function(s) exist', mut),
                            ('the case needs one_computer on and it is off (the coordinator flips it; never flipped here)', need_on == '1' and not on)) if bad]
    if why:
        return False, '; '.join(why) + '; nothing was created'
    return True, f'ok auth_users={total} one_computer={on}'


def fkcounts(label, path):
    r, e = rows(path)
    if e or not all(isinstance(x, dict) and {'tbl', 'col', 'n'} <= set(x) for x in r):
        return [f'  {label}: per-table counts unreadable ({e or "unexpected rows"})', 'unreadable'], False
    try:
        nz = [(x['tbl'], x['col'], int(x['n'])) for x in r]
    except (TypeError, ValueError):
        return [f'  {label}: per-table counts unreadable', 'unreadable'], False
    total = sum(n for _, _, n in nz)
    lines = [f'  {label}: {len(nz)} columns reference auth.users; non-zero:']
    lines += [f'    {t}.{c}: {n}' for t, c, n in nz if n] or ['    none']
    return lines + [str(total)], True


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
    if len(sys.argv) == 4 and sys.argv[1] == 'precheck':
        ok, out = precheck(sys.argv[2], sys.argv[3])
        print(out.replace('\n', ' '))
        sys.exit(0 if ok else 1)
    if len(sys.argv) == 4 and sys.argv[1] == 'fkcounts':
        lines, ok = fkcounts(sys.argv[2], sys.argv[3])
        print('\n'.join(lines))
        sys.exit(0 if ok else 1)
    out = (main(sys.argv[1:8]) if len(sys.argv) == 8 else 'ERROR: usage').replace('\n', ' ')
    print(out)
    sys.exit(0 if out in ('PASS', 'RED') else 1)
