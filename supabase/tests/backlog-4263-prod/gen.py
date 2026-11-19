#!/usr/bin/env python3
"""BACKLOG-4263: read-only post-checks for the ten hosted-MCP migrations 20261118100000 .. 20261118190000.

Writes, from the migration files alone:

  postcheck-<version>.sql   one per migration: the catalogue state right after that migration (one SELECT)
  postcheck-final.sql       the state after the last of the ten (each object at its latest definition)
  expected.json             the facts each file pins, the anon-callable list per stage, the predicted failures
  README.md                 what each file checks; which earlier files fail after which later migration
  verify-run.sql            test project only: runs postcheck-final and the ten files once each, ends in RAISE
  verify-controls.sql       test project only: breaks in one rolled-back transaction, ends in RAISE

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

MIGS = sorted(f for f in os.listdir(MIGDIR) if f.endswith('.sql') and FIRST <= f[:14] <= LAST)
VERSIONS = [f[:14] for f in MIGS]
assert len(MIGS) == 10, MIGS
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


state = {'fn': {}, 'dropped': set(), 'tables': {}, 'cols': {}, 'cons': {}, 'idx': {}, 'cron': {}, 'ledger': set()}
per = {}          # version -> what the migration touched
default_dep = {}  # assertion id -> why it rests on a default or on state from before the lane
stmt_kinds = {}


def touch(v, kind, key):
    per[v][kind].append(key) if key not in per[v][kind] else None


for f in MIGS:
    v = f[:14]
    per[v] = {'file': f'supabase/migrations/{f}', 'file_md5': md5(rd(f'supabase/migrations/{f}')),
              'fn': [], 'dropped': [], 'tables': [], 'cols': [], 'cons': [], 'idx': [], 'cron': []}
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
                    'config': 'search_path=""', 'returns': ctype(mr.group(1))}
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
            continue
        m = re.match(r'ALTER TABLE public\.(\w+) (.*)$', s, re.I)
        if m:
            t, rest = m.groups()
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
    state['ledger'].add(v)
    per[v]['state'] = json.loads(json.dumps(state, default=lambda o: C(o) if isinstance(o, set) else o))

assert set(stmt_kinds) <= {'DO', 'SET', 'INSERT', 'SELECT', 'COMMENT'}, stmt_kinds
for t, x in state['tables'].items():
    assert not x['privs'], ('a created table keeps default grants; the check would rest on default privileges', t, x['privs'])


# ------------------------------------------------------------------------------------------------ facts per stage
def display(sig):
    return sig.replace('public.', '')


def anon_list(st):
    out = set(ANON9)
    for sig in st['dropped']:
        out.discard(sig)
    for sig, x in st['fn'].items():
        if sig.startswith('mcp_'):
            (out.add if ({'anon', 'PUBLIC'} & set(x['execute'])) else out.discard)(sig)
    return C(out)


def sweep_list(st):
    return C(sig for sig, x in st['fn'].items()
             if re.match(r'(ai_app_|_mcp_|_cloud_)', sig) and {'anon', 'authenticated', 'PUBLIC'} & set(x['execute']))


FN_ATTRS = ('md5', 'owner', 'security_definer', 'volatility', 'language', 'config', 'returns', 'execute')


def facts(st, keys):
    """id -> wanted value, for the objects named in keys, at state st."""
    out = {}
    for sig in keys['fn']:
        x = st['fn'].get(sig)
        out[f'function {sig} exists'] = 'true' if x else 'false'
        if x:
            for a in FN_ATTRS:
                out[f'function {sig} {a}'] = ','.join(C(x[a])) if a == 'execute' else x[a]
    for sig in keys['dropped']:
        out[f'function {sig} exists'] = 'true' if sig in st['fn'] else 'false'
    for t in keys['tables']:
        x = st['tables'][t]
        out[f'relation {t} kind'] = x['kind']
        out[f'relation {t} owner'] = x['owner']
        out[f'relation {t} grants to others'] = ''
        if x['kind'] == 'r':
            out[f'relation {t} rls'] = str(x['rls']).lower()
            out[f'relation {t} policies'] = x['policies']
            out[f'relation {t} columns'] = x['columns']
        else:
            out[f'relation {t} sequence type'] = x['seqtype']
    for k in keys['cols']:
        out[f'column {k}'] = st['cols'][k]
    for k in keys['cons']:
        out[f'constraint {k}'] = st['cons'].get(k, '(absent)')
    for k in keys['idx']:
        out[f'index {k}'] = st['idx'][k]
    for k in keys['cron']:
        x = st['cron'][k]
        out[f'cron job {k}'] = f"{x['schedule']} | {x['command']} | {x['username']} | active | this database"
    for v in keys['ledger']:
        out[f'ledger row {v}'] = 'true'
    out['anon-callable mcp_ functions'] = ', '.join(anon_list(st))
    out['ai_app_/_mcp_/_cloud_ functions executable by anon or authenticated'] = ', '.join(sweep_list(st))
    return out


def keys_of(v):
    p = per[v]
    return {'fn': p['fn'], 'dropped': [d for d in p['dropped'] if d not in p['fn']], 'tables': p['tables'], 'cols': p['cols'],
            'cons': p['cons'], 'idx': p['idx'], 'cron': p['cron'], 'ledger': [v]}


FINAL = per[LAST]['state']
FINAL_KEYS = {k: [] for k in ('fn', 'dropped', 'tables', 'cols', 'cons', 'idx', 'cron', 'ledger')}
for v in VERSIONS:
    for k, xs in keys_of(v).items():
        for x in xs:
            if k == 'fn' and x not in FINAL['fn']:
                k2 = 'dropped'
            elif k == 'dropped' and x in FINAL['fn']:
                k2 = 'fn'
            else:
                k2 = k
            if x not in FINAL_KEYS[k2]:
                FINAL_KEYS[k2].append(x)
FINAL_KEYS['cons'] = [c for c in FINAL_KEYS['cons'] if c in FINAL['cons']]

WANT = {v: facts(per[v]['state'], keys_of(v)) for v in VERSIONS}
WANT['final'] = facts(FINAL, FINAL_KEYS)

# consistency with what the lane measured on the test project
assert anon_list(FINAL) == C(FINAL17), (anon_list(FINAL), FINAL17)
assert sweep_list(FINAL) == []
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


def predicted_failures(k, j):
    """ids of postcheck k that differ in the state right after migration j."""
    st = per[j]['state'] if j != 'final' else FINAL
    now = facts(st, keys_of(k) if k != 'final' else FINAL_KEYS)
    bad = [i for i, w in WANT[k].items() if now.get(i) != w]
    gone = {i.rsplit(' ', 1)[0] for i in bad if i.endswith(' exists') and now.get(i) == 'false'}
    return [i for i in bad if not (i.rsplit(' ', 1)[0] in gone and not i.endswith(' exists'))]


PRED = {k: {j: predicted_failures(k, j) for j in VERSIONS if j > k} for k in VERSIONS}

# ------------------------------------------------------------------------------------------------ default-dependent assertions
for v in VERSIONS:
    for sig in per[v]['fn']:
        x = per[v]['state']['fn'][sig]
        if x['pre_lane']:
            default_dep[f'function {sig} owner'] = f'kept from before the lane (CREATE OR REPLACE keeps the owner; first created in {x["pre_lane"][0][:14]})'
            default_dep[f'function {sig} execute'] = 'EXECUTE list kept from before the lane, minus PUBLIC/anon/authenticated/service_role revoked, plus the grants of the migration'
        else:
            default_dep[f'function {sig} owner'] = f'owner = the role that runs the migration ({x["owner"]}' + (', set by SET ROLE in the migration)' if x['owner'] != 'postgres' else '; nothing in the migration sets it)')
            default_dep[f'function {sig} execute'] = 'assumes the default privileges grant EXECUTE to no role other than PUBLIC, anon, authenticated, service_role (the four the migration revokes)'
for t, x in state['tables'].items():
    default_dep[f'relation {t} owner'] = 'owner = the role that runs the migration (postgres); nothing in the migration sets it'
    default_dep[f'relation {t} grants to others'] = 'assumes the default privileges grant to no role other than anon, authenticated, service_role (the roles the migration revokes)'
for j, x in state['cron'].items():
    default_dep[f'cron job {j}'] = 'username = the role that runs cron.schedule (postgres); the migration does not name it'
default_dep['anon-callable mcp_ functions'] = 'includes the nine anon-callable functions that existed before the lane (measured on the test project, harness.py ANON9)'
default_dep['ai_app_/_mcp_/_cloud_ functions executable by anon or authenticated'] = 'covers every function with these prefixes, including ones created before the lane'
default_dep['cron job cloud-todo-purge'] += '; scheduled only where pg_cron is available (the migration skips it otherwise)'


# ------------------------------------------------------------------------------------------------ SQL
def render(k):
    keys = keys_of(k) if k != 'final' else FINAL_KEYS
    st = per[k]['state'] if k != 'final' else FINAL
    want = WANT[k]
    label = k if k != 'final' else 'final'
    fn_rows = []
    for sig in keys['fn']:
        x = st['fn'][sig]
        fn_rows.append('(' + ', '.join(lit(s) for s in ['public.' + sig] + [want[f'function {sig} {a}'] for a in FN_ATTRS]) + ')')
    gone_rows = [f"({lit('public.' + s)})" for s in keys['dropped']]
    rel_rows = []
    for t in keys['tables']:
        x = st['tables'][t]
        rel_rows.append('(' + ', '.join(lit(s) for s in (t, x['kind'], x['owner'], str(x.get('rls', False)).lower(), x.get('columns', ''),
                                                          x.get('seqtype', ''))) + ')')
    col_rows = [f"({lit(c.split('.')[0])}, {lit(c.split('.')[1])}, {lit(want['column ' + c])})" for c in keys['cols']]
    con_rows = [f"({lit(c.split('.')[0])}, {lit(c.split('.')[1])}, {lit(want['constraint ' + c])})" for c in keys['cons']]
    idx_rows = [f"({lit(i)}, {lit(want['index ' + i])})" for i in keys['idx']]
    cron_rows = [f"({lit(j)}, {lit(want['cron job ' + j])})" for j in keys['cron']]
    led_rows = [f"({lit(v)})" for v in keys['ledger']]
    anon_rows = [f"({lit('public.' + s)})" for s in anon_list(st)]
    sweep_rows = [f"({lit('public.' + s)})" for s in sweep_list(st)]

    def values(name, cols, rows, types):
        if rows:
            return f"{name}({cols}) AS (VALUES\n    " + ',\n    '.join(rows) + ')'
        return f"{name}({cols}) AS (SELECT {', '.join('NULL::' + t for t in types)} WHERE false)"

    n_fn, n_gone, n_rel = len(fn_rows), len(gone_rows), len(rel_rows)
    head = f"""-- postcheck-{label}.sql  (generated by {REL}/gen.py; do not hand-edit)
