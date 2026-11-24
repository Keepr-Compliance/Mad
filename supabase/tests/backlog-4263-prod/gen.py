#!/usr/bin/env python3
"""BACKLOG-4263: read-only post-checks for the ten hosted-MCP migrations 20261118100000 .. 20261118190000.

Writes, from the migration files alone:

  postcheck-<version>.sql   one per migration: the catalogue state right after that migration (one SELECT)
  postcheck-final.sql       the state after the last of the ten (each object at its latest definition)
  expected.json             the facts each file pins, the anon-callable list per stage, the predicted failures
  README.md                 what each file checks; which earlier files fail after which later migration

and, in ../backlog-4263-prod-verify/ (TEST DATABASE ONLY, never production; kept apart from the read-only files):

  verify-run.sql            reads only: runs postcheck-final and the ten files once each, ends in RAISE
  verify-controls.sql       breaks the catalogue in one transaction that ends in RAISE; its first statement refuses any
                            database that is not the test database
  README.md

`python3 gen.py guard-control <out>`  writes the refusal control (two mutant guards, then the unmodified controls file)

`python3 gen.py`          writes the files
`python3 gen.py check`    regenerates in memory and fails if any written file differs
`python3 gen.py report <kt-sql output>`  prints a verify-run / verify-controls result and compares it to the prediction

The migrations are parsed statement by statement (comments, quoted strings and dollar-quoted bodies respected).
A function body is the dollar-quoted text exactly as written, which is what PostgreSQL stores in pg_proc.prosrc.
"""
import ast
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
MIGDIR = os.path.join(REPO, 'supabase', 'migrations')
REL = 'supabase/tests/backlog-4263-prod'
FIRST, LAST = '20261118100000', '20261118190000'
md5 = lambda s: hashlib.md5(s.encode('utf-8')).hexdigest()
rd = lambda p: open(os.path.join(REPO, p), encoding='utf-8').read()
lit = lambda s: "'" + s.replace("'", "''") + "'"
C = lambda xs: sorted(xs, key=lambda x: x.encode('utf-8'))  # COLLATE "C" order

# The ten files FIRST .. LAST, then (as the jest tripwire selects them) every later migration that names an mcp_, _mcp_,
# cloud_, _cloud_ or ai_app_ object. postcheck-final.sql stays the state after the ten (production runs it before the
# later ones); postcheck-final-249.sql is the state after the last lane migration.
LANE_OBJECT = re.compile(r'\b_?(mcp|cloud)_\w+|\bai_app_\w+')
TEN = sorted(f for f in os.listdir(MIGDIR) if f.endswith('.sql') and FIRST <= f[:14] <= LAST)
LATER = sorted(f for f in os.listdir(MIGDIR) if f.endswith('.sql') and f[:14] > LAST
               and LANE_OBJECT.search(open(os.path.join(MIGDIR, f), encoding='utf-8').read()))
MIGS = TEN + LATER
VERSIONS = [f[:14] for f in MIGS]
TEN_VERSIONS = [f[:14] for f in TEN]
assert len(TEN) == 10, TEN
F249 = 'final-249'
PRE_LANE = sorted(f for f in os.listdir(MIGDIR) if f.endswith('.sql') and f[:14] < FIRST)


# ------------------------------------------------------------------------------------------------ statement splitter
def split(sql):
    """Top-level statements as (raw, code, dollar_spans). code = raw with top-level comments blanked (same offsets)."""
    code, spans, out = list(sql), [], []
    i, n, start = 0, len(sql), 0
    while i < n:
        if sql.startswith('--', i):
            j = sql.find('\n', i)
            j = n if j < 0 else j
            for k in range(i, j):
                code[k] = ' '
            i = j
            continue
        if sql.startswith('/*', i):
            j = sql.index('*/', i) + 2
            for k in range(i, j):
                if code[k] != '\n':
                    code[k] = ' '
            i = j
            continue
        c = sql[i]
        if c == "'":
            j = i + 1
            while True:
                j = sql.index("'", j)
                if j + 1 < n and sql[j + 1] == "'":
                    j += 2
                    continue
                break
            i = j + 1
            continue
        if c == '"':
            i = sql.index('"', i + 1) + 1
            continue
        if c == '$' and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] == '_')):
            m = re.match(r'\$([A-Za-z_][A-Za-z0-9_]*)?\$', sql[i:])
            if m:
                tag = m.group(0)
                j = sql.index(tag, i + len(tag))
                spans.append((i + len(tag), j))
                i = j + len(tag)
                continue
        if c == ';':
            out.append((start, i + 1))
            start = i + 1
        i += 1
    assert not ''.join(code[start:]).strip(), 'text after the last statement'
    code = ''.join(code)
    return [(sql[s:e], code[s:e], [(a - s, b - s) for a, b in spans if s <= a < e]) for s, e in out]


def paren(text, i):
    """Index of the parenthesis closing the one at text[i] (text has comments blanked; quotes respected)."""
    assert text[i] == '('
    d, j = 0, i
    while True:
        c = text[j]
        if c == "'":
            j = text.index("'", j + 1)
            while text[j + 1:j + 2] == "'":
                j = text.index("'", j + 2)
        elif c == '(':
            d += 1
        elif c == ')':
            d -= 1
            if d == 0:
                return j
        j += 1


def commas(text):
    """Split on top-level commas."""
    parts, d, cur, q = [], 0, '', False
    for c in text:
        if c == "'":
            q = not q
        if not q:
            if c == '(':
                d += 1
            elif c == ')':
                d -= 1
            elif c == ',' and d == 0:
                parts.append(cur)
                cur = ''
                continue
        cur += c
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


ws = lambda s: re.sub(r'\s+', ' ', s).strip()
TYPES = {'timestamptz': 'timestamp with time zone', 'int': 'integer', 'int4': 'integer', 'int8': 'bigint', 'bool': 'boolean',
         'int2': 'smallint', 'varchar': 'character varying'}


def ctype(t):
    t = ws(t).lower()
    arr = t.endswith('[]')
    b = t[:-2].strip() if arr else t
    b = TYPES.get(b, b)
    return b + ('[]' if arr else '')


def arg_types(args):
    out = []
    for a in commas(args):
        a = re.split(r'\s+DEFAULT\s+|\s*=\s*', a, flags=re.I)[0].strip()
        toks = a.split(None, 1)
        assert toks[0].upper() not in ('OUT', 'INOUT', 'VARIADIC', 'IN'), a
        out.append(ctype(toks[1]))
    return out


def sig_of(name, types):
    return f'{name}({",".join(types)})'


KW = {'is', 'null', 'or', 'and', 'not', 'in', 'between', 'date', 'true', 'false', 'char_length'}


def check_cols(expr):
    e = re.sub(r"'(?:[^']|'')*'", ' ', expr)
    ids = [m.group(1) for m in re.finditer(r'\b([a-z_][a-z0-9_]*)\b(?!\s*\()', e, re.I)]
    return C({i for i in ids if i.lower() not in KW})


def check_literals(expr):
    return C({m.group(1).replace("''", "'") for m in re.finditer(r"'((?:[^']|'')*)'", expr)})


def col_def(text):
    """'name type ...' -> (name, type, notnull, rest)."""
    m = re.match(r'(\w+)\s+(.*)$', text, re.S)
    name, rest = m.group(1), m.group(2)
    k = re.search(r'\b(NOT|NULL|DEFAULT|PRIMARY|REFERENCES|CHECK|GENERATED|UNIQUE|CONSTRAINT|COLLATE)\b', rest, re.I)
    typ = ctype(rest[:k.start()] if k else rest)
    notnull = bool(re.search(r'\bNOT\s+NULL\b|\bPRIMARY\s+KEY\b|\bGENERATED\b.*\bIDENTITY\b', rest, re.I))
    return name, typ, notnull, rest


DEL = {'cascade': 'c', 'restrict': 'r', 'set null': 'n', 'set default': 'd', 'no action': 'a'}


def fk_detail(refs):
    m = re.match(r'REFERENCES\s+(\w+)\.(\w+)\s*\(([^)]*)\)\s*(?:ON\s+DELETE\s+(CASCADE|RESTRICT|SET NULL|SET DEFAULT|NO ACTION))?\s*$', ws(refs), re.I)
    assert m, refs
    cols = ','.join(c.strip() for c in m.group(3).split(','))
    return f'{m.group(1)}.{m.group(2)}({cols}) on delete {DEL[(m.group(4) or "no action").lower()]}'


# ------------------------------------------------------------------------------------------------ the model
ALL_ROLES = ('PUBLIC', 'anon', 'authenticated', 'service_role')
ANON9 = sorted(ast.literal_eval(re.search(r'ANON9 = (\{.*?\n\})', rd('supabase/tests/backlog-4263/harness.py'), re.S).group(1)))
FINAL17 = json.loads(rd('supabase/tests/backlog-4263-notice/catalog-facts.json'))['anon_callable_mcp']


def pre_lane_function(name):
    pat = re.compile(r'^CREATE (?:OR REPLACE )?FUNCTION public\.' + re.escape(name) + r'\(', re.M)
    return [f for f in PRE_LANE if pat.search(open(os.path.join(MIGDIR, f), encoding='utf-8').read())]


state = {'fn': {}, 'dropped': set(), 'tables': {}, 'cols': {}, 'cons': {}, 'conexpr': {}, 'idx': {}, 'cron': {}, 'ledger': set(), 'trg': {}}
# data values a migration sets and its post-check pins (one row of a settings table; no personal data): version -> [(name, value)]
DATA_SET = {'20261123150000': [('mcp_settings.notice_version', '2')],
            # BACKLOG-4266: the notice row the exchange must write passes the notice table's provider CHECK for every
            # provider a connection can have; 'equal' when both tables' provider CHECK definitions are the same text
            '20261123170000': [('provider CHECK of ai_app_connect_notices = mcp_connections', 'equal')]}
_PROVIDER_CHECK = lambda t: (f"(SELECT string_agg(pg_catalog.pg_get_constraintdef(k.oid)::text, ' & ' ORDER BY pg_catalog.pg_get_constraintdef(k.oid)::text) "
                             f"FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.{t}'::regclass AND k.contype = 'c' "
                             f"AND k.conkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid = k.conrelid AND a.attname = 'provider')]::smallint[])")
DATA_EXPR = {'mcp_settings.notice_version': '(SELECT s.notice_version::text FROM public.mcp_settings s WHERE s.id)',
             'provider CHECK of ai_app_connect_notices = mcp_connections':
                 f"(SELECT CASE WHEN x.a IS NOT NULL AND x.a = x.b THEN 'equal' ELSE coalesce(x.a, '(none)') || ' <> ' || coalesce(x.b, '(none)') END "
                 f"FROM (SELECT {_PROVIDER_CHECK('ai_app_connect_notices')} AS a, {_PROVIDER_CHECK('mcp_connections')} AS b) x)"}
per = {}          # version -> what the migration touched
default_dep = {}  # assertion id -> why it rests on a default or on state from before the lane
stmt_kinds = {}


def touch(v, kind, key):
    per[v][kind].append(key) if key not in per[v][kind] else None


