#!/usr/bin/env python3
"""BACKLOG-4263 PR-2 (R7): the portal fixture for list_all_deals, regenerated with THIS migration's reader.

Usage: portal_fixture_check.py <out.json>

Runs PR-1's harness (supabase/tests/backlog-4263/harness.py) in its post-PR-2 mode (--post-pr2: this migration is
run after PR-1's in the same rolled-back call, and its p_md5 control expects this migration's reader md5), writes the
FX_* outputs to <out.json> in the fixture format, and compares them with the committed portal fixture (ids and row
order ignored, because fixture ids are random per run). Witness: C_p_md5 PASS in post-PR-2 mode.
"""
import json, os, re, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
pr1 = os.path.normpath(os.path.join(here, '..', 'backlog-4263', 'harness.py'))
out = sys.argv[1]
r = subprocess.run([sys.executable, pr1, 'run', '--post-pr2', '--no-mutants', '--fixtures=' + out], capture_output=True, text=True)
log = r.stdout + r.stderr
subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), '-c', 'select extensions.pg_stat_statements_reset()'], capture_output=True)
for l in log.splitlines():
    if l.startswith(('post-PR-2', 'C_p_md5', 'CONTROLS', 'fixtures written', 'NO RESULT')):
        print(l[:300])
facts = json.load(open(os.path.join(here, 'catalog-facts.json')))
print("this migration's reader md5: " + facts['_mcp_r_list_all_deals(text,date,date,uuid)']['md5'])
ref = json.load(open(os.path.join(here, '..', '..', '..', 'broker-portal', '__tests__', 'mcp', 'fixtures', 'data-tools-4263.json')))
new = json.load(open(out))


def norm(o):
    o = json.loads(re.sub(r'<id:\d+>', '<id>', json.dumps(o, sort_keys=True)))
    res = o.get('result', {})
    if 'rows' in res:
        res['rows'] = sorted(res['rows'], key=lambda x: json.dumps(x))
    if res.get('page', {}).get('next_cursor'):
        res['page']['next_cursor'] = '<id>'
    return o


same = [k for k in new if norm(new[k]) == norm(ref.get(k))]
paged = lambda f: sorted(json.dumps(x[1:]) for k in ('FX_all_f_page1', 'FX_all_f_page2') for x in f[k]['result']['rows'])
print('outputs equal to the committed fixture with ids and order ignored: %s; paged union equal: %s' % (same, paged(new) == paged(ref)))
ok = any(l.startswith('C_p_md5') and l.rstrip().endswith('PASS') for l in log.splitlines())
sys.exit(0 if ok else 1)