-- """ + (f"""State right after migration {per[k]['file']}
--   (migration file md5 {per[k]['file_md5']}). Run it right after that migration, before the next one.""" if k != 'final' else
           """State after all ten migrations 20261118100000 .. 20261118190000 (each object at its latest definition).""") + f"""
-- Read-only: one SELECT over pg_catalog views, cron.job and supabase_migrations.schema_migrations.
-- Returns one row 'ok', or fails with: invalid input syntax for type integer: "POSTCHECK {label} FAILED: <id>: want <x>, got <y> | ...".
-- Pins: {n_fn} functions, {n_gone} functions absent, {n_rel} tables or sequences, {len(col_rows)} added columns, {len(con_rows)} constraints,
-- {len(idx_rows)} indexes, {len(cron_rows)} cron jobs, {len(led_rows)} ledger rows, the anon-callable mcp_ list ({len(anon_rows)} names) and the
-- internal-prefix sweep ({len(sweep_rows)} expected).
"""
    sql = head + 'WITH\n' + ',\n'.join([
        values('fn', 'sig, md5, owner, secdef, vol, lang, config, ret, exec', fn_rows, ['text'] * 9),
        values('gone', 'sig', gone_rows, ['text']),
        values('rel', 'name, kind, owner, rls, cols, seqtype', rel_rows, ['text'] * 6),
        values('col', 'tbl, name, want', col_rows, ['text'] * 3),
        values('con', 'tbl, name, want', con_rows, ['text'] * 3),
        values('idx', 'name, want', idx_rows, ['text'] * 2),
        values('job', 'name, want', cron_rows, ['text'] * 2),
        values('led', 'version', led_rows, ['text']),
        values('anon_want', 'sig', anon_rows, ['text']),
        values('sweep_want', 'sig', sweep_rows, ['text']),
        CHECKS.replace('@@LABEL@@', label)]) + '\n' + FINAL_SELECT.replace('@@LABEL@@', label)
    return sql


GRANTEES = """(SELECT string_agg(g.r, ',' ORDER BY g.r COLLATE "C") FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS r
             FROM pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE a.privilege_type = 'EXECUTE') g)"""
CHECKS = """checks(id, want, got) AS (
  SELECT 'function ' || substr(e.sig, 8) || ' ' || x.attr, x.want, x.got
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
      ('execute', e.exec, """ + GRANTEES + """)) x(attr, want, got)
   WHERE x.attr = 'exists' OR p.oid IS NOT NULL
  UNION ALL
  SELECT 'function ' || substr(g.sig, 8) || ' exists', 'false', (pg_catalog.to_regprocedure(g.sig) IS NOT NULL)::text FROM gone g
  UNION ALL
  SELECT 'relation ' || r.name || ' ' || x.attr, x.want, x.got
    FROM rel r
    LEFT JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass('public.' || r.name)
    CROSS JOIN LATERAL (VALUES
      ('kind', r.kind, c.relkind::text),
      ('owner', r.owner, c.relowner::regrole::text),
      ('grants to others', '', coalesce((SELECT string_agg(z.s, ',' ORDER BY z.s COLLATE "C") FROM (
          SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ':' || a.privilege_type AS s
            FROM pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) a
           WHERE a.grantee <> c.relowner) z), '')),
      ('rls', CASE WHEN r.kind = 'r' THEN r.rls END, CASE WHEN r.kind = 'r' THEN c.relrowsecurity::text END),
      ('policies', CASE WHEN r.kind = 'r' THEN '' END, CASE WHEN r.kind = 'r' THEN coalesce((SELECT string_agg(y.polname::text, ',' ORDER BY y.polname::text COLLATE "C")
                                                                  FROM pg_catalog.pg_policy y WHERE y.polrelid = c.oid), '') END),
      ('columns', CASE WHEN r.kind = 'r' THEN r.cols END, CASE WHEN r.kind = 'r' THEN (SELECT string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
                                                                  || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END, ', ' ORDER BY a.attnum)
                                                             FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) END),
      ('sequence type', CASE WHEN r.kind = 'S' THEN r.seqtype END, CASE WHEN r.kind = 'S' THEN (SELECT pg_catalog.format_type(q.seqtypid, NULL)
                                                                  FROM pg_catalog.pg_sequence q WHERE q.seqrelid = c.oid) END)) x(attr, want, got)
   WHERE (x.attr = 'kind' OR c.oid IS NOT NULL) AND (x.want IS NOT NULL OR x.got IS NOT NULL)
  UNION ALL
  SELECT 'column ' || o.tbl || '.' || o.name, o.want,
         (SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
            FROM pg_catalog.pg_attribute a WHERE a.attrelid = pg_catalog.to_regclass('public.' || o.tbl) AND a.attname = o.name AND NOT a.attisdropped)
    FROM col o
  UNION ALL
  SELECT 'constraint ' || o.tbl || '.' || o.name, o.want,
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
  SELECT 'index ' || i.name, i.want,
         (SELECT t.relname::text || ' unique=' || x.indisunique::text || ' ('
                 || (SELECT string_agg(a.attname::text, ',' ORDER BY u.ord) FROM unnest(x.indkey::int2[]) WITH ORDINALITY u(n, ord)
                       JOIN pg_catalog.pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = u.n)
                 || ') partial=' || (x.indpred IS NOT NULL)::text
            FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
           WHERE x.indexrelid = pg_catalog.to_regclass('public.' || i.name) AND t.relnamespace = 'public'::regnamespace)
    FROM idx i
  UNION ALL
  SELECT 'cron job ' || j.name, j.want,
         (SELECT string_agg(c.schedule || ' | ' || c.command || ' | ' || c.username || ' | ' || CASE WHEN c.active THEN 'active' ELSE 'inactive' END
                            || ' | ' || CASE WHEN c.database = current_database() THEN 'this database' ELSE 'database ' || c.database END, ' & ' ORDER BY c.jobid)
            FROM cron.job c WHERE c.jobname = j.name)
    FROM job j
  UNION ALL
  SELECT 'ledger row ' || l.version, 'true',
         EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations s WHERE s.version = l.version)::text
    FROM led l
  UNION ALL
  SELECT 'anon-callable mcp_ functions', 'missing: none; extra: none',
         'missing: ' || coalesce((SELECT string_agg(substr(w.sig, 8), ', ' ORDER BY w.sig COLLATE "C") FROM anon_want w
                                   WHERE NOT coalesce(pg_catalog.has_function_privilege('anon', pg_catalog.to_regprocedure(w.sig), 'EXECUTE'), false)), 'none')
         || '; extra: ' || coalesce((SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text COLLATE "C") FROM pg_catalog.pg_proc p
                                      WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^mcp_' AND pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
                                        AND p.oid NOT IN (SELECT pg_catalog.to_regprocedure(w.sig)::oid FROM anon_want w WHERE pg_catalog.to_regprocedure(w.sig) IS NOT NULL)), 'none')
  UNION ALL
  SELECT 'ai_app_/_mcp_/_cloud_ functions executable by anon or authenticated', 'missing: none; extra: none',
         'missing: ' || coalesce((SELECT string_agg(substr(w.sig, 8), ', ' ORDER BY w.sig COLLATE "C") FROM sweep_want w
                                   WHERE pg_catalog.to_regprocedure(w.sig) IS NULL), 'none')
         || '; extra: ' || coalesce((SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text COLLATE "C") FROM pg_catalog.pg_proc p
                                      WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^(ai_app_|_mcp_|_cloud_)'
                                        AND (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'))
                                        AND p.oid NOT IN (SELECT pg_catalog.to_regprocedure(w.sig)::oid FROM sweep_want w WHERE pg_catalog.to_regprocedure(w.sig) IS NOT NULL)), 'none')
)"""
FINAL_SELECT = """SELECT CASE WHEN f.msg IS NULL THEN 'ok'
            ELSE ('POSTCHECK @@LABEL@@ FAILED: ' || f.msg)::integer::text END AS postcheck
  FROM (SELECT string_agg(c.id || ': want ' || coalesce(c.want, '(null)') || ', got ' || coalesce(c.got, '(null)'), ' | ' ORDER BY c.id COLLATE "C") AS msg
          FROM checks c WHERE c.got IS DISTINCT FROM c.want) f;
