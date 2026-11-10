#!/usr/bin/env python3
"""BACKLOG-4186 PR C: run capture-pr-c.sql on keepr-test and print the captured answers as JSON.

keepr-test ONLY (kt-sql refuses the production ref). The two read functions are dropped and the
PR A migration applied inside the same transaction, which ends in RAISE, so nothing persists.
"""
import json, os, subprocess, sys, tempfile
here = os.path.dirname(os.path.abspath(__file__))
mig = os.path.join(here, '..', '..', 'migrations', '20261109210000_backlog_4186_sender_rule_set_reads.sql')
drop = ('DROP FUNCTION IF EXISTS public.sender_rule_set_admin_content(BIGINT);\n'
        'DROP FUNCTION IF EXISTS public.sender_rule_set_admin_state();\n')
text = drop + open(mig).read() + '\n' + open(os.path.join(here, 'capture-pr-c.sql')).read()
with tempfile.NamedTemporaryFile('w', suffix='.sql', delete=False) as f:
    f.write(text)
p = subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), f.name], capture_output=True, text=True)
os.unlink(f.name)
out = p.stdout + p.stderr
marker = 'P4186C_CAPTURE '
if marker not in out:
    sys.exit('capture failed:\n' + out[:2000])
body = json.loads(out.split('\n')[0])['message']
start = body.index(marker) + len(marker)
obj, _ = json.JSONDecoder().raw_decode(body[start:].replace('\\"', '"') if body[start] == '\\' else body[start:])
print(json.dumps(obj, indent=1, sort_keys=True))
