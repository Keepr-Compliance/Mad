#!/usr/bin/env python3
"""BACKLOG-4263 harness answer check: every literal a harness compares a product function's ANSWER against (a key it
reads, a status / error / refusal code it expects) must be a literal that function can emit.

What a function can emit (E): every single-quoted literal in its body as the migrations define it (the latest
definition of each name, across the migrations up to LAST), every key and string value of a JSON literal among them, and
the same for every public function its body calls, transitively. A superset: a literal in E is not proven to reach the
answer, but a literal outside E cannot come from that function.

What a harness compares (per .sql file of a folder, after comments are removed):
  - helpers:   each pg_temp.<name> is linked to the product functions (cloud_*, mcp_*, _mcp_*, ...) it calls, by name
               in its body (public.<fn>( or a string literal naming a function), and through other helpers it calls;
  - variables: `v := <expression>` / `DECLARE v jsonb := <expression>` links v to the product functions named in the
               expression, through helpers;
  - compares:  a JSON path on a linked variable or an inline helper call (`x -> 'a' ->> 'b'`, `x ? 'k'`) is checked key
               by key; when it is compared (=, <>, !=, IS [NOT] DISTINCT FROM) with a string literal, that literal is
               checked too, unless it is data the harness itself passed in (a literal that occurs in the file outside
               every compare); a variable or call compared with a JSON object literal is checked key by key and value
               by value. A compare whose left side links to no product function is listed as not checkable.

`python3 answers.py <folder> [...]`  prints findings and not-checkable compares; exit 1 when there is a finding.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
MIGDIR = os.path.join(REPO, 'supabase', 'migrations')
FIRST, LAST = '20261112', '20261123140000'
LIT = re.compile(r"'((?:[^']|'')*)'")


def strip_comments(sql):
    """-- and /* */ comments removed; string literals and dollar quotes kept (comments inside them are removed too)."""
    out, i, n = [], 0, len(sql)
    while i < n:
        if sql.startswith('--', i):
            j = sql.find('\n', i)
            i = n if j < 0 else j
            continue
        if sql.startswith('/*', i):
            j = sql.find('*/', i + 2)
            i = n if j < 0 else j + 2
            out.append(' ')
            continue
        if sql[i] == "'":
            j = i + 1
            while True:
                j = sql.find("'", j)
                if j < 0:
                    j = n - 1
                    break
                if sql[j + 1:j + 2] == "'":
                    j += 2
                    continue
                break
            out.append(sql[i:j + 1])
            i = j + 1
            continue
        out.append(sql[i])
        i += 1
    return ''.join(out)


def literals(text):
    return [m.group(1).replace("''", "'") for m in LIT.finditer(text)]


def json_parts(s):
    """Keys and string values of a JSON literal (nothing when s is not a JSON object or array)."""
    s2 = s.strip()
    if not s2[:1] in ('{', '['):
        return set()
    try:
        v = json.loads(s2)
    except ValueError:
        return set()
    out = set()

    def walk(x):
        if isinstance(x, dict):
            for k, y in x.items():
                out.add(k)
                walk(y)
        elif isinstance(x, list):
            for y in x:
                walk(y)
        elif isinstance(x, str):
            out.add(x)
    walk(v)
    return out


def function_bodies():
    """name -> body (latest definition wins), over the lane's migration range."""
    files = sorted(f for f in os.listdir(MIGDIR) if f.endswith('.sql') and FIRST <= f[:14] <= LAST)
    bodies = {}
    for f in files:
        text = open(os.path.join(MIGDIR, f), encoding='utf-8').read()
        for m in re.finditer(r'CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\s*\(', text):
            a = re.compile(r'\bAS\s+(\$[A-Za-z0-9_]*\$)').search(text, m.end())
            if not a:
                continue
            tag = a.group(1)
            end = text.find(tag, a.end())
            bodies[m.group(1)] = text[a.end():end]
    return bodies


BODIES = function_bodies()


def emitted(fn, seen=None):
    seen = set() if seen is None else seen
    if fn in seen or fn not in BODIES:
        return set()
    seen.add(fn)
    body = strip_comments(BODIES[fn])
    out = set()
    for lit in literals(body):
        out.add(lit)
        out |= json_parts(lit)
        for inner in literals(lit):  # dynamic SQL: a literal inside a format() string
            out.add(inner)
            out |= json_parts(inner)
    for m in re.finditer(r'\bpublic\.(\w+)\s*\(', body):
        out |= emitted(m.group(1), seen)
    return out


