#!/usr/bin/env python3
"""BACKLOG-4265 result-detail rule, run by call_shape.gen_check for every folder whose ENABLED entry is True.

Lane rule: results carry types, keys, counts and SQLSTATEs only.

Checked in the SQL text of a harness folder (comments and single-quoted literals blanked, dollar-quoted bodies read):
  R1  an error handler records SQLSTATE, not the message: SQLERRM appears only as the left operand of a comparison
      with a literal (=, <>, !=, LIKE, NOT LIKE, ILIKE, NOT ILIKE).
  R2  in a result detail -- the second argument of pg_temp.pass(...), the second argument of pg_temp.rec(...), and the
      expression after RETURN 'FAIL -- there is no:
      (a) <variable>::text where the variable is declared jsonb, json or record (or %ROWTYPE) in the same body;
      (b) <call>(...)::text where <call> is not in SAFE_CALLS, or (...)::text after a bare parenthesis;
      (c) a jsonb, json or record variable passed whole to one of WRAPPERS;
      (d) SQLERRM other than in such a comparison.
What it cannot see: a text variable that holds text of another row; a field taken out with ->> or #>>; a value that
reaches the output another way (a temp-table INSERT read back later, a RAISE or NOTICE text); SQL assembled at run
time; and the composed texts a folder lists in COMPOSED (each is checked in its own folder).

`python3 result_detail.py dry <folder>...`   report findings for folders, whether enabled or not (exit 0)
`python3 result_detail.py selftest [--control-green-ok]`   the rule against its own cases
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.abspath(os.path.join(HERE, '..'))

# Switched on per folder. Each folder below is enabled by its own PR, after that folder's sweep; until then its
# findings are reported by `dry` only and its generated files stay as they are.
ENABLED = {
    'backlog-4265': True,
    'backlog-4263-sync2-s1': False,
    'backlog-4263-sync2-s2': False,
    'backlog-4263-sync2-t': False,
    'backlog-4263-sync2-n': False,
    'backlog-4263-sync2-erase': False,
    'backlog-4266': False,
}
# texts a folder composes from another folder, removed (exact text) before its own files are read
COMPOSED = {'backlog-4265': ['backlog-4263-sync2-t/lib/helpers.sql', 'backlog-4263-sync2-t/lib/fixtures.sql']}
SAFE_CALLS = {'jsonb_build_object', 'json_build_object', 'count', 'cardinality', 'length', 'char_length', 'octet_length',
              'array_length', 'jsonb_array_length', 'json_array_length', 'has_table_privilege', 'has_sequence_privilege',
              'has_function_privilege', 'has_any_column_privilege', 'has_schema_privilege', 'pg_has_role', 'md5',
              'jsonb_typeof', 'json_typeof'}
WRAPPERS = {'jsonb_build_object', 'json_build_object', 'jsonb_build_array', 'json_build_array', 'to_jsonb', 'to_json',
            'row_to_json', 'concat', 'concat_ws', 'format', 'left', 'right', 'substr', 'substring'}


def blank(sql):
    """comments and the inside of single-quoted literals replaced by spaces (newlines kept); dollar bodies kept"""
    out, i, n = [], 0, len(sql)
    while i < n:
        if sql.startswith('--', i):
            j = sql.find('\n', i)
            j = n if j < 0 else j
            out.append(' ' * (j - i))
            i = j
            continue
        if sql.startswith('/*', i):
            depth, j = 0, i
            while j < n:
                if sql.startswith('/*', j):
                    depth += 1
                    j += 2
                elif sql.startswith('*/', j):
                    depth -= 1
                    j += 2
                    if depth == 0:
                        break
                else:
                    j += 1
            out.append(re.sub(r'[^\n]', ' ', sql[i:j]))
            i = j
            continue
        if sql[i] == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'" and sql[j + 1:j + 2] == "'":
                    j += 2
                    continue
                if sql[j] == "'":
                    break
                j += 1
            out.append("'" + re.sub(r'[^\n]', ' ', sql[i + 1:j]) + "'")
            i = j + 1
            continue
        out.append(sql[i])
        i += 1
    return ''.join(out)


def close_paren(t, i):
    """index of the ')' matching the '(' at i"""
    depth = 0
    for j in range(i, len(t)):
        if t[j] == '(':
            depth += 1
        elif t[j] == ')':
            depth -= 1
            if depth == 0:
                return j
    return len(t) - 1


def open_paren(t, j):
    """index of the '(' matching the ')' at j"""
    depth = 0
    for i in range(j, -1, -1):
        if t[i] == ')':
            depth += 1
        elif t[i] == '(':
            depth -= 1
            if depth == 0:
                return i
    return 0


def args(t, i):
    """top-level arguments of the call whose '(' is at i, as (start, end) spans"""
    j = close_paren(t, i)
    out, depth, s = [], 0, i + 1
    for k in range(i + 1, j):
        c = t[k]
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif c == ',' and depth == 0:
            out.append((s, k))
            s = k + 1
    out.append((s, j))
    return out


def bodies(t):
    """(start, end) of every dollar-quoted body, and of the whole text as the outer body"""
    out = [(0, len(t))]
    for m in re.finditer(r'\$([A-Za-z_][A-Za-z_0-9]*)?\$', t):
        tag = m.group(0)
        e = t.find(tag, m.end())
        if e > 0:
            out.append((m.end(), e))
    return out


def declared(body):
    """{variable: type} from the DECLARE sections of one body"""
    out = {}
    for d in re.finditer(r'\bDECLARE\b(.*?)\bBEGIN\b', body, re.I | re.S):
        for item in d.group(1).split(';'):
            m = re.match(r'\s*([a-z_][a-z_0-9]*)\s+([a-z_][a-z_0-9.%]*(\s*\[\])?)', item, re.I)
            if m:
                out[m.group(1).lower()] = m.group(2).lower()
    return out


def is_row(ty):
    return ty in ('jsonb', 'json', 'record') or ty.endswith('%rowtype')


def details(t, raw):
    """(start, end) spans of every result-detail expression; raw is the unblanked text at the same offsets"""
    out = []
    for m in re.finditer(r'pg_temp\.(pass|rec)\s*\(', t, re.I):
        a = args(t, m.end() - 1)
        if len(a) >= 2:
            out.append(a[1])
    for m in re.finditer(r"\bRETURN\s+'FAIL", raw, re.I):
        depth, k = 0, m.start()
        while k < len(t):
            if t[k] == '(':
                depth += 1
            elif t[k] == ')':
                depth -= 1
            elif t[k] == ';' and depth <= 0:
                break
            k += 1
        out.append((m.start(), k))
    return out


def findings(sql):
    """[(line, rule, text)] for one SQL text"""
    t = blank(sql)
    line = lambda i: t.count('\n', 0, i) + 1
    snip = lambda a, b: re.sub(r'\s+', ' ', sql[a:b]).strip()[:140]
    out = []
    for m in re.finditer(r'\bSQLERRM\b', t, re.I):
        if not re.match(r"\s*(=|<>|!=|(NOT\s+)?I?LIKE)\s*'", t[m.end():], re.I):
            out.append((line(m.start()), 'R1 SQLERRM recorded', snip(m.start(), m.end() + 60)))
    for b0, b1 in bodies(t):
        body = t[b0:b1]
        dec = declared(body)
        rows = {v for v, ty in dec.items() if is_row(ty)}
        for d0, d1 in details(body, sql[b0:b1]):
            d = body[d0:d1]
            at = b0 + d0
            for m in re.finditer(r'\b([a-z_][a-z_0-9]*)\s*::\s*text\b', d, re.I):
                if m.group(1).lower() in rows and (m.start() == 0 or d[m.start() - 1] != '.'):
                    out.append((line(at + m.start()), 'R2a row or JSON variable cast to text', snip(at + m.start(), at + m.end())))
            for m in re.finditer(r'\)\s*::\s*text\b', d, re.I):
                o = open_paren(d, m.start())
                name = re.search(r'([a-z_][a-z_0-9.]*)\s*$', d[:o], re.I)
                fn = name.group(1).lower().split('.')[-1] if name else ''
                if fn not in SAFE_CALLS:
                    out.append((line(at + m.start()), 'R2b function result cast to text', snip(at + max(o - 30, 0), at + m.end())))
            for m in re.finditer(r'\b([a-z_][a-z_0-9]*)\s*\(', d, re.I):
                if m.group(1).lower() not in WRAPPERS:
                    continue
                for a0, a1 in args(d, m.end() - 1):
                    if d[a0:a1].strip().lower() in rows:
                        out.append((line(at + a0), 'R2c row or JSON variable passed whole', snip(at + m.start(), at + a1)))
            for m in re.finditer(r'\bSQLERRM\b', d, re.I):
                if re.match(r"\s*(=|<>|!=|(NOT\s+)?I?LIKE)\s*'", d[m.end():], re.I):
                    continue
                out.append((line(at + m.start()), 'R2d SQLERRM in a detail', snip(at + m.start(), at + m.end() + 40)))
    return sorted(set(out))


def folder_files(here):
    out = []
    for dp, _, fs in os.walk(here):
        out += [os.path.join(dp, f) for f in fs if f.endswith('.sql')]
    return sorted(out)


def folder_findings(here):
    name = os.path.basename(os.path.normpath(here))
    removed = [open(os.path.join(TESTS, p), encoding='utf-8').read() for p in COMPOSED.get(name, [])]
    out = []
    for p in folder_files(here):
        text = open(p, encoding='utf-8').read()
        for r in removed:
            # keep the line count: the composed text becomes blank lines
            text = text.replace(r, '\n' * r.count('\n'))
        out += [(os.path.relpath(p, here), *f) for f in findings(text)]
    return out


def check(here):
    """problems for call_shape.gen_check: the folder's findings when its ENABLED entry is True, else none"""
    name = os.path.basename(os.path.normpath(here))
    if not ENABLED.get(name, False):
        return []
    return ['RESULT DETAIL %s:%d %s: %s' % f for f in folder_findings(here)]


