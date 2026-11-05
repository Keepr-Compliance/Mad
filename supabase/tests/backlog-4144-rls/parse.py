#!/usr/bin/env python3
"""Read kt-sql output on stdin; print the P4144_RESULT json. Exit 1 when no result or zero controls ran."""
import json, re, sys
t = sys.stdin.read()
try:
    msg = json.loads(t.split('\nkt-sql:')[0])['message']
except Exception:
    msg = t
m = re.search(r'P4144_RESULT (\{.*\})', msg)
if not m:
    print('NO RESULT: ' + msg[:3000]); sys.exit(1)
d, _ = json.JSONDecoder().raw_decode(m.group(1))
print(json.dumps(d, indent=1))
if not d.get('total'):
    print('ZERO CONTROLS RAN'); sys.exit(1)