PATH = r"(?:\s*->>?\s*(?:'(?:[^']|'')*'|\d+))+"
OPS = r"(?:IS\s+NOT\s+DISTINCT\s+FROM|IS\s+DISTINCT\s+FROM|<>|!=|(?<![:<>!])=)"


def compare_free_literals(text):
    """Literals of text that are not the right side of a compare."""
    spans = [(m.start(), m.end()) for m in re.finditer(OPS + r"\s*'(?:[^']|'')*'", text, re.I)]
    out = set()
    for m in LIT.finditer(text):
        if not any(a <= m.start() < b for a, b in spans):
            lit = m.group(1).replace("''", "'")
            out.add(lit)
            out |= json_parts(lit)
    return out


def helper_links(text):
    """pg_temp helper name -> ('products' it reaches, literals it builds itself outside compares, transitively)."""
    defs = {}
    for m in re.finditer(r'CREATE FUNCTION pg_temp\.(\w+)\s*\(', text):
        a = re.compile(r'\bAS\s+(\$[A-Za-z0-9_]*\$)').search(text, m.end())
        if a:
            defs[m.group(1)] = text[a.end():text.find(a.group(1), a.end())]
    out = {}
    for h in defs:
        prods, own, todo, seen = set(), set(), [h], set()
        while todo:
            x = todo.pop()
            if x in seen or x not in defs:
                continue
            seen.add(x)
            prods |= product_names(defs[x])
            own |= compare_free_literals(defs[x]) if re.search(r'jsonb_build_object|jsonb_build_array|jsonb_agg', defs[x]) else set()
            todo += re.findall(r'pg_temp\.(\w+)\s*\(', defs[x])
        out[h] = (prods, own)
    return out, defs


def product_names(expr):
    names = set(m.group(1) for m in re.finditer(r'\bpublic\.(\w+)\s*\(', expr))
    names |= set(lit for lit in literals(expr) if lit in BODIES)
    return {n for n in names if n in BODIES}


def sources_of(expr, helpers, var_at):
    """(product functions, helper-built literals) an expression's value can come from."""
    prods, own = set(product_names(expr)), set()
    for m in re.finditer(r'pg_temp\.(\w+)\s*\(', expr):
        p_, o_ = helpers.get(m.group(1), (set(), set()))
        prods |= p_
        own |= o_
    for m in re.finditer(r"(?<!')\b([a-z_][a-z0-9_]*)\b(?!\s*\()", expr):
        p_, o_ = var_at(m.group(1))
        prods |= p_
        own |= o_
    return prods, own


PRODUCT_DEF = re.compile(r'CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.\w+\s*\(.*?\bAS\s+(\$[A-Za-z0-9_]*\$)', re.S | re.I)


def drop_product_defs(text):
    """A harness's copies of product functions (mutants, rollbacks) are product code, not harness compares."""
    while True:
        m = PRODUCT_DEF.search(text)
        if not m:
            return text
        end = text.find(m.group(1), m.end())
        text = text[:m.start()] + ' ' + text[(len(text) if end < 0 else end + len(m.group(1))):]


