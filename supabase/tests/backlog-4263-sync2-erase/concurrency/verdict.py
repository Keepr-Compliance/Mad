#!/usr/bin/env python3
"""Verdict of one erase two-session case, from the kt-sql outputs (BACKLOG-4263 sync plan P3).

usage: verdict.py <attach|c6g_skip|c6g_wait> <mutant name or ''> <a.out> <b.out>
       verdict.py precheck <pre.out> <case>   -> 'ok auth_users=<n> ...' (exit 0) or the refusal (exit 1)
       verdict.py summary <file.out>          -> one line that never carries row values (error: SQLSTATE only)
       verdict.py applied <name> <md5.out>    -> 'MUTATION APPLIED <name> md5 <x>' or ERROR (the create left no body)
       verdict.py fkcounts <label> <fk.out>   -> one line per table holding rows of the fixture user, then 'total=<n> setnull=<m>'
Prints one line. Exit 0 only for PASS (pristine) or CAUGHT (mutant).

       verdict.py col <key> < out             -> one value of the call's tagged answer (run.sh's reader)
A transport output is one JSON line (an array of rows, or {"message": "Failed to run sql query: ERROR: ..."} for an
error, including an expected RAISE) and on an error 'kt-sql: HTTP <code>'; stderr may be captured with stdout. A call
that does not RAISE answers with one tagged json (final SELECT ... AS a); tagged() reads it from both row shapes (the
final SELECT's column, or every statement's output line). Each session ends with one
marker line written from the database clock:
  session A: attach commits and answers a row {t_start, t_hold, t_end, txn}; c6g_skip / c6g_wait RAISE 'P_A {json}'.
  session B: RAISE 'P_B {json}' with t_start (after the gate), t_end and the case's value (fenced / answer).
Session A's marker is required as well as session B's: an A that failed, timed out or ran in more than one transaction
gives INCONCLUSIVE, never PASS, never FAIL, never CAUGHT. So does a missing or unreadable time, and session B not
starting inside A's hold with at least OVERLAP_S seconds of it left. With overlap measured, "waited" (B ended after A's
hold ended, i.e. after A's locks) is decided by the locks alone, so timing cannot make correct code FAIL.
"""
import json
import os
import re
import sys
import tempfile
from datetime import datetime

SWITCH_WAIT_S = 0.5  # c6g_skip: B's own writes before the scrub must not wait longer than this
OVERLAP_S = 1.5  # B must start at least this long before A's hold ends (hold 4 s, launch offset 1 s: ~3 s expected)
CASES = {'attach': 'single_statement_fence', 'c6g_skip': 'no_skip_locked', 'c6g_wait': 'read_before_lock'}


def envelope(path):
    """The transport's JSON line: the first line of the output that parses as a JSON array or object (stderr may be
    captured with stdout, in any order, so other lines are skipped). None when there is none."""
    for line in open(path, encoding='utf-8').read().replace('\r\n', '\n').split('\n'):
        line = line.strip()
        if line[:1] in ('[', '{'):
            try:
                v = json.loads(line)
            except ValueError:
                continue
            if isinstance(v, (list, dict)):
                return v
    return None


def tagged(rows_):
    """The last tagged answer {"tag": ...} among a call's rows. Two row shapes, one answer: a transport that returns
    the final SELECT's json column as {"a": {...}} (or {"a": "<json text>"}), and one that returns every output line of
    every statement as {"line": "<text>"}."""
    for r in reversed(rows_):
        if not isinstance(r, dict):
            continue
        for key in ('a', 'line'):
            v = r.get(key)
            if isinstance(v, str):
                try:
                    v = json.loads(v)
                except ValueError:
                    v = None
            if isinstance(v, dict) and 'tag' in v:
                return v
    return None


def body(path):
    """(rows, message): the JSON rows of a success, or the message text of an error; (None, None) when unreadable."""
    v = envelope(path)
    if isinstance(v, list):
        return v, None
    if isinstance(v, dict) and isinstance(v.get('message'), str):
        return None, v['message']
    return None, None


def answer(path, tag=None):
    rows_, msg = body(path)
    a = tagged(rows_) if rows_ else None
    if a is None or (tag and a.get('tag') != tag):
        return None
    return a


SAFE = re.compile(r'(P_GATE_TIMEOUT|canceling statement due to (lock|statement) timeout|deadlock detected)')