for f in MIGS:
    v = f[:14]
    per[v] = {'file': f'supabase/migrations/{f}', 'file_md5': md5(rd(f'supabase/migrations/{f}')),
              'fn': [], 'dropped': [], 'tables': [], 'cols': [], 'cons': [], 'idx': [], 'cron': [], 'pretables': [], 'trg': [], 'data': []}
    text = rd(f'supabase/migrations/{f}')
    role = 'postgres'
    stmts = split(text)
    n_create = len(re.findall(r'^\s*CREATE (?:OR REPLACE )?FUNCTION\b', '\n'.join(c for _, c, _ in stmts), re.M | re.I))
    seen_create = 0
    for raw, code, spans in stmts:
        s = ws(code.rstrip().rstrip(';'))
        head = ' '.join(s.split()[:3]).upper()
        if re.match(r'SET ROLE (\w+)$', s, re.I):
            role = re.match(r'SET ROLE (\w+)$', s, re.I).group(1)
            continue
        if re.match(r'RESET ROLE$', s, re.I):
            role = 'postgres'
            continue
        m = re.match(r'\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(', code, re.I)
        if m:
            seen_create += 1
            name = m.group(1)
            close = paren(code, m.end() - 1)
            types = arg_types(code[m.end():close])
            sig = sig_of(name, types)
            a, b = next(sp for sp in spans if sp[0] > close)
            header = ws(code[close + 1:a])
            body = raw[a:b]
            mr = re.match(r'RETURNS (.+?) LANGUAGE (\w+) (.*) AS \$\w*\$$', header, re.I)
            assert mr, (sig, header)
            attrs = mr.group(3).upper()
            vol = 'i' if 'IMMUTABLE' in attrs else 's' if 'STABLE' in attrs else 'v'
            secdef = 'SECURITY DEFINER' in attrs
            assert re.fullmatch(r"(IMMUTABLE |STABLE |VOLATILE )?(SECURITY (DEFINER|INVOKER) )?SET SEARCH_PATH = ''", attrs), (sig, attrs)
            fact = {'md5': md5(body), 'security_definer': str(secdef).lower(), 'volatility': vol, 'language': mr.group(2).lower(),
                    'config': 'search_path=""', 'returns': ctype(mr.group(1)), 'strict': 'false', 'leakproof': 'false', 'parallel': 'u'}
            old = state['fn'].get(sig)
            if old is None:
                pre = pre_lane_function(name)
                execute = {role} | ({'PUBLIC', 'anon', 'authenticated', 'service_role'} if role == 'postgres' else {'PUBLIC'})
                old = {'owner': role, 'execute': execute, 'pre_lane': pre, 'created_in': v}
            state['fn'][sig] = {**old, **fact}
            state['dropped'].discard(sig)
            touch(v, 'fn', sig)
            continue
        m = re.match(r'(GRANT|REVOKE) (.+?) ON (FUNCTION|TABLE|SEQUENCE|SCHEMA) (.+?) (TO|FROM) (.+)$', s, re.I)
        if m:
            verb, priv, kind, obj, _, roles = m.groups()
            roles = [r.strip() for r in roles.split(',')]
            if kind.upper() == 'FUNCTION':
                mo = re.match(r'public\.(\w+)\((.*)\)$', obj)
                sig = sig_of(mo.group(1), [ctype(t) for t in commas(mo.group(2))])
                assert sig in state['fn'], ('grant on a function the lane did not create', sig)
                assert priv.upper() in ('ALL', 'EXECUTE')
                ex = state['fn'][sig]['execute']
                state['fn'][sig]['execute'] = (ex | set(roles)) if verb.upper() == 'GRANT' else (ex - set(roles))
                touch(v, 'fn', sig)
            elif kind.upper() in ('TABLE', 'SEQUENCE'):
                t = obj.replace('public.', '')
                assert verb.upper() == 'REVOKE' and t in state['tables'], s
                privs = state['tables'][t]['privs']
                for r in roles:
                    if priv.upper() == 'ALL':
                        privs.pop(r, None)
                    else:
                        privs.get(r, set()).discard(priv.upper())
            else:
                assert obj == 'public' and priv.upper() == 'CREATE' and roles == ['mcp_reader'], s
            continue
        m = re.match(r'DROP FUNCTION (?:IF EXISTS )?public\.(\w+)\((.*)\)$', s, re.I)
        if m:
            sig = sig_of(m.group(1), [ctype(t) for t in commas(m.group(2))])
            state['fn'].pop(sig, None)
            state['dropped'].add(sig)
            touch(v, 'dropped', sig)
            continue
        m = re.match(r'\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.(\w+)\s*\(', code, re.I)
        if m:
            t = m.group(1)
            close = paren(code, m.end() - 1)
            cols, cons = [], {}
            for d in commas(code[m.end():close]):
                dd = ws(d)
                mc = re.match(r'CONSTRAINT (\w+) (FOREIGN KEY|UNIQUE|PRIMARY KEY|CHECK) \((.*?)\)\s*(.*)$', dd, re.I)
                if mc:
                    cname, ck, ccols, rest = mc.groups()
                    ccols = ','.join(x.strip() for x in ccols.split(','))
                    if ck.upper() == 'FOREIGN KEY':
                        cons[cname] = f'f ({ccols}) ' + fk_detail(rest)
                    elif ck.upper() == 'UNIQUE':
                        cons[cname] = f'u ({ccols})'
                    else:
                        raise AssertionError(dd)
                    continue
                mp = re.match(r'PRIMARY KEY \((.*)\)$', dd, re.I)
                if mp:
                    cons[f'{t}_pkey'] = 'p (' + ','.join(x.strip() for x in mp.group(1).split(',')) + ')'
                    continue
                name, typ, notnull, rest = col_def(d)
                cols.append(f'{name} {typ}' + (' not null' if notnull else ''))
                if re.search(r'\bPRIMARY KEY\b', rest, re.I):
                    cons[f'{t}_pkey'] = f'p ({name})'
                mf = re.search(r'\bREFERENCES\b.*?(?=\bCHECK\b|$)', ws(rest), re.I)
                if mf:
                    cons[f'{t}_{name}_fkey'] = f'f ({name}) ' + fk_detail(mf.group(0))
                ck = re.search(r'\bCHECK\s*\(', rest, re.I)
                if ck:
                    e = rest[ck.end() - 1:paren(rest, ck.end() - 1) + 1]
                    assert f'{t}_{name}_check' not in cons
                    cons[f'{t}_{name}_check'] = f'c ({",".join(check_cols(e))}) [{",".join(check_literals(e))}]'
                    state['conexpr'][f'{t}.{t}_{name}_check'] = e
                assert not re.search(r'\bUNIQUE\b', rest, re.I), d
            assert t not in state['tables']
            state['tables'][t] = {'kind': 'r', 'owner': role, 'rls': False, 'columns': ', '.join(cols), 'policies': '',
                                  'privs': {r: {'ALL'} for r in ('anon', 'authenticated', 'service_role')}, 'created_in': v}
            for cname, val in cons.items():
                state['cons'][f'{t}.{cname}'] = val
                touch(v, 'cons', f'{t}.{cname}')
            touch(v, 'tables', t)
            continue
        m = re.match(r'CREATE SEQUENCE (?:IF NOT EXISTS )?public\.(\w+) AS (\w+)$', s, re.I)
        if m:
            state['tables'][m.group(1)] = {'kind': 'S', 'owner': role, 'privs': {r: {'ALL'} for r in ('anon', 'authenticated', 'service_role')},
                                           'created_in': v, 'seqtype': ctype(m.group(2))}
            touch(v, 'tables', m.group(1))
            continue
        m = re.match(r'CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+) ON public\.(\w+) \((.*?)\)( WHERE .*)?$', s, re.I)
        if m:
            uniq, name, t, icols, where = m.groups()
            icols = ','.join(re.sub(r'\s+(DESC|ASC)$', '', x.strip(), flags=re.I) for x in icols.split(','))
            state['idx'][name] = f'{t} unique={str(bool(uniq)).lower()} ({icols}) partial={str(bool(where)).lower()}'
            touch(v, 'idx', name)
            if t not in state['tables']:
                touch(v, 'pretables', t)
            continue
        m = re.match(r'ALTER TABLE public\.(\w+) (.*)$', s, re.I)
        if m:
            t, rest = m.groups()
            if t not in state['tables']:
                touch(v, 'pretables', t)
            if re.fullmatch(r'ENABLE ROW LEVEL SECURITY', rest, re.I):
                state['tables'][t]['rls'] = True
                continue
            md = re.fullmatch(r'DROP CONSTRAINT IF EXISTS (\w+)', rest, re.I)
            if md:
                state['cons'].pop(f'{t}.{md.group(1)}', None)
                continue
            mc = re.fullmatch(r'ADD CONSTRAINT (\w+) CHECK \((.*)\)', rest, re.I)
            if mc:
                e = '(' + mc.group(2) + ')'
                state['cons'][f'{t}.{mc.group(1)}'] = f'c ({",".join(check_cols(e))}) [{",".join(check_literals(e))}]'
                state['conexpr'][f'{t}.{mc.group(1)}'] = e
                touch(v, 'cons', f'{t}.{mc.group(1)}')
                continue
            if re.match(r'ADD COLUMN', rest, re.I):
                for part in commas(rest):
                    ma = re.match(r'ADD COLUMN (?:IF NOT EXISTS )?(.*)$', part, re.I)
                    assert ma, part
                    name, typ, notnull, _ = col_def(ma.group(1))
                    state['cols'][f'{t}.{name}'] = typ + (' not null' if notnull else '')
                    touch(v, 'cols', f'{t}.{name}')
                continue
            raise AssertionError(('unknown ALTER TABLE', s[:120]))
        m = re.match(r'CREATE (?:OR REPLACE )?TRIGGER (\w+) (BEFORE|AFTER) (\w+) ON public\.(\w+) FOR EACH (ROW|STATEMENT)(?: WHEN \((.*)\))? EXECUTE FUNCTION public\.(\w+)\(\)$', s, re.I)
        if m:
            name, when, ev, t, level, cond, fn = m.groups()
            state['trg'][name] = f'{t} {when.lower()} {ev.lower()} {level.lower()} {fn}() enabled'
            touch(v, 'trg', name)
            if t not in state['tables']:
                touch(v, 'pretables', t)
            continue
        m = re.match(r'DROP TRIGGER (?:IF EXISTS )?(\w+) ON public\.(\w+)$', s, re.I)
        if m:
            state['trg'].pop(m.group(1), None)
            touch(v, 'trg', m.group(1))
            continue
        if re.match(r'LOCK TABLE public\.\w+ IN \w+ MODE$', s, re.I):
            stmt_kinds.setdefault('LOCK', 0)
            stmt_kinds['LOCK'] += 1
            continue
        if head.startswith('DO $'):
            body = raw[spans[0][0]:spans[0][1]]
            assert not re.search(r'CREATE (OR REPLACE )?FUNCTION|CREATE TABLE|CREATE POLICY|GRANT |REVOKE ', body, re.I), (v, s[:60])
            for mc in re.finditer(r"cron\.schedule\('([^']*)', '([^']*)', '([^']*)'\)", body):
                state['cron'][mc.group(1)] = {'schedule': mc.group(2), 'command': mc.group(3), 'username': role}
                touch(v, 'cron', mc.group(1))
            stmt_kinds.setdefault('DO', 0)
            stmt_kinds['DO'] += 1
            continue
        assert not re.match(r'(CREATE|DROP|ALTER|COMMENT|TRUNCATE)\b', s, re.I) or re.match(r'COMMENT ', s, re.I), ('unhandled', v, s[:100])
        assert 'cron.' not in s and 'POLICY' not in s.upper(), s[:100]
        stmt_kinds.setdefault(head.split(' ')[0], 0)
        stmt_kinds[head.split(' ')[0]] += 1
    assert seen_create == n_create, (v, seen_create, n_create)
    for _name, _val in DATA_SET.get(v, []):
        state.setdefault('data', {})[_name] = _val
        touch(v, 'data', _name)
    state['ledger'].add(v)
    per[v]['state'] = json.loads(json.dumps(state, default=lambda o: C(o) if isinstance(o, set) else o))

assert set(stmt_kinds) <= {'DO', 'SET', 'INSERT', 'SELECT', 'COMMENT', 'LOCK'}, stmt_kinds
for t, x in state['tables'].items():
    assert not x['privs'], ('a created table keeps default grants; the check would rest on default privileges', t, x['privs'])


# ------------------------------------------------------------------------------------------------ labels
# Every assertion is MUST HOLD (a difference fails the post-check) unless its kind is in REPORT_ONLY. A report-only
# difference is returned in the report_only column and does not fail the post-check. Only these kinds may be report-only:
REPORT_ONLY = {
    'grants to other roles': 'EXECUTE or table grants to roles other than the owner and PUBLIC, anon, authenticated, service_role, mcp_reader',
    'check definition text': 'full pg_get_constraintdef text of a CHECK (formatting can differ between PostgreSQL versions; the literal set stays MUST HOLD)',
    'index predicate text': 'pg_get_expr text of a partial-index predicate (the partial flag stays MUST HOLD)',
    'pre-lane table grants to service_role': 'service_role grants on tables created before the lane and altered by it (open finding F-12b; '
                                             'measured on keepr-test: all privileges on every such table)',
}
API_ROLES = ('PUBLIC', 'anon', 'authenticated', 'service_role', 'mcp_reader')
NEVER_REPORT_ROLES = ('PUBLIC', 'anon', 'authenticated', 'service_role', 'mcp_reader')
SERVICE_ROLE_EXCEPTION = 'pre-lane table grants to service_role'


def label(kind):
    return 'REPORT ONLY' if kind in REPORT_ONLY else 'MUST HOLD'


def assert_label(i, kind):
    """No assertion about PUBLIC, anon, authenticated or service_role may be report-only (one named service_role exception)."""
    if label(kind) == 'REPORT ONLY':
        for r in NEVER_REPORT_ROLES:
            if re.search(r'(^| )' + r + r'( |$)', i):
                assert r == 'service_role' and kind == SERVICE_ROLE_EXCEPTION, ('API role assertion labelled report-only', i, kind)


