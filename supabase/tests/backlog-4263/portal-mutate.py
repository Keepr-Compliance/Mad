#!/usr/bin/env python3
"""BACKLOG-4263 PR-1: mutants of the portal code, each run against the jest suite that should catch it.
Each is an exact-string replace (stops when the fragment does not match once); the file is restored
from the text read before the mutation. Commit first. Usage: portal-mutate.py [name ...]"""
import os, re, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
bp = os.path.join(root, 'broker-portal')
T = '__tests__/mcp/data-tools-4263.test.ts'
M = [
    ('tuple_length_unchecked', 'lib/mcp/tools/shapes.ts', 'Array.isArray(v) && v.length === s.items.length && s.items.every', 'Array.isArray(v) && s.items.every', T, 'extra value in a row'),
    ('object_extra_key_tolerated', 'lib/mcp/tools/shapes.ts', '      if (Object.keys(v).length !== keys.length) return false;\n', '', T, 'extra key on the frame'),
    ('columns_not_checked', 'lib/mcp/tools/shapes.ts', "columns: { t: 'tuple', items: ALL_DEALS_COLUMNS.map((k) => oneOf([k])) },", "columns: arr(str()),", T, 'columns reordered'),
    ('not_dispatched', 'lib/mcp/server.ts', '    [LIST_ALL_DEALS_TOOL.name, (args) => listAllDeals(atDigest(), args)],\n', '', T, 'FX_all_a'),
    ('cursor_unchecked', 'lib/mcp/tools/deals.ts', "cursor = optString(o, 'cursor', (s) => UUID.test(s));", "cursor = optString(o, 'cursor', () => true);", T, 'garbage'),
    ('range_unchecked', 'lib/mcp/tools/deals.ts', '    if (closedFrom !== null && closedTo !== null && closedFrom > closedTo) throw new InvalidInput();\n', '', T, '2026-03-02'),
    ('day_not_real', 'lib/mcp/tools/deals.ts', "  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;", "  return !Number.isNaN(d.getTime()) || true;", T, '2026-02-30'),
    ('wrong_shape', 'lib/mcp/oauth/rpc.ts', 'return checkDataToolEnvelope(res.data, LIST_ALL_DEALS_SHAPE);', 'return checkDataToolEnvelope(res.data, LIST_DEALS_SHAPE);', T, 'positive'),
    ('not_read_only_annotation', 'lib/mcp/tools/deals.ts', "  outputSchema: toJsonSchema(LIST_ALL_DEALS_SHAPE) as Tool['outputSchema'],\n  annotations: TOOL_ANNOTATIONS,",
     "  outputSchema: toJsonSchema(LIST_ALL_DEALS_SHAPE) as Tool['outputSchema'],\n  annotations: { ...TOOL_ANNOTATIONS, readOnlyHint: false },", T, 'is read-only'),
]
want = sys.argv[1:]
rows = []
for name, f, old, new, suite, expect in M:
    if want and name not in want:
        continue
    p = os.path.join(bp, f)
    orig = open(p).read()
    if orig.count(old) != 1:
        raise SystemExit('MUTATION NOT APPLIED %s: matched %d times' % (name, orig.count(old)))
    open(p, 'w').write(orig.replace(old, new, 1))
    print('MUTATION APPLIED %s: %s' % (name, ' | '.join(l.strip() for l in old.splitlines())[:120]))
    try:
        out = subprocess.run(['npx', 'jest', suite], cwd=bp, capture_output=True, text=True)
    finally:
        open(p, 'w').write(orig)
    txt = out.stdout + out.stderr
    tests = re.search(r'Tests:\s+(.*)', txt)
    failed = [l.strip() for l in txt.splitlines() if l.strip().startswith('●') and 'Console' not in l]
    hit = any(expect in l for l in failed)
    rows.append((name, tests.group(1) if tests else 'NO COUNT', hit, failed[:3]))
    print('  -> %s ; expected red test (%r) red: %s' % (tests.group(1) if tests else 'NO COUNT', expect, hit))
    for l in failed[:3]:
        print('     ' + l[:160])
diff = subprocess.run(['git', '-C', root, 'diff', '--numstat', '--', 'broker-portal'], capture_output=True, text=True).stdout
print('restored, git diff --numstat broker-portal: %r' % diff)
sys.exit(0 if rows and all(r[2] for r in rows) and diff == '' else 1)