"""

FILES = {v: render(v) for v in VERSIONS}
FILES['final'] = render('final')


# ------------------------------------------------------------------------------------------------ test-project verification files
def strip_sql(s):
    return s.rstrip().rstrip(';')


RUN_ORDER = ['final'] + VERSIONS
verify_run = f"""-- verify-run.sql (generated by {REL}/gen.py) — TEST PROJECT ONLY (~/.claude/bin/kt-sql). Read-only.
-- Runs postcheck-final.sql and the ten postcheck files once each, verbatim, each in its own exception block, and ends in
-- RAISE with 'ok' or the error text per file. Afterwards: ~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()".
DO $verify4263prod$
DECLARE r jsonb := '{{}}'; v text;
BEGIN
""" + ''.join(f"""  BEGIN
    EXECUTE $pc{i}$
{strip_sql(FILES[k])}
$pc{i}$ INTO v;
    r := r || jsonb_build_object({lit(k)}, v);
  EXCEPTION WHEN others THEN
    r := r || jsonb_build_object({lit(k)}, SQLERRM);
  END;
""" for i, k in enumerate(RUN_ORDER)) + """  RAISE EXCEPTION 'POSTCHECK_RUN %', r;
END
$verify4263prod$;
"""


def mig_create(v, name):
    for raw, code, spans in split(rd(per[v]['file'])):
        if re.match(r'\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.' + name + r'\s*\(', code, re.I):
            last = raw
    return last.strip()


REG_CREATE = mig_create('20261118190000', 'mcp_register_client')
assert REG_CREATE.count('/*BODY:4263-10.4-register*/') == 1
CONTROLS = [  # (id, postcheck, break statements, proof that the break applied)
    ('B1_body_one_character', '20261118190000', [REG_CREATE.replace('/*BODY:4263-10.4-register*/', '/*BODY:4263-10.4-registeR*/')],
     "(SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.mcp_register_client(text,text,text,text[],bytea)'::regprocedure) <> "
     + lit(FINAL['fn']['mcp_register_client(text,text,text,text[],bytea)']['md5'])),
    ('B2_internal_granted_anon', '20261118190000', ['GRANT EXECUTE ON FUNCTION public._mcp_prune_unused_clients() TO anon'],
     "has_function_privilege('anon', 'public._mcp_prune_unused_clients()'::regprocedure, 'EXECUTE')"),
    ('B3_owner_changed', '20261118180000', ['GRANT CREATE ON SCHEMA public TO mcp_reader',
                                            'ALTER FUNCTION public.ai_app_notice_done(uuid, integer, text, text) OWNER TO mcp_reader'],
     "(SELECT proowner::regrole::text FROM pg_proc WHERE oid = 'public.ai_app_notice_done(uuid,integer,text,text)'::regprocedure) = 'mcp_reader'"),
    ('B4_volatile_to_stable', '20261118150000', ['ALTER FUNCTION public.mcp_find_people(text, bytea, text, text, text, text, text, text, text) STABLE'],
     "(SELECT provolatile FROM pg_proc WHERE oid = 'public.mcp_find_people(text,bytea,text,text,text,text,text,text,text)'::regprocedure) = 's'"),
    ('B5_search_path_removed', '20261118150000', ['ALTER FUNCTION public.mcp_list_todos(text, bytea, text, text, text, text, text, boolean, boolean, text) RESET search_path'],
     "(SELECT proconfig IS NULL FROM pg_proc WHERE oid = 'public.mcp_list_todos(text,bytea,text,text,text,text,text,boolean,boolean,text)'::regprocedure)"),
    ('B6_rls_disabled_notice_table', '20261118180000', ['ALTER TABLE public.ai_app_connect_notices DISABLE ROW LEVEL SECURITY'],
     "(SELECT NOT relrowsecurity FROM pg_class WHERE oid = 'public.ai_app_connect_notices'::regclass)"),
    ('B7_cron_schedule_changed', '20261118190000', ["SELECT cron.schedule('mcp-unused-client-prune', '0 * * * *', 'SELECT public._mcp_prune_unused_clients()')"],
     "EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mcp-unused-client-prune' AND schedule = '0 * * * *')"),
    ('B8_anon_name_swapped_17_kept', '20261118190000', ['REVOKE EXECUTE ON FUNCTION public.mcp_get_status(text, bytea, text) FROM anon',
                                                        'GRANT EXECUTE ON FUNCTION public.mcp_list_my_connections() TO anon'],
     "(SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE')) = 17"
     " AND NOT has_function_privilege('anon', 'public.mcp_get_status(text,bytea,text)'::regprocedure, 'EXECUTE')"),
    ('B9_table_granted_service_role', '20261118180000', ['GRANT SELECT ON public.ai_app_connect_notices TO service_role'],
     "has_table_privilege('service_role', 'public.ai_app_connect_notices'::regclass, 'SELECT')"),
    ('B10_purge_job_schedule_changed', 'final', ["SELECT cron.schedule('cloud-todo-purge', '0 5 * * *', 'SELECT public._cloud_todo_purge()')"],
     "EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cloud-todo-purge' AND schedule = '0 5 * * *')"),
]
for _c in CONTROLS:
    assert _c[1] == 'final' or not predicted_failures(_c[1], 'final'), ('control on a post-check that fails at the final state', _c[0])
CONTROL_WANT = {  # id -> substring the raised message must contain
    'B1_body_one_character': 'function mcp_register_client(text,text,text,text[],bytea) md5',
    'B2_internal_granted_anon': 'function _mcp_prune_unused_clients() execute',
    'B3_owner_changed': 'function ai_app_notice_done(uuid,integer,text,text) owner',
    'B4_volatile_to_stable': 'volatility: want v, got s',
    'B5_search_path_removed': 'function mcp_list_todos(text,bytea,text,text,text,text,text,boolean,boolean,text) config',
    'B6_rls_disabled_notice_table': 'relation ai_app_connect_notices rls: want true, got false',
    'B7_cron_schedule_changed': 'cron job mcp-unused-client-prune',
    'B8_anon_name_swapped_17_kept': 'anon-callable mcp_ functions',
    'B9_table_granted_service_role': 'relation ai_app_connect_notices grants to others',
    'B10_purge_job_schedule_changed': 'cron job cloud-todo-purge',
}


def ctl_block(i, cid, pc, breaks, proof):
    q = strip_sql(FILES[pc])
    qf = strip_sql(FILES['final'])
    stm = ''.join(f"    EXECUTE {dq(b, f'$b{i}_{n}$')};\n" for n, b in enumerate(breaks))
    return f"""  -- {cid}: postcheck-{pc}
  BEGIN
    BEGIN EXECUTE {dq(q, f'$q{i}$')} INTO v; o := jsonb_build_object('before', v); EXCEPTION WHEN others THEN o := jsonb_build_object('before', SQLERRM); END;
{stm}    EXECUTE 'SELECT (' || {lit(proof)} || ')::text' INTO v; o := o || jsonb_build_object('applied', v);
    BEGIN EXECUTE {dq(q, f'$r{i}$')} INTO v; o := o || jsonb_build_object('after', v); EXCEPTION WHEN others THEN o := o || jsonb_build_object('after', SQLERRM); END;
    BEGIN EXECUTE {dq(qf, f'$f{i}$')} INTO v; o := o || jsonb_build_object('final_after', v); EXCEPTION WHEN others THEN o := o || jsonb_build_object('final_after', SQLERRM); END;
    RAISE EXCEPTION 'undo-{cid}';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'undo-{cid}' THEN o := o || jsonb_build_object('error', SQLERRM); END IF;
    r := r || jsonb_build_object({lit(cid)}, o || jsonb_build_object('postcheck', {lit(pc)}, 'want_in_message', {lit(CONTROL_WANT[cid])}));
  END;