def safe(path):
    """A one-line description of a kt-sql output that never carries row values: for a session's own marker its JSON
    (times and fixture-only values); for any other error only the SQLSTATE and, when it is one of the gate / lock /
    deadlock messages, that message; otherwise '(message withheld)'. A row answer prints its column names only."""
    rows_, msg = body(path)
    if rows_ is not None:
        a = tagged(rows_)
        if a is not None:
            return f"answer {a.get('tag')}, keys {', '.join(sorted(k for k in a if k != 'tag'))}"
        return f'{len(rows_)} row(s), no tagged answer'
    if msg is None:
        return 'no readable answer'
    for name in ('P_A', 'P_B'):
        m = marker(path, name)
        if m is not None:
            return f'{name} ' + json.dumps(m)[:600]
    st = re.search(r'ERROR:\s+([0-9A-Z]{5}):', msg)
    known = SAFE.search(msg)
    return f'error SQLSTATE {st.group(1) if st else "unknown"}' + (f': {known.group(1)}' if known else ' (message withheld)')


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
        a = answer(fa, 'attach_a')
        if a is None or a.get('txn') != 'one':
            return 'INCONCLUSIVE: session A did not answer its row from one transaction: ' + safe(fa)
    else:
        a = marker(fa, 'P_A')
        if a is None:
            return 'INCONCLUSIVE: session A did not end with its P_A marker: ' + safe(fa)
    b = marker(fb, 'P_B')
    if b is None:
        return 'INCONCLUSIVE: session B did not end with its P_B marker: ' + safe(fb)
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
        t_scrub = ts(b.get('t_scrub'))
        if t_scrub is None:
            return 'INCONCLUSIVE: P_B lacks t_scrub'
        if (t_scrub - b_start).total_seconds() > SWITCH_WAIT_S:
            return (f'INCONCLUSIVE: session B waited {(t_scrub - b_start).total_seconds():.3f} s before its scrub '
                    '(the switch row was held by someone else)')
        passing, failing = (not waited) and ans.get('state') == 'skipped', waited
    else:
        passing, failing = waited, not waited
    if mut:
        return 'CAUGHT' if failing else 'NOT_CAUGHT'
    return 'PASS' if passing else 'FAIL'


def fk_rows(x):
    """[(table, column, on-delete action, n)] from fk-counts rows, or None when unreadable."""
    if not isinstance(x, list) or not x:
        return None
    try:
        return [(str(r['tbl']), str(r['col']), str(r.get('del', '')), int(r['n'])) for r in x]
    except (KeyError, TypeError, ValueError):
        return None


def fk_lines(label, fk):
    total = sum(n for _, _, _, n in fk)
    kept = sum(n for _, _, d, n in fk if d in ('n', 'd'))
    lines = [f'  {label}: {len(fk)} columns reference auth.users; non-zero:']
    lines += [f'    {t}.{c}: {n}' + (' (ON DELETE SET NULL/DEFAULT: stays behind with the id cleared)' if d in ('n', 'd') else '')
              for t, c, d, n in fk if n] or ['    none']
    return lines + [f'total={total} setnull={kept}']


def probe(r, need):
    """(ok, line) for the first call's tagged answer. ok only when it proves one call = one transaction (a local setting
    set by an earlier statement is still visible), read committed, readable per-table counts that are all 0, and nothing
    left behind."""
    if r.get('txn') != 'one':
        return False, f"one call = one transaction NOT proven (txn {r.get('txn')!r}); nothing was created"
    if r.get('iso') != 'read committed':
        return False, f"isolation is {r.get('iso')!r}, not read committed; nothing was created"
    try:
        by_id, by_pat, mut, total = (int(r[k]) for k in ('by_id', 'by_pattern', 'mutants', 'auth_users'))
    except (KeyError, TypeError, ValueError):
        return False, 'probe row unreadable: ' + json.dumps(r)[:200]
    fk = fk_rows(r.get('fk'))
    why = [(f'{by_id} auth user(s) already have the fixture id', by_id),
           (f'{by_pat} fixture user(s) exist: {r.get("pattern_emails")}', by_pat),
           (f'{mut} public.*_m4263 function(s) exist: {r.get("mutant_names")}', mut),
           ('the per-table count query is unreadable', fk is None),
           (f'{sum(n for *_, n in fk or [])} rows already reference the fixture id', fk is not None and any(n for *_, n in fk))]
    why += [(w, bad) for w, bad in need(r)]
    why = [w for w, bad in why if bad]
    if why:
        return False, '; '.join(why) + '; nothing was created'
    return True, (f"ok auth_users={total} one_computer={r.get('one_computer') is True} txn=one iso=read_committed "
                  f"track_activity_query_size={r.get('track_size')} bypassrls={r.get('bypassrls')} orphans={r.get('orphans', '-')} "
                  f"fk_columns={len(fk)}")