# ------------------------------------------------------------------------------------------------ measured on keepr-test
# Report-only texts are formatted by PostgreSQL, so they are taken from the test project (2026-11-19, read-only
# catalogue query) and, for a CHECK an earlier migration wrote with other literals, rebuilt from that text.
MEASURED_CHECKDEF = {
    'mcp_call_log.mcp_call_log_tool_check': "CHECK (((tool IS NULL) OR (tool = ANY (ARRAY['get_status'::text, 'list_deals'::text, 'get_deal'::text, 'get_deal_checklists'::text, 'list_all_deals'::text, 'update_todo'::text, 'add_todo'::text, 'remove_todo'::text, 'restore_todo'::text, 'find_people'::text, 'list_todos'::text]))))",
    'mcp_call_log.mcp_call_log_outcome_check': "CHECK ((outcome = ANY (ARRAY['pending'::text, 'ok'::text, 'not_connected'::text, 'disabled'::text, 'rate_limited'::text, 'busy'::text, 'not_entitled'::text, 'timeout'::text, 'error'::text, 'invalid_input'::text, 'not_found'::text, 'too_large'::text, 'read_only'::text, 'refused'::text])))",
    'cloud_deals.cloud_deals_removed_kind_ck': "CHECK (((removed_kind IS NULL) OR (removed_kind = ANY (ARRAY['deal'::text, 'install'::text]))))",
    'cloud_deal_checklist_items.cloud_deal_checklist_items_due_ck': "CHECK (((due_date IS NULL) OR ((due_date >= '2000-01-01'::date) AND (due_date <= '2100-12-31'::date))))",
    'mcp_connections.mcp_connections_scope_check': "CHECK ((scope = ANY (ARRAY['mcp:read'::text, 'mcp:todos'::text])))",
    'mcp_authorization_requests.mcp_authorization_requests_scope_check': "CHECK ((scope = ANY (ARRAY['mcp:read'::text, 'mcp:todos'::text])))",
    'mcp_write_settings.mcp_write_settings_id_check': 'CHECK (id)',
    'cloud_todo_history.cloud_todo_history_kind_check': "CHECK ((kind = ANY (ARRAY['change'::text, 'conflict'::text])))",
    'cloud_todo_history.cloud_todo_history_part_check': "CHECK ((part = ANY (ARRAY['created'::text, 'done'::text, 'title'::text, 'note'::text, 'due'::text, 'order'::text, 'removed'::text])))",
    'cloud_todo_history.cloud_todo_history_entity_check': "CHECK ((entity = ANY (ARRAY['deal'::text, 'checklist'::text, 'item'::text])))",
    'cloud_todo_history.cloud_todo_history_outcome_check': "CHECK ((outcome = ANY (ARRAY['applied'::text, 'lost'::text, 'unchanged'::text, 'removed'::text, 'restored'::text, 'applied_to_removed'::text, 'held_locked'::text])))",
    'cloud_todo_history.cloud_todo_history_actor_kind_check': "CHECK ((actor_kind = ANY (ARRAY['desktop'::text, 'cloud_user'::text, 'ai_app'::text])))",
    'ai_app_connect_notices.ai_app_connect_notices_status_check': "CHECK ((status = ANY (ARRAY['due'::text, 'sent'::text, 'queued'::text, 'failed'::text, 'skipped'::text])))",
    'ai_app_connect_notices.ai_app_connect_notices_attempts_check': 'CHECK ((attempts >= 0))',
    'ai_app_connect_notices.ai_app_connect_notices_provider_check': "CHECK ((provider = ANY (ARRAY['anthropic'::text, 'openai'::text])))",
    'ai_app_connect_notices.ai_app_connect_notices_last_error_check': 'CHECK (((last_error IS NULL) OR (char_length(last_error) <= 40)))',
}
MEASURED_PREDICATE = {
    'ai_app_connect_notices_due_idx': "(status = 'due'::text)",
    'cloud_deal_checklists_my_items_uq': "((template_id = 'keepr:my-items'::text) AND (removed_at IS NULL) AND (purged_at IS NULL))",
}
# Constraints and partial-index predicates first written by a migration after the ten: NOT measured. Each is the
# measured text of an identical expression above (ai_app_connect_notices, mcp_write_settings) with the table name changed.
PREDICTED_CHECKDEF = {
    'cloud_release_switches.cloud_release_switches_id_check': MEASURED_CHECKDEF['mcp_write_settings.mcp_write_settings_id_check'],
    'cloud_computer_move_notices.cloud_computer_move_notices_status_check': MEASURED_CHECKDEF['ai_app_connect_notices.ai_app_connect_notices_status_check'],
    'cloud_computer_move_notices.cloud_computer_move_notices_attempts_check': MEASURED_CHECKDEF['ai_app_connect_notices.ai_app_connect_notices_attempts_check'],
    'cloud_computer_move_notices.cloud_computer_move_notices_last_error_check': MEASURED_CHECKDEF['ai_app_connect_notices.ai_app_connect_notices_last_error_check'],
    # 20261123140000 (T-S): the provider CHECK's measured text with the column and literals changed; the part CHECK is
    # written in the same form as the measured last_error CHECK (report only, NOT measured)
    'mcp_message_reads.mcp_message_reads_tool_check': "CHECK ((tool = ANY (ARRAY['list_deal_messages'::text, 'get_message'::text])))",
    'mcp_message_reads.mcp_message_reads_channel_check': "CHECK ((channel = ANY (ARRAY['email'::text, 'text'::text])))",
    'mcp_message_reads.mcp_message_reads_part_check': 'CHECK (((part IS NULL) OR (part >= 1)))',
}
PREDICTED_PREDICATE = {
    'cloud_computer_move_notices_due_idx': MEASURED_PREDICATE['ai_app_connect_notices_due_idx'],
}
CHECKDEF_TEXT = {**MEASURED_CHECKDEF, **PREDICTED_CHECKDEF}
PREDICATE_TEXT = {**MEASURED_PREDICATE, **PREDICTED_PREDICATE}
AUTH_FINAL_MEASURED = ['mcp_authorize_approve(text,bytea,text,bytea)', 'mcp_authorize_deny(text,bytea,text)', 'mcp_authorize_view(text,bytea)',
                       'mcp_disconnect(uuid)', 'mcp_disconnect_all_mine()', 'mcp_list_my_connections()']
# report_only the final-state check returns on keepr-test (measured): service_role holds every privilege on the six
# pre-lane tables the lane alters.
lits_ordered = lambda e: [m.group(1).replace("''", "'") for m in re.finditer(r"'((?:[^']|'')*)'", e)]


def checkdef(st, k):
    final = CHECKDEF_TEXT[k]
    if k not in FINAL['conexpr'] or st['conexpr'][k] == FINAL['conexpr'][k]:
        return final
    arr = ', '.join("'" + x.replace("'", "''") + "'::text" for x in lits_ordered(st['conexpr'][k]))
    out, n = re.subn(r'ARRAY\[[^\]]*\]', 'ARRAY[' + arr + ']', final)
    assert n == 1, k
    return out


# ------------------------------------------------------------------------------------------------ pre-lane table grants
def pre_lane_table_grants(t):
    """Grants of PUBLIC/anon/authenticated/mcp_reader on a pre-lane table, replayed from the pre-lane migrations."""
    g = {'PUBLIC': set(), 'anon': {'ALL'}, 'authenticated': {'ALL'}, 'mcp_reader': set()}
    pat = re.compile(r'^\s*(GRANT|REVOKE) ([A-Z, ]+?) ON (?:TABLE )?public\.' + re.escape(t) + r' (TO|FROM) ([\w, ]+);', re.M)
    seen = False
    for f in PRE_LANE:
        for m in pat.finditer(open(os.path.join(MIGDIR, f), encoding='utf-8').read()):
            seen = True
            privs = {p.strip() for p in m.group(2).split(',')}
            for r in (x.strip() for x in m.group(4).split(',')):
                if r in g:
                    g[r] = (g[r] | privs) if m.group(1) == 'GRANT' else (set() if 'ALL' in privs else g[r] - privs)
    assert seen, ('no pre-lane grant statement for', t)
    for r, p in g.items():
        assert 'ALL' not in p, ('pre-lane table keeps a default grant to an API role', t, r)
    return {r: ','.join(C(p)) for r, p in g.items()}


# ------------------------------------------------------------------------------------------------ facts per stage
def anon_list(st):
    out = set(ANON9)
    for sig in st['dropped']:
        out.discard(sig)
    for sig, x in st['fn'].items():
        if sig.startswith('mcp_'):
            (out.add if ({'anon', 'PUBLIC'} & set(x['execute'])) else out.discard)(sig)
    return C(out)


LANE_NEW = {sig for v in VERSIONS for sig in per[v]['fn'] if not per[v]['state']['fn'][sig]['pre_lane']}
AUTH_PRE = [s for s in AUTH_FINAL_MEASURED if s not in LANE_NEW]


def auth_list(st):
    out = set(AUTH_PRE)
    for sig in st['dropped']:
        out.discard(sig)
    for sig, x in st['fn'].items():
        if sig.startswith('mcp_'):
            (out.add if ({'authenticated', 'PUBLIC'} & set(x['execute'])) else out.discard)(sig)
    return C(out)


def sweep_list(st):
    return C(sig for sig, x in st['fn'].items()
             if re.match(r'(ai_app_|_mcp_|_cloud_)', sig) and {'anon', 'authenticated', 'PUBLIC'} & set(x['execute']))


FN_ATTRS = ('md5', 'owner', 'security_definer', 'volatility', 'language', 'config', 'returns', 'strict', 'leakproof', 'parallel')
ANON_ID, AUTH_ID = 'anon-callable mcp_ functions', 'authenticated-callable mcp_ functions'
SWEEP_ID = 'ai_app_/_mcp_/_cloud_ functions executable by anon or authenticated'


def facts(st, keys):
    """id -> (kind, wanted value), for the objects named in keys, at state st."""
    out = {}
    for sig in keys['fn']:
        x = st['fn'].get(sig)
        out[f'function {sig} exists'] = ('function exists', 'true' if x else 'false')
        if x:
            for a in FN_ATTRS:
                out[f'function {sig} {a}'] = (f'function {a}', x[a])
            for r in API_ROLES:
                out[f'function {sig} execute {r}'] = ('function execute api role', str(r in x['execute']).lower())
            out[f'function {sig} execute other roles'] = ('grants to other roles', ','.join(C(set(x['execute']) - set(API_ROLES) - {x['owner']})))
    for sig in keys['dropped']:
        out[f'function {sig} exists'] = ('function exists', 'true' if sig in st['fn'] else 'false')
    for t in keys['tables']:
        x = st['tables'][t]
        out[f'relation {t} kind'] = ('relation kind', x['kind'])
        out[f'relation {t} owner'] = ('relation owner', x['owner'])
        for r in API_ROLES:
            out[f'relation {t} grants {r}'] = ('relation grants api role', '')
        out[f'relation {t} grants other roles'] = ('grants to other roles', '')
        if x['kind'] == 'r':
            out[f'relation {t} rls'] = ('relation rls', str(x['rls']).lower())
            out[f'relation {t} force_rls'] = ('relation force_rls', 'false')
            out[f'relation {t} triggers'] = ('relation triggers', ','.join(C(n for n, d in st['trg'].items() if d.split(' ')[0] == t)))
            out[f'relation {t} policies'] = ('relation policies', x['policies'])
            out[f'relation {t} columns'] = ('relation columns', x['columns'])
        else:
            out[f'relation {t} sequence type'] = ('relation sequence type', x['seqtype'])
    for t in keys['pretables']:
        g = PRE_GRANTS[t]
        for r in API_ROLES:
            if r == 'service_role':
                out[f'table {t} grants service_role'] = (SERVICE_ROLE_EXCEPTION, '')
            else:
                out[f'table {t} grants {r}'] = ('pre-lane table grants api role', g[r])
        out[f'table {t} grants other roles'] = ('grants to other roles', '')
    for k in keys['cols']:
        out[f'column {k}'] = ('column', st['cols'][k])
    for k in keys['cons']:
        out[f'constraint {k}'] = ('constraint', st['cons'].get(k, '(absent)'))
        if k in st['cons'] and st['cons'][k].startswith('c '):
            out[f'constraint {k} definition'] = ('check definition text', checkdef(st, k))
    for k in keys['idx']:
        out[f'index {k}'] = ('index', st['idx'][k])
        if st['idx'][k].endswith('partial=true'):
            out[f'index {k} predicate'] = ('index predicate text', PREDICATE_TEXT[k])
    for k in keys['cron']:
        x = st['cron'][k]
        out[f'cron job {k}'] = ('cron job', f"{x['schedule']} | {x['command']} | {x['username']} | active | this database")
    for v in keys['ledger']:
        out[f'ledger row {v}'] = ('ledger row', 'true')
    for name in keys.get('trg', []):
        out[f'trigger {name}'] = ('trigger', st['trg'].get(name, '(absent)'))
    for name in keys.get('data', []):
        out[f'data {name}'] = ('data value', st['data'][name])
    out[ANON_ID] = ('anon-callable list', ', '.join(anon_list(st)))
    out[AUTH_ID] = ('authenticated-callable list', ', '.join(auth_list(st)))
    out[SWEEP_ID] = ('internal-prefix sweep', ', '.join(sweep_list(st)))
    for i, (kind, _) in out.items():
        assert_label(i, kind)
    return out