"""


def dq(s, tag):
    assert tag not in s
    return tag + '\n' + s + '\n' + tag


verify_controls = f"""-- verify-controls.sql (generated by {REL}/gen.py) — TEST PROJECT ONLY (~/.claude/bin/kt-sql).
-- One transaction that ends in RAISE, so nothing is kept. For each break: the post-check passes, the break is made in a
-- subtransaction, a catalogue probe shows it applied, the same post-check (and postcheck-final) must raise naming what differs,
-- then the subtransaction is undone. Afterwards: ~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset()".
SET LOCAL lock_timeout = '5s';
DO $controls4263prod$
DECLARE r jsonb := '{{}}'; o jsonb; v text;
BEGIN
""" + ''.join(ctl_block(i, *c) for i, c in enumerate(CONTROLS)) + """  RAISE EXCEPTION 'POSTCHECK_CONTROLS %', r;
END
$controls4263prod$;
"""


# ------------------------------------------------------------------------------------------------ expected.json, README
def counts(k):
    keys = keys_of(k) if k != 'final' else FINAL_KEYS
    return {'functions': len(keys['fn']), 'functions_absent': len(keys['dropped']), 'tables_or_sequences': len(keys['tables']),
            'columns_added': len(keys['cols']), 'constraints': len(keys['cons']), 'indexes': len(keys['idx']), 'cron_jobs': len(keys['cron']),
            'ledger_rows': len(keys['ledger'])}


expected = {
    'generated_by': f'{REL}/gen.py',
    'migrations': {v: {'file': per[v]['file'], 'file_md5': per[v]['file_md5']} for v in VERSIONS},
    'anon_callable_mcp_by_stage': {'before_lane': ANON9, **{v: anon_list(per[v]['state']) for v in VERSIONS}},
    'postchecks': {k: {'file': f'postcheck-{k}.sql', 'counts': counts(k), 'pins': WANT[k]} for k in RUN_ORDER},
    'fails_after': {k: {j: PRED[k][j] for j in PRED[k] if PRED[k][j]} for k in VERSIONS},
    'expected_at_final_state': {k: ('ok' if not predicted_failures(k, 'final') else predicted_failures(k, 'final')) for k in VERSIONS},
    'rests_on_default_or_pre_lane_state': {k: default_dep[k] for k in sorted(default_dep) if any(k in WANT[x] for x in RUN_ORDER)},
    'controls': {c[0]: {'postcheck': c[1], 'message_names': CONTROL_WANT[c[0]]} for c in CONTROLS},
}
assert not predicted_failures('final', 'final')


def short(v):
    return v[8:10] + v[10:12]


rows = []
for k in VERSIONS:
    later = [j for j in VERSIONS if j > k]
    cells = []
    for j in later:
        ids = PRED[k][j]
        cells.append(f'{j}: ' + ('passes' if not ids else 'FAILS (' + '; '.join(ids) + ')'))
    rows.append(f'| `postcheck-{k}.sql` | ' + ('<br>'.join(cells) if cells else '(last migration)') + ' |')

readme = f"""# Production post-checks for migrations {FIRST} .. {LAST} (BACKLOG-4263)

