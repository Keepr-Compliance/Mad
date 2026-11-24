#!/usr/bin/env python3
"""Verdict of one two-session case, from the kt-sql outputs (BACKLOG-4263 S1).

usage: verdict.py <case> <pristine|mutant> <first.out> <second.out> <state.out> <IA> <IB>
       verdict.py applied <name> <md5.out>    -> 'MUTATION APPLIED <name> md5 <x>' or ERROR (the create left no body)
       verdict.py precheck <pre.out> <need_on> -> 'ok auth_users=<n> one_computer=<b> ...' (exit 0) or the refusal (exit 1)
       verdict.py fkcounts <label> <fk.out>   -> one line per table holding rows of the fixture user, then 'total=<n> setnull=<m>'
Prints one line and exits 0 only for the expected outcome:
  pristine run: PASS (the case's passing shape) or ERROR: <why> / INCONCLUSIVE: <why>
  mutant run:   RED  (the case's own red shape)  or ERROR: <why> / INCONCLUSIVE: <why>
       verdict.py col <key> < out             -> one value of the call's tagged answer (run.sh's reader)
A transport output is one JSON line (an array of rows on success, an object with "message" on an error) and, on an
error, a line 'kt-sql: HTTP <code>'; stderr may be captured with stdout. Every call answers with one tagged json (a
final SELECT ... AS a, or a RAISE for raising sessions); tagged() reads it from both row shapes (the final SELECT's
column, or every statement's output line). Anything that is not the expected tagged answer is ERROR, never a pass and
never a red. Session 1 answers r, t_start, t_hold (after its call, before
its hold) and t_end (after its hold, before its locks are released); session 2 answers r, t_start (after the gate) and
t_end. A missing or unreadable time, or session 2 not starting inside session 1's hold with at least OVERLAP_S seconds
of it left, is INCONCLUSIVE: no PASS and no RED without measured overlap. Waited = session 2 ended after t_end.
"""
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone


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


def answer(path, tag=None):
    """(answer dict, None) or (None, why)."""
    v = envelope(path)
    if v is None:
        return None, 'not JSON: ' + open(path, encoding='utf-8').read()[:200]
    if isinstance(v, dict):
        return None, 'error: ' + str(v.get('message', v))[:300]
    a = tagged(v) if v else None
    if a is None:
        return None, 'no tagged answer row'
    if tag and a.get('tag') != tag:
        return None, f"answer tagged {a.get('tag')!r}, expected {tag!r}"
    return a, None


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
    a, e1 = answer(f1, 'session')
    b, e2 = answer(f2, 'session')
    s, e3 = answer(fs, 'state')
    for name, e in (('session 1', e1), ('session 2', e2), ('state', e3)):
        if e:
            return f'ERROR: {name} {e}'
    st = s.get('j')
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


def precheck(path, need_on):
    r, e = answer(path, 'probe')
    if e:
        return False, f'precheck {e}'
    return probe(r, lambda x: [('the case needs one_computer on and it is off (the coordinator flips it; never flipped here)',
                                need_on == '1' and x.get('one_computer') is not True)])


def fkcounts(label, path):
    r, e = answer(path, 'fkcount')
    fk = None if e else fk_rows(r.get('fk'))
    if fk is None:
        return [f'  {label}: per-table counts unreadable', 'unreadable'], False
    return fk_lines(label, fk), True


def applied(name, path):
    r, e = answer(path, 'md5')
    if e:
        return f'ERROR: mutant {name} not proven applied: {e}'
    m = r.get('m')
    if not (isinstance(m, str) and re.fullmatch(r'[0-9a-f]{32}', m)):
        return f'ERROR: mutant {name} not proven applied: no body (md5 {m!r})'
    return f'MUTATION APPLIED {name} md5 {m}'


def col(key, text):
    """One value of a call's tagged answer, for run.sh; exit 1 when there is none."""
    with tempfile.NamedTemporaryFile('w', delete=False) as fh:
        fh.write(text)
    try:
        a, e = answer(fh.name)
    finally:
        os.unlink(fh.name)
    if e or key not in a:
        return False, None
    return True, a[key]


def timing(f1, f2):
    """One line of the measured times (database clock), for the record; never part of the verdict."""
    a, _ = answer(f1, 'session')
    b, _ = answer(f2, 'session')
    if not a or not b:
        return 'timing: unreadable'
    t = {k: ts(v) for k, v in (('a0', a.get('t_start')), ('ah', a.get('t_hold')), ('ae', a.get('t_end')), ('b0', b.get('t_start')),
                                ('be', b.get('t_end')))}
    if None in t.values():
        return 'timing: unreadable'
    s = lambda x, y: f"{(t[y] - t[x]).total_seconds():.3f}"
    return (f"timing: session 1 {s('a0', 'ae')} s (hold {s('ah', 'ae')} s); session 2 {s('b0', 'be')} s; "
            f"overlap: session 2 started {s('b0', 'ae')} s before the hold ended; session 2 ended {s('ae', 'be')} s after it")


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'col':
        found, v = col(sys.argv[2], sys.stdin.read())
        if not found:
            sys.exit(1)
        print(v)
        sys.exit(0)
    if len(sys.argv) == 4 and sys.argv[1] == 'timing':
        print(timing(sys.argv[2], sys.argv[3]))
        sys.exit(0)
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