def keys_of(v):
    p = per[v]
    return {'fn': p['fn'], 'dropped': [d for d in p['dropped'] if d not in p['fn']], 'tables': p['tables'], 'cols': p['cols'],
            'cons': p['cons'], 'idx': p['idx'], 'cron': p['cron'], 'ledger': [v], 'pretables': p['pretables'], 'trg': p['trg'],
            'data': p['data']}


FINAL = per[LAST]['state']
PRE_GRANTS = {t: pre_lane_table_grants(t) for v in VERSIONS for t in per[v]['pretables']}


def final_keys(versions, st):
    keys = {k: [] for k in ('fn', 'dropped', 'tables', 'cols', 'cons', 'idx', 'cron', 'ledger', 'pretables', 'trg', 'data')}
    for v in versions:
        for k, xs in keys_of(v).items():
            for x in xs:
                if k == 'fn' and x not in st['fn']:
                    k2 = 'dropped'
                elif k == 'dropped' and x in st['fn']:
                    k2 = 'fn'
                else:
                    k2 = k
                if x not in keys[k2]:
                    keys[k2].append(x)
    keys['cons'] = [c for c in keys['cons'] if c in st['cons']]
    return keys


FINAL_KEYS = final_keys(TEN_VERSIONS, FINAL)
FINALS = {'final': (FINAL, FINAL_KEYS)}
if LATER:
    FINALS[F249] = (per[VERSIONS[-1]]['state'], final_keys(VERSIONS, per[VERSIONS[-1]]['state']))
stage_of = lambda k: FINALS[k][0] if k in FINALS else per[k]['state']
keys_at = lambda k: FINALS[k][1] if k in FINALS else keys_of(k)

WANT = {v: facts(per[v]['state'], keys_of(v)) for v in VERSIONS}
for _k, (_st, _keys) in FINALS.items():
    WANT[_k] = facts(_st, _keys)
ALL_KINDS = sorted({kind for w in WANT.values() for kind, _ in w.values()})
assert set(REPORT_ONLY) <= set(ALL_KINDS), set(REPORT_ONLY) - set(ALL_KINDS)

# consistency with what the lane measured on the test project
assert anon_list(FINAL) == C(FINAL17), (anon_list(FINAL), FINAL17)
assert auth_list(FINAL) == C(AUTH_FINAL_MEASURED), auth_list(FINAL)
assert sweep_list(FINAL) == []
assert set(MEASURED_CHECKDEF) == {k for k in FINAL['cons'] if FINAL['cons'][k].startswith('c ') and k in FINAL_KEYS['cons']}, \
    set(MEASURED_CHECKDEF) ^ {k for k in FINAL['cons'] if FINAL['cons'][k].startswith('c ')}
for k, text in MEASURED_CHECKDEF.items():  # the measured text holds exactly the literal set the migration wrote
    assert C(set(lits_ordered(text))) == check_literals(FINAL['conexpr'][k]), k
for k, text in PREDICTED_CHECKDEF.items():  # the predicted text holds exactly the literal set the later migration wrote
    assert C(set(lits_ordered(text))) == check_literals(stage_of(VERSIONS[-1])['conexpr'][k]), k
assert {k for k in stage_of(VERSIONS[-1])['cons'] if stage_of(VERSIONS[-1])['cons'][k].startswith('c ')
        and k not in FINAL['cons']} == set(PREDICTED_CHECKDEF), 'a later CHECK without a predicted text'
_apply100 = rd('supabase/tests/backlog-4263/apply-20261118100000.sql').replace("''", "'")
assert checkdef(per[FIRST]['state'], 'mcp_call_log.mcp_call_log_tool_check') in _apply100, 'rebuilt 100000 tool CHECK text differs from the PR-1 apply file'
known = {'_mcp_r_list_all_deals(text,date,date,uuid)': '6ea286c67274464080b19fa439b5d9ac',
         'mcp_list_all_deals(text,bytea,text,text,text,text,text)': '5b12fa79e9f010af2c7c8752f23d3c9c'}
for v, sig, k in (('20261118190000', 'mcp_register_client(text,text,text,text[],bytea)', 'register_md5_after'),
                  ('20261118190000', 'mcp_refresh(text,bytea,text,text,bytea,bytea)', 'refresh_md5_after'),
                  ('20261118190000', '_mcp_prune_unused_clients()', 'cleanup_md5')):
    known[sig + '@' + v] = json.loads(rd('supabase/tests/backlog-4263-bounds/catalog-facts.json'))[k]
for k, want in known.items():
    sig, _, v = k.partition('@')
    got = per[v or FIRST]['state']['fn'][sig]['md5']
    assert got == want, (k, got, want)


def predicted_diffs(k, j, must_only=True):
    """ids of postcheck k whose wanted value differs in the state right after migration j."""
    st = stage_of(j)
    now = facts(st, keys_at(k))
    gone = {i.rsplit(' ', 1)[0] for i in WANT[k] if i.endswith(' exists') and now.get(i, (0, ''))[1] == 'false' and WANT[k][i][1] == 'true'}
    bad = [i for i, (kind, w) in WANT[k].items() if (i not in now or now[i][1] != w) and (label(kind) == 'MUST HOLD') == must_only]
    return [i for i in bad if not (i.startswith('function ') and not i.endswith(' exists')
                                   and any(i.startswith(g + ' ') for g in gone))]


predicted_failures = predicted_diffs
PRED = {k: {j: predicted_diffs(k, j) for j in VERSIONS if j > k} for k in VERSIONS}
# what report_only returns on keepr-test where nothing else differs: the service_role grants on pre-lane tables
# plus, for a file run after later migrations, the report-only pins those migrations changed (the tool CHECK text)
TEST_REPORT = {k: sorted({i for i, (kind, _) in WANT[k].items() if kind == SERVICE_ROLE_EXCEPTION}
                         | set(predicted_diffs(k, 'final', must_only=False) if k != 'final' else [])) for k in ['final'] + TEN_VERSIONS}
LAST_FINAL = F249 if LATER else 'final'
for k in [v for v in VERSIONS if v not in TEN_VERSIONS] + ([F249] if LATER else []):
    TEST_REPORT[k] = sorted({i for i, (kind, _) in WANT[k].items() if kind == SERVICE_ROLE_EXCEPTION}
                            | set(predicted_diffs(k, F249, must_only=False) if k != F249 else []))

SUPERSEDED = {}
for k in VERSIONS:
    for i in predicted_diffs(k, LAST_FINAL):
        if i.endswith(' md5'):
            sig = i[len('function '):-len(' md5')]
            later = [j for j in VERSIONS if j > k and sig in per[j]['fn']]
            assert later and WANT[k][i][1] in rd(per[later[0]]['file']), ('superseded body md5 not required by the replacing migration', k, sig)
            SUPERSEDED[f'{k} {sig}'] = {'md5': WANT[k][i][1], 'pre_check_of': later[0]}

PRE_LANE_PREFIXED = {}
for sig, x in FINAL['fn'].items():
    name = sig.split('(')[0]
    if re.match(r'(ai_app_|_mcp_|_cloud_)', name) and x['pre_lane']:
        hits = [f[:14] for f in PRE_LANE if re.search(r'^REVOKE ALL ON FUNCTION public\.' + re.escape(name) + r'\([^)]*\) FROM PUBLIC, anon, authenticated',
                                                       open(os.path.join(MIGDIR, f), encoding='utf-8').read(), re.M)]
        assert hits, ('pre-lane prefixed function with no pre-lane revoke', sig)
        PRE_LANE_PREFIXED[sig] = hits


# ------------------------------------------------------------------------------------------------ SQL
def values(name, cols, rows):
    n = len(cols.split(','))
    if rows:
        return f"{name}({cols}) AS (VALUES\n    " + ',\n    '.join(rows) + ')'
    return f"{name}({cols}) AS (SELECT {', '.join(['NULL::text'] * n)} WHERE false)"


row = lambda *xs: '(' + ', '.join(lit(x) for x in xs) + ')'


def render(k):
    keys = keys_at(k)
    want = {i: w for i, (_, w) in WANT[k].items()}
    st = stage_of(k)
    fn_rows, fx_rows = [], []
    for sig in keys['fn']:
        fn_rows.append(row('public.' + sig, *[want[f'function {sig} {a}'] for a in FN_ATTRS]))
        for r in API_ROLES:
            fx_rows.append(row('public.' + sig, r, want[f'function {sig} execute {r}'], 'function execute api role'))
        fx_rows.append(row('public.' + sig, '*', want[f'function {sig} execute other roles'], 'grants to other roles'))
    gone_rows = [row('public.' + s) for s in keys['dropped']]
    rel_rows, rx_rows = [], []
    for t in keys['tables']:
        x = st['tables'][t]
        rel_rows.append(row(t, x['kind'], x['owner'], str(x.get('rls', False)).lower(), x.get('columns', ''), x.get('seqtype', '')))
        for r in API_ROLES:
            rx_rows.append(row(t, 'relation', r, '', 'relation grants api role'))
        rx_rows.append(row(t, 'relation', '*', '', 'grants to other roles'))
    for t in keys['pretables']:
        for r in API_ROLES:
            kind = SERVICE_ROLE_EXCEPTION if r == 'service_role' else 'pre-lane table grants api role'
            rx_rows.append(row(t, 'table', r, WANT[k][f'table {t} grants {r}'][1], kind))
        rx_rows.append(row(t, 'table', '*', '', 'grants to other roles'))
    col_rows = [row(c.split('.')[0], c.split('.')[1], want['column ' + c]) for c in keys['cols']]
    con_rows = [row(c.split('.')[0], c.split('.')[1], want['constraint ' + c]) for c in keys['cons']]
    cdef_rows = [row(c.split('.')[0], c.split('.')[1], want[f'constraint {c} definition']) for c in keys['cons'] if f'constraint {c} definition' in want]
    idx_rows = [row(i, want['index ' + i]) for i in keys['idx']]
    pred_rows = [row(i, want[f'index {i} predicate']) for i in keys['idx'] if f'index {i} predicate' in want]
    cron_rows = [row(j, want['cron job ' + j]) for j in keys['cron']]
    led_rows = [row(v) for v in keys['ledger']]
    trg_rows = [row(n, want['trigger ' + n].split(' ')[0], want['trigger ' + n]) for n in keys.get('trg', [])]
    dat_rows = [row(n, want['data ' + n]) for n in keys.get('data', [])]
    anon_rows = [row('public.' + s) for s in anon_list(st)]
    auth_rows = [row('public.' + s) for s in auth_list(st)]
    sweep_rows = [row('public.' + s) for s in sweep_list(st)]
    rule_rows = [f"({lit(kind)}, {'false' if kind in REPORT_ONLY else 'true'})" for kind in ALL_KINDS
                 if kind not in NEW_KINDS or any(kd == kind for kd, _ in WANT[k].values())]
    n_must = sum(1 for kind, _ in WANT[k].values() if label(kind) == 'MUST HOLD')
    n_rep = len(WANT[k]) - n_must
    head = f"""-- postcheck-{k}.sql  (generated by {REL}/gen.py; do not hand-edit)
-- """ + (f"""State right after migration {per[k]['file']}
--   (migration file md5 {per[k]['file_md5']}). Run it right after that migration, before the next one.""" if k not in FINALS else
           """State after all ten migrations 20261118100000 .. 20261118190000 (each object at its latest definition).""" if k == 'final' else
           f"""State after every lane migration through {VERSIONS[-1]} (each object at its latest definition); the 2.49 final.""") + f"""
-- Read-only: one SELECT over pg_catalog, cron.job and supabase_migrations.schema_migrations.
-- Returns one row (postcheck, report_only). postcheck = 'ok' when every MUST HOLD assertion holds; report_only lists the
-- differences of the REPORT ONLY assertions ('' when none). A MUST HOLD difference fails with:
--   invalid input syntax for type integer: "POSTCHECK {k} FAILED: <id>: want <x>, got <y> | ... || REPORT ONLY: ..."
-- Assertions: {n_must} MUST HOLD, {n_rep} REPORT ONLY (labels: the rule CTE; README.md).
"""
    ctes = [values('fn', 'sig, md5, owner, secdef, vol, lang, config, ret, strict, leak, par', fn_rows),
            values('fx', 'sig, role, want, kind', fx_rows),
            values('gone', 'sig', gone_rows),
            values('rel', 'name, kind, owner, rls, cols, seqtype', rel_rows),
            values('rx', 'name, src, role, want, kind', rx_rows),
            values('col', 'tbl, name, want', col_rows),
            values('con', 'tbl, name, want', con_rows),
            values('cdef', 'tbl, name, want', cdef_rows),
            values('idx', 'name, want', idx_rows),
            values('ipred', 'name, want', pred_rows),
            values('job', 'name, want', cron_rows),
            values('led', 'version', led_rows),
            values('anon_want', 'sig', anon_rows),
            values('auth_want', 'sig', auth_rows),
            values('sweep_want', 'sig', sweep_rows),
            'rule(kind, must) AS (VALUES\n    ' + ',\n    '.join(rule_rows) + ')',
            CHECKS]
    # triggers and data values: only in the files that pin one (the other files stay as they were)
    if trg_rows or dat_rows:
        ctes.insert(-2, values('trg', 'name, tbl, want', trg_rows))
        ctes.insert(-2, values('dat', 'name, want', dat_rows))
        names = [n for n in keys.get('data', [])]
        case = 'CASE d.name ' + ' '.join(f'WHEN {lit(n)} THEN {DATA_EXPR[n]}' for n in names) + ' END' if names else 'NULL::text'
        ctes[-1] = CHECKS[:-1] + EXTRA_CHECKS.replace('@@DATA_CASE@@', case) + ')'
    return head + 'WITH\n' + ',\n'.join(ctes) + '\n' + FINAL_SELECT.replace('@@LABEL@@', k)