Generated by `gen.py`; do not hand-edit. `python3 gen.py check` fails when any file here is stale.

## What each file is

`postcheck-<version>.sql` is one read-only `SELECT` that describes the database right after migration `<version>`.
It returns one row with the value `ok`, or it fails with an error whose text names every difference:

```
invalid input syntax for type integer: "POSTCHECK <version> FAILED: <id>: want <x>, got <y> | <id>: want <x>, got <y>"
```

Style: one `SELECT`, not a `DO` block. A `SELECT` cannot change anything, returns a visible `ok` row through any SQL
client (including ones that drop notices), and fails with a message by casting the list of differences to `integer`,
which only runs when there is a difference.

Catalogue views read: `pg_catalog.pg_proc`, `pg_language`, `pg_class`, `pg_attribute`, `pg_constraint`, `pg_index`,
`pg_policy`, `pg_sequence`, `pg_namespace`, the functions `to_regprocedure`, `to_regclass`, `aclexplode`, `acldefault`,
`format_type`, `pg_get_constraintdef`, `has_function_privilege`, plus `cron.job` and
`supabase_migrations.schema_migrations`. No temporary table, no setting, no data table.

## How to run

1. Apply migration `<version>`.
2. Run `postcheck-<version>.sql` right after it, before the next migration.
3. `ok` means the state matches. An error means it does not; the message names each difference.

