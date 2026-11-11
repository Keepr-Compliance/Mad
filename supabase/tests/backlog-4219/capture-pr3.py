#!/usr/bin/env python3
"""BACKLOG-4219 PR3: capture a real learn_pilot_report_admin_list() answer on keepr-test.

Usage: capture-pr3.py <out-dir>   -> writes <out-dir>/admin-list-capture.json

Runs this directory's controls.sql (the PR1 harness) in ONE kt-sql call with one inserted line
that records owner u1's list `j` before the S11 block, filtered to the harness's fixture users.
The controls end in RAISE, so the whole call rolls back: nothing persists. keepr-test only
(kt-sql refuses the production ref). The admin-portal fixture
admin-portal/__tests__/learn-pilot-4219/fixtures.ts is transcribed from this output.
"""
import json, os, re, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
out_dir = sys.argv[1]
ctl = open(os.path.join(here, 'controls.sql')).read()
rb = open(os.path.join(here, 'rollback-4219.sql')).read()
anchor = "    -- ===== S11: joined to rule-set versions and pins;"
assert ctl.count(anchor) == 1, 'anchor miss'
ins = ("    r := r || jsonb_build_object('CAPTURE_LIST', jsonb_build_object('truncated', j->'truncated', 'rows', "
       "(SELECT jsonb_agg(x) FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' LIKE '00000000-0000-4219-8000-%'))::text);\n")
assert ctl.count('__ROLLBACK__') == 1
ctl = ctl.replace(anchor, ins + anchor).replace('__ROLLBACK__', rb)
sql = os.path.join(out_dir, 'capture-pr3.sql')
open(sql, 'w').write(ctl)
print('CAPTURE INSERTED')
t = subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), sql], capture_output=True, text=True).stdout
msg = json.loads(t.split('\nkt-sql:')[0])['message']
d, _ = json.JSONDecoder().raw_decode(re.search(r'P4219_RESULT (\{.*\})', msg).group(1))
cap = json.loads(d['reds'].pop('CAPTURE_LIST'))
print('controls total=%s reds_excluding_capture=%s %s' % (d['total'], len(d['reds']), list(d['reds'])))
json.dump(cap, open(os.path.join(out_dir, 'admin-list-capture.json'), 'w'), indent=1, sort_keys=True)
ids = set(re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', json.dumps(cap)))
print('rows', len(cap['rows']), 'keys', sorted(cap['rows'][0]))
print('non-fixture uuids', sorted(i for i in ids if not i.startswith('00000000-0000-4219-8000-')), 'has @', '@' in json.dumps(cap))