ROLE_OID = "CASE {r} WHEN 'PUBLIC' THEN 0::oid ELSE pg_catalog.to_regrole({r})::oid END"
API_ARRAY = "ARRAY['anon', 'authenticated', 'service_role', 'mcp_reader']"


def callable_list(want_cte, role, name_re, label_):
    return f"""  SELECT {lit(label_)}, {lit(label_kind[label_])}, 'missing: none; extra: none',
         'missing: ' || coalesce((SELECT string_agg(substr(w.sig, 8), ', ' ORDER BY w.sig COLLATE "C") FROM {want_cte} w
                                   WHERE NOT coalesce(pg_catalog.has_function_privilege('{role}', pg_catalog.to_regprocedure(w.sig), 'EXECUTE'), false)), 'none')
         || '; extra: ' || coalesce((SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text COLLATE "C") FROM pg_catalog.pg_proc p
                                      WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '{name_re}' AND pg_catalog.has_function_privilege('{role}', p.oid, 'EXECUTE')
                                        AND p.oid NOT IN (SELECT pg_catalog.to_regprocedure(w.sig)::oid FROM {want_cte} w WHERE pg_catalog.to_regprocedure(w.sig) IS NOT NULL)), 'none')"""


label_kind = {ANON_ID: 'anon-callable list', AUTH_ID: 'authenticated-callable list'}
FN_ACL = "pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner)))"
REL_ACL = "pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::\"char\", c.relowner)))"
CHECKS = """checks(id, kind, want, got) AS (
  SELECT 'function ' || substr(e.sig, 8) || ' ' || x.attr, 'function ' || x.attr, x.want, x.got
    FROM fn e
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(e.sig)
    CROSS JOIN LATERAL (VALUES
      ('exists', 'true', (p.oid IS NOT NULL)::text),
      ('md5', e.md5, md5(p.prosrc)),
      ('owner', e.owner, p.proowner::regrole::text),
      ('security_definer', e.secdef, p.prosecdef::text),
      ('volatility', e.vol, p.provolatile::text),
      ('language', e.lang, (SELECT l.lanname::text FROM pg_catalog.pg_language l WHERE l.oid = p.prolang)),
      ('config', e.config, array_to_string(p.proconfig, ',')),
      ('returns', e.ret, pg_catalog.format_type(p.prorettype, NULL)),
      ('strict', e.strict, p.proisstrict::text),
      ('leakproof', e.leak, p.proleakproof::text),
      ('parallel', e.par, p.proparallel::text)) x(attr, want, got)
   WHERE x.attr = 'exists' OR p.oid IS NOT NULL
  UNION ALL
  SELECT 'function ' || substr(f.sig, 8) || ' execute ' || CASE WHEN f.role = '*' THEN 'other roles' ELSE f.role END, f.kind, f.want,
         CASE WHEN f.role = '*' THEN
           coalesce((SELECT string_agg(z.r, ',' ORDER BY z.r COLLATE "C") FROM (SELECT DISTINCT a.grantee::regrole::text AS r FROM """ + FN_ACL + """ a
                      WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> 0 AND a.grantee <> p.proowner
                        AND a.grantee::regrole::text <> ALL (""" + API_ARRAY + """)) z), '')
         ELSE EXISTS (SELECT 1 FROM """ + FN_ACL + """ a WHERE a.privilege_type = 'EXECUTE' AND a.grantee = """ + ROLE_OID.format(r='f.role') + """)::text END
    FROM fx f JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(f.sig)
  UNION ALL
  SELECT 'function ' || substr(g.sig, 8) || ' exists', 'function exists', 'false', (pg_catalog.to_regprocedure(g.sig) IS NOT NULL)::text FROM gone g
  UNION ALL
  SELECT 'relation ' || r.name || ' ' || x.attr, 'relation ' || x.attr, x.want, x.got
    FROM rel r
    LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass('public.' || r.name)
    CROSS JOIN LATERAL (VALUES
      ('kind', r.kind, c.relkind::text),
      ('owner', r.owner, c.relowner::regrole::text),
      ('rls', CASE WHEN r.kind = 'r' THEN r.rls END, CASE WHEN r.kind = 'r' THEN c.relrowsecurity::text END),
      ('force_rls', CASE WHEN r.kind = 'r' THEN 'false' END, CASE WHEN r.kind = 'r' THEN c.relforcerowsecurity::text END),
      ('triggers', CASE WHEN r.kind = 'r' THEN '' END, CASE WHEN r.kind = 'r' THEN coalesce((SELECT string_agg(t.tgname::text, ',' ORDER BY t.tgname::text COLLATE "C")
                                                                  FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal), '') END),
      ('policies', CASE WHEN r.kind = 'r' THEN '' END, CASE WHEN r.kind = 'r' THEN coalesce((SELECT string_agg(y.polname::text, ',' ORDER BY y.polname::text COLLATE "C")
                                                                  FROM pg_catalog.pg_policy y WHERE y.polrelid = c.oid), '') END),
      ('columns', CASE WHEN r.kind = 'r' THEN r.cols END, CASE WHEN r.kind = 'r' THEN (SELECT string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
                                                                  || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END, ', ' ORDER BY a.attnum)
                                                             FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) END),
      ('sequence type', CASE WHEN r.kind = 'S' THEN r.seqtype END, CASE WHEN r.kind = 'S' THEN (SELECT pg_catalog.format_type(q.seqtypid, NULL)
                                                                  FROM pg_catalog.pg_sequence q WHERE q.seqrelid = c.oid) END)) x(attr, want, got)
   WHERE (x.attr = 'kind' OR c.oid IS NOT NULL) AND (x.want IS NOT NULL OR x.got IS NOT NULL)
  UNION ALL
  SELECT g.src || ' ' || g.name || ' grants ' || CASE WHEN g.role = '*' THEN 'other roles' ELSE g.role END, g.kind, g.want,
         CASE WHEN g.role = '*' THEN
           coalesce((SELECT string_agg(z.s, ',' ORDER BY z.s COLLATE "C") FROM (SELECT a.grantee::regrole::text || ':' || a.privilege_type AS s FROM """ + REL_ACL + """ a
                      WHERE a.grantee <> 0 AND a.grantee <> c.relowner AND a.grantee::regrole::text <> ALL (""" + API_ARRAY + """)) z), '')
         ELSE coalesce((SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type COLLATE "C") FROM """ + REL_ACL + """ a
                         WHERE a.grantee = """ + ROLE_OID.format(r='g.role') + """ AND a.grantee <> c.relowner), '') END
    FROM rx g JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass('public.' || g.name)
  UNION ALL
  SELECT 'column ' || o.tbl || '.' || o.name, 'column', o.want,
         (SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
            FROM pg_catalog.pg_attribute a WHERE a.attrelid = pg_catalog.to_regclass('public.' || o.tbl) AND a.attname = o.name AND NOT a.attisdropped)
    FROM col o
  UNION ALL
  SELECT 'constraint ' || o.tbl || '.' || o.name, 'constraint', o.want,
         coalesce((SELECT k.contype::text || ' ('
                  || (SELECT string_agg(a.attname::text, ',' ORDER BY CASE WHEN k.contype = 'c' THEN 0 ELSE u.ord END, a.attname::text COLLATE "C")
                        FROM unnest(k.conkey) WITH ORDINALITY u(n, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n) || ')'
                  || CASE k.contype
                       WHEN 'f' THEN ' ' || (SELECT n.nspname::text || '.' || t.relname::text FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                                             WHERE t.oid = k.confrelid)
                            || '(' || (SELECT string_agg(a.attname::text, ',' ORDER BY u.ord) FROM unnest(k.confkey) WITH ORDINALITY u(n, ord)
                                       JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n) || ') on delete ' || k.confdeltype::text
                       WHEN 'c' THEN ' [' || coalesce((SELECT string_agg(DISTINCT m.v, ',' ORDER BY m.v) FROM (
                                       SELECT (regexp_matches(pg_catalog.pg_get_constraintdef(k.oid), '''((?:[^'']|'''')*)''', 'g'))[1] COLLATE "C" AS v) m), '') || ']'
                       ELSE '' END
                FROM pg_catalog.pg_constraint k WHERE k.conrelid = pg_catalog.to_regclass('public.' || o.tbl) AND k.conname = o.name), '(absent)')
    FROM con o
  UNION ALL
  SELECT 'constraint ' || o.tbl || '.' || o.name || ' definition', 'check definition text', o.want,
         (SELECT pg_catalog.pg_get_constraintdef(k.oid) FROM pg_catalog.pg_constraint k
           WHERE k.conrelid = pg_catalog.to_regclass('public.' || o.tbl) AND k.conname = o.name)
    FROM cdef o
  UNION ALL
  SELECT 'index ' || i.name, 'index', i.want,
         (SELECT t.relname::text || ' unique=' || x.indisunique::text || ' ('
                 || (SELECT string_agg(a.attname::text, ',' ORDER BY u.ord) FROM unnest(x.indkey::int2[]) WITH ORDINALITY u(n, ord)
                       JOIN pg_catalog.pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = u.n)
                 || ') partial=' || (x.indpred IS NOT NULL)::text
            FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
           WHERE x.indexrelid = pg_catalog.to_regclass('public.' || i.name) AND t.relnamespace = 'public'::regnamespace)
    FROM idx i
  UNION ALL
  SELECT 'index ' || i.name || ' predicate', 'index predicate text', i.want,
         (SELECT pg_catalog.pg_get_expr(x.indpred, x.indrelid) FROM pg_catalog.pg_index x WHERE x.indexrelid = pg_catalog.to_regclass('public.' || i.name))
    FROM ipred i
  UNION ALL
  SELECT 'cron job ' || j.name, 'cron job', j.want,
         (SELECT string_agg(c.schedule || ' | ' || c.command || ' | ' || c.username || ' | ' || CASE WHEN c.active THEN 'active' ELSE 'inactive' END
                            || ' | ' || CASE WHEN c.database = current_database() THEN 'this database' ELSE 'database ' || c.database END, ' & ' ORDER BY c.jobid)
            FROM cron.job c WHERE c.jobname = j.name)
    FROM job j
  UNION ALL
  SELECT 'ledger row ' || l.version, 'ledger row', 'true',
         EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations s WHERE s.version = l.version)::text
    FROM led l
  UNION ALL
""" + callable_list('anon_want', 'anon', '^mcp_', ANON_ID) + """
  UNION ALL
""" + callable_list('auth_want', 'authenticated', '^mcp_', AUTH_ID) + """
  UNION ALL
  SELECT """ + lit(SWEEP_ID) + """, 'internal-prefix sweep', 'missing: none; extra: none',
         'missing: ' || coalesce((SELECT string_agg(substr(w.sig, 8), ', ' ORDER BY w.sig COLLATE "C") FROM sweep_want w
                                   WHERE pg_catalog.to_regprocedure(w.sig) IS NULL), 'none')
         || '; extra: ' || coalesce((SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text COLLATE "C") FROM pg_catalog.pg_proc p
                                      WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^(ai_app_|_mcp_|_cloud_)'
                                        AND (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'))
                                        AND p.oid NOT IN (SELECT pg_catalog.to_regprocedure(w.sig)::oid FROM sweep_want w WHERE pg_catalog.to_regprocedure(w.sig) IS NOT NULL)), 'none')
)"""
NEW_KINDS = ('trigger', 'data value')
EXTRA_CHECKS = """  UNION ALL
  SELECT 'trigger ' || g.name, 'trigger', g.want,
         coalesce((SELECT string_agg(g.tbl || ' '
                                     || CASE WHEN t.tgtype::int & 2 <> 0 THEN 'before' ELSE 'after' END || ' '
                                     || CASE WHEN t.tgtype::int & 28 = 16 THEN 'update' ELSE 'other events' END || ' '
                                     || CASE WHEN t.tgtype::int & 1 <> 0 THEN 'row' ELSE 'statement' END || ' '
                                     || t.tgfoid::regproc::text || '() ' || CASE WHEN t.tgenabled = 'O' THEN 'enabled' ELSE 'not enabled' END, ' & ')
                     FROM pg_catalog.pg_trigger t WHERE t.tgname = g.name AND NOT t.tgisinternal
                      AND t.tgrelid = pg_catalog.to_regclass('public.' || g.tbl)), '(absent)')
    FROM trg g
  UNION ALL
  SELECT 'data ' || d.name, 'data value', d.want,
         @@DATA_CASE@@
    FROM dat d
"""
FINAL_SELECT = """SELECT CASE WHEN f.must IS NULL THEN 'ok'
            ELSE ('POSTCHECK @@LABEL@@ FAILED: ' || f.must || ' || REPORT ONLY: ' || coalesce(f.rep, 'none'))::integer::text END AS postcheck,
       coalesce(f.rep, '') AS report_only
  FROM (SELECT string_agg(d.line, ' | ' ORDER BY d.id COLLATE "C") FILTER (WHERE d.must) AS must,
               string_agg(d.line, ' | ' ORDER BY d.id COLLATE "C") FILTER (WHERE NOT d.must) AS rep
          FROM (SELECT c.id, coalesce(r.must, true) AS must,
                       c.id || ': want ' || coalesce(c.want, '(null)') || ', got ' || coalesce(c.got, '(null)') AS line
                  FROM checks c LEFT JOIN rule r ON r.kind = c.kind
                 WHERE c.got IS DISTINCT FROM c.want) d) f;
"""

