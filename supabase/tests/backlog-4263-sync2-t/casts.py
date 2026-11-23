#!/usr/bin/env python3
"""BACKLOG-4263 cast check: a pg_catalog column whose type is not text, used as an operand of `||` or as a direct
argument of a concatenating function (concat, concat_ws, string_agg, format) without an explicit cast, is a finding.

PostgreSQL resolves `text || "char"` (and `|| boolean`, `|| oid`, `|| name`, `|| aclitem[]`) only when the database
plans the statement, so a parser cannot see the error; this check sees the part of that class the text shows. It reads
the SQL with comments and single-quoted literals blanked (dollar-quoted bodies are read: function bodies live there).

`python3 casts.py <file>...`  prints findings; exit 1 when there is one.
"""
import re
import sys

# pg_catalog columns that are not text (PostgreSQL catalog documentation; types from memory, not queried):
# "char", boolean, oid, name, aclitem[], int2[] ...
NON_TEXT = {
    'pg_proc': {'provolatile': '"char"', 'prosecdef': 'boolean', 'proowner': 'oid', 'proacl': 'aclitem[]', 'prokind': '"char"',
                'proparallel': '"char"', 'proleakproof': 'boolean', 'proisstrict': 'boolean', 'proretset': 'boolean',
                'pronamespace': 'oid', 'prorettype': 'oid', 'proname': 'name', 'proconfig': 'text[]'},
    'pg_class': {'relowner': 'oid', 'relacl': 'aclitem[]', 'relkind': '"char"', 'relpersistence': '"char"',
                 'relrowsecurity': 'boolean', 'relname': 'name', 'relnamespace': 'oid'},
    'pg_constraint': {'contype': '"char"', 'conname': 'name', 'confdeltype': '"char"', 'convalidated': 'boolean',
                      'conrelid': 'oid', 'confrelid': 'oid', 'conkey': 'int2[]'},
    'pg_roles': {'rolsuper': 'boolean', 'rolinherit': 'boolean', 'rolname': 'name'},
    'pg_auth_members': {'inherit_option': 'boolean', 'set_option': 'boolean', 'admin_option': 'boolean',
                        'roleid': 'oid', 'member': 'oid'},
    'pg_namespace': {'nspacl': 'aclitem[]', 'nspname': 'name', 'nspowner': 'oid'},
    'pg_attribute': {'attnum': 'int2', 'attname': 'name', 'attcompression': '"char"', 'attstorage': '"char"'},
    'pg_policy': {'polrelid': 'oid', 'polname': 'name'},
}
COLS = {c: (t, ty) for t, cs in NON_TEXT.items() for c, ty in cs.items()}
CONCAT_FNS = ('concat', 'concat_ws', 'string_agg', 'format')


def blank(sql):
    """Comments and single-quoted literals replaced by spaces (same length, so offsets and line numbers hold)."""
    out, i, n = list(sql), 0, len(sql)
    while i < n:
        if sql.startswith('--', i):
            j = sql.find('\n', i)
            j = n if j < 0 else j
            out[i:j] = ' ' * (j - i)
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
            out[i:j + 1] = ' ' * (j + 1 - i)
            i = j + 1
            continue
        i += 1
    return ''.join(out)


def enclosing_call(t, pos):
    """Name of the function whose argument list directly contains pos (no other parenthesis between), else None."""
    depth = 0
    i = pos - 1
    while i >= 0:
        c = t[i]
        if c == ')':
            depth += 1
        elif c == '(':
            if depth == 0:
                m = re.search(r'([A-Za-z_][A-Za-z0-9_.]*)\s*$', t[:i])
                return m.group(1).split('.')[-1].lower() if m else None
            depth -= 1
        elif c == ';' and depth == 0:
            return None
        i -= 1
    return None


def findings(sql):
    t = blank(sql)
    out = []
    for m in re.finditer(r'(?<![A-Za-z0-9_$])(?:[A-Za-z_][A-Za-z0-9_]*\.)?(' + '|'.join(COLS) + r')(?![A-Za-z0-9_])', t):
        col = m.group(1)
        after = t[m.end():]
        if re.match(r'\s*::', after):
            continue  # explicit cast
        before = t[:m.start()]
        why = None
        if re.search(r'\|\|\s*$', before) or re.match(r'\s*\|\|', after):
            why = 'operand of ||'
        else:
            fn = enclosing_call(t, m.start())
            # a direct argument: the text between the argument's start and the column is only whitespace/commas
            if fn in CONCAT_FNS:
                k = m.start() - 1
                while k >= 0 and t[k] in ' \t\n':
                    k -= 1
                if k >= 0 and t[k] in '(,':
                    why = f'direct argument of {fn}()'
        if why:
            line = sql.count('\n', 0, m.start()) + 1
            text = sql.splitlines()[line - 1].strip()
            out.append((line, col, COLS[col][1], why, text[:160]))
    return out


def main(files):
    bad = 0
    for f in files:
        for line, col, ty, why, text in findings(open(f, encoding='utf-8').read()):
            bad += 1
            print(f'CAST {f}:{line} {col} ({ty}) {why} without an explicit cast: {text}')
    print(f'cast check: {len(files)} files, {bad} findings')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