CASES = [  # (sql, expected rule prefixes)
    ("DO $x$ BEGIN NULL; EXCEPTION WHEN OTHERS THEN res := 'E ' || SQLSTATE; END $x$;", []),
    ("DO $x$ BEGIN NULL; EXCEPTION WHEN OTHERS THEN res := 'E ' || SQLERRM; END $x$;", ['R1']),
    ("DO $x$ BEGIN NULL; EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'undo' THEN res := SQLSTATE; END IF; END $x$;", []),
    ("DO $x$ BEGIN NULL; EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'u%' THEN res := SQLSTATE; END IF; END $x$;", []),
    ("DO $x$ BEGIN RAISE NOTICE '%', left(SQLERRM, 10); END $x$;", ['R1']),
    ("SELECT 'SQLERRM in a literal';", []),
    ("-- SQLERRM in a comment\nSELECT 1;", []),
    ("CREATE FUNCTION pg_temp.c() RETURNS text LANGUAGE plpgsql AS $c$ DECLARE cl jsonb; BEGIN\n"
     "RETURN pg_temp.pass(true, jsonb_build_object('claim', left(cl::text, 200))::text); END $c$;", ['R2a']),
    ("CREATE FUNCTION pg_temp.c() RETURNS text LANGUAGE plpgsql AS $c$ DECLARE cl jsonb; BEGIN\n"
     "RETURN pg_temp.pass(true, jsonb_build_object('claim', cl)::text); END $c$;", ['R2c']),
    ("CREATE FUNCTION pg_temp.c() RETURNS text LANGUAGE plpgsql AS $c$ DECLARE cl jsonb; BEGIN\n"
     "RETURN pg_temp.pass(true, jsonb_build_object('type', jsonb_typeof(cl), 'ok', cl ->> 'ok')::text); END $c$;", []),
    ("CREATE FUNCTION pg_temp.c() RETURNS text LANGUAGE plpgsql AS $c$ BEGIN\n"
     "RETURN pg_temp.pass(true, public.some_answer()::text); END $c$;", ['R2b']),
    ("CREATE FUNCTION pg_temp.c() RETURNS text LANGUAGE plpgsql AS $c$ BEGIN\n"
     "RETURN pg_temp.pass(true, (1 = 1)::text); END $c$;", ['R2b']),
    ("CREATE FUNCTION pg_temp.c() RETURNS text LANGUAGE plpgsql AS $c$ DECLARE m record; BEGIN\n"
     "RETURN 'FAIL: ' || m::text; END $c$;", ['R2a']),
    ("CREATE FUNCTION pg_temp.c() RETURNS text LANGUAGE plpgsql AS $c$ DECLARE m record; BEGIN\n"
     "RETURN 'FAIL: ' || m.id::text; END $c$;", []),
    ("CREATE FUNCTION pg_temp.c() RETURNS text LANGUAGE plpgsql AS $c$ BEGIN\n"
     "RETURN 'FAIL: ' || count(*)::text; END $c$;", []),
    ("DO $x$ DECLARE r jsonb; BEGIN PERFORM pg_temp.rec('k', to_jsonb(r)); END $x$;", ['R2c']),
    ("DO $x$ DECLARE r jsonb; BEGIN PERFORM pg_temp.rec('k', to_jsonb(r ->> 'state')); END $x$;", []),
]


def selftest(green_ok=False):
    fails = 0
    for i, (sql, want) in enumerate(CASES):
        got = sorted({f[1][:3].strip() for f in findings(sql)})
        if green_ok and want:
            want = []  # the selftest's own control: a red case expected green must make the selftest fail
        ok = got == sorted(want)
        fails += 0 if ok else 1
        print(('ok   ' if ok else 'FAIL ') + f'case {i}: want {want} got {got}')
    print('result-detail selftest: OK' if fails == 0 else f'result-detail selftest: {fails} FAILED')
    return 1 if fails else 0


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['selftest']:
        sys.exit(selftest(green_ok='--control-green-ok' in a))
    if a[:1] == ['dry']:
        for f in a[1:]:
            here = os.path.join(TESTS, f)
            fs = folder_findings(here)
            print(f'{f}: {len(fs)} finding(s), enabled={ENABLED.get(f, False)}')
            for x in fs:
                print('  %s:%d %s' % x[:3])
        sys.exit(0)
    print(__doc__)
    sys.exit(2)