RUN_ORDER = ['final'] + VERSIONS + ([F249] if LATER else [])
VERIFY_ORDER = ['final'] + TEN_VERSIONS  # the test-database harness below covers the ten (unchanged)
FILES = {k: render(k) for k in RUN_ORDER}


# ------------------------------------------------------------------------------------------------ test-project verification files
def strip_sql(s):
    return s.rstrip().rstrip(';')


def dq(s, tag):
    assert tag not in s
    return tag + '\n' + s + '\n' + tag


VREL = 'supabase/tests/backlog-4263-prod-verify'
VDIR = os.path.join(REPO, VREL)
NEVER = 'TEST DATABASE ONLY. This file ends in a rollback and must never be run on production.'
verify_run = f"""-- verify-run.sql (generated by {REL}/gen.py) — {NEVER}
-- It only reads: it EXECUTEs the eleven read-only post-check SELECTs and ends in RAISE (nothing is kept either way).
-- Run with ~/.claude/bin/kt-sql.
-- Runs postcheck-final.sql and the ten postcheck files once each, verbatim, each in its own exception block, and ends in
-- RAISE with {{postcheck, report_only}} or the error text per file.
-- Afterwards: ~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()".
DO $verify4263prod$
DECLARE r jsonb := '{{}}'; v text; w text;
BEGIN
""" + ''.join(f"""  BEGIN
    EXECUTE {dq(strip_sql(FILES[k]), f'$pc{i}$')} INTO v, w;
    r := r || jsonb_build_object({lit(k)}, jsonb_build_object('postcheck', v, 'report_only', w));
  EXCEPTION WHEN others THEN
    r := r || jsonb_build_object({lit(k)}, jsonb_build_object('error', SQLERRM));
  END;
""" for i, k in enumerate(VERIFY_ORDER)) + """  RAISE EXCEPTION 'POSTCHECK_RUN %', r;
END
$verify4263prod$;
"""


def mig_create(v, name):
    last = None
    for raw, code, spans in split(rd(per[v]['file'])):
        if re.match(r'\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.' + name + r'\s*\(', code, re.I):
            last = raw
    return last.strip()


REG_CREATE = mig_create('20261118190000', 'mcp_register_client')
assert REG_CREATE.count('/*BODY:4263-10.4-register*/') == 1
CLAIM = 'public.ai_app_notice_claim(integer)'
CONTROLS = [  # (id, postcheck, break statements, proof that the break applied, 'error' | 'report', text the result must contain)
    ('B1_body_one_character', '20261118190000', [REG_CREATE.replace('/*BODY:4263-10.4-register*/', '/*BODY:4263-10.4-registeR*/')],
     "(SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.mcp_register_client(text,text,text,text[],bytea)'::regprocedure) <> "
     + lit(FINAL['fn']['mcp_register_client(text,text,text,text[],bytea)']['md5']), 'error',
     'function mcp_register_client(text,text,text,text[],bytea) md5'),
    ('B2_internal_granted_anon', '20261118190000', ['GRANT EXECUTE ON FUNCTION public._mcp_prune_unused_clients() TO anon'],
     "has_function_privilege('anon', 'public._mcp_prune_unused_clients()'::regprocedure, 'EXECUTE')", 'error',
     'function _mcp_prune_unused_clients() execute anon: want false, got true'),
    ('B3_owner_changed', '20261118180000', ['GRANT CREATE ON SCHEMA public TO mcp_reader',
                                            'ALTER FUNCTION public.ai_app_notice_done(uuid, integer, text, text) OWNER TO mcp_reader'],
     "(SELECT proowner::regrole::text FROM pg_proc WHERE oid = 'public.ai_app_notice_done(uuid,integer,text,text)'::regprocedure) = 'mcp_reader'", 'error',
     'function ai_app_notice_done(uuid,integer,text,text) owner: want postgres, got mcp_reader'),
    ('B4_volatile_to_stable', '20261118150000', ['ALTER FUNCTION public.mcp_find_people(text, bytea, text, text, text, text, text, text, text) STABLE'],
     "(SELECT provolatile FROM pg_proc WHERE oid = 'public.mcp_find_people(text,bytea,text,text,text,text,text,text,text)'::regprocedure) = 's'", 'error',
     'volatility: want v, got s'),
    ('B5_search_path_removed', '20261118150000', ['ALTER FUNCTION public.mcp_list_todos(text, bytea, text, text, text, text, text, boolean, boolean, text) RESET search_path'],
     "(SELECT proconfig IS NULL FROM pg_proc WHERE oid = 'public.mcp_list_todos(text,bytea,text,text,text,text,text,boolean,boolean,text)'::regprocedure)", 'error',
     'function mcp_list_todos(text,bytea,text,text,text,text,text,boolean,boolean,text) config'),
    ('B6_rls_disabled_notice_table', '20261118180000', ['ALTER TABLE public.ai_app_connect_notices DISABLE ROW LEVEL SECURITY'],
     "(SELECT NOT relrowsecurity FROM pg_class WHERE oid = 'public.ai_app_connect_notices'::regclass)", 'error',
     'relation ai_app_connect_notices rls: want true, got false'),
    ('B7_cron_schedule_changed', '20261118190000', ["SELECT cron.schedule('mcp-unused-client-prune', '0 * * * *', 'SELECT public._mcp_prune_unused_clients()')"],
     "EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mcp-unused-client-prune' AND schedule = '0 * * * *')", 'error', 'cron job mcp-unused-client-prune'),
    ('B8_anon_name_swapped_17_kept', '20261118190000', ['REVOKE EXECUTE ON FUNCTION public.mcp_get_status(text, bytea, text) FROM anon',
                                                        'GRANT EXECUTE ON FUNCTION public.mcp_list_my_connections() TO anon'],
     "(SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE')) = 17"
     " AND NOT has_function_privilege('anon', 'public.mcp_get_status(text,bytea,text)'::regprocedure, 'EXECUTE')", 'error',
     'anon-callable mcp_ functions: want missing: none; extra: none, got missing: mcp_get_status(text,bytea,text); extra: mcp_list_my_connections()'),
    ('B9_table_granted_service_role', '20261118180000', ['GRANT SELECT ON public.ai_app_connect_notices TO service_role'],
     "has_table_privilege('service_role', 'public.ai_app_connect_notices'::regclass, 'SELECT')", 'error',
     'relation ai_app_connect_notices grants service_role: want , got SELECT'),
    ('B10_purge_job_schedule_changed', 'final', ["SELECT cron.schedule('cloud-todo-purge', '0 5 * * *', 'SELECT public._cloud_todo_purge()')"],
     "EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cloud-todo-purge' AND schedule = '0 5 * * *')", 'error', 'cron job cloud-todo-purge'),
    ('R1_strict', '20261118180000', [f'ALTER FUNCTION {CLAIM} STRICT'],
     f"(SELECT proisstrict FROM pg_proc WHERE oid = '{CLAIM}'::regprocedure)", 'error',
     'function ai_app_notice_claim(integer) strict: want false, got true'),
    ('R2_parallel_safe_cost', '20261118180000', [f'ALTER FUNCTION {CLAIM} PARALLEL SAFE COST 1000'],
     f"(SELECT proparallel = 's' AND procost = 1000 FROM pg_proc WHERE oid = '{CLAIM}'::regprocedure)", 'error',
     'function ai_app_notice_claim(integer) parallel: want u, got s'),
    ('R3_force_rls', '20261118180000', ['ALTER TABLE public.ai_app_connect_notices FORCE ROW LEVEL SECURITY'],
     "(SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.ai_app_connect_notices'::regclass)", 'error',
     'relation ai_app_connect_notices force_rls: want false, got true'),
    ('R4_trigger', '20261118180000', ['CREATE FUNCTION public.x4263_trg() RETURNS trigger LANGUAGE plpgsql AS $t$BEGIN RETURN NEW; END$t$',
                                      'CREATE TRIGGER x4263_t BEFORE INSERT ON public.ai_app_connect_notices FOR EACH ROW EXECUTE FUNCTION public.x4263_trg()'],
     "EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'x4263_t')", 'error', 'relation ai_app_connect_notices triggers: want , got x4263_t'),
    ('R5_index_predicate_changed', '20261118180000', ['DROP INDEX public.ai_app_connect_notices_due_idx',
                                                      "CREATE INDEX ai_app_connect_notices_due_idx ON public.ai_app_connect_notices (connected_at) WHERE status = 'sent'"],
     "(SELECT pg_get_expr(indpred, indrelid) FROM pg_index WHERE indexrelid = 'public.ai_app_connect_notices_due_idx'::regclass) LIKE '%sent%'", 'report',
     'index ai_app_connect_notices_due_idx predicate'),
    ('R6_authenticated_on_mcp_tool', '20261118190000', ['GRANT EXECUTE ON FUNCTION public.mcp_get_deal(text, bytea, text, text) TO authenticated'],
     "has_function_privilege('authenticated', 'public.mcp_get_deal(text,bytea,text,text)'::regprocedure, 'EXECUTE')", 'error',
     'authenticated-callable mcp_ functions: want missing: none; extra: none, got missing: none; extra: mcp_get_deal(text,bytea,text,text)'),
    ('R7_pre_lane_table_granted_anon', '20261118150000', ['GRANT SELECT ON public.mcp_call_log TO anon'],
     "has_table_privilege('anon', 'public.mcp_call_log'::regclass, 'SELECT')", 'error', 'table mcp_call_log grants anon: want , got SELECT'),
    ('L1_report_only_other_role', '20261118180000', ['CREATE ROLE x4263_other NOLOGIN', f'GRANT EXECUTE ON FUNCTION {CLAIM} TO x4263_other'],
     f"has_function_privilege('x4263_other', '{CLAIM}'::regprocedure, 'EXECUTE')", 'report',
     'function ai_app_notice_claim(integer) execute other roles: want , got x4263_other'),
    ('L2_must_table_owner', '20261118180000', ['GRANT CREATE ON SCHEMA public TO mcp_reader', 'ALTER TABLE public.ai_app_connect_notices OWNER TO mcp_reader'],
     "(SELECT relowner::regrole::text FROM pg_class WHERE oid = 'public.ai_app_connect_notices'::regclass) = 'mcp_reader'", 'error',
     'relation ai_app_connect_notices owner: want postgres, got mcp_reader'),
    ('L3_must_anon_grant', '20261118180000', [f'GRANT EXECUTE ON FUNCTION {CLAIM} TO anon'],
     f"has_function_privilege('anon', '{CLAIM}'::regprocedure, 'EXECUTE')", 'error',
     'function ai_app_notice_claim(integer) execute anon: want false, got true'),
]
for _c in CONTROLS:
    assert _c[1] == 'final' or not predicted_diffs(_c[1], 'final'), ('control on a post-check that fails at the final state', _c[0])


