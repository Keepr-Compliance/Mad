#!/usr/bin/env python3
"""BACKLOG-4257 PR A static checks (no database). Exit 1 on any failure.

1. The new _learn_pilot_report_invalid with the schema-2 branch removed is the 4219 text byte for byte.
2. rollback-4257.sql carries the 4219 text byte for byte (md5 printed: compare with keepr-test).
3. The migration's five value-name ARRAYs equal SIGNAL_VALUES ids (electron/services/learn/
   signalScoring.ts) split on '.', in order.
"""
import hashlib, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
M4219 = open(os.path.join(REPO, 'supabase/migrations/20261112130000_backlog_4219_learn_pilot_report.sql')).read()
M4257 = open(os.path.join(REPO, 'supabase/migrations/20261117120000_backlog_4257_learn_pilot_signals.sql')).read()
RB = open(os.path.join(HERE, 'rollback-4257.sql')).read()
TS = open(os.path.join(REPO, 'electron/services/learn/signalScoring.ts')).read()
HEAD = 'CREATE OR REPLACE FUNCTION public._learn_pilot_report_invalid(p JSONB)'
fails = []


def body(text):
    assert text.count(HEAD) == 1, 'validator count'
    a = text.index('AS $fn$', text.index(HEAD)) + len('AS $fn$')
    return text[a:text.index('$fn$', a)]


def md5(s): return hashlib.md5(s.encode()).hexdigest()


b19, b57, brb = body(M4219), body(M4257), body(RB)
s = b57.index('  -- BACKLOG-4257: schema 2')
e = b57.index('  END IF;\n', b57.index("RETURN public._learn_pilot_report_invalid((p - 'signals')")) + len('  END IF;\n')
stripped = b57[:s] + b57[e:]
print('md5 4219 file      ', md5(b19))
print('md5 4257 stripped  ', md5(stripped), '(branch %d bytes)' % (e - s))
print('md5 4257 full      ', md5(b57))
print('md5 rollback-4257  ', md5(brb))
if stripped != b19: fails.append('schema-1 path differs from 4219')
if brb != b19: fails.append('rollback body differs from 4219')
if b57 == b19: fails.append('migration did not change the validator')

lists = {}
for name in ('PLACEMENTS', 'STAGES', 'TIERS', 'FILENAME_CLASSES', 'FORM_KINDS'):
    m = re.search(r'const %s\b[^=]*=\s*\[([^\]]*)\]' % name, TS)
    lists[name] = re.findall(r'"([^"]*)"', m.group(1))
blk = TS[TS.index('export const SIGNAL_VALUES'):]
blk = blk[:blk.index('\n];\n')]
ids = []
for line in blk.splitlines():
    m = re.search(r'\.\.\.(\w+)\.map\(\(\w+\) => \(\{\s*$|\.\.\.(\w+)\.map\(\(\w+\) => \(\{ id: `(\w+)\.', line)
    sp = re.search(r'\.\.\.(\w+)\.map', line)
    if sp:
        fam = re.search(r'id: `(\w+)\.\$', line) or None
        ids.append(('MAP', sp.group(1), fam.group(1) if fam else None))
        continue
    fm = re.search(r'id: `(\w+)\.\$', line)
    if fm and ids and ids[-1][0] == 'MAP' and ids[-1][2] is None:
        ids[-1] = ('MAP', ids[-1][1], fm.group(1)); continue
    lit = re.search(r'id: "(\w+)\.(\w+)"', line)
    if lit: ids.append(('ID', lit.group(1), lit.group(2)))
flat = []
for kind, a, b in ids:
    if kind == 'MAP': flat += [(b, x) for x in lists[a]]
    else: flat.append((a, b))
ts_names = {}
for f, n in flat: ts_names.setdefault(f, []).append(n)
mig_names = {}
for f in ['anchor', 'stage', 'sender', 'filename', 'forms']:
    a = re.search(r"  v_%s CONSTANT TEXT\[\] := ARRAY\[([^\]]*)\];" % f, M4257)
    mig_names[f] = re.findall(r"'([^']*)'", a.group(1))
print('SIGNAL_VALUES ids', len(flat), '| migration names', sum(map(len, mig_names.values())))
if ts_names != mig_names: fails.append('value names differ: ts=%s mig=%s' % (ts_names, mig_names))
if len(flat) != 40: fails.append('expected 40 SIGNAL_VALUES, got %d' % len(flat))
for tag in ('$rb$', '$b$', '$f$', '$drv$', '$k4257$', '$pj$'):
    if tag in RB or tag in M4257: fails.append('dollar tag %s in migration/rollback' % tag)
print('STATIC ' + ('OK' if not fails else 'FAIL: ' + '; '.join(fails)))
sys.exit(1 if fails else 0)