def check_file(path, helpers, data):
    raw = open(path, encoding='utf-8').read()
    text = drop_product_defs(strip_comments(raw))
    findings, unchecked, checked = [], [], 0
    units = re.split(r'(?=CREATE FUNCTION pg_temp\.|\bDO \$)', text)
    for unit in units:
        assigns = []   # (pos, var, prods, own)
        aliases = {}   # alias -> (prods, own)
        var_json = {}

        def var_at(name, pos=None):
            if name in aliases:
                return aliases[name]
            best = None
            for a in assigns:
                if a[1] == name and (pos is None or a[0] < pos):
                    best = a
            return (best[2], best[3]) if best else (set(), set())
        for m in re.finditer(r"\b([a-z_][a-z0-9_]*)\s+jsonb\s*:=\s*'((?:[^']|'')*)'\s*;", unit):
            var_json[m.group(1)] = m.group(2).replace("''", "'")
        for m in re.finditer(r'(?<![:\w])([a-z_][a-z0-9_]*)\s+(?:jsonb\s+|text\s+)?:=\s*(.+?);', unit, re.S):
            pr, ow = sources_of(m.group(2), helpers, lambda n, p=m.start(): var_at(n, p))
            if pr or ow:
                assigns.append((m.start(), m.group(1), pr, ow))
        for m in re.finditer(r'jsonb_array_elements\s*\(((?:[^()]|\([^()]*\))*)\)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)', unit, re.I):
            aliases[m.group(2)] = sources_of(m.group(1), helpers, lambda n, p=m.start(): var_at(n, p))

        def judge(pos, base, keys, vals, expr):
            nonlocal checked
            if base.startswith('pg_temp.'):
                pr, ow = sources_of(base, helpers, lambda n: var_at(n, pos))
            else:
                pr, ow = var_at(base, pos)
            if not pr and not ow:
                unchecked.append((path, expr))
                return
            checked += 1
            em = set(ow).union(*(emitted(f) for f in pr)) if pr else set(ow)
            names = sorted(pr) + (['(helper-built)'] if ow else [])
            for k in keys:
                if k not in em:
                    findings.append((path, expr, k, names))
            for v in vals:
                if v in em or v in ('true', 'false', 'null', '') or re.fullmatch(r'-?\d+(\.\d+)?', v):
                    continue
                if v in data:
                    continue
                if any(len(d) >= 4 and v.startswith(d) for d in data):
                    unchecked.append((path, expr + '   [value computed from harness data]'))
                    continue
                findings.append((path, expr, v, names))
        for m in re.finditer(r"([a-z_][a-z0-9_]*)(" + PATH + r")?\s*\?\s*'((?:[^']|'')*)'", unit):
            judge(m.start(), m.group(1), literals(m.group(2) or '') + [m.group(3)], [], m.group(0).strip()[:140])
        for m in re.finditer(r"((?:pg_temp\.\w+\s*\((?:[^()]|\([^()]*\))*\))|\b[a-z_][a-z0-9_]*)(" + PATH + r")?\s*(" + OPS + r")\s*('(?:[^']|'')*'|[a-z_][a-z0-9_]*\b)", unit, re.I):
            base, path_, rhs = m.group(1), m.group(2) or '', m.group(4)
            if base.lower() in ('and', 'or', 'not', 'then', 'when', 'else', 'select', 'where', 'if', 'case', 'is', 'end'):
                continue
            rhs_lit = rhs[1:-1].replace("''", "'") if rhs.startswith("'") else var_json.get(rhs)
            if not path_ and (rhs_lit is None or not json_parts(rhs_lit)):
                continue
            jp = json_parts(rhs_lit) if rhs_lit is not None else set()
            vals = jp if jp else ({rhs_lit} if rhs_lit is not None and '->>' in path_ else set())
            judge(m.start(), base, literals(path_), vals, m.group(0).strip()[:140])
    return findings, unchecked, checked


def check_folder(folder):
    """A folder with lib/: its lib/*.sql (the generated harness embeds them). Otherwise every .sql file of the folder
    itself (not of subfolders) except apply and rollback files."""
    lib = os.path.join(folder, 'lib')
    if os.path.isdir(lib):
        files = sorted(os.path.join(lib, f) for f in os.listdir(lib) if f.endswith('.sql'))
    else:
        files = sorted(os.path.join(folder, f) for f in os.listdir(folder) if f.endswith('.sql') and not f.startswith(('apply-', 'rollback-')))
    allt = drop_product_defs(strip_comments('\n'.join(open(f, encoding='utf-8').read() for f in files)))
    helpers, _ = helper_links(allt)
    data = compare_free_literals(allt)
    out = {'files': [os.path.relpath(f, REPO) for f in files], 'findings': [], 'unchecked': [], 'checked': 0}
    for f in files:
        fi, un, n = check_file(f, helpers, data)
        out['findings'] += [(os.path.relpath(a, REPO), b, c, d) for a, b, c, d in fi]
        out['unchecked'] += [(os.path.relpath(a, REPO), b) for a, b in un]
        out['checked'] += n
    return out


if __name__ == '__main__':
    bad = 0
    for folder in sys.argv[1:]:
        r = check_folder(os.path.abspath(folder))
        print(f"== {os.path.relpath(os.path.abspath(folder), REPO)}: {len(r['files'])} files, {r['checked']} compares checked, "
              f"{len(r['findings'])} findings, {len(r['unchecked'])} not checkable")
        for f, expr, lit, fns in r['findings']:
            print(f"  FINDING {f}: {lit!r} is not emitted by {','.join(fns)}: {expr}")
        for f, expr in r['unchecked']:
            print(f"  not checkable {f}: {expr}")
        bad += len(r['findings'])
    sys.exit(1 if bad else 0)