def timing(case, fa, fb):
    """One line of the measured times (database clock), for the record; never part of the verdict."""
    a = answer(fa, 'attach_a') if case == 'attach' else marker(fa, 'P_A')
    b = marker(fb, 'P_B')
    if not a or not b:
        return 'timing: unreadable'
    t = {k: ts(v) for k, v in (('a0', a.get('t_start')), ('ah', a.get('t_hold') or a.get('t_start')), ('ae', a.get('t_end')),
                                ('b0', b.get('t_start')), ('be', b.get('t_end')))}
    if None in t.values():
        return 'timing: unreadable'
    s = lambda x, y: f"{(t[y] - t[x]).total_seconds():.3f}"
    return (f"timing: session A {s('a0', 'ae')} s (hold {s('ah', 'ae')} s); session B {s('b0', 'be')} s; "
            f"overlap: B started {s('b0', 'ae')} s before A's hold ended; B ended {s('ae', 'be')} s after it")


def precheck(path, case):
    a = answer(path, 'probe')
    if a is None:
        return False, 'precheck failed: ' + safe(path)

    def need(r):
        try:
            runs, orph = int(r['marked_runs']), int(r['orphans'])
        except (KeyError, TypeError, ValueError):
            return [('probe row unreadable (marked_runs / orphans)', True)]
        return [(f'{runs} cloud_blob_erase_runs row(s) marked p4263c exist', runs),
                (f'{orph} unreferenced blobs older than 24 h (attach needs fewer than 900, or blob X may not be listed)',
                 case == 'attach' and orph >= 900)]
    return probe(a, need)


def applied(name, path):
    a = answer(path, 'md5')
    m = a.get('m') if a else None
    if not (isinstance(m, str) and re.fullmatch(r'[0-9a-f]{32}', m)):
        return f'ERROR: {name} not proven created: {safe(path)} (md5 {m!r})'[:300]
    return f'MUTATION APPLIED {name} md5 {m}'


def fkcounts(label, path):
    a = answer(path, 'fkcount')
    fk = fk_rows(a.get('fk')) if a else None
    if fk is None:
        return [f'  {label}: per-table counts unreadable ({safe(path)})', 'unreadable'], False
    return fk_lines(label, fk), True


if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) == 2 and a[0] == 'col':
        with tempfile.NamedTemporaryFile('w', delete=False) as fh:
            fh.write(sys.stdin.read())
        try:
            v = answer(fh.name)
        finally:
            os.unlink(fh.name)
        if v is None or a[1] not in v:
            sys.exit(1)
        print(v[a[1]])
        sys.exit(0)
    if len(a) == 3 and a[0] == 'precheck':
        ok, out = precheck(a[1], a[2])
        print(out.replace('\n', ' '))
        sys.exit(0 if ok else 1)
    if len(a) == 3 and a[0] == 'applied':
        out = applied(a[1], a[2]).replace('\n', ' ')
        print(out)
        sys.exit(0 if out.startswith('MUTATION APPLIED ') else 1)
    if len(a) == 4 and a[0] == 'timing':
        print(timing(a[1], a[2], a[3]))
        sys.exit(0)
    if len(a) == 2 and a[0] == 'summary':
        print(safe(a[1]).replace('\n', ' '))
        sys.exit(0)
    if len(a) == 3 and a[0] == 'fkcounts':
        lines, ok = fkcounts(a[1], a[2])
        print('\n'.join(lines))
        sys.exit(0 if ok else 1)
    out = (verdict(*a) if len(a) == 4 else 'INCONCLUSIVE: usage').replace('\n', ' ')
    print(out)
    sys.exit(0 if out in ('PASS', 'CAUGHT') else 1)
