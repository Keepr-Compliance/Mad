#!/usr/bin/env python3
"""Verdict of one erase two-session case, from the kt-sql outputs (BACKLOG-4263 sync plan P3).

usage: verdict.py <attach|c6g_skip|c6g_wait> <mutant name or ''> <a.out> <b.out>
       verdict.py precheck <pre.out> <case>   -> 'ok auth_users=<n>' (exit 0) or the refusal (exit 1)
       verdict.py applied <name> <md5.out>    -> 'MUTATION APPLIED <name> md5 <x>' or ERROR (the create left no body)
       verdict.py fkcounts <label> <fk.out>   -> one line per table holding rows of the fixture user, then the total
Prints one line. Exit 0 only for PASS (pristine) or CAUGHT (mutant).

A kt-sql output is the Management API's body (a JSON array of rows, or {"message": "Failed to run sql query: ERROR: ..."}
for an error, including an expected RAISE) followed on an error by 'kt-sql: HTTP <code>'. Each session ends with one
marker line written from the database clock:
  session A: attach commits and answers a row {t_start, t_hold, t_end, txn}; c6g_skip / c6g_wait RAISE 'P_A {json}'.
  session B: RAISE 'P_B {json}' with t_start (after the gate), t_end and the case's value (fenced / answer).
Session A's marker is required as well as session B's: an A that failed, timed out or ran in more than one transaction
gives INCONCLUSIVE, never PASS, never FAIL, never CAUGHT. So does a missing or unreadable time, and session B not
starting inside A's hold with at least OVERLAP_S seconds of it left. With overlap measured, "waited" (B ended after A's
hold ended, i.e. after A's locks) is decided by the locks alone, so timing cannot make correct code FAIL.
"""
import json
import re
import sys
from datetime import datetime

OVERLAP_S = 1.5  # B must start at least this long before A's hold ends (hold 4 s, launch offset 1 s: ~3 s expected)
CASES = {'attach': 'single_statement_fence', 'c6g_skip': 'no_skip_locked', 'c6g_wait': 'read_before_lock'}


def body(path):
    """(rows, message): the JSON rows of a success, or the message text of an error; (None, None) when unreadable."""
    t = open(path, encoding='utf-8').read()
    b = t.split('\nkt-sql:')[0].strip()
    try:
        v = json.loads(b)
    except Exception:
        return None, None
    if isinstance(v, list):
        return v, None
    if isinstance(v, dict) and isinstance(v.get('message'), str):
        return None, v['message']
    return None, None


def marker(path, name):
    """The JSON object a session RAISEd as '<name> {...}', or None."""
    _, msg = body(path)
    if msg is None:
        return None
    m = re.search(r'\b' + name + r' (\{.*)', msg)
    if not m:
        return None
    try:
        v = json.loads(m.group(1).split('\n')[0])
    except Exception:
        return None
    return v if isinstance(v, dict) else None


def ts(x):
    """'2026-11-23 10:00:00.12+00' (PostgreSQL text) or '2026-11-19T00:22:25.109459+00:00' (jsonb) -> aware datetime."""
    m = re.fullmatch(r'(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)', str(x or ''))
    if not m:
        return None
    frac = (m.group(3) or '0').ljust(6, '0')
    tz = m.group(4)
    tz = '+00:00' if tz == 'Z' else (tz if ':' in tz else (tz + ':00' if len(tz) == 3 else tz[:3] + ':' + tz[3:]))
    try:
        return datetime.fromisoformat(f'{m.group(1)}T{m.group(2)}.{frac}{tz}')
    except ValueError:
        return None


