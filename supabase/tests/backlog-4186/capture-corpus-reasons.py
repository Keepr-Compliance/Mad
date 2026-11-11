#!/usr/bin/env python3
"""BACKLOG-4186 PR B: the SQL validator's reason for every case of the 4175 corpus.

Runs public._sender_rule_set_invalid over supabase/tests/backlog-4175/corpus.json on keepr-test
(kt-sql; read-only SELECT) and prints [{name, reason}] in corpus order. The output is committed as
admin-portal/__tests__/sender-rules-4186/corpus-sql-reasons.json.
"""
import json, os, subprocess, sys, tempfile
here = os.path.dirname(os.path.abspath(__file__))
corpus = open(os.path.join(here, '..', 'backlog-4175', 'corpus.json')).read()
assert '$cj$' not in corpus
sql = ("SELECT jsonb_agg(jsonb_build_object('name', e->>'name', 'reason', public._sender_rule_set_invalid(e->'content'))"
       " ORDER BY i) AS r FROM jsonb_array_elements($cj$" + corpus + "$cj$::jsonb) WITH ORDINALITY AS t(e, i);")
with tempfile.NamedTemporaryFile('w', suffix='.sql', delete=False) as f:
    f.write(sql)
p = subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), f.name], capture_output=True, text=True)
os.unlink(f.name)
if p.returncode != 0:
    sys.exit('kt-sql failed:\n' + (p.stdout + p.stderr)[:2000])
rows = json.loads(p.stdout)[0]['r']
print(json.dumps(rows, indent=1))