Run them in order, each right after its own migration. A file describes the state right after its own migration, so
running an earlier file after a later migration fails where the later migration changed something it pins (table
below). `postcheck-final.sql` describes the state after all ten.

## What each file pins

For every function the migration creates or replaces: it exists with the exact argument types, `md5(prosrc)` (computed
here from the migration text), owner, `prosecdef`, `provolatile`, language, `proconfig`, return type, and the exact set
of roles with `EXECUTE` (from `proacl`; `PUBLIC` appears in the set only if it holds `EXECUTE`).
For every function it drops: absent. For every table or sequence it creates: kind, owner, no grantee other than the
owner, row level security flag, policy names (none), columns with types and `not null`. Added columns: type and
`not null`. Constraints it adds: type, columns, and for a `CHECK` the set of quoted literals in its definition, for a
foreign key the referenced table, columns and delete action. Indexes it creates: table, unique, columns, partial.
Cron jobs it schedules: the job exists exactly once with this schedule, command, username, active, in this database.
The ledger row of its own version. The anon-callable `mcp_*` functions exactly as listed for that stage. No function
named `ai_app_*`, `_mcp_*` or `_cloud_*` executable by `anon` or `authenticated` beyond the ones listed for that stage
(none at every stage).

Not pinned: totals of functions or cron jobs, row counts, other versions in the ledger, any id.