USED = sorted({c[1] for c in CONTROLS} | {'final'})
qvar = lambda k: 'q_' + k


def ctl_block(i, cid, pc, breaks, proof, expect, text):
    stm = ''.join(f"    EXECUTE {dq(b, f'$b{i}_{n}$')};\n" for n, b in enumerate(breaks))
    run = lambda var, key: (f"    BEGIN EXECUTE {var} INTO v, w; "
                            f"o := o || jsonb_build_object('{key}', jsonb_build_object('postcheck', v, 'report_only', w)); "
                            f"EXCEPTION WHEN others THEN o := o || jsonb_build_object('{key}', jsonb_build_object('error', SQLERRM)); END;\n")
    return (f"  -- {cid}: postcheck-{pc}\n  BEGIN\n    o := '{{}}';\n" + run(qvar(pc), 'before') + stm
            + f"    EXECUTE 'SELECT (' || {lit(proof)} || ')::text' INTO v; o := o || jsonb_build_object('applied', v);\n"
            + run(qvar(pc), 'after') + run(qvar('final'), 'final_after')
            + f"""    RAISE EXCEPTION 'undo-{cid}';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'undo-{cid}' THEN o := o || jsonb_build_object('error', SQLERRM); END IF;
    r := r || jsonb_build_object({lit(cid)}, o || jsonb_build_object('postcheck', {lit(pc)}, 'expect', {lit(expect)}, 'text', {lit(text)}));
  END;
""")


# The first statement refuses any database that is not the test database, before any write:
#  (a) a production-only fact is present: public.pm_backlog_items holds more than 100 rows (the tracker lives on
#      production; on the test database the table exists and is empty). A missing table counts as "not production".
#  (b) a test-database-only fact is absent: the reserved test account in auth.users, compared by md5 of its id (no id
#      literal in the repository; one boolean is read, no row content).
#  (a) also reads pg_stat_user_tables.n_live_tup, which row level security cannot hide from a non-owner runner.
# The same two checks run again as the first statements inside the block that writes, so a client that runs one
# statement at a time and continues past an error still cannot reach a write.
GUARD_A = ("n > 100 OR coalesce((SELECT s.n_live_tup FROM pg_catalog.pg_stat_user_tables s "
           "WHERE s.relid = pg_catalog.to_regclass('public.pm_backlog_items')), 0) > 100")
GUARD_B = "md5(u.id::text) = '53a385187695375e2e8695625a20a77a'"
REFUSE = f'verify-controls.sql refuses to run: {NEVER}'


def guard_checks(a=GUARD_A, b=GUARD_B):
    return f"""  IF pg_catalog.to_regclass('public.pm_backlog_items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.pm_backlog_items' INTO n;
  END IF;
  IF {a} THEN
    RAISE EXCEPTION '{REFUSE} (production tracker rows present)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE {b}) THEN
    RAISE EXCEPTION '{REFUSE} (test database marker absent)';
  END IF;
"""


def guard(a=GUARD_A, b=GUARD_B):
    return f"""DO $guard4263verify$
DECLARE n bigint := 0;
BEGIN
{guard_checks(a, b)}END
$guard4263verify$;
"""


def controls_block(a=GUARD_A, b=GUARD_B):
    return f"""DO $controls4263prod$
DECLARE n bigint := 0; r jsonb := '{{}}'; o jsonb; v text; w text;
""" + ''.join(f"  {qvar(k)} text := {dq(strip_sql(FILES[k]), f'$v{n}$')};\n" for n, k in enumerate(USED)) + f"""BEGIN
{guard_checks(a, b)}""" + ''.join(ctl_block(i, *c) for i, c in enumerate(CONTROLS)) + """  r := r || jsonb_build_object('guard_probe', current_setting('x4263.guard_probe', true));
  RAISE EXCEPTION 'POSTCHECK_CONTROLS %', r;
END
$controls4263prod$;
"""


verify_controls = f"""-- verify-controls.sql (generated by {REL}/gen.py) — {NEVER}
-- The first statement refuses any database that is not the test database (the guard below), before any write; the
-- same checks are the first statements inside the block that writes.
-- One transaction that ends in RAISE, so nothing is kept. For each break: the post-check runs, the break is made in a
-- subtransaction, a catalogue probe shows it applied, the same post-check and postcheck-final run again, then the
-- subtransaction is undone. A MUST HOLD break must fail the post-check; a REPORT ONLY break must leave postcheck = 'ok'
-- and appear in report_only. Afterwards: ~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()".
{guard()}SET LOCAL lock_timeout = '5s';
""" + controls_block()


# ------------------------------------------------------------------------------------------------ expected.json, README
def counts(k):
    keys = keys_at(k)
    n_must = sum(1 for kind, _ in WANT[k].values() if label(kind) == 'MUST HOLD')
    return {'functions': len(keys['fn']), 'functions_absent': len(keys['dropped']), 'tables_or_sequences': len(keys['tables']),
            'pre_lane_tables': len(keys['pretables']), 'columns_added': len(keys['cols']), 'constraints': len(keys['cons']),
            'indexes': len(keys['idx']), 'cron_jobs': len(keys['cron']), 'ledger_rows': len(keys['ledger']),
            'must_hold': n_must, 'report_only': len(WANT[k]) - n_must}


stage_st = stage_of
expected = {
    'generated_by': f'{REL}/gen.py',
    'migrations': {v: {'file': per[v]['file'], 'file_md5': per[v]['file_md5']} for v in VERSIONS},
    'labels': {'default': 'MUST HOLD', 'report_only_kinds': REPORT_ONLY,
               'never_report_only_roles': list(NEVER_REPORT_ROLES), 'service_role_exception': SERVICE_ROLE_EXCEPTION,
               'kinds': {kind: label(kind) for kind in ALL_KINDS}},
    'anon_callable_mcp_by_stage': {'before_lane': ANON9, **{v: anon_list(per[v]['state']) for v in VERSIONS}},
    'authenticated_callable_mcp_by_stage': {'before_lane': AUTH_PRE, **{v: auth_list(per[v]['state']) for v in VERSIONS}},
    'postchecks': {k: {'file': f'postcheck-{k}.sql', 'counts': counts(k),
                       'pins': {i: {'label': label(kind), 'kind': kind, 'want': w} for i, (kind, w) in WANT[k].items()}} for k in RUN_ORDER},
    'fails_after': {k: {j: PRED[k][j] for j in PRED[k] if PRED[k][j]} for k in VERSIONS},
    'expected_at_final_state': {k: ('ok' if not predicted_diffs(k, 'final') else predicted_diffs(k, 'final')) for k in TEN_VERSIONS},
    **({'expected_at_final_249_state': {k: ('ok' if not predicted_diffs(k, F249) else predicted_diffs(k, F249)) for k in VERSIONS}} if LATER else {}),
    'report_only_expected_on_keepr_test': TEST_REPORT,
    'controls': {c[0]: {'postcheck': c[1], 'expect': c[4], 'text': c[5]} for c in CONTROLS},
    'superseded_bodies_required_by_later_pre_checks': SUPERSEDED,
    'pre_lane_prefixed_functions_revoked_before_the_lane': PRE_LANE_PREFIXED,
    'pre_lane_table_grants_from_pre_lane_migrations': PRE_GRANTS,
}
assert not predicted_diffs('final', 'final')
assert not LATER or not predicted_diffs(F249, F249)

rows = []
for k in VERSIONS:
    cells = [f'{j}: ' + ('passes' if not PRED[k][j] else 'FAILS (' + '; '.join(PRED[k][j]) + ')') for j in VERSIONS if j > k]
    rows.append(f'| `postcheck-{k}.sql` | ' + ('<br>'.join(cells) if cells else '(last migration)') + ' |')

OPERATOR = """> Run `postcheck-<version>.sql` right after migration `<version>`.
> - `ok` and `report_only` empty: continue.
> - `ok` and `report_only` not empty: continue; paste the `report_only` text into pm_comments on BACKLOG-4263 with
>   the version.
> - An error: STOP the release run. Do not apply the next migration.
>   - If every listed difference is an owner or a cron username: find the role that applied the migration. If it is
>     not `postgres`, do not waive; fix the owner with a reviewed migration and re-run.
>   - Any difference in md5, security definer, search_path, strict, RLS, FORCE RLS, policies, triggers, the anon or
>     authenticated lists, the sweep, or an EXECUTE or table grant to anon, authenticated, PUBLIC or service_role is
>     never waived."""

