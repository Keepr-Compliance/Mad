#!/usr/bin/env python3
"""Read kt-sql output on stdin; print the P4098_RESULT json, one mode per line."""
import json, re, sys
t = sys.stdin.read()
try:
    msg = json.loads(t.split('\nkt-sql:')[0])['message']
except Exception:
    msg = t
m = re.search(r'P4098_RESULT (\{.*\})', msg)
if not m:
    print('NO RESULT: ' + msg[:3000]); sys.exit(1)
d, _ = json.JSONDecoder().raw_decode(m.group(1))
for k, v in d.items():
    print(k, json.dumps(v, indent=1) if k == 'base' else json.dumps(v))