| File | Functions | Absent | Tables/sequences | Added columns | Constraints | Indexes | Cron jobs | anon `mcp_*` |
|---|---|---|---|---|---|---|---|---|
""" + '\n'.join(f"| `postcheck-{k}.sql` | {counts(k)['functions']} | {counts(k)['functions_absent']} | {counts(k)['tables_or_sequences']} | "
                f"{counts(k)['columns_added']} | {counts(k)['constraints']} | {counts(k)['indexes']} | {counts(k)['cron_jobs']} | "
                f"{len(anon_list(per[k]['state'] if k != 'final' else FINAL))} |" for k in RUN_ORDER) + f"""

## Anon-callable `mcp_*` functions at each stage

""" + '\n'.join(f"- {'before the lane' if s == 'before_lane' else 'after ' + s}: {len(l)}" + (f" (+ {', '.join(C(set(l) - set(prev)))})" if prev is not None and set(l) - set(prev) else '')
                for s, l, prev in [(s, l, p) for (s, l), p in zip(expected['anon_callable_mcp_by_stage'].items(),
                                                                  [None] + list(expected['anon_callable_mcp_by_stage'].values())[:-1])]) + f"""

Full lists: `expected.json` → `anon_callable_mcp_by_stage`.

## Which earlier post-checks fail after which later migration

