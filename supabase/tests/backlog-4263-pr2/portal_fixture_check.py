#!/usr/bin/env python3
"""BACKLOG-4263 PR-2 (R7): the portal fixture for list_all_deals, regenerated with THIS migration's reader.

Usage: portal_fixture_check.py <out.json>

Runs the PR-1 harness (supabase/tests/backlog-4263/harness.py, which calls main() at module level) from its
source text with two exact-string edits, each asserted to match once and reported:
  1. compose: this migration is inserted right after PR-1's migration in the composed call;
  2. the module-level main() call is removed, so main() runs only after the edit is in place.
Witness in the same call: PR-1's C_p_md5 must be red on 'reader md5' (the reader was replaced). One rolled-back
call; the FX_* outputs are written to <out.json> in the fixture format.
"""
import contextlib, io, json, os, re, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
pr1 = os.path.normpath(os.path.join(here, '..', 'backlog-4263', 'harness.py'))
src = open(pr1).read()
old_compose = "    text = head + guard + RB + '\\n' + MIG + '\\n' + MIG + '\\n' + HL + '\\n'"
assert src.count(old_compose) == 1, 'compose fragment'
src = src.replace(old_compose, "    text = head + guard + RB + '\\n' + MIG + '\\n' + MIG + '\\n' + MIG2 + '\\n' + HL + '\\n'")
print('EDIT APPLIED: compose inserts 20261118110000 after PR-1 migration')
assert src.rstrip().endswith('\nmain()'), 'module-level main() call'
src = src.rstrip()[:-len('main()')] + '\n'
print('EDIT APPLIED: module-level main() removed')
out = sys.argv[1]
facts = json.load(open(os.path.join(here, 'catalog-facts.json')))
want_md5 = facts['_mcp_r_list_all_deals(text,date,date,uuid)']['md5']
ns = {'__file__': pr1, '__name__': 'pr1_harness'}
sys.argv = [pr1, 'run', '--no-mutants', '--fixtures=' + out]
ns['MIG2'] = open(os.path.join(here, '..', '..', 'migrations', '20261118110000_backlog_4263_todo_server_core.sql')).read()
exec(compile(src, pr1, 'exec'), ns)
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        ns['main']()
except SystemExit:
    pass
log = buf.getvalue()
subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), '-c', 'select extensions.pg_stat_statements_reset()'], capture_output=True)
md5_line = next((l for l in log.splitlines() if l.startswith('C_p_md5')), 'C_p_md5 missing')
print(md5_line[:300])
for l in log.splitlines():
    if l.startswith(('CONTROLS', 'fixtures written', 'NO RESULT')) or (l.startswith('C_') and 'FAIL' in l):
        print(l[:400])
replaced = 'FAIL' in md5_line and 'reader md5' in md5_line
print('WITNESS: PR-1 reader md5 control red (reader replaced): %s; this migration\'s reader md5 %s' % (replaced, want_md5))
ref = json.load(open(os.path.join(here, '..', '..', '..', 'broker-portal', '__tests__', 'mcp', 'fixtures', 'data-tools-4263.json')))
new = json.load(open(out))


def norm(o):
    o = json.loads(re.sub(r'<id:\d+>', '<id>', json.dumps(o, sort_keys=True)))
    r = o.get('result', {})
    if 'rows' in r:
        r['rows'] = sorted(r['rows'], key=lambda x: json.dumps(x))
    if r.get('page', {}).get('next_cursor'):
        r['page']['next_cursor'] = '<id>'
    return o


same = [k for k in new if norm(new[k]) == norm(ref.get(k))]
paged = lambda f: sorted(json.dumps(r[1:]) for k in ('FX_all_f_page1', 'FX_all_f_page2') for r in f[k]['result']['rows'])
print('outputs equal to the committed fixture with ids and order ignored: %s; paged union equal: %s' % (same, paged(new) == paged(ref)))
sys.exit(0 if replaced else 1)