LATER_NOTE = ("" if not LATER else f"""
## After the ten: the 2.49 migrations

Later lane migrations ({', '.join(f'`{f[:14]}`' for f in LATER)}) each have their own `postcheck-<version>.sql`, run
right after that migration. `postcheck-final.sql` is unchanged and still describes the state after the ten: production
runs it before the first later migration, and it fails after one (expected; see the table below).
`postcheck-{F249}.sql` describes the state after the last lane migration (`{VERSIONS[-1]}`); it is run on production
only, at the end of the 2.49 release run. On the test project it is expected to fail while any later migration is
not yet applied there. The test-database harness in `../backlog-4263-prod-verify/` covers the ten only.
CHECK texts and partial-index predicates first written after the ten are not measured: each is the measured text of an
identical expression on an earlier table (`gen.py`, `PREDICTED_CHECKDEF`, `PREDICTED_PREDICATE`; report only).
""")
readme = f"""# Production post-checks for migrations {FIRST} .. {VERSIONS[-1]} (BACKLOG-4263)

Generated by `gen.py`; do not hand-edit. `python3 gen.py check` fails when any file here is stale.

## Operator instruction

{OPERATOR}

A waiver of an owner or cron-username difference needs the founder's recorded go, naming the role and why it is
harmless.

Before the first apply: confirm `pg_cron` is enabled on the database. 110000 skips scheduling `cloud-todo-purge`
without it (its post-check then fails on `cron job cloud-todo-purge`); 190000 refuses to apply.

Files `postcheck-{FIRST}.sql` .. `postcheck-20261118140000.sql` have never run against a catalogue at their own stage
(on the test project they were only run after all ten migrations, where they fail as listed below). If one fails,
first re-derive the pin from the migration (`gen.py`), then question the database.

## What each file is

`postcheck-<version>.sql` is one read-only `SELECT` describing the database right after migration `<version>`. It
returns one row with two columns:

| Column | Value |
|---|---|
| `postcheck` | `ok` when every MUST HOLD assertion holds |
| `report_only` | `''`, or `<id>: want <x>, got <y> \\| ...` for each REPORT ONLY assertion that differs |

When a MUST HOLD assertion differs, the statement fails with:

```
invalid input syntax for type integer: "POSTCHECK <version> FAILED: <must-hold differences> || REPORT ONLY: <report differences>"
```

Style: one `SELECT` (no `DO` block) that calls no function with a side effect. The error is produced by casting the
list of differences to `integer`, which happens only when there is a difference.

Catalogue views read: `pg_catalog.pg_proc`, `pg_language`, `pg_class`, `pg_attribute`, `pg_constraint`, `pg_index`,
`pg_policy`, `pg_trigger`, `pg_sequence`, `pg_namespace`; functions `to_regprocedure`, `to_regclass`, `to_regrole`,
`aclexplode`, `acldefault`, `format_type`, `pg_get_constraintdef`, `pg_get_expr`, `has_function_privilege`; plus
`cron.job` and `supabase_migrations.schema_migrations`. No temporary table, no setting, no data table.

## Labels

Every assertion is **MUST HOLD** unless its kind is one of these **REPORT ONLY** kinds (the `rule` CTE in each file;
`expected.json` → `labels`):

""" + '\n'.join(f'- `{k}`: {v}' for k, v in REPORT_ONLY.items()) + f"""

No assertion about `PUBLIC`, `anon`, `authenticated` or `service_role` is report-only, with one named exception:
`{SERVICE_ROLE_EXCEPTION}` (service_role on tables created before the lane; open finding F-12b). `gen.py` and the
jest tripwire both enforce this. `procost` is deliberately not pinned: no migration sets it.

MUST HOLD pins that come from the applying role rather than the migration text: function and table owners
(`postgres`, or `mcp_reader` under `SET ROLE`), the cron `username`; and from state before the lane: the owners and
kept grants of replaced pre-lane functions, the nine pre-lane anon-callable and six authenticated-callable names, the
grants on pre-lane tables (replayed from the pre-lane migrations).

## What each file pins

For every function the migration creates or replaces: existence with the exact argument types, `md5(prosrc)`
(computed here from the migration text), owner, security definer, volatility, language, `proconfig`, return type,
strict, leakproof, parallel; whether each of `PUBLIC`, `anon`, `authenticated`, `service_role`, `mcp_reader` holds
`EXECUTE`; and the list of other grantees (report only). For every function it drops: absent.
For every table or sequence it creates: kind, owner, the privileges of each of the five roles (none), other grantees
(report only), row level security, FORCE row level security (off), triggers (none), policies (none), columns with
types and `not null`. For tables created before the lane that it alters: the privileges of `PUBLIC`, `anon`,
`authenticated`, `mcp_reader` (as the pre-lane migrations left them) and `service_role` (report only).
Added columns; constraints (type, columns, CHECK literal set, foreign key target and delete action) plus the full CHECK
text (report only); indexes (table, unique, columns, partial) plus the predicate text (report only); cron jobs it
schedules (exactly once, schedule, command, username, active, this database); the ledger row of its own version; the
anon-callable and authenticated-callable `mcp_*` lists for that stage; no `ai_app_*`/`_mcp_*`/`_cloud_*` function
executable by `anon` or `authenticated`.

Not pinned: totals of functions or cron jobs, row counts, other versions in the ledger, any id.

| File | MUST HOLD | REPORT ONLY | Functions | Absent | Tables/sequences | Pre-lane tables | Added columns | Constraints | Indexes | Cron jobs | anon `mcp_*` | authenticated `mcp_*` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
""" + '\n'.join(f"| `postcheck-{k}.sql` | {counts(k)['must_hold']} | {counts(k)['report_only']} | {counts(k)['functions']} | {counts(k)['functions_absent']} | "
                f"{counts(k)['tables_or_sequences']} | {counts(k)['pre_lane_tables']} | {counts(k)['columns_added']} | {counts(k)['constraints']} | "
                f"{counts(k)['indexes']} | {counts(k)['cron_jobs']} | {len(anon_list(stage_st(k)))} | {len(auth_list(stage_st(k)))} |" for k in RUN_ORDER) + """

## Callable `mcp_*` functions at each stage

""" + '\n'.join(f"- {'before the lane' if s == 'before_lane' else 'after ' + s}: anon {len(a)}, authenticated {len(u)}"
                for (s, a), u in zip(expected['anon_callable_mcp_by_stage'].items(), expected['authenticated_callable_mcp_by_stage'].values())) + """

Full lists: `expected.json` → `anon_callable_mcp_by_stage`, `authenticated_callable_mcp_by_stage`.

## On the test project

`report_only` at the final state lists `service_role` privileges on the six pre-lane tables the lane alters; a file
run after later migrations also reports the CHECK text those migrations changed (`expected.json` →
`report_only_expected_on_keepr_test`). Everything else is empty.

## Which earlier post-checks fail after which later migration

Expected; each cell lists the MUST HOLD ids that differ.

| Post-check | Result after each later migration |
|---|---|
""" + '\n'.join(rows) + """
""" + LATER_NOTE + """
## Files

| File | What it is |
|---|---|
| `gen.py` | Generator and `check` / `report` modes |
| `postcheck-<version>.sql` | Read-only post-check per migration |
| `postcheck-final.sql` | Read-only post-check of the state after the ten (frozen: production runs it before the later ones) |""" + ("" if not LATER else f"""
| `postcheck-{F249}.sql` | Read-only post-check of the state after the last lane migration (production, end of the 2.49 run) |""") + """
| `expected.json` | Pinned facts with labels, callable lists per stage, predicted failures |

Every `.sql` file in this folder is read-only. The test-database harness (`verify-run.sql`, `verify-controls.sql`) is
in `../backlog-4263-prod-verify/` and is never run on production.
"""

OUTS = {f'postcheck-{k}.sql': FILES[k] for k in RUN_ORDER}
OUTS['expected.json'] = json.dumps(expected, indent=2, ensure_ascii=False) + '\n'
OUTS['README.md'] = readme
VERIFY_README = f"""# Test-database harness for the BACKLOG-4263 production post-checks

**TEST DATABASE ONLY. Never run on production.** Generated by `../backlog-4263-prod/gen.py`; do not hand-edit.

| File | What it does |
|---|---|
| `verify-run.sql` | Reads only. Runs `postcheck-final.sql` and the ten post-checks once each and ends in `RAISE`, so nothing is kept. |
| `verify-controls.sql` | Breaks the catalogue on purpose (grants, owners, RLS, a replaced function body, a cron schedule, a role, an index) inside one transaction that ends in `RAISE`, so nothing is kept. Its **first statement refuses** any database that is not the test database, before any write. |

The refusal raises when either holds:

1. `public.pm_backlog_items` has more than 100 rows (the tracker lives on production; on the test database the table
   is empty; a missing table counts as not production).
2. The reserved test account is absent from `auth.users` (compared by the md5 of its id; no id is stored here).

Run with `~/.claude/bin/kt-sql <file>`, then `~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()"`.
Read the result with `python3 ../backlog-4263-prod/gen.py report <output>`.
The same two checks are the first statements inside the block that writes, so a client that runs one statement at a
time and continues past an error still stops there.
`python3 ../backlog-4263-prod/gen.py guard-control <out>` writes the refusal control: four mutants (each refusal
forced, in the top-level guard and in the writing block) must refuse before the first write, then the unmodified
`verify-controls.sql` runs to its rollback.
"""
VOUTS = {'verify-run.sql': verify_run, 'verify-controls.sql': verify_controls, 'README.md': VERIFY_README}
FIRST_WRITE = CONTROLS[0][2][0]
GUARD_MUTANTS = {'a_production_rows_present': guard(a='n > -1'), 'b_test_marker_absent': guard(b=GUARD_B.replace("'53a3", "'0000")),
                 'c_in_block_production_rows_present': controls_block(a='n > -1'),
                 'd_in_block_test_marker_absent': controls_block(b=GUARD_B.replace("'53a3", "'0000"))}
assert all(m not in (guard(), controls_block()) for m in GUARD_MUTANTS.values())
guard_control = ('-- guard control (generated by gen.py guard-control) — TEST DATABASE ONLY; ends in a rollback.\n'
                 + 'DO $guardctl4263$\nDECLARE e text; res jsonb := \'{}\';\nBEGIN\n'
                 + ''.join(f"""  BEGIN
    EXECUTE {dq(strip_sql(m), f'$m{i}$')};
    EXECUTE {dq(FIRST_WRITE, f'$w{i}$')};
    e := NULL;
  EXCEPTION WHEN others THEN e := SQLERRM;
  END;
  res := res || jsonb_build_object({lit(mid)}, jsonb_build_object('error', e,
           'first_write_absent', (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.mcp_register_client(text,text,text,text[],bytea)'::regprocedure)
                                 = {lit(FINAL['fn']['mcp_register_client(text,text,text,text[],bytea)']['md5'])}));
  IF e IS NULL OR e NOT LIKE {lit(REFUSE + '%')} THEN
    RAISE EXCEPTION 'GUARD CONTROL FAILED: %', res;
  END IF;
""" for i, (mid, m) in enumerate(GUARD_MUTANTS.items()))
                 + "  PERFORM set_config('x4263.guard_probe', res::text, true);\nEND\n$guardctl4263$;\n" + verify_controls)


def ids_of(text):
    return sorted(x.strip() for x in re.findall(r'(?:^|\| )([^|]+?): want ', text or ''))


if len(sys.argv) > 2 and sys.argv[1] == 'report':
    raw = open(sys.argv[2]).read()
    try:
        msg = json.loads(raw.splitlines()[0])['message']
    except Exception:
        msg = raw
    if 'POSTCHECK_RUN ' in msg:
        res = json.loads(msg[msg.index('POSTCHECK_RUN ') + 14:].split('\nCONTEXT')[0])
        bad = 0
        for k in VERIFY_ORDER:
            got = res.get(k, {})
            pred = [] if k == 'final' else predicted_diffs(k, 'final')
            rep = TEST_REPORT[k]
            if not pred:
                ok = got.get('postcheck') == 'ok' and ids_of(got.get('report_only')) == sorted(rep)
            else:
                e = got.get('error', '')
                must, _, reptxt = e.partition(' || REPORT ONLY: ')
                ok = 'FAILED: ' in must and ids_of(must.split('FAILED: ', 1)[1]) == sorted(pred) and ids_of(reptxt) == sorted(rep)
            bad += not ok
            print(('MATCH ' if ok else 'DIFF  ') + k + ': ' + json.dumps(got, ensure_ascii=False)[:2500])
            if not ok:
                print('      predicted must: ' + json.dumps(pred) + ' report: ' + json.dumps(rep))
        sys.exit(1 if bad else 0)
    if 'POSTCHECK_CONTROLS ' in msg:
        res = json.loads(msg[msg.index('POSTCHECK_CONTROLS ') + 19:].split('\nCONTEXT')[0])
        bad = 0
        gp = res.pop('guard_probe', None)
        print('guard_probe: ' + str(gp))
        for cid, pc, _, _, expect, text in CONTROLS:
            o = res.get(cid, {})
            base_rep = sorted(TEST_REPORT[pc])
            before_ok = o.get('before', {}).get('postcheck') == 'ok' and ids_of(o.get('before', {}).get('report_only')) == base_rep
            after, fa = o.get('after', {}), o.get('final_after', {})
            if expect == 'error':
                hit = 'FAILED' in after.get('error', '') and text in after.get('error', '').split(' || REPORT ONLY: ')[0] and 'FAILED' in fa.get('error', '')
            else:
                hit = after.get('postcheck') == 'ok' and text in (after.get('report_only') or '') and fa.get('postcheck') == 'ok'
            ok = before_ok and o.get('applied') == 'true' and hit and 'error' not in o
            bad += not ok
            print(('OK  ' if ok else 'BAD ') + cid + ' ' + json.dumps(o, ensure_ascii=False)[:1800])
        sys.exit(1 if bad else 0)
    print(msg[:3000])
    sys.exit(2)
if len(sys.argv) > 2 and sys.argv[1] == 'guard-control':
    open(sys.argv[2], 'w', encoding='utf-8').write(guard_control)
    print('written', sys.argv[2], md5(guard_control))
    sys.exit(0)
ALL_OUTS = {os.path.join(HERE, k): v for k, v in OUTS.items()}
ALL_OUTS.update({os.path.join(VDIR, k): v for k, v in VOUTS.items()})
if len(sys.argv) > 1 and sys.argv[1] == 'check':
    extra = [f for f in os.listdir(HERE) if f.startswith('verify-')]
    bad = [os.path.relpath(k, REPO) for k, v in ALL_OUTS.items() if not os.path.exists(k) or open(k, encoding='utf-8').read() != v] + extra
    print('differs: ' + ', '.join(bad) if bad else 'all generated files match')
    sys.exit(1 if bad else 0)
os.makedirs(VDIR, exist_ok=True)
for k, v in ALL_OUTS.items():
    open(k, 'w', encoding='utf-8').write(v)
for k in RUN_ORDER:
    print(f'postcheck-{k}.sql', md5(OUTS[f"postcheck-{k}.sql"]), counts(k))
print('statement kinds outside the modelled ones:', stmt_kinds)