Expected; each cell lists the ids that differ.

| Post-check | Result after each later migration |
|---|---|
""" + '\n'.join(rows) + f"""

## Checks that rest on a default or on state from before the lane

These can differ on another database for a benign reason (the migration does not set them explicitly). Full list with
the reason per assertion: `expected.json` → `rests_on_default_or_pre_lane_state` ({len(expected['rests_on_default_or_pre_lane_state'])} assertions).

- Owner of every function and table the lane creates as `postgres` = the role that runs the migration.
- Owner and `EXECUTE` list of functions that existed before the lane and are replaced (`CREATE OR REPLACE` keeps both).
- `EXECUTE` = owner + explicit grants assumes the default privileges grant to no role beyond `PUBLIC`, `anon`,
  `authenticated`, `service_role` (the four each migration revokes); same for table grants.
- Cron `username` = the role that runs `cron.schedule`; `cloud-todo-purge` exists only where `pg_cron` is available.
- The anon-callable list includes the nine functions that existed before the lane; the prefix sweep covers functions
  created before the lane.

## Files

| File | What it is |
|---|---|
| `gen.py` | Generator and `check` / `report` modes |
| `postcheck-<version>.sql` | Read-only post-check per migration (ten) |
| `postcheck-final.sql` | Read-only post-check of the state after all ten |
| `expected.json` | Pinned facts, anon list per stage, predicted failures, default-dependent assertions |
| `verify-run.sql` | Test project only: runs the final and the ten files once each, ends in `RAISE` |
| `verify-controls.sql` | Test project only: breaks the catalogue inside one transaction that ends in `RAISE` (nothing kept) and records that the matching post-check passes before and fails after each break |
"""

OUTS = {f'postcheck-{k}.sql': FILES[k] for k in RUN_ORDER}
OUTS['expected.json'] = json.dumps(expected, indent=2, ensure_ascii=False) + '\n'
OUTS['README.md'] = readme
OUTS['verify-run.sql'] = verify_run
OUTS['verify-controls.sql'] = verify_controls


if len(sys.argv) > 2 and sys.argv[1] == 'report':
    raw = open(sys.argv[2]).read()
    try:
        msg = json.loads(raw.splitlines()[0])['message']
    except Exception:
        msg = raw
    if 'POSTCHECK_RUN ' in msg:
        res = json.loads(msg[msg.index('POSTCHECK_RUN ') + 14:].split('\nCONTEXT')[0])
        bad = 0
        for k in RUN_ORDER:
            got = res.get(k)
            pred = expected['expected_at_final_state'].get(k, 'ok') if k != 'final' else 'ok'
            if pred == 'ok':
                ok = got == 'ok'
            else:
                ids = re.findall(r'(?:^|\| )([^|]+?): want ', got.split('FAILED: ', 1)[1]) if got and 'FAILED: ' in got else None
                ok = ids is not None and sorted(i.strip() for i in ids) == sorted(pred)
            bad += not ok
            print(('MATCH ' if ok else 'DIFF  ') + k + ': ' + (got if got == 'ok' else (got or '')[:3000]))
            if not ok:
                print('      predicted: ' + json.dumps(pred))
        sys.exit(1 if bad else 0)
    if 'POSTCHECK_CONTROLS ' in msg:
        res = json.loads(msg[msg.index('POSTCHECK_CONTROLS ') + 19:].split('\nCONTEXT')[0])
        bad = 0
        for cid, *_ in CONTROLS:
            o = res.get(cid, {})
            ok = (o.get('before') == 'ok' and o.get('applied') == 'true' and 'FAILED' in (o.get('after') or '')
                  and CONTROL_WANT[cid] in (o.get('after') or '') and 'FAILED' in (o.get('final_after') or '') and 'error' not in o)
            bad += not ok
            print(('OK  ' if ok else 'BAD ') + cid + ' ' + json.dumps(o, ensure_ascii=False)[:1500])
        sys.exit(1 if bad else 0)
    print(msg[:3000])
    sys.exit(2)
if len(sys.argv) > 1 and sys.argv[1] == 'check':
    bad = [k for k, v in OUTS.items() if not os.path.exists(os.path.join(HERE, k)) or open(os.path.join(HERE, k), encoding='utf-8').read() != v]
    print('differs: ' + ', '.join(bad) if bad else 'all generated files match')
    sys.exit(1 if bad else 0)
for k, v in OUTS.items():
    open(os.path.join(HERE, k), 'w', encoding='utf-8').write(v)
for k in RUN_ORDER:
    print(f'postcheck-{k}.sql', md5(OUTS[f"postcheck-{k}.sql"]), counts(k), 'anon', len(anon_list(per[k]['state'] if k != 'final' else FINAL)))
print('statement kinds outside the modelled ones:', stmt_kinds)