def verdict(case, mut, fa, fb):
    if case not in CASES:
        return f'INCONCLUSIVE: unknown case {case}'
    if mut and mut != CASES[case]:
        return f'INCONCLUSIVE: {case} has no mutant {mut}'
    if case == 'attach':
        rows, msg = body(fa)
        a = rows[-1] if rows and isinstance(rows[-1], dict) else None
        if a is None or a.get('txn') != 'one':
            return 'INCONCLUSIVE: session A did not answer its row from one transaction ' + str(msg or rows)[:200]
    else:
        a = marker(fa, 'P_A')
        if a is None:
            return 'INCONCLUSIVE: session A did not end with its P_A marker ' + str(body(fa)[1] or body(fa)[0])[:200]
    b = marker(fb, 'P_B')
    if b is None:
        return 'INCONCLUSIVE: session B did not end with its P_B marker ' + str(body(fb)[1] or body(fb)[0])[:200]
    a_hold = ts(a.get('t_hold') or a.get('t_start'))
    a_end, b_start, b_end = ts(a.get('t_end')), ts(b.get('t_start')), ts(b.get('t_end'))
    if None in (a_hold, a_end, b_start, b_end):
        return 'INCONCLUSIVE: a session start or end time is missing or unreadable'
    left = (a_end - b_start).total_seconds()
    if not (a_hold <= b_start and left >= OVERLAP_S):
        return f'INCONCLUSIVE: no measured overlap (B started {left:.3f} s before A hold end; needs {OVERLAP_S})'
    waited = b_end > a_end
    if case == 'attach':
        if not isinstance(b.get('fenced'), bool):
            return 'INCONCLUSIVE: P_B lacks fenced'
        passing, failing = waited and b['fenced'] is False, b['fenced'] is True
    elif case == 'c6g_skip':
        ans = b.get('answer')
        if not isinstance(ans, dict):
            return 'INCONCLUSIVE: P_B lacks answer'
        passing, failing = (not waited) and ans.get('state') == 'skipped', waited
    else:
        passing, failing = waited, not waited
    if mut:
        return 'CAUGHT' if failing else 'NOT_CAUGHT'
    return 'PASS' if passing else 'FAIL'


def precheck(path, case):
    rows, msg = body(path)
    if not rows or not isinstance(rows[-1], dict):
        return False, 'precheck failed: ' + str(msg)[:200]
    r = rows[-1]
    try:
        by_id, by_pat, mut, runs, total, orph = (int(r[k]) for k in ('by_id', 'by_pattern', 'mutants', 'marked_runs', 'auth_users', 'orphans'))
    except (KeyError, TypeError, ValueError):
        return False, 'precheck row unreadable: ' + json.dumps(r)[:200]
    why = [w for w, bad in ((f'{by_id} auth user(s) already have the fixture id', by_id),
                            (f'{by_pat} p4263c-*@example.test fixture user(s) exist', by_pat),
                            (f'{mut} public.*_m4263 function(s) exist', mut),
                            (f'{runs} cloud_blob_erase_runs row(s) marked p4263c exist', runs),
                            (f'{orph} unreferenced blobs older than 24 h (attach needs fewer than 900, or blob X may not be listed)',
                             case == 'attach' and orph >= 900)) if bad]
    if why:
        return False, '; '.join(why) + '; nothing was created'
    return True, f'ok auth_users={total}'


def applied(name, path):
    rows, msg = body(path)
    m = rows[-1].get('m') if rows and isinstance(rows[-1], dict) else None
    if not (isinstance(m, str) and re.fullmatch(r'[0-9a-f]{32}', m)):
        return f'ERROR: {name} not proven created: {msg or ("md5 " + repr(m))}'[:300]
    return f'MUTATION APPLIED {name} md5 {m}'


def fkcounts(label, path):
    rows, msg = body(path)
    if rows is None or not all(isinstance(x, dict) and {'tbl', 'col', 'n'} <= set(x) for x in rows):
        return [f'  {label}: per-table counts unreadable ({msg or "unexpected rows"})'[:300], 'unreadable'], False
    try:
        nz = [(x['tbl'], x['col'], int(x['n'])) for x in rows]
    except (TypeError, ValueError):
        return [f'  {label}: per-table counts unreadable', 'unreadable'], False
    lines = [f'  {label}: {len(nz)} columns reference auth.users; non-zero:']
    lines += [f'    {t}.{c}: {n}' for t, c, n in nz if n] or ['    none']
    return lines + [str(sum(n for _, _, n in nz))], True


if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) == 3 and a[0] == 'precheck':
        ok, out = precheck(a[1], a[2])
        print(out.replace('\n', ' '))
        sys.exit(0 if ok else 1)
    if len(a) == 3 and a[0] == 'applied':
        out = applied(a[1], a[2]).replace('\n', ' ')
        print(out)
        sys.exit(0 if out.startswith('MUTATION APPLIED ') else 1)
    if len(a) == 3 and a[0] == 'fkcounts':
        lines, ok = fkcounts(a[1], a[2])
        print('\n'.join(lines))
        sys.exit(0 if ok else 1)
    out = (verdict(*a) if len(a) == 4 else 'INCONCLUSIVE: usage').replace('\n', ' ')
    print(out)
    sys.exit(0 if out in ('PASS', 'CAUGHT') else 1)
